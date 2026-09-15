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

        const waitForNormalIntent = async (candidate, intent, label) => {
            assert(await waitFor(() => {
                const frame = candidate.get_frame_rect();
                return Math.abs(frame.width - intent.width) <= 2 &&
                    Math.abs(frame.height - intent.height) <= 2;
            }), `${label} must restore the normal frame ${intent.width}x${intent.height}, not the miniature presentation`);
        };

        assertMiniatureDoesNotReplaceNormalIntent(miniature);

        // The rail is part of the same visual cluster as the normal mosaic. It must stay one
        // configured spacing away without being pinned to the screen edge, and the combined
        // normal+miniature cluster must stay centered in the work area. The side itself is a
        // packing decision (left/right/bottom), so the assertion is side-agnostic.
        assert(await waitFor(() => {
            const target = WindowState.get(miniature, WindowState.MINIATURE_TARGET_POS);
            const size = ext.miniatureManager.getMiniatureSize(miniature);
            if (!target || !size || WindowState.get(miniature, WindowState.ANIMATING_MINIATURE))
                return false;
            const frame = normal.get_frame_rect();
            const horizontalGap = Math.max(frame.x, target.x) -
                Math.min(frame.x + frame.width, target.x + size.width);
            const workArea = workspace.get_work_area_for_monitor(monitor);
            const clusterLeft = Math.min(frame.x, target.x);
            const clusterRight = Math.max(frame.x + frame.width, target.x + size.width);
            const clusterCenter = (clusterLeft + clusterRight) / 2;
            const workCenter = workArea.x + workArea.width / 2;
            return Math.abs(horizontalGap - constants.WINDOW_SPACING) <= 2 &&
                Math.abs(clusterCenter - workCenter) <= 4;
        }), 'The miniature rail must stay one spacing from the normal window while both remain centered as one cluster');
        console.log('[MINIATURE RESTORE TEST] normal mosaic and miniature rail form one centered cluster');

        // Regression: focus-triggered restore used to set a global Smart Resize blocker before
        // asking the gate. A rejected gate emitted no restored signal, so that blocker leaked
        // forever and all later miniature focus restores stopped responding.
        normal.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === normal),
            'Normal sibling must be focused before rejected-focus regression');
        ext.miniatureManager.setRestoreGate(() => false);
        miniature.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === miniature),
            'Miniature must receive focus for rejected restore regression');
        await Scripting.sleep(100);
        assert(WindowState.get(miniature, WindowState.IS_MINIATURE),
            'Rejected focus restore must leave the window miniature');
        assert(!ext.tilingManager._isSmartResizingBlocked,
            'Rejected focus restore must not leak the global Smart Resize blocker');
        assert(!WindowState.get(miniature, 'restoringFromMiniature'),
            'Rejected focus restore must clean its per-window restoring state');
        ext.miniatureManager.setRestoreGate((window, options) =>
            ext.tilingManager.maximizedLayout.restore(window, options));
        console.log('[MINIATURE RESTORE TEST] rejected focus restore leaves no blocker state');

        // Explicit restore is user intent: if both windows fit after Smart Resize, protect the
        // selected miniature and let the other large window become the miniature instead.
        normal.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === normal),
            'Normal sibling must regain focus before explicit restore');
        const firstRestoreIntent = assertMiniatureDoesNotReplaceNormalIntent(miniature);
        assert(ext.miniatureManager.restoreMiniature(miniature, null, { reason: 'click' }),
            'Explicit restore of one of two large windows must be accepted');
        assert(await waitFor(() =>
            !WindowState.get(miniature, WindowState.IS_MINIATURE) &&
            WindowState.get(normal, WindowState.IS_MINIATURE)),
        'Explicit restore must swap which large window is miniature');
        assert(miniature.get_workspace() === workspace && normal.get_workspace() === workspace,
            'Explicit miniature swap must stay in the original workspace');
        assert(!ext.tilingManager._isSmartResizingBlocked,
            'Successful restore must leave Smart Resize unblocked');
        await waitForNormalIntent(miniature, firstRestoreIntent, 'First explicit miniature swap');
        console.log('[MINIATURE RESTORE TEST] explicit restore swaps the miniature in-place');

        const oldMiniature = miniature;
        miniature = normal;
        normal = oldMiniature;
        const secondRestoreIntent = assertMiniatureDoesNotReplaceNormalIntent(miniature);
        assert(ext.miniatureManager.restoreMiniature(miniature, null, { reason: 'keyboard' }),
            'Keyboard-style explicit restore must also be accepted');
        assert(await waitFor(() =>
            !WindowState.get(miniature, WindowState.IS_MINIATURE) &&
            WindowState.get(normal, WindowState.IS_MINIATURE)),
        'Repeated explicit restore must remain reversible');
        await waitForNormalIntent(miniature, secondRestoreIntent, 'Repeated explicit miniature swap');

        // QQ/WeChat-like minimums: both normal frames cannot coexist, but either normal
        // frame plus the other window's miniature fits. Alacritty's native minimum is too
        // small to exercise this admission failure, so seed the learned client constraints.
        for (const window of pair) {
            WindowState.set(window, 'actualMinWidth', 800);
            WindowState.set(window, 'actualMinHeight', 600);
        }
        const workArea = ext.tilingManager.getUsableWorkArea(workspace, monitor);
        assert(workArea.width < 1600 && workArea.height < 1200,
            'Large minimum frames must not coexist in the test work area');

        for (let attempt = 0; attempt < 2; attempt++) {
            miniature = miniatureOf(pair)[0];
            normal = pair.find(window => window !== miniature);
            assert(await waitFor(() => pair.every(window =>
                !WindowState.get(window, WindowState.ANIMATING_MINIATURE))),
            'Previous miniature swap must settle before the next click');
            const normalFrame = normal.get_frame_rect();

            for (const reason of ['auto', 'hover']) {
                assert(!ext.miniatureManager.restoreMiniature(miniature, null, {reason}),
                    `${reason} must not sacrifice the normal sibling to restore a miniature`);
            }
            assert(!ext.tilingManager.canRestoreMiniature(miniature, pair,
                {...workArea, width: 500, height: 400}),
            'Explicit restore must still reject a layout where even the selected minimum cannot fit');

            WindowState.set(normal, 'arrivalPending', true);
            try {
                assert(!ext.tilingManager.canRestoreMiniature(miniature, pair, workArea),
                    'An arriving sibling must not be sacrificed by the restore probe');
            } finally {
                WindowState.remove(normal, 'arrivalPending');
            }

            assert(ext.tilingManager.canRestoreMiniature(miniature, pair, workArea),
                'Explicit restore must consider miniaturizing a sibling when minimums cannot coexist');
            assert(WindowState.get(miniature, WindowState.IS_MINIATURE) &&
                !WindowState.get(normal, WindowState.IS_MINIATURE) &&
                !WindowState.get(normal, WindowState.PENDING_MINIATURE) &&
                !WindowState.get(normal, 'targetSmartResizeSize') &&
                ['x', 'y', 'width', 'height'].every(key => normal.get_frame_rect()[key] === normalFrame[key]),
            'Admission probing must not change live miniature state or normal geometry');

            assert(ext.miniatureManager.restoreMiniature(miniature, null, {reason: 'click'}),
                'Click must restore a large-minimum miniature without bypassing the gate');
            assert(await waitFor(() =>
                !WindowState.get(miniature, WindowState.IS_MINIATURE) &&
                WindowState.get(normal, WindowState.IS_MINIATURE) &&
                global.display.focus_window === miniature &&
                !WindowState.get(miniature, WindowState.ANIMATING_MINIATURE)),
            'Click must swap the large-minimum windows and focus the selected window');
            assert(pair.every(window => window.get_workspace() === workspace &&
                window.get_monitor() === monitor),
            'Large-minimum swaps must keep both windows on their original workspace and monitor');
        }
        console.log('[MINIATURE RESTORE TEST] large-minimum click swaps are reversible; passive and impossible restores stay rejected');

        // Move the normal window away and back, as with moving QQ beside WeChat. Its
        // durable constrained flag survives the move, but the destination needs fresh admission.
        const moving = pair.find(window => !WindowState.get(window, WindowState.IS_MINIATURE));
        const resident = pair.find(window => window !== moving);
        const preferredBeforeMove = {...ext.tilingManager.getPreferredSize(moving)};
        assert(WindowState.get(moving, 'isConstrainedByMosaic'),
            'Workspace move regression requires a previously constrained normal window');
        const spare = global.workspace_manager.append_new_workspace(false, global.get_current_time());
        moving.change_workspace(spare);
        assert(await waitFor(() => moving.get_workspace() === spare &&
            !WindowState.get(moving, 'arrivalPending') &&
            !WindowState.get(moving, 'pendingInQueue') &&
            !WindowState.get(resident, WindowState.IS_MINIATURE)),
        'Moving the normal window out must finish admission and restore the resident');

        // Keep native focus on the resident: admission must protect the arriving window
        // even when Mutter has not yet focused it, instead of sending it straight to the rail.
        workspace.activate(global.get_current_time());
        resident.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === resident),
            'Resident must own native focus before the constrained window moves back');
        moving.change_workspace(workspace);
        assert(await waitFor(() => moving.get_workspace() === workspace &&
            !WindowState.get(moving, 'arrivalPending') &&
            !WindowState.get(moving, 'pendingInQueue') &&
            !WindowState.get(moving, WindowState.IS_MINIATURE) &&
            WindowState.get(resident, WindowState.IS_MINIATURE)),
        'Cross-workspace admission must keep the arriving constrained window normal and miniaturize its sibling');
        const preferredAfterMove = ext.tilingManager.getPreferredSize(moving);
        assert(preferredAfterMove.width === preferredBeforeMove.width &&
            preferredAfterMove.height === preferredBeforeMove.height,
        'Cross-workspace admission must preserve the moving window\'s preferred size');
        assert(resident.get_workspace() === workspace && moving.get_monitor() === monitor,
            'Cross-workspace fit must not overflow either window to another workspace or monitor');
        console.log('[MINIATURE RESTORE TEST] constrained workspace arrival replans around the incoming window');

        // Independently exercise plain retile: seed two normal windows whose current sizes
        // overflow, without running the explicit admission or miniature-restored pipeline.
        moving.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === moving && pair.every(window =>
            !WindowState.get(window, WindowState.ANIMATING_MINIATURE))),
        'Workspace move must settle before the plain-retile regression');
        ext.dragHandler._suppressRestoreRetile = true;
        try {
            assert(ext.miniatureManager.restoreMiniature(resident, null,
                {activate: false, layoutBypass: true, instant: true}),
            'Plain-retile regression must begin with both windows normal');
        } finally {
            ext.dragHandler._suppressRestoreRetile = false;
        }
        const beforeProbe = pair.map(window => window.get_frame_rect());
        const dryResult = ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false, false, true);
        assert(dryResult.overflow && pair.every((window, index) =>
            !WindowState.get(window, WindowState.IS_MINIATURE) &&
            !WindowState.get(window, WindowState.PENDING_MINIATURE) &&
            ['x', 'y', 'width', 'height'].every(key => window.get_frame_rect()[key] === beforeProbe[index][key])),
        'Dry-run overflow must not miniaturize or reposition live windows');
        const retile = ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor);
        assert(!retile.overflow && WindowState.get(resident, WindowState.IS_MINIATURE) &&
            !WindowState.get(moving, WindowState.IS_MINIATURE),
        'Plain retile must try miniature recovery before rejecting an overflowing initial layout');
        assert(await waitFor(() => pair.every(window =>
            !WindowState.get(window, WindowState.ANIMATING_MINIATURE))),
        'Recovered layout must finish miniature animation');
        const normalRect = moving.get_frame_rect();
        const miniRect = {...WindowState.get(resident, WindowState.MINIATURE_TARGET_POS),
            ...ext.miniatureManager.getMiniatureSize(resident)};
        assert(normalRect.x + normalRect.width <= miniRect.x + 2 ||
            miniRect.x + miniRect.width <= normalRect.x + 2 ||
            normalRect.y + normalRect.height <= miniRect.y + 2 ||
            miniRect.y + miniRect.height <= normalRect.y + 2,
        'Recovered normal and miniature windows must not overlap');
        assert(pair.every(window => window.get_workspace() === workspace),
            'Plain-retile recovery must preserve workspace membership');
        console.log('[MINIATURE RESTORE TEST] plain retile resolves overflow; dry-run stays geometry-neutral');

        // Regression: closing a window used to let the auto-restore chain re-restore a
        // window it had already brought back. Every restore re-enters the tile pass
        // synchronously, so an unstable fit ping-ponged restore -> reject -> miniaturize
        // until the stack overflowed, and the aborted pass leaked the workspace lock,
        // which then read as "transaction busy" to constrained resize reconciliation.
        const closing = pair.find(window => !WindowState.get(window, WindowState.IS_MINIATURE));
        const survivor = pair.find(window => window !== closing);
        const miniatureManager = ext.miniatureManager;
        const originalRestoreMiniature = miniatureManager.restoreMiniature;
        const restoresById = new Map();
        miniatureManager.restoreMiniature = function (...args) {
            const id = args[0]?.get_id?.() ?? '?';
            restoresById.set(id, (restoresById.get(id) ?? 0) + 1);
            return originalRestoreMiniature.apply(this, args);
        };
        try {
            assert(await waitFor(() => !WindowState.get(survivor, WindowState.ANIMATING_MINIATURE)),
                'Surviving window must settle before the close-restore regression');
            const closingId = closing.get_id();
            const survivorId = survivor.get_id();
            const closeChild = children.find(child =>
                Number(child.get_identifier()) === closing.get_pid());
            assert(closeChild, 'The closing window must belong to a tracked Alacritty child');
            closeChild.force_exit();

            assert(await waitFor(() => !ext.windowHandler._windowSignals.has(closing)),
                'Closing a window must retire its signals');
            // The close path retiles and auto-restores synchronously; the deferred close retile
            // may add one more pass. A chain that keeps re-restoring what it already restored
            // shows up as the same window restored over and over.
            await Scripting.sleep(constants.RETILE_DELAY_MS + constants.ANIMATION_DURATION_MS + 600);

            const locked = ext.windowHandler.isWorkspaceLocked(workspace);
            assert(!locked,
                'A window close must not leave its workspace locked');
            // The ledger holds one entry per live tile lock; an empty ledger means no pass is
            // still waiting on the animation timer to hand its lock back.
            assert(ext.windowHandler._locks.pendingCount === 0,
                'A window close must not leave an unlock waiting on the animation timer');
            assert(survivor.get_workspace() === workspace,
                'The surviving window must stay on its workspace');
            const repeating = [...restoresById].filter(([, count]) => count > 2);
            assert(repeating.length === 0,
                `Closing one window must not re-restore the same window, saw ${JSON.stringify(repeating)}`);
            console.log(`[MINIATURE RESTORE TEST] close of ${closingId} restored ${JSON.stringify([...restoresById])} for survivor ${survivorId} and released the workspace lock`);

            // Guard state on the live handler: the close chain must have recorded the window it
            // restored, so a re-entry from the same synchronous 'miniature-restored' path
            // (restoreMiniature emits synchronously) cannot walk it a second time. That walk is
            // what used to overflow the stack and strand the workspace lock.
            const handler = ext.windowHandler;
            assert(handler._cascadeAttempted.size === 0,
                'A settled close-restore chain must clear its attempted set');
            let reentrantRestores = 0;
            miniatureManager.restoreMiniature = function (...args) {
                reentrantRestores++;
                return originalRestoreMiniature.apply(this, args);
            };
            const attempt = () => handler.guardTilePass(() =>
                handler._tryAutoRestoreMiniature([survivor], workspace, monitor));
            const firstAttempt = attempt();
            assert(handler._cascadeAttempted.size === 0,
                'A refused auto-restore must not record attempted windows');
            const secondAttempt = attempt();
            assert(reentrantRestores === 0,
                `A re-entrant auto-restore chain must not restore ${survivorId} again (restores=${reentrantRestores})`);
            assert(firstAttempt === false && secondAttempt === false,
                `Auto-restore must refuse an unstable fit (first=${firstAttempt}, second=${secondAttempt})`);
            assert(!handler.isWorkspaceLocked(workspace),
                'A re-entrant auto-restore chain must not leak the workspace lock');
            console.log('[MINIATURE RESTORE TEST] auto-restore refuses the rejected fit and leaves no lock behind');
        } finally {
            miniatureManager.restoreMiniature = originalRestoreMiniature;
        }
        assert(!ext.windowHandler.isWorkspaceLocked(workspace),
            'The close-restore regression must leave the workspace unlocked');

        console.log('[MINIATURE RESTORE TEST] PASS: two-window restore remains reversible and blocker-safe');
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
