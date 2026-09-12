// Regression for durable Mosaic size ownership after a Smart Resize configure ack.
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
    const ext = new Mosaic({ ...metadata, dir, path: extensionPath });
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
        'Alacritty must finish ordinary Mosaic admission');
        assert(!WindowState.get(window, WindowState.IS_DOMINANT),
            'Durable constraint regression requires an ordinary normal-role window');

        const initial = window.get_frame_rect();
        const target = {
            x: initial.x,
            y: initial.y,
            width: Math.max(320, initial.width - 120),
            height: Math.max(240, initial.height - 100),
        };
        assert(target.width < initial.width && target.height < initial.height,
            'Regression window must have room for a smaller constrained slot');

        // Reproduce the state immediately before the Firefox bug: Smart Resize owns a durable
        // model slot while targetSmartResizeSize only bridges the asynchronous configure.
        MosaicModel.commitNormalSlot(window, target, window.get_workspace(), window.get_monitor());
        WindowState.set(window, 'isConstrainedByMosaic', true);
        WindowState.set(window, 'targetSmartResizeSize', {width: target.width, height: target.height});
        WindowState.set(window, 'targetSmartResizeSetAt', GLib.get_monotonic_time() / 1000);
        window.move_resize_frame(false, target.x, target.y, target.width, target.height);

        assert(await waitFor(() => {
            const frame = window.get_frame_rect();
            return Math.abs(frame.width - target.width) <= 2 &&
                Math.abs(frame.height - target.height) <= 2;
        }), 'Alacritty must acknowledge the constrained target');
        assert(await waitFor(() => !WindowState.get(window, 'targetSmartResizeSize')),
            'Successful configure ack must clear only the transient Smart Resize bridge');
        assert(WindowState.get(window, 'isConstrainedByMosaic'),
            'Configure ack must not release Mosaic durable size ownership');
        const committedBeforeDrift = MosaicModel.normalSlotFor(window);
        console.log(`[CONSTRAINED MODEL TEST] pre-drift constraint=${WindowState.get(window, 'isConstrainedByMosaic')} target=${JSON.stringify(WindowState.get(window, 'targetSmartResizeSize'))} slot=${committedBeforeDrift?.width}x${committedBeforeDrift?.height} live=${window.get_frame_rect().width}x${window.get_frame_rect().height} grab=${ext.resizeHandler._currentGrabOp}`);

        // Simulate Firefox publishing a second startup/session-restore size after that ack.
        // This is deliberately not a manual grab, so the model must win over the live frame.
        const lateSize = {
            width: Math.min(initial.width, target.width + 80),
            height: Math.min(initial.height, target.height + 60),
        };
        window.move_resize_frame(false, target.x, target.y, lateSize.width, lateSize.height);
        assert(await waitFor(() => {
            const frame = window.get_frame_rect();
            return frame.width > target.width + 20 || frame.height > target.height + 20;
        }), 'Window must accept the simulated post-ack client drift');
        console.log(`[CONSTRAINED MODEL TEST] drift accepted constraint=${WindowState.get(window, 'isConstrainedByMosaic')} slot=${MosaicModel.normalSlotFor(window)?.width}x${MosaicModel.normalSlotFor(window)?.height} live=${window.get_frame_rect().width}x${window.get_frame_rect().height} grab=${ext.resizeHandler._currentGrabOp}`);

        assert(await waitFor(() => {
            const frame = window.get_frame_rect();
            return Math.abs(frame.width - target.width) <= 2 &&
                Math.abs(frame.height - target.height) <= 2;
        }), 'Mosaic must reassert the committed constrained model slot after post-ack drift');

        const slot = MosaicModel.normalSlotFor(window);
        assert(slot && Math.abs(slot.width - target.width) <= 2 && Math.abs(slot.height - target.height) <= 2,
            'Post-ack client drift must not overwrite the durable Mosaic model slot');
        console.log(`[CONSTRAINED MODEL TEST] PASS: ${lateSize.width}x${lateSize.height} drift returned to ${target.width}x${target.height}`);
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        child.force_exit();
    }
}
