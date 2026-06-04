// Run in an isolated GNOME Shell with --automation-script pointing to this file.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

import { DrawingManager } from '../extension/drawing.js';
import { KeyboardNavigatorManager } from '../extension/keyboardNavigator.js';
import { ComputedLayouts } from '../extension/mosaicModel.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (predicate())
            return true;
        await Scripting.sleep(50);
    }
    return predicate();
}

export async function run() {
    Main.overview.hide();
    await Scripting.sleep(500);
    const existingWindows = new Set(global.display.list_all_windows());
    await Scripting.createTestWindow({ width: 640, height: 480 });
    await Scripting.waitTestWindows();
    await Scripting.sleep(200);
    const window = global.display.list_all_windows().find(candidate => !existingWindows.has(candidate));
    assert(window, 'Test window must be mapped');
    window.activate(global.get_current_time());
    assert(await waitFor(() => global.display.focus_window === window),
        'Test window must have focus');

    const stylesheet = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
        .get_child('extension').get_child('stylesheet.css');
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.load_stylesheet(stylesheet);
    const drawing = new DrawingManager();
    const settings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.mosaic-wm' });
    const testWindows = [window];
    const navigator = new KeyboardNavigatorManager({
        drawingManager: drawing,
        getSettings: () => settings,
        windowingManager: {
            isNavigable: candidate => testWindows.includes(candidate),
            getMonitorWorkspaceWindows: () => testWindows,
        },
    });
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const heldKeys = new Set();
    const key = async (symbol, pressed) => {
        if (pressed)
            heldKeys.add(symbol);
        else
            heldKeys.delete(symbol);
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
        await Scripting.sleep(100);
    };
    const visible = () => drawing._focusCorners?.every(corner => corner.visible && corner.is_mapped());
    const hidden = () => !drawing._focusCorners?.some(corner => corner.visible);

    const closeOverview = async () => {
        Main.overview.hide();
        await Scripting.sleep(800);
        assert(!Main.overview.visible, 'Overview must be closed before this case');
    };
    const checkFrame = candidate => {
        const frame = candidate.get_frame_rect();
        const [left, top] = drawing._focusCorners[0].get_transformed_position();
        const [right, bottom] = drawing._focusCorners[3].get_transformed_position();
        assert(Math.abs(left - frame.x) < 2 && Math.abs(top - frame.y) < 2 &&
            Math.abs(right + 18 - frame.x - frame.width) < 2 &&
            Math.abs(bottom + 18 - frame.y - frame.height) < 2,
        `Corners must match current frame, got ${left},${top},${right},${bottom}; frame=${JSON.stringify(frame)}`);
    };
    Main.wm.addKeybinding('focus-down', settings, Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL, () => navigator.startOrAdvance('down'));
    const pendingWindows = [];
    const terminalAction = global.display.grab_accelerator('<Super>Return', Meta.KeyBindingFlags.NONE);
    assert(terminalAction !== Meta.KeyBindingAction.NONE, 'Test Super+Enter shortcut must register');
    const terminalBinding = Meta.external_binding_name_for_action(terminalAction);
    Main.wm.allowKeybinding(terminalBinding, Shell.ActionMode.NORMAL);
    const acceleratorId = global.display.connect('accelerator-activated', (_display, action) => {
        if (action === terminalAction) {
            pendingWindows.push(Scripting.createTestWindow({ width: 400, height: 300 }));
        }
    });
    try {
        drawing.showFocusCorners({ x: NaN, y: 0, width: 800, height: 600 });
        assert(hidden(), 'Unallocated window coordinates must never reach corner layout');
        navigator.enable();
        assert(settings.get_uint('super-hold-threshold-ms') === 500, 'Default hold threshold must be 500 ms');
        await closeOverview();
        await key(Clutter.KEY_Super_L, true);
        await Scripting.sleep(500);
        assert(visible(), 'Long hold must keep corners visible');
        await key(Clutter.KEY_Super_L, false);
        await Scripting.sleep(300);
        assert(!Main.overview.visible && hidden(), 'Long Super release must hide corners without opening overview');
        await key(Clutter.KEY_Super_L, true);
        await key(Clutter.KEY_Super_L, false);
        await Scripting.sleep(400);
        assert(Main.overview.visible, 'Short Super tap after a long hold must still open overview');
        await closeOverview();
        // Deliver overlay-key later than the modifier release and its idle work.
        navigator._primaryModifierHeld = true;
        navigator._trackSuperHold();
        await Scripting.sleep(600);
        global.display.emit('overlay-key');
        await Scripting.sleep(100);
        assert(navigator._overlayKeyBlocked, 'An overlay event while Super remains held must not lift suppression');
        navigator._primaryModifierHeld = false;
        navigator._trackSuperHold();
        await Scripting.sleep(150);
        assert(navigator._overlayKeyBlocked, 'Long-release suppression must survive until overlay-key arrives');
        global.display.emit('overlay-key');
        await Scripting.sleep(100);
        assert(!Main.overview.visible, 'A delayed overlay-key from a long press must be suppressed');
        assert(!navigator._overlayKeyBlocked, 'Consumed overlay-key must release the temporary block');
        settings.set_uint('super-hold-threshold-ms', 80);
        await key(Clutter.KEY_Super_L, true);
        await key(Clutter.KEY_Super_L, false);
        await Scripting.sleep(300);
        assert(!Main.overview.visible, 'Changed hold threshold must apply to the next press');
        settings.reset('super-hold-threshold-ms');

        for (const symbol of [Clutter.KEY_Super_L, Clutter.KEY_Super_R]) {
            Main.overview.hide();
            await Scripting.sleep(400);
            await key(symbol, true);
            console.log(`[NAV TEST] Super held: pointer mask=${global.get_pointer()[2]}`);
            assert(visible(), 'Super press must map all four focus corners before h/j/k/l');
            assert(!navigator.isSessionActive(), 'Preview must not acquire a modal grab');
            await key(symbol, false);
            assert(hidden(), 'Super release must hide all focus corners');
        }

        await closeOverview();
        await key(Clutter.KEY_Super_L, true);
        await key(Clutter.KEY_j, true);
        await key(Clutter.KEY_j, false);
        assert(navigator.isSessionActive(), 'Navigation must start a session');
        await key(Clutter.KEY_Super_R, true);
        await key(Clutter.KEY_Super_L, false);
        console.log(`[NAV TEST] dual Super: mask=${global.get_pointer()[2]} session=${navigator.isSessionActive()} visible=${visible()} mode=${Main.actionMode}`);
        assert(navigator.isSessionActive() && visible(), 'Holding the other Super must keep navigation active');
        await key(Clutter.KEY_Super_R, false);
        assert(!navigator.isSessionActive() && hidden(), 'Last Super release must end navigation and hide corners');

        await closeOverview();
        await key(Clutter.KEY_Super_L, true);
        for (let index = 0; index < 3; index++) {
            await key(Clutter.KEY_Return, true);
            await key(Clutter.KEY_Return, false);
        }
        assert(pendingWindows.length === 3, 'Super+Enter must reach all three accelerator activations');
        await Promise.all(pendingWindows);
        await Scripting.waitTestWindows();
        await Scripting.sleep(300);
        const created = global.display.list_all_windows().filter(candidate =>
            !existingWindows.has(candidate) && candidate !== window);
        assert(created.length === 3, 'Repeated Super+Enter must create three windows');
        testWindows.push(...created);
        for (const [index, candidate] of created.entries()) {
            candidate.activate(global.get_current_time());
            await Scripting.sleep(100);
            // Simulate stale layout targets and a later compositor resize/move.
            ComputedLayouts.set(candidate, { x: 1, y: 1, width: 20, height: 20 });
            candidate.move_resize_frame(false, 70 + index * 80, 80 + index * 50, 450, 330);
            await Scripting.sleep(200);
            checkFrame(candidate);
            const actor = candidate.get_compositor_private();
            const frame = candidate.get_frame_rect();
            actor.translation_x = 60;
            actor.translation_y = 35;
            await Scripting.sleep(100);
            const [x, y] = drawing._focusCorners[0].get_transformed_position();
            assert(Math.abs(x - frame.x - 60) < 2 && Math.abs(y - frame.y - 35) < 2,
                'Corners must follow the actor during a tiling animation');
            actor.ease({ translation_x: 0, translation_y: 0, duration: 250,
                mode: Clutter.AnimationMode.LINEAR });
            await Scripting.sleep(350);
            checkFrame(candidate);
            ComputedLayouts.delete(candidate);
        }

        const startWindow = created[0];
        startWindow.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === startWindow),
            'Virtual navigation start window must have focus');
        const startRect = navigator._getVisualRect(startWindow);
        const expectedSelection = navigator._findDirectionalNeighbor(
            startWindow.get_workspace(),
            startWindow.get_monitor(),
            startWindow,
            startRect,
            'right'
        );
        assert(expectedSelection, 'Virtual navigation test needs a window to the right');
        navigator.startOrAdvance('right');
        await Scripting.sleep(100);
        assert(navigator._selectedWindow === expectedSelection.window,
            'Navigation must move the virtual selection');
        assert(global.display.focus_window === startWindow,
            'Navigation must not focus the selected window before Super release');

        const incidentalFocus = created.find(candidate =>
            candidate !== startWindow && candidate !== expectedSelection.window) ?? window;
        incidentalFocus.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === incidentalFocus),
            'Test must simulate an incidental Mutter focus change');
        assert(navigator._selectedWindow === expectedSelection.window,
            'Incidental focus changes must not overwrite the virtual selection');

        await key(Clutter.KEY_Super_L, false);
        assert(await waitFor(() => global.display.focus_window === expectedSelection.window),
            'Super release must commit focus to the virtual selection');
        assert(hidden(), 'Releasing after repeated launches must hide corners');
        await closeOverview();
        await key(Clutter.KEY_Super_L, true);
        assert(visible(), 'A new Super press must show corners again');
        navigator.disable();
        assert(hidden(), 'Disable must hide corners');
        await key(Clutter.KEY_Super_L, false);
        console.log('[NAV TEST] PASS: 500ms long hold, delayed overlay event, held modifier suppression, short tap, changed threshold, left/right Super, virtual navigation, release-to-focus, incidental focus isolation, dual Super, repeated Super+Enter, live geometry/animation, disable');
    } finally {
        Main.wm.removeKeybinding('focus-down');
        global.display.disconnect(acceleratorId);
        global.display.ungrab_accelerator(terminalAction);
        Main.wm.allowKeybinding(terminalBinding, Shell.ActionMode.NONE);
        settings.reset('super-hold-threshold-ms');
        for (const symbol of [...heldKeys])
            await key(symbol, false);
        navigator.disable();
        drawing.destroy();
        theme.unload_stylesheet(stylesheet);
        await Scripting.destroyTestWindows();
    }
}
