// Run with --automation-script in a private headless GNOME Shell session.
// MOSAIC_TEST_EXTENSION_DIR must point to an extension copy with compiled schemas.
// Alacritty must be in PATH.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as WindowState from '../extension/windowState.js';

const WAIT_MS = 8000;
const GEOMETRY_TOLERANCE = 8;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function assertMiniatureInUnifiedRail(ext, window, workspace, monitor) {
    const area = ext.tilingManager.getUsableWorkArea(workspace, monitor);
    const target = WindowState.get(window, WindowState.MINIATURE_TARGET_POS);
    const size = ext.miniatureManager.getMiniatureSize(window);
    assert(target && size, `Window ${window.get_id()} must expose miniature geometry`);
    assert(target.x + GEOMETRY_TOLERANCE >= area.x &&
        target.y + GEOMETRY_TOLERANCE >= area.y &&
        target.x + size.width <= area.x + area.width + GEOMETRY_TOLERANCE &&
        target.y + size.height <= area.y + area.height + GEOMETRY_TOLERANCE,
    `Born dominant miniature ${window.get_id()} must stay inside the unified rail work area`);
    assert(Math.abs(Math.max(size.width, size.height) - 128) <= GEOMETRY_TOLERANCE,
        'Previous dominant must use compact miniature size while the new dominant is focused');
}


async function waitFor(predicate, timeoutMs = WAIT_MS) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (predicate()) return true;
        await Scripting.sleep(50);
    }
    return predicate();
}

function launchAlacritty(startupMode) {
    return Gio.Subprocess.new([
        'alacritty', '--config-file', '/dev/null',
        '-o', `window.startup_mode="${startupMode}"`,
        '-e', 'sleep', '60',
    ], Gio.SubprocessFlags.NONE);
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
    `Alacritty ${pid} must finish dominant admission`);
    return window;
}

async function closeAndWait(child, window) {
    child.force_exit();
    assert(await waitFor(() => !global.display.list_all_windows().includes(window)),
        `Window ${window.get_id()} must close`);
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
    await Scripting.sleep(800);

    const children = [];
    try {
        const firstChild = launchAlacritty('Maximized');
        children.push(firstChild);
        const first = await waitForChildWindow(firstChild);
        const workspace = first.get_workspace();
        const monitor = first.get_monitor();

        assert(await waitFor(() => ext.dominantManager.isActive(first) && first.is_maximized()),
            'Born-maximized Alacritty must become Mosaic dominant without mutating native maximize');
        assert(first.get_workspace() === workspace,
            'Born-maximized admission must stay on its original workspace');
        console.log('[BORN DOMINANT TEST] first born-maximized window became in-workspace dominant');

        const secondChild = launchAlacritty('Maximized');
        children.push(secondChild);
        const second = await waitForChildWindow(secondChild);
        assert(await waitFor(() =>
            ext.dominantManager.isActive(second) &&
            second.is_maximized() &&
            WindowState.get(first, WindowState.IS_MINIATURE)),
        'Second born-maximized window must keep native maximize while taking dominance and miniaturizing the previous dominant');
        assert(second.get_workspace() === workspace && second.get_monitor() === monitor,
            'Second born-maximized window must not be isolated to another workspace');
        assertMiniatureInUnifiedRail(ext, first, workspace, monitor);
        console.log('[BORN DOMINANT TEST] second born-maximized window won latest intent');

        const workspaceCountBeforeFullscreen = global.workspace_manager.get_n_workspaces();
        const thirdChild = launchAlacritty('Fullscreen');
        children.push(thirdChild);
        const third = await waitForChildWindow(thirdChild);
        assert(await waitFor(() => third.is_fullscreen()),
            'Born-fullscreen Alacritty must remain natively fullscreen');
        assert(!ext.dominantManager.isActive(third) && !ext.dominantManager.hasIntentForWindow(third),
            'Born-fullscreen window must never enter the dominant stack');
        assert(ext.dominantManager.isActive(second),
            'Existing maximized dominant intent must remain active underneath unrelated fullscreen');
        assert(!WindowState.get(second, WindowState.IS_MINIATURE),
            'Born fullscreen must not miniaturize the existing active dominant');
        assert(third.get_workspace() === workspace && third.get_monitor() === monitor,
            'Born-fullscreen window must stay on the same workspace and monitor');
        assert(global.workspace_manager.get_n_workspaces() === workspaceCountBeforeFullscreen,
            'Born fullscreen must not create an overflow workspace');
        console.log('[BORN DOMINANT TEST] born-fullscreen stays native and outside the dominant stack');

        await closeAndWait(thirdChild, third);
        assert(await waitFor(() =>
            ext.dominantManager.isActive(second) &&
            !WindowState.get(second, WindowState.IS_MINIATURE)),
        'Closing born-fullscreen must leave the previous maximize-derived dominant untouched');
        console.log('[BORN DOMINANT TEST] closing fullscreen leaves maximized dominant unchanged');

        await closeAndWait(secondChild, second);
        assert(await waitFor(() =>
            ext.dominantManager.isActive(first) &&
            !WindowState.get(first, WindowState.IS_MINIATURE)),
        'Closing second dominant must restore the first dominant intent');
        console.log('[BORN DOMINANT TEST] stack restored first born-maximized dominant');

        console.log('[BORN DOMINANT TEST] PASS: born maximize stack and independent native fullscreen stay in workspace');
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
