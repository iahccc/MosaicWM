// Run with --automation-script in a private headless GNOME Shell session.
// MOSAIC_TEST_EXTENSION_DIR must point to an extension copy with compiled schemas.
// Alacritty must be in PATH; MOSAIC_TEST_SCREENSHOT optionally saves the final frame.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as WindowState from '../extension/windowState.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function assertCorners(drawing, window) {
    const corners = drawing._focusCorners;
    assert(corners?.length === 4, 'All four corners must exist');
    for (const corner of corners) {
        assert(corner.visible && corner.has_allocation(), 'Visible corners must have a valid allocation');
        assert(corner.get_transformed_position().every(Number.isFinite),
            'Rendered corner coordinates must remain finite after each new window');
    }
    const frame = window.get_frame_rect();
    const [left, top] = corners[0].get_transformed_position();
    const [right, bottom] = corners[3].get_transformed_position();
    assert(Math.abs(left - frame.x) < 2 && Math.abs(top - frame.y) < 2 &&
        Math.abs(right + 18 - frame.x - frame.width) < 2 &&
        Math.abs(bottom + 18 - frame.y - frame.height) < 2,
    'Rendered corners must surround the focused Alacritty, not a previous window');
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
    await Scripting.sleep(1000);

    const seat = global.stage.get_context().get_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const heldKeys = new Set();
    const key = async (symbol, down, delay = 70) => {
        if (down)
            heldKeys.add(symbol);
        else
            heldKeys.delete(symbol);
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol,
            down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
        await Scripting.sleep(delay);
    };
    const action = global.display.grab_accelerator('<Super>Return', Meta.KeyBindingFlags.NONE);
    assert(action !== Meta.KeyBindingAction.NONE, 'Super+Enter must register');
    const binding = Meta.external_binding_name_for_action(action);
    Main.wm.allowKeybinding(binding, Shell.ActionMode.NORMAL);
    const children = [];
    const prematureFrames = [];
    let pendingFrames = 0;
    let visiblePendingFrames = 0;
    let lastShownRect = null;
    const showCorners = ext.drawingManager.showFocusCorners.bind(ext.drawingManager);
    ext.drawingManager.showFocusCorners = rect => {
        const focused = global.display.focus_window;
        const pending = focused && (WindowState.get(focused, 'arrivalPending') ||
            WindowState.get(focused, 'pendingFirstPlacement'));
        const nextRect = rect && [rect.x, rect.y, rect.width, rect.height].join(',');
        if (pending && nextRect && nextRect !== lastShownRect)
            prematureFrames.push(focused.get_id());
        if (nextRect)
            lastShownRect = nextRect;
        return showCorners(rect);
    };
    const paintId = global.stage.connect('after-paint', () => {
        const focused = global.display.focus_window;
        if (focused && WindowState.get(focused, 'pendingFirstPlacement')) {
            pendingFrames++;
            if (ext.drawingManager._focusCorners?.some(corner => corner.visible))
                visiblePendingFrames++;
        }
    });
    const acceleratorId = global.display.connect('accelerator-activated', (_display, activated) => {
        if (activated === action) {
            children.push(Gio.Subprocess.new(
                ['alacritty', '--config-file', '/dev/null', '-e', 'sleep', '60'],
                Gio.SubprocessFlags.NONE));
        }
    });

    try {
        // First burst holds Super continuously; the second releases it between launches.
        for (const releaseBetween of [false, true]) {
            await key(Clutter.KEY_Super_L, true);
            for (let index = 0; index < 4; index++) {
                await key(Clutter.KEY_Return, true);
                await key(Clutter.KEY_Return, false, 130);
                if (releaseBetween && index < 3) {
                    await key(Clutter.KEY_Super_L, false);
                    await key(Clutter.KEY_Super_L, true);
                }
            }
            await Scripting.sleep(1500);
            const window = global.display.focus_window;
            assert(window?.get_pid() === Number(children.at(-1).get_identifier()),
                'The last launched Alacritty must receive focus');
            assertCorners(ext.drawingManager, window);
            console.log(`[ALACRITTY TEST] ${children.length} windows: focused window and rendered corners match`);
            const screenshotPath = GLib.getenv('MOSAIC_TEST_SCREENSHOT');
            if (screenshotPath) {
                const stream = Gio.File.new_for_path(screenshotPath).replace(null, false, Gio.FileCreateFlags.NONE, null);
                await new Shell.Screenshot().screenshot(false, stream);
                stream.close(null);
            }
            await key(Clutter.KEY_Super_L, false);
            assert(ext.drawingManager._focusCorners.every(corner => !corner.visible),
                'Releasing Super must hide corners');
            // Regression: a fresh long press after four shortcut launches.
            for (let attempt = 0; attempt < 3; attempt++) {
                await key(Clutter.KEY_Super_L, true, 650);
                await key(Clutter.KEY_Super_L, false, 300);
                assert(!Main.overview.visible, 'Long Super after four launches must not open overview');
            }
            await key(Clutter.KEY_Super_L, true);
            await key(Clutter.KEY_Super_L, false, 500);
            assert(Main.overview.visible, 'A short tap after repeated long holds must open overview');
            Main.overview.hide();
            await Scripting.sleep(800);
        }
        assert(children.length === 8, 'Every Super+Enter must launch Alacritty');
        assert(pendingFrames > 0, 'The test must sample real entrance animation frames');
        assert(visiblePendingFrames === 0, `Corners were visible in ${visiblePendingFrames} entrance frames`);
        assert(prematureFrames.length === 0, `Corners changed during first placement in ${prematureFrames.length} frames`);
        console.log(`[ALACRITTY TEST] PASS: ${pendingFrames} entrance frames with hidden corners; four-window launches followed by long/short Super, valid rendered allocations and focus`);
    } finally {
        for (const symbol of [...heldKeys])
            await key(symbol, false);
        global.stage.disconnect(paintId);
        global.display.disconnect(acceleratorId);
        global.display.ungrab_accelerator(action);
        Main.wm.allowKeybinding(binding, Shell.ActionMode.NONE);
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        children.forEach(child => child.force_exit());
    }
}
