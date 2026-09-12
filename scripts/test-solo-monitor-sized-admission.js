// Regression: a normal window whose restored startup frame fills Mutter's work area must
// stay in Mosaic on its current workspace instead of being ejected as overflow. A lone
// window is resized with the ordinary layout's outer gap; the
// regression is the overflow migration, not the absence of a shrink.
// Run with --automation-script in a private headless GNOME Shell session.
// MOSAIC_TEST_EXTENSION_DIR must point to an extension copy with compiled schemas.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import {MosaicModel} from '../extension/mosaicModel.js';
import * as WindowState from '../extension/windowState.js';
import {allocate} from '../extension/sizeAllocator.js';

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
        const workspaceCount = global.workspace_manager.get_n_workspaces();

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
        assert(!window.is_fullscreen(), 'Regression window must remain natively non-fullscreen');
        assert(!WindowState.get(window, WindowState.MOSAIC_FULLSCREEN),
            'Monitor-sized normal geometry must not create Mosaic fullscreen state');
        assert(!ext.windowingManager.isFullscreenLike(window),
            'Monitor-sized normal geometry must not be treated as fullscreen-like');

        const admittedWorkspace = await ext.windowHandler._ensureWindowFits(window, workspace, monitor);
        assert(admittedWorkspace === workspace,
            'A lone monitor-sized normal window must stay on its current workspace');
        assert(window.get_workspace() === workspace,
            'Solo self-resize admission must not change the MetaWorkspace');
        assert(!WindowState.get(window, 'movedByOverflow'),
            'Solo self-resize admission must not enter overflow migration');
        assert(global.workspace_manager.get_n_workspaces() === workspaceCount,
            'Solo self-resize admission must not create an overflow workspace');
        assert(!WindowState.get(window, WindowState.IS_MINIATURE),
            'A lone monitor-sized window must not be miniaturized');
        // Ordinary admission applies its existing packing gap even to a single window.
        assert(await waitFor(() => {
            const frame = window.get_frame_rect();
            return frame.x >= rawWorkArea.x && frame.y >= rawWorkArea.y &&
                frame.width <= rawWorkArea.width && frame.height <= rawWorkArea.height;
        }), 'Solo monitor-sized frame must keep the full work area without overflowing');

        const miniatureFrames = [];
        const paintId = global.stage.connect('after-paint', () => {
            if (WindowState.get(window, WindowState.IS_MINIATURE) ||
                WindowState.get(window, WindowState.PENDING_MINIATURE))
                miniatureFrames.push(window.get_frame_rect());
        });
        try {
            for (const pause of [400, 30, 400]) {
                window.maximize();
                await Scripting.sleep(pause);
                window.unmaximize();
                await Scripting.sleep(700);
                assert(!window.is_maximized() && !WindowState.get(window, WindowState.IS_MINIATURE),
                    'a solitary monitor-sized window must remain normal after unmaximize');
            }
        } finally {
            global.stage.disconnect(paintId);
        }
        assert(miniatureFrames.length === 0,
            'single-window maximize/unmaximize must never present a miniature frame');

        // The Electron window's normal width equals its computed miniature threshold.
        // The restored height is only four pixels beyond the packing gap, not a reason to
        // turn the sole window into a thumbnail (the actual desktop regression).
        const minimum = ext.tilingManager.getWindowMinimumSize(window);
        const intent = {width: Math.round((minimum.width + rawWorkArea.width) / 2),
            height: rawWorkArea.height - 12};
        const maxSize = ext.tilingManager.getWindowMaximumSize;
        ext.tilingManager.getWindowMaximumSize = w => w === window
            ? {width: rawWorkArea.width, height: rawWorkArea.height} : maxSize.call(ext.tilingManager, w);
        try {
            WindowState.set(window, 'preferredSize', {...intent});
            const participant = ext.tilingManager._allocationParticipant(window, intent,
                rawWorkArea, null, null, new Map([[window.get_id(), 0]]));
            const result = allocate({participants: [participant], fits: sizes => sizes.every(size =>
                size.width <= rawWorkArea.width - 16 && size.height <= rawWorkArea.height - 16)});
            assert(result.fits && result.entries.get(window.get_id()).mode === 'window',
                'width at the miniature threshold must not turn a tiny height adjustment into miniature mode');
            window.maximize();
            await Scripting.sleep(400);
            window.unmaximize();
            await Scripting.sleep(800);
            assert(!WindowState.get(window, WindowState.IS_MINIATURE) &&
                !WindowState.get(window, WindowState.PENDING_MINIATURE),
            'width at the miniature threshold and a four-pixel height overflow must preserve the sole normal window');
            const frame = window.get_frame_rect();
            assert(frame.height <= rawWorkArea.height - 16 && frame.width <= intent.width + 2,
                'the restored ordinary frame must fit the packing area');
        } finally {
            ext.tilingManager.getWindowMaximumSize = maxSize;
        }

        console.log('[SOLO OVERSIZED TEST] PASS: monitor-sized normal window stays in Mosaic without workspace overflow');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        child.force_exit();
    }
}
