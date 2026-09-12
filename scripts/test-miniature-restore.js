export const requiresBinary = 'alacritty';
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

function miniatureOf(windows) {
    return windows.filter(window => WindowState.get(window, WindowState.IS_MINIATURE));
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
        const firstChild = launchAlacritty();
        children.push(firstChild);
        const first = await waitForChildWindow(firstChild);
        const workspace = first.get_workspace();
        const monitor = first.get_monitor();
        const workspaceCount = global.workspace_manager.get_n_workspaces();
        const secondChild = launchAlacritty();
        children.push(secondChild);
        const second = await waitForChildWindow(secondChild);
        const pair = [first, second];

        assert(second.get_workspace() === workspace && second.get_monitor() === monitor,
            'Two large windows must remain in one workspace for miniature recovery');
        assert(await waitFor(() => miniatureOf(pair).length === 1),
            'Exactly one of two large windows must become miniature');
        assert(global.workspace_manager.get_n_workspaces() === workspaceCount,
            'Two-window Smart Resize must not create an overflow workspace');

        let miniature = miniatureOf(pair)[0];
        let normal = pair.find(window => window !== miniature);
        console.log(`[MINIATURE RESTORE TEST] initial miniature=${miniature.get_id()} normal=${normal.get_id()}`);

        const assertMiniatureDoesNotReplaceNormalIntent = candidate => {
            const normalSlot = MosaicModel.normalSlotFor(candidate);
            const presentation = MosaicModel.presentationSlotFor(candidate);
            assert(normalSlot && presentation,
                'Miniature must retain both normal intent and presentation geometry');
            assert(normalSlot.width > presentation.width + 100 || normalSlot.height > presentation.height + 100,
                `Miniature presentation ${presentation.width}x${presentation.height} must not replace normal intent ${normalSlot.width}x${normalSlot.height}`);
            return {...normalSlot};
        };

        assertMiniatureDoesNotReplaceNormalIntent(miniature);

        const checkScene = () => {
            const small = pair.find(w => WindowState.get(w, WindowState.IS_MINIATURE));
            const main = pair.find(w => w !== small);
            assert(small && main, 'dynamic layout must retain one usable normal window');
            const size = ext.miniatureManager.getMiniatureSize(small);
            const slot = WindowState.get(small, WindowState.MINIATURE_TARGET_POS);
            const frame = main.get_frame_rect();
            const area = workspace.get_work_area_for_monitor(monitor);
            assert(Math.max(size.width, size.height) >= 127, 'dynamic miniature floor is 128px');
            assert(slot.x >= area.x - 2 && slot.y >= area.y - 2 &&
                slot.x + size.width <= area.x + area.width + 2 &&
                slot.y + size.height <= area.y + area.height + 2, 'miniature stays inside usable area');
            assert(frame.x + frame.width <= slot.x + 2 || slot.x + size.width <= frame.x + 2 ||
                frame.y + frame.height <= slot.y + 2 || slot.y + size.height <= frame.y + 2,
            'normal and miniature presentation must not overlap');
            assertMiniatureDoesNotReplaceNormalIntent(small);
        };
        await Scripting.sleep(700);
        checkScene();
        for (const reason of ['click', 'keyboard', 'dnd']) {
            miniature = miniatureOf(pair)[0];
            normal = pair.find(w => w !== miniature);
            assert(ext.miniatureManager.restoreMiniature(miniature, null, {reason}),
                `${reason} must restore the selected miniature`);
            assert(await waitFor(() => !WindowState.get(miniature, WindowState.IS_MINIATURE) &&
                WindowState.get(normal, WindowState.IS_MINIATURE)),
            'the current allocation must protect the requested window and miniaturize its sibling');
            await Scripting.sleep(700);
            assert(!ext.tilingManager._isSmartResizingBlocked, 'restoration must release its blocker');
            checkScene();
        }
        // A refused role restore must also release the focus handler's transient blocker.
        miniature = miniatureOf(pair)[0];
        const manager = ext.miniatureManager;
        const originalLayout = manager._maximizedLayout;
        manager._maximizedLayout = {applying: false, hasWindows: () => true, restore: () => false};
        try {
            miniature.activate(global.get_current_time());
            await Scripting.sleep(120);
            assert(!ext.tilingManager._isSmartResizingBlocked, 'refused focus restore must release blocker');
            assert(WindowState.get(miniature, WindowState.IS_MINIATURE), 'refused restore keeps its role');
        } finally { manager._maximizedLayout = originalLayout; }
        normal = pair.find(w => w !== miniature);
        normal.delete(global.get_current_time());
        assert(await waitFor(() => !WindowState.get(miniature, WindowState.IS_MINIATURE)),
            'closing the normal sibling must recover the remaining miniature');
        assert(await waitFor(() => !ext.windowHandler.isWorkspaceLocked(workspace) &&
            ext.windowHandler._locks.pendingCount === 0), 'close recovery must release every tile lock');
        console.log('[MINIATURE RESTORE TEST] PASS: dynamic sizes, explicit selection, refusal, close recovery and locks');
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
