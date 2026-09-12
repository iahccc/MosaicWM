// Regression for a miniature that auto-restores while dominant mode is released.
// The restored window must stay normal after its scale-up animation has completed.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as WindowState from '../extension/windowState.js';

const WAIT_MS = 8000;
const POST_RESTORE_GUARD_MS = 650;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function waitFor(predicate, timeoutMs = WAIT_MS) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (predicate()) return true;
        await Scripting.sleep(40);
    }
    return predicate();
}

function launchAlacritty() {
    return Gio.Subprocess.new(
        ['alacritty', '--config-file', '/dev/null', '-e', 'sleep', '60'],
        Gio.SubprocessFlags.NONE);
}

async function waitForChildWindow(child) {
    const pid = Number(child.get_identifier());
    let window = null;
    assert(await waitFor(() => {
        window = global.display.list_all_windows().find(candidate => candidate.get_pid() === pid) ?? null;
        return !!window;
    }), `Alacritty ${pid} must create a window`);
    assert(await waitFor(() =>
        !WindowState.get(window, 'arrivalPending') &&
        !WindowState.get(window, 'pendingInQueue')),
    `Alacritty ${pid} must finish admission`);
    return window;
}

function isMiniature(window) {
    return !!WindowState.get(window, WindowState.IS_MINIATURE);
}

async function focus(window) {
    window.activate(global.get_current_time());
    assert(await waitFor(() => global.display.focus_window === window),
        `Window ${window.get_id()} must receive focus`);
}

async function enterDominant(ext, window) {
    await focus(window);
    window.maximize();
    assert(await waitFor(() => ext.dominantManager.isActive(window) && window.is_maximized()),
        `Window ${window.get_id()} must enter Mosaic dominant state`);
}

async function leaveDominant(ext, window) {
    window.unmaximize();
    assert(await waitFor(() => !ext.dominantManager.isActive(window) && !window.is_maximized()),
        `Window ${window.get_id()} must leave Mosaic dominant state`);
    assert(await waitFor(() => !ext.dominantManager.isReleaseSettling(window)),
        `Window ${window.get_id()} dominant release must settle`);
}

async function assertStableNormal(window) {
    assert(await waitFor(() =>
        !isMiniature(window) &&
        !WindowState.get(window, WindowState.ANIMATING_MINIATURE) &&
        (() => {
            const actor = window.get_compositor_private();
            return !actor || (actor.scale_x > 0.95 && actor.scale_y > 0.95 && actor.opacity > 0);
        })()),
    `Auto-restored window ${window.get_id()} must visually finish its restore animation as normal`);

    const deadline = GLib.get_monotonic_time() + POST_RESTORE_GUARD_MS * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        const actor = window.get_compositor_private();
        assert(!isMiniature(window),
            `Auto-restored window ${window.get_id()} must not be miniaturized again after restore animation`);
        assert(!WindowState.get(window, WindowState.ANIMATING_MINIATURE),
            `Auto-restored window ${window.get_id()} must not start a second miniature animation`);
        assert(!actor || (actor.scale_x > 0.95 && actor.scale_y > 0.95 && actor.opacity > 0),
            `Auto-restored window ${window.get_id()} actor must remain visible at normal scale`);
        await Scripting.sleep(20);
    }
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
    await Scripting.sleep(800);

    const children = [];
    try {
        const windows = [];
        for (let i = 0; i < 3; i++) {
            const child = launchAlacritty();
            children.push(child);
            windows.push(await waitForChildWindow(child));
        }

        assert(await waitFor(() => windows.filter(isMiniature).length === 1),
            'Three large Alacritty windows must settle as two normal windows plus one miniature');
        const normalsBeforeDominant = windows.filter(window => !isMiniature(window));
        assert(normalsBeforeDominant.length === 2,
            'Three-window layout must keep two normal windows before dominant entry');
        const [dominant, forcedSibling] = normalsBeforeDominant;

        await enterDominant(ext, dominant);
        const miniatureBeforeRelease = windows.filter(window => window !== dominant && isMiniature(window));
        assert(miniatureBeforeRelease.length === 2 && isMiniature(forcedSibling),
            'Focused dominant must force the previously normal sibling into miniature state');

        await leaveDominant(ext, dominant);
        // Mutter does not deterministically transfer focus to the fresh forced miniature on
        // every run. Make the user intent explicit while its focus guard may still be armed;
        // this exercises the same deferred restore path as the production race.
        if (isMiniature(forcedSibling))
            forcedSibling.activate(global.get_current_time());
        assert(await waitFor(() => !isMiniature(forcedSibling)),
            'Focusing the forced miniature after dominant release must restore it');
        console.log(`[DOMINANT AUTO-RESTORE TEST] release + focus restored forced sibling ${forcedSibling.get_id()}`);
        await assertStableNormal(forcedSibling);

        console.log('[DOMINANT AUTO-RESTORE TEST] PASS: auto-restored sibling stays normal after its animation completes');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        for (const child of children) {
            try {
                child.force_exit();
            } catch {
                // Already exited.
            }
        }
    }
}
