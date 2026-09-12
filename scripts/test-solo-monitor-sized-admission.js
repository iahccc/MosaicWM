// Regression: a normal window whose restored startup frame fills Mutter's work area must
// shrink into Mosaic instead of being ejected as overflow from an otherwise empty workspace.
// Run with --automation-script in a private headless GNOME Shell session.
// MOSAIC_TEST_EXTENSION_DIR must point to an extension copy with compiled schemas.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as constants from '../extension/constants.js';
import {MosaicModel} from '../extension/mosaicModel.js';
import * as WindowState from '../extension/windowState.js';

const WAIT_MS = 10000;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function waitFor(predicate, timeoutMs = WAIT_MS) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (predicate()) return true;
        await Scripting.sleep(60);
    }
    return predicate();
}

function windowForPid(pid) {
    return global.display.list_all_windows().find(window => window.get_pid() === pid) ?? null;
}

export async function run() {
    const extensionPath = GLib.getenv('MOSAIC_TEST_EXTENSION_DIR');
    assert(extensionPath, 'Set MOSAIC_TEST_EXTENSION_DIR to the test extension copy');
    const dir = Gio.File.new_for_path(extensionPath);
    const metadata = JSON.parse(new TextDecoder().decode(dir.get_child('metadata.json').load_contents(null)[1]));
    const ext = new Mosaic({...metadata, dir, path: extensionPath});
    const stylesheet = dir.get_child('stylesheet.css');
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.load_stylesheet(stylesheet);
    ext.enable();
    Main.overview.hide();
    await Scripting.sleep(700);

    const child = Gio.Subprocess.new(
        ['alacritty', '--config-file', '/dev/null', '-e', 'sleep', '60'],
        Gio.SubprocessFlags.NONE);
    const pid = Number(child.get_identifier());
    let window = null;

    try {
        assert(await waitFor(() => {
            window = windowForPid(pid);
            return !!window;
        }), 'Alacritty must create a window');
        assert(await waitFor(() =>
            !WindowState.get(window, 'arrivalPending') &&
            !WindowState.get(window, 'pendingInQueue')),
        'Alacritty must finish its initial Mosaic admission');

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const rawWorkArea = workspace.get_work_area_for_monitor(monitor);
        const layoutArea = {
            width: rawWorkArea.width - constants.WINDOW_SPACING * 2,
            height: rawWorkArea.height - constants.WINDOW_SPACING * 2,
        };
        assert(layoutArea.width > 0 && layoutArea.height > 0,
            'Regression requires a usable Mosaic layout area');

        // Recreate the startup state from Firefox/GNOME Settings: ordinary native state,
        // no reliable preferred size, and a frame exactly equal to Mutter's work area.
        WindowState.remove(window, 'preferredSize');
        WindowState.remove(window, 'openingSize');
        WindowState.remove(window, 'targetSmartResizeSize');
        WindowState.remove(window, 'targetRestoredSize');
        WindowState.remove(window, 'isConstrainedByMosaic');
        MosaicModel.forget(window);
        window.move_resize_frame(false,
            rawWorkArea.x, rawWorkArea.y, rawWorkArea.width, rawWorkArea.height);
        assert(await waitFor(() => {
            const frame = window.get_frame_rect();
            return Math.abs(frame.width - rawWorkArea.width) <= 2 &&
                Math.abs(frame.height - rawWorkArea.height) <= 2;
        }), 'Regression window must reach monitor-sized normal geometry');
        assert(!window.is_maximized(), 'Regression window must remain natively unmaximized');

        // A monitor-sized frame is not itself a fullscreen role. WPS and other clients can
        // restore normal windows at exactly the work-area size; born-mode sampling must not
        // promote that geometry into MOSAIC_FULLSCREEN and bypass normal admission.
        ext.windowHandler._sampleInitialWindowMode(window);
        assert(!window.is_fullscreen(), 'Regression window must remain natively non-fullscreen');
        assert(!WindowState.get(window, WindowState.MOSAIC_FULLSCREEN),
            'Monitor-sized normal geometry must not create Mosaic fullscreen state');
        assert(!ext.windowingManager.isFullscreenLike(window),
            'Monitor-sized normal geometry must not be treated as fullscreen-like');

        const admittedWorkspace = await ext.windowHandler._fitByResizeOrOverflow(window, workspace, monitor);
        assert(admittedWorkspace === workspace,
            'A lone monitor-sized normal window must stay on its current workspace');
        assert(window.get_workspace() === workspace,
            'Solo self-resize admission must not change the MetaWorkspace');
        assert(!WindowState.get(window, 'movedByOverflow'),
            'Solo self-resize admission must not enter overflow migration');
        assert(WindowState.get(window, 'isConstrainedByMosaic'),
            'Mosaic must own the resized solo frame after admission');
        assert(await waitFor(() => {
            const frame = window.get_frame_rect();
            return frame.width <= layoutArea.width + 2 &&
                frame.height <= layoutArea.height + 2;
        }), 'Solo monitor-sized frame must shrink into the usable Mosaic area');

        console.log('[SOLO OVERSIZED TEST] PASS: monitor-sized normal window self-resized without workspace overflow');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        child.force_exit();
    }
}
