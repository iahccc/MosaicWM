// Run with --automation-script in a private headless GNOME Shell session.
// MOSAIC_TEST_EXTENSION_DIR must point to an extension copy with compiled schemas.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import { TileZone, WINDOW_SPACING } from '../extension/constants.js';
import * as WindowState from '../extension/windowState.js';

const WAIT_MS = 6000;
const GEOMETRY_TOLERANCE = 8;
const OUTER_GAP_TOLERANCE = 2;

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
    await Scripting.createTestWindow({ width, height });
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

function sameWorkspace(window, workspace, monitor) {
    return window.get_workspace() === workspace && window.get_monitor() === monitor;
}

function dominantGeometryMatches(ext, dominant, workspace, monitor) {
    const area = ext.tilingManager.getUsableWorkArea(workspace, monitor);
    const frame = dominant.get_frame_rect();
    return frame.x + GEOMETRY_TOLERANCE >= area.x &&
        frame.y + GEOMETRY_TOLERANCE >= area.y &&
        frame.x + frame.width <= area.x + area.width + GEOMETRY_TOLERANCE &&
        frame.y + frame.height <= area.y + area.height + GEOMETRY_TOLERANCE &&
        frame.width >= 96 && frame.height >= 96;
}

function assertDominantGeometry(ext, dominant, workspace, monitor) {
    const area = ext.tilingManager.getUsableWorkArea(workspace, monitor);
    const frame = dominant.get_frame_rect();
    assert(dominantGeometryMatches(ext, dominant, workspace, monitor),
        `Dominant ${JSON.stringify(frame)} must stay inside usable area ${JSON.stringify(area)}`);
    assertOuterGap(frame, area, `Dominant ${dominant.get_id()}`);
}

function dominantFillsUsableArea(ext, dominant, workspace, monitor) {
    const area = ext.tilingManager.getUsableWorkArea(workspace, monitor);
    const frame = dominant.get_frame_rect();
    return Math.abs(frame.x - area.x) <= OUTER_GAP_TOLERANCE &&
        Math.abs(frame.y - area.y) <= OUTER_GAP_TOLERANCE &&
        Math.abs(frame.width - area.width) <= OUTER_GAP_TOLERANCE &&
        Math.abs(frame.height - area.height) <= OUTER_GAP_TOLERANCE;
}

function assertOuterGap(rect, area, label) {
    const minimum = WINDOW_SPACING - OUTER_GAP_TOLERANCE;
    assert(rect.x - area.x >= minimum &&
        rect.y - area.y >= minimum &&
        area.x + area.width - (rect.x + rect.width) >= minimum &&
        area.y + area.height - (rect.y + rect.height) >= minimum,
    `${label} must keep the same outer gap as Mosaic's internal spacing`);
}

function rectsDoNotOverlap(a, b) {
    return a.x + a.width <= b.x + GEOMETRY_TOLERANCE ||
        b.x + b.width <= a.x + GEOMETRY_TOLERANCE ||
        a.y + a.height <= b.y + GEOMETRY_TOLERANCE ||
        b.y + b.height <= a.y + GEOMETRY_TOLERANCE;
}

function assertDominantDoesNotOverlap(dominant, sibling) {
    assert(rectsDoNotOverlap(dominant.get_frame_rect(), sibling.get_frame_rect()),
        `Rail window ${sibling.get_id()} must not overlap dominant ${dominant.get_id()}`);
}

function assertMiniatureWithinWorkArea(ext, window, workspace, monitor) {
    const area = ext.tilingManager.getUsableWorkArea(workspace, monitor);
    const target = WindowState.get(window, WindowState.MINIATURE_TARGET_POS);
    const size = ext.miniatureManager.getMiniatureSize(window);
    assert(target && size, `Window ${window.get_id()} must expose miniature geometry`);
    assert(target.x + GEOMETRY_TOLERANCE >= area.x &&
        target.y + GEOMETRY_TOLERANCE >= area.y &&
        target.x + size.width <= area.x + area.width + GEOMETRY_TOLERANCE &&
        target.y + size.height <= area.y + area.height + GEOMETRY_TOLERANCE,
    `Miniature ${window.get_id()} must stay fully inside the usable work area`);
    assertOuterGap({x: target.x, y: target.y, width: size.width, height: size.height}, area,
        `Miniature ${window.get_id()}`);
}

function normalDoesNotOverlapMiniature(ext, normalWindow, miniatureWindow) {
    const normal = normalWindow.get_frame_rect();
    const target = WindowState.get(miniatureWindow, WindowState.MINIATURE_TARGET_POS);
    const size = ext.miniatureManager.getMiniatureSize(miniatureWindow);
    if (!target || !size) return false;

    const mini = { x: target.x, y: target.y, width: size.width, height: size.height };
    return normal.x + normal.width <= mini.x + GEOMETRY_TOLERANCE ||
        mini.x + mini.width <= normal.x + GEOMETRY_TOLERANCE ||
        normal.y + normal.height <= mini.y + GEOMETRY_TOLERANCE ||
        mini.y + mini.height <= normal.y + GEOMETRY_TOLERANCE;
}

function miniatureVisualFrameRect(window) {
    const actor = window.get_compositor_private();
    const preSize = WindowState.get(window, WindowState.PRE_MINIATURE_SIZE);
    const scale = WindowState.get(window, WindowState.MINIATURE_SCALE);
    if (!actor || actor.is_destroyed?.() || !preSize || !scale) return null;
    const [actorX, actorY] = actor.get_position();
    const extLeft = WindowState.get(window, WindowState.MINIATURE_EXT_LEFT) ?? 0;
    const extTop = WindowState.get(window, WindowState.MINIATURE_EXT_TOP) ?? 0;
    return {
        x: actorX + actor.translation_x + extLeft * scale,
        y: actorY + actor.translation_y + extTop * scale,
        width: preSize.width * scale,
        height: preSize.height * scale,
    };
}

function miniatureVisualMatchesTarget(ext, window) {
    const visual = miniatureVisualFrameRect(window);
    const target = WindowState.get(window, WindowState.MINIATURE_TARGET_POS);
    const size = ext.miniatureManager.getMiniatureSize(window);
    if (!visual || !target || !size) return false;
    return Math.abs(visual.x - target.x) <= GEOMETRY_TOLERANCE &&
        Math.abs(visual.y - target.y) <= GEOMETRY_TOLERANCE &&
        Math.abs(visual.width - size.width) <= GEOMETRY_TOLERANCE &&
        Math.abs(visual.height - size.height) <= GEOMETRY_TOLERANCE;
}

function normalDoesNotOverlapMiniatureVisual(normalWindow, miniatureWindow) {
    const visual = miniatureVisualFrameRect(miniatureWindow);
    return !!visual && rectsDoNotOverlap(normalWindow.get_frame_rect(), visual);
}

function miniatureIconIsCentered(ext, window) {
    const overlay = WindowState.get(window, WindowState.MINIATURE_OVERLAY);
    const target = WindowState.get(window, WindowState.MINIATURE_TARGET_POS);
    const size = ext.miniatureManager.getMiniatureSize(window);
    const icon = overlay?.get_children?.()[0];
    if (!overlay || !target || !size || !icon) return false;

    const [iconX, iconY] = icon.get_transformed_position();
    const [iconW, iconH] = icon.get_transformed_size();
    const expectedX = target.x + size.width / 2;
    const expectedY = target.y + size.height / 2;
    return Math.abs(iconX + iconW / 2 - expectedX) <= GEOMETRY_TOLERANCE &&
        Math.abs(iconY + iconH / 2 - expectedY) <= GEOMETRY_TOLERANCE;
}

function dominantDoesNotOverlap(dominant, sibling) {
    return rectsDoNotOverlap(dominant.get_frame_rect(), sibling.get_frame_rect());
}

function miniatureLongEdge(ext, window) {
    const size = ext.miniatureManager.getMiniatureSize(window);
    return size ? Math.max(size.width, size.height) : 0;
}

function rectArea(rect) {
    return rect.width * rect.height;
}

async function toggleMaximize(window) {
    if (window.is_maximized())
        window.unmaximize();
    else
        window.maximize();
    await Scripting.sleep(50);
}

async function enterFullscreen(window) {
    window.make_fullscreen();
    await Scripting.sleep(50);
}

async function exitFullscreen(window) {
    window.unmake_fullscreen();
    await Scripting.sleep(50);
}

async function key(keyboard, symbol, pressed, delay = 60) {
    keyboard.notify_keyval(GLib.get_monotonic_time(), symbol,
        pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    await Scripting.sleep(delay);
}

async function shortcut(keyboard, modifier, symbol) {
    await key(keyboard, modifier, true);
    await key(keyboard, symbol, true);
    await key(keyboard, symbol, false);
    await key(keyboard, modifier, false);
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
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

    try {
        const dominant = await createWindow(600, 420);
        const workspace = dominant.get_workspace();
        const monitor = dominant.get_monitor();
        const workspaceIndex = workspace.index();

        dominant.maximize();
        assert(await waitFor(() =>
            ext.dominantManager.isActive(dominant) &&
            dominant.is_maximized() &&
            dominantFillsUsableArea(ext, dominant, workspace, monitor)),
        'A lone dominant window must stay natively maximized while filling the usable work area without Mosaic outer gaps');
        await toggleMaximize(dominant);
        assert(await waitFor(() => !ext.dominantManager.hasActive(workspace, monitor)),
            'Single-window dominant setup must toggle off before shared-layout regression');
        console.log('[DOMINANT TEST] lone dominant fills usable work area with zero outer gap');

        // PerfHelper enforces a ~295px minimum width. A wide sibling becomes a standard
        // miniature and the unified rail solver decides which screen edge best preserves
        // the dominant area.
        const shelfAnchor = await createWindow(600, 300);
        const shelfPreferredBefore = WindowState.get(shelfAnchor, 'preferredSize');
        // Canonical role reasoning is allowed to remember a different desired size, but
        // the compositor can only scale the live frame. This deliberately separates those
        // two sources so the regression catches overlay/icon geometry being built from the
        // canonical preferred size instead of the actor's actual backing frame.
        WindowState.set(shelfAnchor, 'preferredSize', {width: 900, height: 520});

        dominant.maximize();
        assert(await waitFor(() =>
            ext.dominantManager.isActive(dominant) &&
            dominant.is_maximized() &&
            dominantGeometryMatches(ext, dominant, workspace, monitor) &&
            WindowState.get(shelfAnchor, WindowState.IS_MINIATURE)),
            'Manual maximize must remain native while Mosaic constrains the dominant frame');
        assert(WindowState.get(dominant, WindowState.IS_DOMINANT),
            'Dominant state must be explicit');
        assert(sameWorkspace(dominant, workspace, monitor) && workspace.index() === workspaceIndex,
            'Entering dominant must not move workspaces or monitors');
        assert(await waitFor(() =>
            !WindowState.get(shelfAnchor, WindowState.ANIMATING_MINIATURE) &&
            miniatureVisualMatchesTarget(ext, shelfAnchor) &&
            miniatureIconIsCentered(ext, shelfAnchor)),
        'Dominant rail must use live frame geometry for miniature actor, overlay and icon even when preferred size differs');
        if (shelfPreferredBefore)
            WindowState.set(shelfAnchor, 'preferredSize', shelfPreferredBefore);
        else
            WindowState.remove(shelfAnchor, 'preferredSize');
        assertDominantGeometry(ext, dominant, workspace, monitor);
        console.log('[DOMINANT TEST] maximize intent stays on workspace and becomes dominant');

        const transferWorkspace = global.workspace_manager.append_new_workspace(false, global.get_current_time());
        dominant.change_workspace(transferWorkspace);
        transferWorkspace.activate(global.get_current_time());
        assert(await waitFor(() =>
            dominant.get_workspace() === transferWorkspace &&
            ext.dominantManager.isActive(dominant) &&
            !ext.dominantManager.hasActive(workspace, monitor) &&
            dominantGeometryMatches(ext, dominant, transferWorkspace, monitor)),
        'Moving a dominant window must atomically transfer its dominant scope to the destination workspace');
        await Scripting.sleep(250);
        assert(global.workspace_manager.get_active_workspace() === transferWorkspace,
            'A stale empty-source renavigate must not pull focus away from the workspace chosen by the move');

        const workspaceCountBeforeTransferArrival = global.workspace_manager.get_n_workspaces();
        const transferPeer = await createWindow(800, 600);
        assert(transferPeer.get_workspace() === transferWorkspace,
            'A normal window opened beside a transferred dominant must be admitted on that workspace, not overflow elsewhere');
        assert(global.workspace_manager.get_n_workspaces() === workspaceCountBeforeTransferArrival,
            'Transferred dominant admission must not create an extra overflow workspace');
        transferPeer.delete(global.get_current_time());
        assert(await waitFor(() => !global.display.list_all_windows().includes(transferPeer)),
            'Transfer admission peer must close before moving the dominant back');
        assert(await waitFor(() => ext.dominantManager.isActive(dominant)),
            'Transferred dominant intent must recover after its temporary peer closes');

        dominant.change_workspace(workspace);
        workspace.activate(global.get_current_time());
        assert(await waitFor(() =>
            dominant.get_workspace() === workspace &&
            ext.dominantManager.isActive(dominant) &&
            dominantGeometryMatches(ext, dominant, workspace, monitor)),
        'Moving the dominant back must transfer its scope back without losing native maximize intent');
        console.log('[DOMINANT TEST] cross-workspace dominant transfer preserves scope and local admission');

        const small = await createWindow(160, 120);
        assert(await waitFor(() =>
            ext.dominantManager.isActive(dominant) &&
            !WindowState.get(small, WindowState.IS_MINIATURE) &&
            WindowState.get(small, WindowState.DOMINANT_KEEP_NORMAL) &&
            dominantDoesNotOverlap(dominant, small)),
        'Small normal arrival must coexist with the active dominant');
        assert(sameWorkspace(small, workspace, monitor),
            'Coexisting arrival must remain in the dominant workspace');
        assertDominantDoesNotOverlap(dominant, small);

        small.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === small),
            'Normal peer must be focused before checking the normal miniature profile');
        assert(await waitFor(() =>
            Math.abs(miniatureLongEdge(ext, shelfAnchor) - 256) <= GEOMETRY_TOLERANCE),
        'Miniatures must use the global default size while dominant is not focused');
        assert(await waitFor(() =>
            !WindowState.get(shelfAnchor, WindowState.ANIMATING_MINIATURE) &&
            miniatureVisualMatchesTarget(ext, shelfAnchor)),
        'Default-profile miniature visual frame must settle exactly onto its solver target');
        const shelfOverlay = WindowState.get(shelfAnchor, WindowState.MINIATURE_OVERLAY);
        const shelfIcon = shelfOverlay?.get_children?.()[0];
        assert(shelfIcon, 'Miniature must expose an app icon for compact-profile alignment regression');
        // Reproduce an in-flight icon vector when the parent overlay is retargeted. The
        // production race is the same: icon fly-in owns child translation while focus
        // changes the parent from the 256 profile to the 128 profile.
        shelfIcon.set_translation(37, -23, 0);
        const normalProfileDominantArea = rectArea(dominant.get_frame_rect());

        dominant.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === dominant),
            'Dominant must gain real focus before compact presentation activates');
        assert(await waitFor(() =>
            Math.abs(miniatureLongEdge(ext, shelfAnchor) - 128) <= GEOMETRY_TOLERANCE),
        'Focused dominant must halve miniature presentation size');
        assert(await waitFor(() =>
            !WindowState.get(shelfAnchor, WindowState.ANIMATING_MINIATURE) &&
            miniatureVisualMatchesTarget(ext, shelfAnchor)),
        'Compact-profile miniature visual frame must settle exactly onto its solver target');
        assert(await waitFor(() =>
            Math.abs(shelfIcon.translation_x) <= GEOMETRY_TOLERANCE &&
            Math.abs(shelfIcon.translation_y) <= GEOMETRY_TOLERANCE &&
            miniatureIconIsCentered(ext, shelfAnchor)),
        '128-profile retarget must discard stale icon flight translation and remain centered');
        assert(await waitFor(() => rectArea(dominant.get_frame_rect()) > normalProfileDominantArea),
            'Compact miniature presentation must enlarge the dominant rectangle');
        assert(normalDoesNotOverlapMiniatureVisual(dominant, shelfAnchor),
            'Compact miniature visual frame must not overlap the dominant frame');
        assertDominantDoesNotOverlap(dominant, small);

        // Focus-neutral windows must preserve the last layout-relevant focus instead of
        // manufacturing a NORMAL profile transition. This models standalone always-on-top,
        // sticky/skip-taskbar helpers and other excluded windows. A transient is different:
        // its focus belongs to the nearest managed ancestor.
        const originalIsExcluded = ext.windowingManager.isExcluded.bind(ext.windowingManager);
        const fakeActor = {is_destroyed: () => false};
        const neutralFocus = {
            get_compositor_private: () => fakeActor,
            get_transient_for: () => null,
        };
        const peerTransientFocus = {
            get_compositor_private: () => fakeActor,
            get_transient_for: () => small,
        };
        ext.windowingManager.isExcluded = window =>
            window === neutralFocus || window === peerTransientFocus || originalIsExcluded(window);
        try {
            ext.dominantManager.onFocusChanged(neutralFocus);
            assert(await waitFor(() =>
                Math.abs(miniatureLongEdge(ext, shelfAnchor) - 128) <= GEOMETRY_TOLERANCE),
            'Excluded focus-neutral window must preserve the focused-dominant profile');

            ext.dominantManager.onFocusChanged(peerTransientFocus);
            assert(await waitFor(() =>
                Math.abs(miniatureLongEdge(ext, shelfAnchor) - 256) <= GEOMETRY_TOLERANCE),
            'Transient focus must resolve to its managed normal parent');

            ext.dominantManager.onFocusChanged(dominant);
            assert(await waitFor(() =>
                Math.abs(miniatureLongEdge(ext, shelfAnchor) - 128) <= GEOMETRY_TOLERANCE),
            'Returning layout focus to dominant must restore compact presentation');
        } finally {
            ext.windowingManager.isExcluded = originalIsExcluded;
        }
        console.log('[DOMINANT TEST] excluded focus is neutral; transient focus resolves to managed parent');

        small.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === small),
            'Normal peer must regain focus when leaving focused-dominant mode');
        assert(await waitFor(() =>
            Math.abs(miniatureLongEdge(ext, shelfAnchor) - 256) <= GEOMETRY_TOLERANCE),
        'Leaving dominant focus must restore the global miniature size');
        assert(await waitFor(() =>
            !WindowState.get(shelfAnchor, WindowState.ANIMATING_MINIATURE) &&
            miniatureVisualMatchesTarget(ext, shelfAnchor)),
        'Restored default-profile miniature visual frame must match its solver target');
        console.log('[DOMINANT TEST] unified rail coexists with normal peer and focus toggles 256↔128 presentation');

        const large = await createWindow(500, 360);
        assert(await waitFor(() =>
            !ext.dominantManager.hasActive(workspace, monitor) &&
            WindowState.get(dominant, WindowState.IS_MINIATURE)),
        'Large arrival must demote a dominant that cannot preserve canonical geometry');
        assert(sameWorkspace(large, workspace, monitor),
            'Dominant demotion must not itself exile the new window');
        assertMiniatureWithinWorkArea(ext, dominant, workspace, monitor);
        assert(await waitFor(() =>
            normalDoesNotOverlapMiniature(ext, large, dominant) &&
            normalDoesNotOverlapMiniatureVisual(large, dominant)),
            'Ordinary windows must not overlap a dormant-dominant miniature in the unified rail');
        assert(await waitFor(() =>
            !WindowState.get(dominant, WindowState.ANIMATING_MINIATURE) &&
            miniatureIconIsCentered(ext, dominant)),
        'Dominant miniature icon must be centered over its visual frame');
        console.log('[DOMINANT TEST] oversized admission demotes dominant into the unified miniature rail');

        large.delete(global.get_current_time());
        assert(await waitFor(() => !global.display.list_all_windows().includes(large)),
            'Large test window must close');
        assert(await waitFor(() =>
            ext.dominantManager.isActive(dominant) &&
            !WindowState.get(dominant, WindowState.IS_MINIATURE) &&
            dominantGeometryMatches(ext, dominant, workspace, monitor) &&
            dominantDoesNotOverlap(dominant, small)),
        'Dormant dominant intent must recover after the blocking arrival closes');
        assert(!WindowState.get(small, WindowState.IS_MINIATURE),
            'A small coexisting sibling must remain normal when dominant recovers');
        assert(WindowState.get(shelfAnchor, WindowState.IS_MINIATURE),
            'Historical sibling must remain miniature while dominant is active');
        assertDominantDoesNotOverlap(dominant, small);
        console.log('[DOMINANT TEST] dormant dominant stack recovers after space is freed');

        const explicitBlocker = await createWindow(500, 360);
        assert(await waitFor(() =>
            !ext.dominantManager.hasActive(workspace, monitor) &&
            WindowState.get(dominant, WindowState.IS_MINIATURE)),
        'Second oversized arrival must suspend dominant for explicit restore regression');
        assertMiniatureWithinWorkArea(ext, dominant, workspace, monitor);
        explicitBlocker.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === explicitBlocker),
            'Blocking ordinary window must be focused before dominant miniature restore');
        const workspaceCountBeforeRestore = global.workspace_manager.get_n_workspaces();

        // Regression for the real-world "first one dies, then the next one dies" failure:
        // a stack miniature whose dominant plan is impossible must not be driven through
        // requestDominance(), because that mutates active/stack presentation before the
        // solver can reject the plan. Passive restore stays blocked; explicit user intent
        // falls back to the normal restore path without consuming dominant history.
        const originalBuildPlan = ext.dominantManager._buildPlan.bind(ext.dominantManager);
        const originalOrdinaryRestore = ext.dominantManager._restoreOrdinaryMiniature.bind(ext.dominantManager);
        let explicitFallbackCount = 0;
        ext.dominantManager._buildPlan = (scope, ws, mon, options = {}) => {
            const candidate = options.dominant ?? scope?.active;
            if (candidate === dominant) return null;
            return originalBuildPlan(scope, ws, mon, options);
        };
        ext.dominantManager._restoreOrdinaryMiniature = () => {
            explicitFallbackCount++;
            return true;
        };
        try {
            assert(!ext.dominantManager.requestMiniatureRestore(dominant, {reason: 'hover'}),
                'Passive restore must stay blocked when historical dominant cannot be realized');
            assert(explicitFallbackCount === 0,
                'Passive restore must not fall back to ordinary explicit restoration');
            assert(!ext.dominantManager.hasActive(workspace, monitor) &&
                ext.dominantManager.hasIntentForWindow(dominant) &&
                WindowState.get(dominant, WindowState.IS_MINIATURE),
            'Failed passive stack restore must leave scope and miniature intent unchanged');

            assert(ext.dominantManager.requestMiniatureRestore(dominant, {reason: 'click'}),
                'Explicit stack restore must fall back when dominant layout is impossible');
            assert(explicitFallbackCount === 1,
                'Impossible explicit dominant restore must use the ordinary in-workspace restore path exactly once');
            assert(!ext.dominantManager.hasActive(workspace, monitor) &&
                ext.dominantManager.hasIntentForWindow(dominant) &&
                WindowState.get(dominant, WindowState.IS_MINIATURE),
            'Fallback routing itself must not poison active scope or consume dormant dominant intent');
        } finally {
            ext.dominantManager._buildPlan = originalBuildPlan;
            ext.dominantManager._restoreOrdinaryMiniature = originalOrdinaryRestore;
        }
        console.log('[DOMINANT TEST] impossible stack-dominant restore falls back explicitly without poisoning scope');

        assert(ext.miniatureManager.restoreMiniature(dominant, null, { reason: 'click' }),
            'Click-style restore of dormant dominant miniature must be accepted');
        assert(WindowState.get(dominant, WindowState.MINIATURE_ANIM_KIND) === 'restore',
            'Switching a dormant dominant miniature must use the ordinary miniature restore animation');
        assert(await waitFor(() =>
            ext.dominantManager.isActive(dominant) &&
            !WindowState.get(dominant, WindowState.IS_MINIATURE) &&
            !WindowState.get(dominant, WindowState.MINIATURE_ANIM_KIND) &&
            WindowState.get(explicitBlocker, WindowState.IS_MINIATURE)),
        'Restoring dormant dominant must reactivate it and miniaturize the blocker in-place');
        assert(explicitBlocker.get_workspace() === workspace,
            'Restoring dominant miniature must never exile the previously focused ordinary window');
        assert(global.workspace_manager.get_n_workspaces() === workspaceCountBeforeRestore,
            'Restoring dominant miniature must not create an overflow workspace');
        explicitBlocker.delete(global.get_current_time());
        assert(await waitFor(() => !global.display.list_all_windows().includes(explicitBlocker)),
            'Explicit-restore blocker must close');
        console.log('[DOMINANT TEST] explicit dominant miniature restore keeps focused blocker in workspace');

        await toggleMaximize(dominant);
        assert(await waitFor(() =>
            !ext.dominantManager.hasActive(workspace, monitor) &&
            !WindowState.get(dominant, WindowState.IS_DOMINANT) &&
            !dominant.is_maximized() &&
            !WindowState.get(shelfAnchor, WindowState.IS_MINIATURE)),
        'Repeating maximize on active dominant must toggle dominant off');
        console.log('[DOMINANT TEST] repeated maximize toggles dominant off');

        const staleRestoreTarget = { width: 1200, height: 700 };
        const newerSmartTarget = { width: 600, height: 300 };
        WindowState.set(dominant, 'targetRestoredSize', staleRestoreTarget);
        ext.tilingManager.setSmartResizeTarget(dominant, newerSmartTarget);
        const descriptorTarget = ext.tilingManager._descriptorSizeForExisting(dominant);
        const effectiveTarget = ext.tilingManager.getEffectiveWindowSize(dominant);
        assert(!WindowState.has(dominant, 'targetRestoredSize') &&
            descriptorTarget.width === newerSmartTarget.width &&
            descriptorTarget.height === newerSmartTarget.height &&
            effectiveTarget.width === newerSmartTarget.width &&
            effectiveTarget.height === newerSmartTarget.height,
        'A newer Smart Resize target must invalidate and supersede a stale restore-settle size');
        WindowState.remove(dominant, 'targetSmartResizeSize');
        console.log('[DOMINANT TEST] smart-resize target supersedes stale restore bridge');

        const fullscreenWorkspaceCount = global.workspace_manager.get_n_workspaces();
        await enterFullscreen(small);
        assert(await waitFor(() => small.is_fullscreen()),
            'Fullscreen must remain native instead of being normalized into dominant');
        assert(!ext.dominantManager.hasIntentForWindow(small) && !ext.dominantManager.isActive(small),
            'Fullscreen must not create dominant intent or active dominance');
        assert(sameWorkspace(small, workspace, monitor),
            'Fullscreen must stay on the same workspace and monitor');
        assert(global.workspace_manager.get_n_workspaces() === fullscreenWorkspaceCount,
            'Entering fullscreen must not create an overflow workspace');
        await exitFullscreen(small);
        assert(await waitFor(() => !small.is_fullscreen()),
            'Native fullscreen must exit normally');
        assert(!ext.dominantManager.hasIntentForWindow(small) && sameWorkspace(small, workspace, monitor),
            'Exiting fullscreen must not manufacture dominant intent or move the window');
        console.log('[DOMINANT TEST] native fullscreen stays independent of dominant and workspace admission');

        await toggleMaximize(dominant);
        assert(await waitFor(() => ext.dominantManager.isActive(dominant)),
            'Window must become dominant before fullscreen suspension test');

        assert(WindowState.get(small, WindowState.IS_MINIATURE),
            'Scenario setup must retain the historical small window as miniature');
        await enterFullscreen(small);
        assert(await waitFor(() => small.is_fullscreen() && ext.dominantManager.isActive(dominant)),
            'Fullscreen on an unrelated miniature must not replace the active dominant intent');
        await exitFullscreen(small);
        assert(await waitFor(() =>
            !small.is_fullscreen() &&
            ext.dominantManager.isActive(dominant) &&
            WindowState.get(small, WindowState.IS_MINIATURE)),
        'Miniature fullscreen exit must restore the original miniature role');
        console.log('[DOMINANT TEST] miniature → fullscreen → exit preserves miniature role');

        const fullscreenPeer = await createWindow(140, 100);
        assert(await waitFor(() =>
            ext.dominantManager.isActive(dominant) &&
            !WindowState.get(fullscreenPeer, WindowState.IS_MINIATURE) &&
            WindowState.get(fullscreenPeer, WindowState.DOMINANT_KEEP_NORMAL)),
        'Fresh small peer must coexist normally with dominant before fullscreen return test');
        await enterFullscreen(fullscreenPeer);
        assert(await waitFor(() => fullscreenPeer.is_fullscreen() && ext.dominantManager.isActive(dominant)),
            'Fullscreen on an unrelated normal peer must leave dominant intent active');
        const fullscreenFrame = fullscreenPeer.get_frame_rect();
        assert(!ext.miniatureManager.createMiniature(fullscreenPeer, {
            x: fullscreenFrame.x,
            y: fullscreenFrame.y,
            width: 128,
            height: 96,
        }), 'Miniature manager must reject a fullscreen window defensively');
        assert(ext.dominantManager.relayout(workspace, monitor),
            'Dominant relayout must remain valid while an unrelated fullscreen peer is present');
        assert(!WindowState.get(fullscreenPeer, WindowState.IS_MINIATURE),
            'Fullscreen peer must stay outside the dominant miniature rail');
        assert(!ext.dominantManager.hasIntentForWindow(fullscreenPeer),
            'Unrelated fullscreen peer must stay outside the dominant stack');
        await exitFullscreen(fullscreenPeer);
        assert(await waitFor(() =>
            !fullscreenPeer.is_fullscreen() &&
            ext.dominantManager.isActive(dominant) &&
            !WindowState.get(fullscreenPeer, WindowState.IS_MINIATURE) &&
            WindowState.get(fullscreenPeer, WindowState.DOMINANT_KEEP_NORMAL)),
        'Normal fullscreen return must rejoin through dominant-aware admission without disturbing dominant');
        console.log('[DOMINANT TEST] unrelated normal fullscreen exits through dominant-aware admission');

        assert(ext.dominantManager.requestDominance(small, 'manual-maximize'),
            'Historical miniature must be able to become the newest dominant stack intent');
        assert(await waitFor(() =>
            ext.dominantManager.isActive(small) &&
            WindowState.get(dominant, WindowState.IS_MINIATURE)),
        'New stack top must become active and demote the previous dominant');

        // A dormant dominant deliberately keeps native maximize while represented as a
        // miniature. If the active dominant is later unmaximized and the dormant candidate
        // cannot immediately coexist, generic forced-miniature recovery must not restore the
        // dormant window as an ordinary maximized frame on top of the normal layout.
        const forcedBeforeProbe = WindowState.get(dominant, WindowState.DOMINANT_FORCED_MINIATURE);
        const originalManagedWindows = ext.dominantManager._managedWindows.bind(ext.dominantManager);
        const originalDirectRestore = ext.dominantManager._restoreMiniatureDirect.bind(ext.dominantManager);
        const originalCanRestore = ext.tilingManager.canRestoreMiniature.bind(ext.tilingManager);
        let genericStackRestoreCount = 0;
        WindowState.set(dominant, WindowState.DOMINANT_FORCED_MINIATURE, true);
        ext.dominantManager._managedWindows = () => [dominant];
        ext.tilingManager.canRestoreMiniature = () => true;
        ext.dominantManager._restoreMiniatureDirect = (window, ...args) => {
            if (window === dominant) genericStackRestoreCount++;
            return originalDirectRestore(window, ...args);
        };
        try {
            ext.dominantManager._restoreForcedMiniatures(workspace, monitor);
            assert(genericStackRestoreCount === 0 &&
                WindowState.get(dominant, WindowState.IS_MINIATURE) &&
                dominant.is_maximized(),
            'Generic forced-miniature recovery must not restore a maximized dominant-stack window as normal');
        } finally {
            ext.dominantManager._managedWindows = originalManagedWindows;
            ext.dominantManager._restoreMiniatureDirect = originalDirectRestore;
            ext.tilingManager.canRestoreMiniature = originalCanRestore;
            if (!forcedBeforeProbe)
                WindowState.remove(dominant, WindowState.DOMINANT_FORCED_MINIATURE);
        }
        console.log('[DOMINANT TEST] fullscreen and dormant-maximized miniatures cannot cross generic role boundaries');

        assert(ext.miniatureManager.restoreMiniature(fullscreenPeer, null, { reason: 'click' }),
            'Fullscreen lifecycle peer must be restorable as a normal sibling of the new stack top');
        assert(await waitFor(() =>
            !WindowState.get(fullscreenPeer, WindowState.IS_MINIATURE) &&
            WindowState.get(fullscreenPeer, WindowState.DOMINANT_KEEP_NORMAL)),
        'Fullscreen lifecycle peer must be normal before entering fullscreen');

        await enterFullscreen(fullscreenPeer);
        assert(await waitFor(() => fullscreenPeer.is_fullscreen() && ext.dominantManager.isActive(small)),
            'Unrelated fullscreen must leave the current stack top active');
        small.delete(global.get_current_time());
        assert(await waitFor(() => !global.display.list_all_windows().includes(small)),
            'Active stack top must close while unrelated fullscreen is active');
        assert(!ext.dominantManager.hasActive(workspace, monitor) &&
            ext.dominantManager.hasIntentForWindow(dominant),
        'Lower dominant intent must remain dormant while fullscreen blocks reconciliation');

        await exitFullscreen(fullscreenPeer);
        assert(await waitFor(() =>
            !fullscreenPeer.is_fullscreen() &&
            ext.dominantManager.isActive(dominant) &&
            !WindowState.get(fullscreenPeer, WindowState.IS_MINIATURE) &&
            WindowState.get(fullscreenPeer, WindowState.DOMINANT_KEEP_NORMAL)),
        'Fullscreen exit must restore the surviving dominant stack top before normal admission');
        console.log('[DOMINANT TEST] fullscreen exit resumes dormant stack after active dominant closes underneath');

        const dominantWorkspaceCount = global.workspace_manager.get_n_workspaces();
        await enterFullscreen(dominant);
        assert(await waitFor(() =>
            dominant.is_fullscreen() &&
            !ext.dominantManager.isActive(dominant) &&
            ext.dominantManager.hasIntentForWindow(dominant)),
        'Fullscreen on a dominant window must suspend active dominance but preserve maximize intent');
        assert(sameWorkspace(dominant, workspace, monitor) &&
            global.workspace_manager.get_n_workspaces() === dominantWorkspaceCount,
        'Dominant-to-fullscreen transition must remain on the same workspace');
        await exitFullscreen(dominant);
        assert(await waitFor(() =>
            !dominant.is_fullscreen() && ext.dominantManager.isActive(dominant)),
        'Leaving fullscreen must restore the previous maximize-derived dominant intent');
        await toggleMaximize(dominant);
        assert(await waitFor(() =>
            !ext.dominantManager.hasActive(workspace, monitor) &&
            !ext.dominantManager.hasIntentForWindow(dominant)),
        'Dominant must toggle off cleanly after fullscreen suspension/resume');
        console.log('[DOMINANT TEST] maximize → fullscreen → exit preserves only the original maximize intent');

        const fakeUnboundedWindow = {
            get_min_size: () => [true, 686, 168],
            get_max_size: () => [true, 16384, 16384],
        };
        const thresholdArea = ext.tilingManager.getUsableWorkArea(workspace, monitor);
        const threshold = ext.tilingManager._miniatureThreshold(fakeUnboundedWindow, thresholdArea);
        assert(threshold.thresholdW <= thresholdArea.width && threshold.thresholdH <= thresholdArea.height,
            'Unbounded client max-size hints must be clamped to the usable work area');
        console.log('[DOMINANT TEST] unbounded max-size hints cannot poison miniature thresholds');

        const workArea = workspace.get_work_area_for_monitor(monitor);
        assert(ext.edgeTilingManager.applyTile(dominant, TileZone.LEFT_FULL, workArea, true),
            'Edge tiling setup must succeed');
        assert(await waitFor(() => ext.edgeTilingManager.isEdgeTiled(dominant)),
            'Window must enter edge-tiled state before dominant handoff');

        await toggleMaximize(dominant);
        assert(await waitFor(() =>
            ext.dominantManager.isActive(dominant) &&
            !ext.edgeTilingManager.isEdgeTiled(dominant) &&
            dominant.is_maximized() &&
            dominantGeometryMatches(ext, dominant, workspace, monitor)),
        'Dominant entry must atomically release edge-tile ownership without clearing native maximize');
        assertDominantGeometry(ext, dominant, workspace, monitor);
        console.log('[DOMINANT TEST] edge tile ownership hands off atomically to dominant');

        dominant.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === dominant),
            'Dominant must have focus before keyboard resize grab');
        await shortcut(keyboard, Clutter.KEY_Alt_L, Clutter.KEY_F8);
        assert(await waitFor(() =>
            !ext.dominantManager.hasActive(workspace, monitor) &&
            !ext.dominantManager.hasIntent(workspace, monitor)),
        'Manual resize grab must clear active dominance and its stack intent');
        await key(keyboard, Clutter.KEY_Escape, true);
        await key(keyboard, Clutter.KEY_Escape, false);
        assert(dominant.is_maximized(),
            'Cancelling a manual resize grab must not clear the native maximize state');
        console.log('[DOMINANT TEST] manual resize grab exits dominant without restoring intent');

        dominant.unmaximize();
        assert(await waitFor(() => !dominant.is_maximized()),
            'Explicit unmaximize must clear native maximize before re-entry');
        dominant.maximize();
        assert(await waitFor(() =>
            ext.dominantManager.isActive(dominant) &&
            dominant.is_maximized() &&
            dominantGeometryMatches(ext, dominant, workspace, monitor)),
        'Window must be able to enter dominant again after an explicit maximize');
        dominant.activate(global.get_current_time());
        await shortcut(keyboard, Clutter.KEY_Alt_L, Clutter.KEY_F7);
        assert(await waitFor(() =>
            !ext.dominantManager.hasActive(workspace, monitor) &&
            !ext.dominantManager.hasIntent(workspace, monitor)),
        'Manual move grab must clear active dominance and its stack intent');
        await key(keyboard, Clutter.KEY_Escape, true);
        await key(keyboard, Clutter.KEY_Escape, false);
        console.log('[DOMINANT TEST] manual move grab exits dominant without restoring intent');

        console.log('[DOMINANT TEST] PASS: maximize dominance, unified miniature rail, focused compact profile, native fullscreen independence, coexistence, demotion, stack recovery, forced-mini restore, edge handoff, manual move/resize exit');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        await Scripting.destroyTestWindows();
    }
}
