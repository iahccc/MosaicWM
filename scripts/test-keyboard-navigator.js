// Real modifier timing and animated hint geometry in a private GNOME Shell session.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {KeyboardNavigatorManager} from '../extension/keyboardNavigator.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function waitFor(predicate, message) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await Scripting.sleep(50);
    }
    assert(predicate(), message);
}

export async function run() {
    await waitFor(() => !Main.layoutManager._startingUp, 'Shell startup must finish');
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 'Overview must close');
    const existing = new Set(global.display.list_all_windows());
    await Scripting.createTestWindow({width: 640, height: 480});
    await Scripting.waitTestWindows();
    const window = global.display.list_all_windows().find(candidate => !existing.has(candidate));
    assert(window, 'A test window must map');
    window.activate(global.get_current_time());
    await waitFor(() => global.display.focus_window === window, 'The test window must have focus');
    const stylesheet = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
        .get_child('extension').get_child('stylesheet.css');
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.load_stylesheet(stylesheet);
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.mosaic-wm'});
    const navigator = new KeyboardNavigatorManager({getSettings: () => settings, windowingManager: {
        isNavigable: candidate => candidate === window,
        getMonitorWorkspaceWindows: (workspace, monitor) =>
            window.get_workspace() === workspace && window.get_monitor() === monitor ? [window] : [],
    }});
    const keyboard = global.stage.get_context().get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const held = new Set();
    const key = async (symbol, down) => {
        if (down) held.add(symbol);
        else held.delete(symbol);
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol,
            down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
        await Scripting.sleep(40);
    };
    const hold = async (symbol = Clutter.KEY_Super_L) => {
        await key(symbol, true);
        await waitFor(() => navigator._hintOverlay, 'Holding Super must show hints');
    };
    const assertCentered = (dx = 0, dy = 0) => {
        const label = [...navigator._hintOverlay._labels.values()][0].label;
        const frame = window.get_frame_rect();
        const [x, y] = label.get_transformed_position();
        assert(Number.isFinite(x) && Number.isFinite(y) &&
            Math.abs(x + label.width / 2 - frame.x - frame.width / 2 - dx) < 2 &&
            Math.abs(y + label.height / 2 - frame.y - frame.height / 2 - dy) < 2,
        'The hint must follow the rendered window center, excluding shadows');
    };
    let launches = 0;
    const action = global.display.grab_accelerator('<Super>Return', Meta.KeyBindingFlags.NONE);
    assert(action !== Meta.KeyBindingAction.NONE, 'The unrelated Super+Enter shortcut must register');
    const binding = Meta.external_binding_name_for_action(action);
    Main.wm.allowKeybinding(binding, Shell.ActionMode.NORMAL);
    const acceleratorId = global.display.connect('accelerator-activated', (_display, activated) => {
        if (activated === action) launches++;
    });
    try {
        navigator.enable();
        assert(settings.get_uint('super-hold-threshold-ms') === 200, 'The default delay must be 200 ms');
        await key(Clutter.KEY_Super_L, true);
        await Scripting.sleep(50);
        assert(!navigator.isSessionActive(), 'Super must not show hints before the delay');
        await waitFor(() => navigator._hintOverlay, 'Long Super must start selection');
        await Scripting.sleep(100);
        assertCentered();
        const actor = window.get_compositor_private();
        actor.translation_x = 60;
        actor.translation_y = 35;
        await Scripting.sleep(100);
        assertCentered(60, 35);
        actor.ease({translation_x: 0, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.LINEAR});
        await Scripting.sleep(300);
        assertCentered();
        await key(Clutter.KEY_Super_L, false);
        assert(!navigator._hintOverlay && !Main.overview.visible, 'Long release must dismiss hints and suppress Overview');
        await key(Clutter.KEY_Super_L, true);
        await key(Clutter.KEY_Super_L, false);
        await waitFor(() => Main.overview.visible, 'A short tap after a long hold must still open Overview');
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 'Overview must close');

        // Deliver overlay-key after release-time idle work, as Mutter can do during retiling.
        navigator._primaryModifierHeld = true;
        navigator._trackSuperHold();
        await Scripting.sleep(600);
        global.display.emit('overlay-key');
        await Scripting.sleep(100);
        assert(navigator._overlayKeyBlocked, 'An overlay signal while Super is held must not lift suppression');
        navigator._primaryModifierHeld = false;
        navigator._trackSuperHold();
        await Scripting.sleep(150);
        assert(navigator._overlayKeyBlocked, 'Suppression must survive until the delayed overlay signal');
        global.display.emit('overlay-key');
        await Scripting.sleep(100);
        assert(!Main.overview.visible && !navigator._overlayKeyBlocked, 'The delayed signal must be consumed before unblocking');
        settings.set_uint('super-hold-threshold-ms', 80);
        await hold();
        await key(Clutter.KEY_Super_L, false);
        assert(!Main.overview.visible, 'A custom delay must apply on the next press');
        settings.reset('super-hold-threshold-ms');
        for (const symbol of [Clutter.KEY_Super_L, Clutter.KEY_Super_R]) {
            await hold(symbol);
            await key(symbol, false);
            assert(!navigator.isSessionActive() && !Main.overview.visible, 'Either Super key must close selection cleanly');
        }
        await key(Clutter.KEY_Super_L, true);
        for (let i = 0; i < 3; i++) {
            await key(Clutter.KEY_Return, true);
            await key(Clutter.KEY_Return, false);
        }
        await Scripting.sleep(550);
        assert(launches === 3 && !navigator.isSessionActive(), 'Repeated unrelated shortcuts must cancel hints for the hold');
        await key(Clutter.KEY_Super_L, false);
        await hold();
        navigator.disable();
        assert(!navigator._hintOverlay && !navigator._hintFrameId && Main.actionMode === Shell.ActionMode.NORMAL,
            'Disable must release keyboard input and stop geometry tracking');
        await key(Clutter.KEY_Super_L, false);
        console.log('[NAV TEST] PASS: delay, centered animated geometry, long/short Super, delayed overlay signal, configurable threshold, both Super keys, repeated shortcuts and teardown');
    } finally {
        settings.reset('super-hold-threshold-ms');
        for (const symbol of [...held]) await key(symbol, false);
        navigator.disable();
        global.display.disconnect(acceleratorId);
        global.display.ungrab_accelerator(action);
        Main.wm.allowKeybinding(binding, Shell.ActionMode.NONE);
        theme.unload_stylesheet(stylesheet);
        await Scripting.destroyTestWindows();
    }
}
