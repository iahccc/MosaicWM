// Real key events in a private GNOME Shell session; no user settings or windows are used.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {KeyboardNavigatorManager} from '../extension/keyboardNavigator.js';
import {MiniatureManager} from '../extension/miniature.js';
import * as WindowState from '../extension/windowState.js';

function assert(value, message) {
    if (!value) throw new Error(message);
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
    new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'}).set_string('focus-mode', 'click');
    new Gio.Settings({schema_id: 'org.gnome.mutter'}).set_boolean('dynamic-workspaces', false);
    new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'}).set_int('num-workspaces', 2);
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 'Overview must close');
    const existing = new Set(global.display.list_all_windows());
    for (let i = 0; i < 5; i++) await Scripting.createTestWindow({width: 320, height: 160});
    await Scripting.waitTestWindows();
    const windows = global.display.list_all_windows().filter(window => !existing.has(window));
    assert(windows.length === 5, 'Five windows are required for spatial assignment');
    const [anchor, left, right, up, mini] = windows;
    const workspace = anchor.get_workspace();
    const area = workspace.get_work_area_for_monitor(anchor.get_monitor());
    const midX = area.x + area.width / 2 - 160;
    const midY = area.y + area.height / 2 - 80;
    const positions = [[midX, midY], [area.x + 20, midY], [area.x + area.width - 340, midY],
        [midX, area.y + 10], [midX, area.y + area.height - 170]];
    // GTK's first configure can arrive after the windows map. Retry until the actual
    // frames, rather than the requested rectangles, form the cross used by this test.
    await waitFor(() => windows.every((window, i) => {
        const frame = window.get_frame_rect();
        const settled = Math.abs(frame.x - positions[i][0]) < 2 && Math.abs(frame.y - positions[i][1]) < 2 &&
            Math.abs(frame.width - 320) < 2 && Math.abs(frame.height - 160) < 2;
        if (!settled) window.move_resize_frame(false, ...positions[i], 320, 160);
        return settled;
    }), 'Window frames must settle into the intended cross');
    await Scripting.sleep(300);

    const stylesheet = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
        .get_child('extension').get_child('stylesheet.css');
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.load_stylesheet(stylesheet);
    const minis = new MiniatureManager();
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.mosaic-wm'});
    const wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
    wmSettings.set_strv('close', ['<Super>q']);
    wmSettings.set_strv('minimize', ['<Super>h']);
    const navigator = new KeyboardNavigatorManager({miniatureManager: minis,
        getSettings: () => settings,
        windowingManager: {
            isNavigable: window => windows.includes(window) && !!window.get_compositor_private() && !window.minimized,
            getMonitorWorkspaceWindows: (ws, monitor) => windows.filter(window =>
                window.get_workspace() === ws && window.get_monitor() === monitor),
        }});
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const held = new Set();
    const key = async (symbol, down) => {
        if (down) held.add(symbol);
        else held.delete(symbol);
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol,
            down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
        await Scripting.sleep(35);
    };
    const tap = async symbol => { await key(symbol, true); await key(symbol, false); };
    const focusAnchor = async () => {
        anchor.activate(global.get_current_time());
        await waitFor(() => global.display.focus_window === anchor, 'Anchor must have focus');
    };
    const hold = async () => {
        await focusAnchor();
        await key(Clutter.KEY_Super_L, true);
        await waitFor(() => navigator._hintOverlay !== null, 'Long Super must show hints');
    };
    const hintFor = window => [...navigator._hintTargets].find(([, item]) => item.window === window)?.[0];
    const choose = async window => {
        const hint = hintFor(window);
        assert(hint, 'Every window must have a free navigation hint');
        for (const letter of hint) await tap(Clutter[`KEY_${letter}`]);
    };
    const shortcutActions = ['<Super>u', '<Super><Shift>Return', '<Super>j'].map(accelerator => {
        const action = global.display.grab_accelerator(accelerator, Meta.KeyBindingFlags.NONE);
        assert(action !== Meta.KeyBindingAction.NONE, `Test shortcut ${accelerator} must register`);
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NORMAL);
        return action;
    });
    const shortcutHits = shortcutActions.map(() => 0);
    const shortcutId = global.display.connect('accelerator-activated', (_display, action) => {
        const index = shortcutActions.indexOf(action);
        if (index >= 0) shortcutHits[index]++;
    });
    const destroyId = global.window_manager.connect('destroy', (_wm, actor) => {
        const id = actor.meta_window.get_id();
        const index = windows.findIndex(window => window.get_id() === id);
        if (index >= 0) windows.splice(index, 1);
        navigator.onWindowDestroyed(id);
    });
    try {
        navigator.enable();
        const pre = mini.get_frame_rect();
        const scale = 128 / Math.max(pre.width, pre.height);
        const miniSlot = {x: midX, y: area.y + area.height - pre.height * scale - 10,
            width: pre.width * scale, height: pre.height * scale};
        minis.createMiniature(mini, miniSlot, pre, {animate: false});
        const miniOverlay = WindowState.get(mini, WindowState.MINIATURE_OVERLAY);
        await waitFor(() => miniOverlay._icon?.opacity === 255 && miniOverlay._icon.has_allocation() &&
            miniOverlay._icon.width > 0, 'The original miniature icon must be visible and allocated');
        const centerOfActor = actor => {
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            return [x + width / 2, y + height / 2];
        };
        const iconCenter = centerOfActor(miniOverlay._icon);
        await focusAnchor();
        await tap(Clutter.KEY_Super_L);
        await waitFor(() => Main.overview.visible, 'A short Super tap must still open Overview');
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 'Overview must close before selection');
        const availableKeys = navigator._getAvailableHintKeys();
        assert(['q', 'h', 'j', 'u'].every(letter => !availableKeys.includes(letter)),
            'Native and user shortcuts must be excluded, including directional letters');
        const iconOpacities = [];
        miniOverlay._icon.connect('notify::opacity', icon => iconOpacities.push(icon.opacity));
        const stageFocus = global.stage.get_key_focus();
        await hold();
        assert(Main.modalCount === 0 && global.stage.get_key_focus() === stageFocus,
            'Showing hints must not grab the keyboard or steal its focus');
        assert(settings.get_strv('mosaic-window-hints').length === 0,
            'Temporary hint bindings must not change stored preferences');
        const id = letter => navigator._hintTargets.get(letter)?.window;
        for (const [letter, window] of [['h', left], ['l', right], ['k', up], ['j', mini]]) {
            if (availableKeys.includes(letter))
                assert(id(letter) === window, `Free direction ${letter} must select its spatial neighbor`);
            else
                assert(!navigator._hintTargets.has(letter), `Occupied direction ${letter} must not become a hint`);
        }
        assert([...navigator._hintTargets.keys()].every(hint => [...hint].every(letter => availableKeys.includes(letter))),
            'Every letter in every hint must be available');
        assert(id('i') === anchor && !navigator._hintTargets.has('u') && !navigator._hintTargets.has('q'),
            'Fallback hints must skip occupied shortcuts and start with an available right-hand letter');
        await tap(Clutter.KEY_i);
        assert(navigator._selectedWindow === anchor, 'The right-hand fallback letter must select its window');
        const mapping = [...navigator._hintTargets].map(([letter, item]) => [letter, item.id]);
        const miniLabel = navigator._hintOverlay._labels.get(hintFor(mini)).label;
        await waitFor(() => miniLabel.is_mapped() && miniLabel.width > 0, 'The miniature letter must be mapped and allocated');
        const hintCenter = centerOfActor(miniLabel);
        assert(hintCenter.every((value, i) => Math.abs(value - iconCenter[i]) < 2),
            `The miniature letter must occupy the original application icon position: hint=${hintCenter}, icon=${iconCenter}, currentIcon=${centerOfActor(miniOverlay._icon)}, overlay=${centerOfActor(miniOverlay)}`);
        assert(miniOverlay._icon.opacity === 255, 'The original icon must remain visible under the letter');
        miniOverlay.showIcon(0);
        assert(miniOverlay._icon.opacity === 255, 'Icon refreshes must preserve its visibility under the letter');
        await choose(right);
        assert(navigator._selectedWindow === right && global.display.focus_window === anchor,
            `A letter previews without activating its target: selected=${navigator._selectedWindow?.get_id()}, right=${right.get_id()}, focus=${global.display.focus_window?.get_id()}, anchor=${anchor.get_id()}, mode=${Main.actionMode}, hints=${!!navigator._hintOverlay}`);
        await choose(left);
        assert(navigator._selectedWindow === left, 'Fallback selection must stay relative to the original anchor');
        await choose(right);
        assert(navigator._selectedWindow === right, 'Releasing a letter must allow selecting it again');
        assert(JSON.stringify([...navigator._hintTargets].map(([letter, item]) => [letter, item.id])) === JSON.stringify(mapping),
            'The session must preserve its mapping');
        await choose(mini);
        await waitFor(() => miniOverlay._titleLabel?.visible, 'Selecting the 128px miniature must reveal its title');
        assert(WindowState.get(mini, WindowState.IS_MINIATURE) && global.display.focus_window === anchor,
            'Title confirmation must not restore the miniature prematurely');
        assert(shortcutHits[2] === 0, 'Selecting hints must not invoke occupied direction shortcuts');
        const screenshot = GLib.getenv('MOSAIC_HINTS_SCREENSHOT');
        if (screenshot) {
            const stream = Gio.File.new_for_path(screenshot).replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new Shell.Screenshot().screenshot(false, stream);
            stream.close(null);
        }
        await tap(Clutter.KEY_Escape);
        assert(miniOverlay._icon.opacity === 255 && !miniOverlay._titleLabel?.visible &&
            WindowState.get(mini, WindowState.IS_MINIATURE),
        'Cancel must keep the icon visible and dismiss the title without restoring the miniature');
        assert(iconOpacities.every(opacity => opacity === 255),
            'Entering, selecting and canceling hints must never hide or fade the icon');
        await key(Clutter.KEY_Super_L, false);
        await hold();
        await choose(mini);
        await key(Clutter.KEY_Super_L, false);
        await waitFor(() => !navigator.isSessionActive() && global.display.focus_window === mini,
            'Super release must restore and focus the selected miniature');
        assert(!WindowState.get(mini, WindowState.IS_MINIATURE) && !navigator._hintOverlay && !minis._navigationActive,
            'Confirmation must clean up hints and miniature preview');

        await hold();
        await choose(right);
        await tap(Clutter.KEY_Escape);
        assert(!navigator._hintOverlay && global.display.focus_window === anchor,
            'Escape must cancel selection again after an earlier canceled session');
        await key(Clutter.KEY_Super_L, false);
        assert(!Main.overview.visible, 'Cancel must not fall through to Overview');
        await hold();
        await key(Clutter.KEY_Super_L, false);
        assert(global.display.focus_window === anchor, 'Releasing without a choice keeps focus');

        await hold();
        await key(Clutter.KEY_Super_R, true);
        await choose(right);
        await key(Clutter.KEY_Super_L, false);
        assert(navigator._hintOverlay && navigator._selectedWindow === right,
            'Holding the other Super keeps the selection open');
        await key(Clutter.KEY_Super_R, false);
        await waitFor(() => global.display.focus_window === right, 'The last Super release confirms');

        await hold();
        await choose(right);
        await tap(Clutter.KEY_j);
        await waitFor(() => shortcutHits[2] === 1 && !navigator._hintOverlay,
            'An occupied direction letter must run its user shortcut instead of navigating');
        assert(!navigator._selectedWindow && global.display.focus_window === anchor,
            'A direction shortcut conflict must cancel the preview without focusing its target');
        await key(Clutter.KEY_Super_L, false);

        await hold();
        await choose(right);
        await tap(Clutter.KEY_h);
        await waitFor(() => anchor.minimized && !navigator._hintOverlay,
            'The native Super+H minimize shortcut must win over direction navigation');
        assert(!navigator._selectedWindow, 'Native minimize must discard the pending selection');
        await key(Clutter.KEY_Super_L, false);
        anchor.unminimize();
        await focusAnchor();
        await Scripting.sleep(300);

        await hold();
        await choose(right);
        await tap(Clutter.KEY_u);
        await waitFor(() => shortcutHits[0] === 1 && !navigator._hintOverlay,
            'An existing Super shortcut must run after hints appear');
        assert(!navigator._selectedWindow && global.display.focus_window === anchor,
            'An existing shortcut must cancel the preview without committing it');
        await Scripting.sleep(300);
        assert(!navigator._hintOverlay, 'A shortcut must not reopen hints during the same Super hold');
        await key(Clutter.KEY_Super_L, false);
        assert(global.display.focus_window === anchor, 'Releasing Super after a shortcut must not commit stale selection');

        await hold();
        await choose(right);
        await key(Clutter.KEY_Shift_L, true);
        await tap(Clutter.KEY_Return);
        await waitFor(() => shortcutHits[1] === 1 && !navigator._hintOverlay,
            'Super+Shift shortcuts must remain usable after hints appear');
        await key(Clutter.KEY_Shift_L, false);
        await key(Clutter.KEY_Super_L, false);
        assert(global.display.focus_window === anchor, 'A modified shortcut must not accept the previous selection');

        if (global.display.get_n_monitors() > 1) {
            const origin = left.get_monitor();
            const destination = origin === 0 ? 1 : 0;
            const frame = left.get_frame_rect();
            const saved = {x: frame.x, y: frame.y, width: frame.width, height: frame.height};
            left.move_to_monitor(destination);
            await waitFor(() => left.get_monitor() === destination, 'A target must move to the second monitor');
            await Scripting.sleep(300);
            await hold();
            const hint = [...navigator._hintTargets].find(([, item]) => item.window === left)?.[0];
            assert(hint, 'Hints must cover other monitors on the active workspace');
            const label = navigator._hintOverlay._labels.get(hint).label;
            await waitFor(() => label.is_mapped(), 'The other monitor hint must be visible');
            const bounds = Main.layoutManager.monitors[destination];
            const [x, y] = label.get_transformed_position();
            assert(x >= bounds.x && y >= bounds.y && x + label.width <= bounds.x + bounds.width &&
                y + label.height <= bounds.y + bounds.height, 'A hint must stay on its target monitor');
            for (const letter of hint) await tap(Clutter[`KEY_${letter}`]);
            assert(navigator._selectedWindow === left, 'A letter must preview the other monitor target');
            await key(Clutter.KEY_Super_L, false);
            await waitFor(() => global.display.focus_window === left, 'Release must focus the other monitor target');
            left.move_to_monitor(origin);
            left.move_resize_frame(false, saved.x, saved.y, saved.width, saved.height);
            await Scripting.sleep(350);
        }

        await hold();
        await choose(right);
        const dialog = new St.Widget({reactive: true, can_focus: true});
        Main.layoutManager.addChrome(dialog);
        const dialogGrab = Main.pushModal(dialog);
        try {
            await waitFor(() => !navigator._hintOverlay, 'A new modal must cancel hints');
            assert(global.display.focus_window === anchor, 'A new modal must not commit the preview');
        } finally {
            Main.popModal(dialogGrab);
            dialog.destroy();
        }
        await key(Clutter.KEY_Super_L, false);
        await hold();
        global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time());
        await waitFor(() => !navigator._hintOverlay, 'Changing workspace must cancel hints');
        await key(Clutter.KEY_Super_L, false);
        workspace.activate(global.get_current_time());
        await Scripting.sleep(400);

        await focusAnchor();
        await key(Clutter.KEY_Super_L, true);
        await tap(Clutter.KEY_j);
        assert(!navigator.isSessionActive() && global.display.focus_window === anchor,
            'A quick Super+J must not start the removed directional navigation');
        assert(shortcutHits[2] === 2, 'The original J shortcut must still work after hints close');
        await key(Clutter.KEY_Super_L, false);
        await Scripting.sleep(550);
        assert(!navigator._hintOverlay && global.display.focus_window === anchor,
            'A completed quick chord must leave no delayed selection');
        await hold();
        await choose(right);
        const unchanged = [...navigator._hintTargets].filter(([, item]) => item.window !== right);
        right.delete(global.get_current_time());
        await waitFor(() => ![...navigator._hintTargets.values()].some(item => item.window === right),
            'Closing a hinted window must remove its label');
        assert(navigator._selectedWindow === null, 'A disappearing selection must not pick an unrelated replacement');
        assert(unchanged.every(([letter, item]) => navigator._hintTargets.get(letter) === item),
            'Closing a window must not reassign surviving letters');
        await key(Clutter.KEY_Super_L, false);
        assert(global.display.focus_window === anchor, 'A closed selection must not steal focus');
        await hold();
        navigator.disable();
        assert(!navigator._hintOverlay && !navigator._hintBindingActive && !navigator._keybindingFilterId &&
            !minis._navigationActive && Main.actionMode === Shell.ActionMode.NORMAL,
        'Disabling must remove temporary keybindings and every preview');
        await key(Clutter.KEY_Super_L, false);
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible && Main.actionMode === Shell.ActionMode.NORMAL,
            'The normal Super shortcut must settle after disabling before the next case');
        navigator.enable();
        await hold();
        await choose(left);
        let sessionAtClose = null;
        anchor.connect('unmanaged', () => { sessionAtClose = navigator.isSessionActive(); });
        await tap(Clutter.KEY_q);
        await waitFor(() => !anchor.get_compositor_private(),
            'The native close-window shortcut must close the focused window after hints appear');
        assert(sessionAtClose === false && !navigator._hintOverlay && !navigator._selectedWindow,
            'Native shortcuts must cancel navigation before closing the window');
        await key(Clutter.KEY_Super_L, false);
        console.log('[WINDOW HINT TEST] PASS: short tap, available direction priority, native/user direction conflicts, reserved shortcut letters, normal/modified shortcuts, native close, stable letters, centered letters over persistent icons, title preview, release commit, Escape, dual Super, modal/workspace cancellation, quick chords, closed targets and teardown');
    } finally {
        for (const symbol of [...held]) await key(symbol, false);
        navigator.disable();
        global.display.disconnect(shortcutId);
        for (const action of shortcutActions) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE);
        }
        wmSettings.reset('close');
        wmSettings.reset('minimize');
        global.window_manager.disconnect(destroyId);
        minis.restoreAllMiniatures();
        minis.destroy();
        theme.unload_stylesheet(stylesheet);
        await Scripting.destroyTestWindows();
    }
}
