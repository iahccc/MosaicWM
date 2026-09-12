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
        // normal+miniature cluster must stay centered in the work area.
        assert(await waitFor(() => {
            const target = WindowState.get(miniature, WindowState.MINIATURE_TARGET_POS);
            const size = ext.miniatureManager.getMiniatureSize(miniature);
            if (!target || !size || WindowState.get(miniature, WindowState.ANIMATING_MINIATURE))
                return false;
            const frame = normal.get_frame_rect();
            const horizontalGap = target.x - (frame.x + frame.width);
            const workArea = workspace.get_work_area_for_monitor(monitor);
            const clusterLeft = Math.min(frame.x, target.x);
            const clusterRight = Math.max(frame.x + frame.width, target.x + size.width);
            const clusterCenter = (clusterLeft + clusterRight) / 2;
            const workCenter = workArea.x + workArea.width / 2;
            return Math.abs(horizontalGap - constants.WINDOW_SPACING) <= 2 &&
                Math.abs(clusterCenter - workCenter) <= 4;
        }), 'A right-side miniature rail must stay adjacent while normal+miniature remain centered as one cluster');
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
            ext.dominantManager.requestMiniatureRestore(window, options));
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

        // Real-Alacritty regression for a historical dominant miniature whose dominant
        // layout is currently impossible. This was the production failure mode where a
        // click first made one miniature permanently unrestorable, then clicking another
        // window eventually drove that one through the same poisoned stack path.
        const stackCandidate = pair.find(window => !WindowState.get(window, WindowState.IS_MINIATURE));
        assert(stackCandidate, 'One Alacritty must be normal before dominant-history regression setup');
        assert(ext.dominantManager.requestDominance(stackCandidate, 'test-stack-history'),
            'Alacritty must be able to acquire dominant history for restore regression');
        assert(await waitFor(() => ext.dominantManager.isActive(stackCandidate)),
            'Alacritty must become active dominant before forced suspension');
        assert(ext.dominantManager._demoteActiveToMiniature(workspace, monitor, {keepIntent: true}),
            'Regression setup must suspend active dominance while preserving intent');
        assert(await waitFor(() =>
            !ext.dominantManager.hasActive(workspace, monitor) &&
            ext.dominantManager.hasIntentForWindow(stackCandidate) &&
            WindowState.get(stackCandidate, WindowState.IS_MINIATURE)),
        'Suspended Alacritty must be a dormant stack miniature');

        const originalBuildPlan = ext.dominantManager._buildPlan.bind(ext.dominantManager);
        ext.dominantManager._buildPlan = (scope, ws, mon, options = {}) => {
            const candidate = options.dominant ?? scope?.active;
            if (candidate === stackCandidate) return null;
            return originalBuildPlan(scope, ws, mon, options);
        };
        try {
            assert(ext.miniatureManager.restoreMiniature(stackCandidate, null, {reason: 'click'}),
                'Explicit click must restore dormant Alacritty as normal when dominance is impossible');
            assert(await waitFor(() =>
                !WindowState.get(stackCandidate, WindowState.IS_MINIATURE) &&
                !ext.dominantManager.hasActive(workspace, monitor)),
            'Failed dominant preflight must not leave the selected Alacritty miniature or poison active scope');
            assert(ext.dominantManager.hasIntentForWindow(stackCandidate),
                'Normal fallback must preserve dormant dominant history for future recovery');
            assert(stackCandidate.get_workspace() === workspace,
                'Dominant-history fallback must stay in the original workspace');

            const secondMiniature = pair.find(window =>
                window !== stackCandidate && WindowState.get(window, WindowState.IS_MINIATURE));
            assert(secondMiniature,
                'The sibling Alacritty must remain independently addressable after stack fallback');
            assert(ext.miniatureManager.restoreMiniature(secondMiniature, null, {reason: 'click'}),
                'Clicking the second Alacritty after stack fallback must still be accepted');
            assert(await waitFor(() => !WindowState.get(secondMiniature, WindowState.IS_MINIATURE)),
                'Second Alacritty must not inherit the first window restore failure');
            assert(!ext.tilingManager._isSmartResizingBlocked,
                'Repeated Alacritty restores must leave the global Smart Resize gate unblocked');
            console.log('[MINIATURE RESTORE TEST] dormant dominant failure cannot spread between real Alacritty miniatures');
        } finally {
            ext.dominantManager._buildPlan = originalBuildPlan;
        }
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
