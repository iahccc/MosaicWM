// Real-Alacritty regression for dominant release geometry settling.
// Runs in an isolated headless GNOME Shell session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as constants from '../extension/constants.js';
import * as WindowState from '../extension/windowState.js';

const WAIT_MS = 8000;
const GEOMETRY_TOLERANCE = 8;

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

function miniatureWindows(windows) {
    return windows.filter(window => WindowState.get(window, WindowState.IS_MINIATURE));
}

function miniatureLongEdge(ext, window) {
    const size = ext.miniatureManager.getMiniatureSize(window);
    return size ? Math.max(size.width, size.height) : 0;
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
}

function miniatureVisualRect(ext, window) {
    const pos = WindowState.get(window, WindowState.MINIATURE_TARGET_POS);
    const size = ext.miniatureManager.getMiniatureSize(window);
    return pos && size ? {x: pos.x, y: pos.y, width: size.width, height: size.height} : null;
}

function normalDoesNotOverlapMiniature(ext, normal, miniature) {
    const visual = miniatureVisualRect(ext, miniature);
    return visual && !rectsOverlap(normal.get_frame_rect(), visual);
}

function unionRect(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return {x: left, y: top, width: right - left, height: bottom - top};
}

function normalMiniatureClusterCentered(ext, normal, miniature) {
    const visual = miniatureVisualRect(ext, miniature);
    if (!visual) return false;
    const workArea = normal.get_workspace().get_work_area_for_monitor(normal.get_monitor());
    const cluster = unionRect(normal.get_frame_rect(), visual);
    const clusterCenterX = cluster.x + cluster.width / 2;
    const clusterCenterY = cluster.y + cluster.height / 2;
    const workCenterX = workArea.x + workArea.width / 2;
    const workCenterY = workArea.y + workArea.height / 2;
    // A side rail only changes the perpendicular axis. Along the rail axis, both the
    // normal layout and rail are independently centered already.
    const sideBySide = visual.x >= normal.get_frame_rect().x + normal.get_frame_rect().width ||
        normal.get_frame_rect().x >= visual.x + visual.width;
    return sideBySide
        ? Math.abs(clusterCenterX - workCenterX) <= GEOMETRY_TOLERANCE
        : Math.abs(clusterCenterY - workCenterY) <= GEOMETRY_TOLERANCE;
}

async function focus(window) {
    window.activate(global.get_current_time());
    assert(await waitFor(() => global.display.focus_window === window),
        `Window ${window.get_id()} must receive focus`);
}

async function enterDominant(ext, window) {
    await focus(window);
    window.maximize();
    assert(await waitFor(() =>
        ext.dominantManager.isActive(window) && window.is_maximized()),
    `Window ${window.get_id()} must enter Mosaic dominant state`);
}

async function leaveDominant(ext, window) {
    window.unmaximize();
    assert(await waitFor(() =>
        !ext.dominantManager.isActive(window) && !window.is_maximized()),
    `Window ${window.get_id()} must leave Mosaic dominant state`);
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
        for (let i = 0; i < 2; i++) {
            const child = launchAlacritty();
            children.push(child);
            await waitForChildWindow(child);
        }
        const pair = children.map(child => {
            const pid = Number(child.get_identifier());
            return global.display.list_all_windows().find(window => window.get_pid() === pid);
        });
        assert(pair.every(Boolean), 'Both Alacritty windows must remain alive');
        assert(await waitFor(() => miniatureWindows(pair).length === 1),
            'Two large Alacritty windows must produce one miniature');

        let miniature = miniatureWindows(pair)[0];
        let normal = pair.find(window => window !== miniature);

        // Reproduce the production failure where a normal Smart Resize target was still
        // pending when MAXIMIZE transferred geometry ownership to dominant. The old target
        // must be revoked before the native maximized frame can reach clamp learning.
        const beforeDominant = normal.get_frame_rect();
        const abandonedTarget = {
            width: Math.max(200, beforeDominant.width - 120),
            height: Math.max(160, beforeDominant.height - 90),
        };
        ext.tilingManager.setSmartResizeTarget(normal, abandonedTarget);
        WindowState.set(normal, 'targetSmartResizeSetAt', GLib.get_monotonic_time() / 1000 - 5000);
        ext.resizeHandler._armClampVerification(normal, abandonedTarget);
        await enterDominant(ext, normal);
        assert(!WindowState.get(normal, 'targetSmartResizeSize') &&
            WindowState.get(normal, 'clampVerifyId') === undefined,
        'Entering dominant must atomically revoke the previous normal Smart Resize contract');
        await Scripting.sleep(constants.RESIZE_CLAMP_VERIFY_DELAY_MS + 120);
        assert(!WindowState.get(normal, 'actualMinWidth') && !WindowState.get(normal, 'actualMinHeight'),
            'Native/dominant geometry must never satisfy a stale normal-role clamp verifier');
        console.log('[DOMINANT RELEASE TEST] dominant entry revokes stale normal resize ownership');
        assert(await waitFor(() =>
            WindowState.get(miniature, WindowState.IS_MINIATURE) &&
            miniatureLongEdge(ext, miniature) <= 128 + GEOMETRY_TOLERANCE),
        'Focused dominant must use the compact miniature presentation');
        const compactTargetBeforeRelease = {
            ...WindowState.get(miniature, WindowState.MINIATURE_TARGET_POS),
        };

        // Freeze only the presentation commit. Role release and live configure processing still
        // run normally, which deterministically exposes the otherwise timing-sensitive middle
        // state where a stale large frame used to coexist with an already-expanded 256px rail.
        const originalCanCommit = ext.tilingManager.canUseMiniatureTargetSizeFromLiveFrames.bind(ext.tilingManager);
        let allowPresentationCommit = false;
        ext.tilingManager.canUseMiniatureTargetSizeFromLiveFrames = (...args) =>
            allowPresentationCommit && originalCanCommit(...args);
        try {
            await leaveDominant(ext, normal);
            assert(await waitFor(() => ext.dominantManager.isReleaseSettling(normal)),
                'Dominant release must hold presentation until live geometry is safe');
            assert(await waitFor(() =>
                WindowState.get(miniature, WindowState.IS_MINIATURE) &&
                miniatureLongEdge(ext, miniature) <= 128 + GEOMETRY_TOLERANCE &&
                !WindowState.get(miniature, WindowState.ANIMATING_MINIATURE)),
            'Release transaction must retain compact miniature geometry while commit is frozen');
            const compactTargetDuringRelease = WindowState.get(
                miniature, WindowState.MINIATURE_TARGET_POS);
            assert(compactTargetDuringRelease &&
                Math.abs(compactTargetDuringRelease.x - compactTargetBeforeRelease.x) <= GEOMETRY_TOLERANCE &&
                Math.abs(compactTargetDuringRelease.y - compactTargetBeforeRelease.y) <= GEOMETRY_TOLERANCE,
            'Release hold must preserve the existing compact rail slot until normal live geometry settles');
            console.log('[DOMINANT RELEASE TEST] compact rail is held until live geometry can commit normal presentation');

            // Force the exact stale-clamp branch from the production log. The live frame is
            // deliberately above this target, and the timestamp is old enough that the normal
            // clamp learner would immediately promote it to actualMinWidth/actualMinHeight.
            const live = normal.get_frame_rect();
            const staleTarget = {
                width: Math.max(200, live.width - 96),
                height: Math.max(160, live.height - 72),
            };
            ext.tilingManager.setSmartResizeTarget(normal, staleTarget);
            WindowState.set(normal, 'targetSmartResizeSetAt', GLib.get_monotonic_time() / 1000 - 5000);
            WindowState.set(normal, 'addedTime', GLib.get_monotonic_time() / 1000 - 5000);
            ext.resizeHandler._armClampVerification(normal, staleTarget);
            await Scripting.sleep(constants.RESIZE_CLAMP_VERIFY_DELAY_MS + 120);
            assert(!WindowState.get(normal, 'actualMinWidth') && !WindowState.get(normal, 'actualMinHeight'),
                'Dominant-release stale geometry must never be learned as an application minimum');
            assert(!WindowState.get(normal, 'targetSmartResizeSize'),
                'Rejected release clamp target must be consumed instead of poisoning later fit checks');
            console.log('[DOMINANT RELEASE TEST] stale dominant frame cannot poison Smart Resize minimums');

            allowPresentationCommit = true;
            ext.dominantManager.notifyGeometryChanged(normal);
            assert(await waitFor(() => !ext.dominantManager.isReleaseSettling(normal)),
                'Release presentation must commit once the live-frame solver accepts the normal profile');
        } finally {
            ext.tilingManager.canUseMiniatureTargetSizeFromLiveFrames = originalCanCommit;
        }

        assert(await waitFor(() =>
            WindowState.get(miniature, WindowState.IS_MINIATURE) &&
            miniatureLongEdge(ext, miniature) >= 256 - GEOMETRY_TOLERANCE &&
            !WindowState.get(miniature, WindowState.ANIMATING_MINIATURE) &&
            normalMiniatureClusterCentered(ext, normal, miniature)),
        'Committed normal presentation must restore the standard miniature size');
        assert(normalDoesNotOverlapMiniature(ext, normal, miniature),
            'Normal profile commit must remain non-overlapping');
        console.log('[DOMINANT RELEASE TEST] normal profile restores a centered 256px content/rail cluster');

        // Native maximize is application/Mutter state; dominant geometry is a compositor
        // constraint layered on top. Repeated MAXIMIZE notifications must therefore be
        // idempotent instead of acting as a synthetic toggle-off signal.
        await enterDominant(ext, normal);
        assert(normal.is_maximized(),
            'Dominant entry must preserve the native maximized bit');
        assert(await waitFor(() => normalDoesNotOverlapMiniature(ext, normal, miniature)),
            'External dominant geometry constraint must override the native maximized work-area frame');
        assert(ext.dominantManager.handleNativeEnter(normal, 'test-maximize-echo'),
            'Duplicate MAXIMIZE on an active dominant must be consumed');
        assert(await waitFor(() =>
            ext.dominantManager.isActive(normal) &&
            normal.is_maximized() &&
            WindowState.get(normal, WindowState.IS_DOMINANT) &&
            normalDoesNotOverlapMiniature(ext, normal, miniature)),
        'Duplicate MAXIMIZE must preserve native maximize and active constrained dominance');
        await leaveDominant(ext, normal);
        assert(await waitFor(() => !ext.dominantManager.isReleaseSettling(normal)),
            'Native UNMAXIMIZE must release dominant geometry ownership cleanly');
        console.log('[DOMINANT RELEASE TEST] native maximize state is preserved and duplicate MAXIMIZE is idempotent');

        // Exercise several real maximize -> release cycles after the deterministic probe. No
        // cycle may recreate the fake minimum or strand the release presentation transaction.
        for (let cycle = 0; cycle < 3; cycle++) {
            await enterDominant(ext, normal);
            await leaveDominant(ext, normal);
            assert(await waitFor(() => !ext.dominantManager.isReleaseSettling(normal)),
                `Release cycle ${cycle + 1} must settle its presentation transaction`);
            assert(!WindowState.get(normal, 'actualMinWidth') && !WindowState.get(normal, 'actualMinHeight'),
                `Release cycle ${cycle + 1} must not learn dominant geometry as a minimum`);
        }
        console.log('[DOMINANT RELEASE TEST] repeated maximize/release cycles remain constraint-clean');

        miniature = miniatureWindows(pair)[0];
        normal = pair.find(window => window !== miniature);
        assert(miniature && normal, 'One miniature must remain available for click-restore regression');
        assert(ext.miniatureManager.restoreMiniature(miniature, null, {reason: 'click'}),
            'Miniature click restore must remain accepted after repeated dominant release cycles');
        assert(await waitFor(() =>
            !WindowState.get(miniature, WindowState.IS_MINIATURE) &&
            WindowState.get(normal, WindowState.IS_MINIATURE)),
        'Miniature click restore must still swap the visible normal window after release stress');
        console.log('[DOMINANT RELEASE TEST] PASS: release is presentation-atomic, clamp-safe, and click-restorable');
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
