// Run with --automation-script in a private headless GNOME Shell session.
// MOSAIC_TEST_EXTENSION_DIR must point to an extension copy with compiled schemas.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as WindowState from '../extension/windowState.js';

const WAIT_MS = 6000;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function waitFor(predicate, timeoutMs = WAIT_MS) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (predicate()) return true;
        await Scripting.sleep(50);
    }
    return predicate();
}

async function createWindow(width, height) {
    const before = new Set(global.display.list_all_windows());
    await Scripting.createTestWindow({width, height});
    await Scripting.waitTestWindows();

    let created = null;
    assert(await waitFor(() => {
        created = global.display.list_all_windows().find(window => !before.has(window)) ?? null;
        return !!created;
    }), `A ${width}x${height} test window must be created`);

    assert(await waitFor(() =>
        !WindowState.get(created, 'arrivalPending') &&
        !WindowState.get(created, 'pendingInQueue')),
    `Window ${created.get_id()} must finish admission`);
    return created;
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

    try {
        const returning = await createWindow(600, 420);
        const workspace = returning.get_workspace();
        const monitor = returning.get_monitor();

        returning.make_above();
        assert(await waitFor(() =>
            returning.is_above() &&
            ext.windowingManager.isExcluded(returning) &&
            WindowState.get(returning, 'previousExclusionState') === true),
        'Always-on-top window must enter the excluded role before re-inclusion');

        const firstSibling = await createWindow(600, 420);
        const secondSibling = await createWindow(600, 420);
        assert(firstSibling.get_workspace() === workspace && secondSibling.get_workspace() === workspace,
            'Scenario setup must keep siblings in the original workspace');

        const workspaceCount = global.workspace_manager.get_n_workspaces();
        const originalSmartResizeBlock = ext.tilingManager._isSmartResizingBlocked;
        ext.tilingManager._isSmartResizingBlocked = true;
        try {
            returning.unmake_above();
            assert(await waitFor(() =>
                !returning.is_above() &&
                !ext.windowingManager.isExcluded(returning) &&
                WindowState.get(returning, 'previousExclusionState') === false),
            'Always-on-top window must re-enter Mosaic');
            await Scripting.sleep(400);
        } finally {
            ext.tilingManager._isSmartResizingBlocked = originalSmartResizeBlock;
        }

        assert(returning.get_workspace() === workspace && returning.get_monitor() === monitor,
            'Re-inclusion must preserve the existing window workspace and monitor');
        assert(firstSibling.get_workspace() === workspace && secondSibling.get_workspace() === workspace,
            'Re-inclusion must not exile existing siblings');
        assert(global.workspace_manager.get_n_workspaces() === workspaceCount,
            'Re-inclusion must not create an overflow workspace when Smart Resize is unavailable');
        assert(!WindowState.get(returning, 'movedByOverflow'),
            'Re-inclusion must never acquire overflow-migration ownership');

        console.log('[REINCLUDE TEST] PASS: excluded window re-enters locally without workspace migration');
    } finally {
        ext.tilingManager._isSmartResizingBlocked = false;
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        await Scripting.destroyTestWindows();
    }
}
