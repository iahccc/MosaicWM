// Real Firefox regression for unbounded max-size hints + explicit miniature restore.
// Runs in an isolated headless GNOME Shell session with a disposable Firefox profile.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as WindowState from '../extension/windowState.js';

const WAIT_MS = 15000;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function waitFor(predicate, timeoutMs = WAIT_MS) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (predicate()) return true;
        await Scripting.sleep(75);
    }
    return predicate();
}

async function key(keyboard, symbol, down, delay = 70) {
    keyboard.notify_keyval(GLib.get_monotonic_time(), symbol,
        down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    await Scripting.sleep(delay);
}

async function shortcutCtrlN(keyboard) {
    await key(keyboard, Clutter.KEY_Control_L, true);
    await key(keyboard, Clutter.KEY_n, true);
    await key(keyboard, Clutter.KEY_n, false);
    await key(keyboard, Clutter.KEY_Control_L, false, 150);
}

function firefoxWindows(pid) {
    return global.display.list_all_windows().filter(window =>
        window.get_pid() === pid && window.get_wm_class()?.toLowerCase().includes('firefox'));
}

function launchFirefox(profile) {
    return Gio.Subprocess.new([
        'firefox', '--no-remote', '--profile', profile, '--new-window', 'about:blank',
    ], Gio.SubprocessFlags.NONE);
}

function frameDiffersFromTarget(frame, target, tolerance = 2) {
    return Math.abs(frame.x - target.x) > tolerance ||
        Math.abs(frame.y - target.y) > tolerance ||
        Math.abs(frame.width - target.width) > tolerance ||
        Math.abs(frame.height - target.height) > tolerance;
}

async function waitForAdmission(window) {
    return waitFor(() =>
        !WindowState.get(window, 'arrivalPending') &&
        !WindowState.get(window, 'pendingInQueue'));
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

    const tempProfiles = [];
    const children = [];
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

    try {
        // First-open visibility regression. Exercise the exact firstPlacement animation path
        // against a real Firefox surface with a deliberately smaller planned frame. Firefox
        // acknowledges move_resize_frame asynchronously, so there is a deterministic interval
        // where the planner target and live buffer differ. The actor must remain hidden for that
        // whole interval; mapping alone is not permission to expose stale oversized geometry.
        const probeProfile = `${GLib.get_tmp_dir()}/mosaic-firefox-probe-${GLib.get_monotonic_time()}`;
        tempProfiles.push(probeProfile);
        GLib.mkdir_with_parents(probeProfile, 0o700);
        const probeChild = launchFirefox(probeProfile);
        children.push(probeChild);
        const probePid = Number(probeChild.get_identifier());
        let probe = null;
        assert(await waitFor(() => {
            probe = firefoxWindows(probePid)[0] ?? null;
            return !!probe;
        }), 'Probe Firefox must create its first window');
        assert(await waitForAdmission(probe), 'Probe Firefox must finish ordinary admission before entrance-gate setup');
        const probeActor = probe.get_compositor_private();
        assert(probeActor, 'Probe Firefox must have a compositor actor');
        const probeFrame = probe.get_frame_rect();
        const probeTarget = {
            x: probeFrame.x,
            y: probeFrame.y,
            width: Math.max(700, probeFrame.width - 120),
            height: Math.max(300, probeFrame.height - 80),
        };
        let targetAckSnapshot = null;
        const probeSizeChangedId = probe.connect('size-changed', () => {
            const frame = probe.get_frame_rect();
            if (frameDiffersFromTarget(frame, probeTarget) || targetAckSnapshot) return;
            const buffer = probe.get_buffer_rect();
            targetAckSnapshot = {
                frame: {...frame},
                buffer: {x: buffer.x, y: buffer.y, width: buffer.width, height: buffer.height},
                actorX: probeActor.x,
                actorY: probeActor.y,
                actorWidth: probeActor.width,
                actorHeight: probeActor.height,
                opacity: probeActor.opacity,
            };
        });
        probeActor.opacity = 0;
        WindowState.set(probe, 'pendingFirstPlacement', true);
        ext.animationsManager.animateWindow(probe, probeTarget, {firstPlacement: true});

        const liveAfterConfigure = probe.get_frame_rect();
        assert(frameDiffersFromTarget(liveAfterConfigure, probeTarget),
            'Real Firefox must expose an asynchronous configure interval for first-placement gating');
        assert(probeActor.opacity === 0,
            `Fresh Firefox must stay hidden while live ${liveAfterConfigure.width}x${liveAfterConfigure.height} has not committed target ${probeTarget.width}x${probeTarget.height}`);
        assert(probeActor.scale_x <= 1.001 && probeActor.scale_y <= 1.001,
            `Fresh Firefox entrance must not preserve its oversized spawn geometry as actor scale (${probeActor.scale_x.toFixed(3)}x${probeActor.scale_y.toFixed(3)})`);
        console.log(`[FIREFOX MINIATURE TEST] first-open gate live=${liveAfterConfigure.width}x${liveAfterConfigure.height}, target=${probeTarget.width}x${probeTarget.height}, opacity=${probeActor.opacity}`);

        assert(await waitFor(() => {
            const actor = probe.get_compositor_private();
            return actor?.opacity === 255 && !WindowState.get(probe, 'pendingFirstPlacement');
        }), 'Firefox entrance must become visible after its planned geometry commits');
        probe.disconnect(probeSizeChangedId);
        assert(targetAckSnapshot, 'Firefox must emit a logical target-size ack during the first-placement probe');
        const actorLaggedAtFrameAck =
            Math.abs(targetAckSnapshot.actorWidth - targetAckSnapshot.buffer.width) > 2 ||
            Math.abs(targetAckSnapshot.actorHeight - targetAckSnapshot.buffer.height) > 2 ||
            Math.abs(targetAckSnapshot.actorX - targetAckSnapshot.buffer.x) > 2 ||
            Math.abs(targetAckSnapshot.actorY - targetAckSnapshot.buffer.y) > 2;
        assert(actorLaggedAtFrameAck,
            'Real Firefox probe must exercise the frame-rect-before-actor-allocation race');
        assert(targetAckSnapshot.opacity === 0,
            'Firefox must remain hidden when logical frame is ready but compositor allocation is stale');
        const committedBuffer = probe.get_buffer_rect();
        assert(Math.abs(probeActor.width - committedBuffer.width) <= 2 &&
            Math.abs(probeActor.height - committedBuffer.height) <= 2 &&
            Math.abs(probeActor.x - committedBuffer.x) <= 2 &&
            Math.abs(probeActor.y - committedBuffer.y) <= 2,
        'Firefox may become visible only after actor allocation catches up with the committed buffer');
        console.log(`[FIREFOX MINIATURE TEST] target ack actor=${targetAckSnapshot.actorWidth}x${targetAckSnapshot.actorHeight}@${targetAckSnapshot.actorX},${targetAckSnapshot.actorY} buffer=${targetAckSnapshot.buffer.width}x${targetAckSnapshot.buffer.height}@${targetAckSnapshot.buffer.x},${targetAckSnapshot.buffer.y} opacity=${targetAckSnapshot.opacity}`);
        console.log('[FIREFOX MINIATURE TEST] first-open stale geometry cannot cover existing windows');

        probeChild.force_exit();
        assert(await waitFor(() => !global.display.list_all_windows().includes(probe)),
            'Probe Firefox must close before cold two-window regression');

        const profile = `${GLib.get_tmp_dir()}/mosaic-firefox-${GLib.get_monotonic_time()}`;
        tempProfiles.push(profile);
        GLib.mkdir_with_parents(profile, 0o700);
        const child = launchFirefox(profile);
        children.push(child);
        const pid = Number(child.get_identifier());

        let first = null;
        assert(await waitFor(() => {
            first = firefoxWindows(pid)[0] ?? null;
            return !!first;
        }), 'Firefox must create its first window');
        // Stress the real cold-start race: request the second Firefox window as soon as the
        // first MetaWindow exists, before Mosaic's first-window admission has necessarily settled.
        const firstWasPendingAtSecondLaunch = !!(WindowState.get(first, 'arrivalPending') || WindowState.get(first, 'pendingInQueue'));
        const workspace = first.get_workspace();
        const monitor = first.get_monitor();
        const workspaceCount = global.workspace_manager.get_n_workspaces();

        first.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === first),
            'First Firefox window must receive focus before Ctrl+N');
        await shortcutCtrlN(keyboard);
        console.log(`[FIREFOX MINIATURE TEST] second launch while firstPending=${firstWasPendingAtSecondLaunch}`);

        assert(await waitFor(() => firefoxWindows(pid).length >= 2),
            'Ctrl+N must create a second Firefox window');
        const pair = firefoxWindows(pid).slice(0, 2);
        const second = pair.find(window => window !== first);
        assert(await waitForAdmission(first), 'First Firefox window must eventually finish Mosaic admission');
        assert(second && await waitForAdmission(second),
            'Second Firefox window must finish Mosaic admission');
        assert(pair.every(window => window.get_workspace() === workspace && window.get_monitor() === monitor),
            'Both Firefox windows must remain on the same workspace and monitor');
        assert(global.workspace_manager.get_n_workspaces() === workspaceCount,
            'Two Firefox windows must not create an overflow workspace');

        assert(await waitFor(() => pair.filter(window =>
            WindowState.get(window, WindowState.IS_MINIATURE)).length === 1),
        'Exactly one of two Firefox windows must become miniature');
        let miniature = pair.find(window => WindowState.get(window, WindowState.IS_MINIATURE));
        let normal = pair.find(window => window !== miniature);
        const workArea = ext.tilingManager.getUsableWorkArea(workspace, monitor);

        // Exercise the real focus path immediately, while the fresh miniature focus guard
        // may still be armed. This is the cold-start interaction that a direct manager call misses.
        normal.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === normal),
            'Normal Firefox sibling must be focused before focus-switch regression');
        const guardWasArmed = !!WindowState.get(miniature, 'justMiniaturized');
        miniature.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === miniature),
            'Fresh Firefox miniature must receive requested focus');
        const focusSwapped = await waitFor(() =>
            !WindowState.get(miniature, WindowState.IS_MINIATURE) &&
            WindowState.get(normal, WindowState.IS_MINIATURE), 1200);
        console.log(`[FIREFOX MINIATURE TEST] immediate focus guardArmed=${guardWasArmed} swapped=${focusSwapped}`);
        assert(focusSwapped,
            'Immediately focusing a fresh Firefox miniature must swap the miniature, not drop the user intent');

        [miniature, normal] = [normal, miniature];
        const maxSize = ext.tilingManager.getWindowMaximumSize(miniature);
        const threshold = ext.tilingManager._miniatureThreshold(miniature, workArea);
        assert(threshold.thresholdW <= workArea.width && threshold.thresholdH <= workArea.height,
            `Firefox max-size hint ${maxSize?.width}x${maxSize?.height} must not inflate miniature threshold beyond work area`);
        console.log(`[FIREFOX MINIATURE TEST] max=${maxSize?.width}x${maxSize?.height}, threshold=${Math.round(threshold.thresholdW)}x${Math.round(threshold.thresholdH)}`);

        assert(pair.every(window => window.get_workspace() === workspace),
            'Firefox miniature swap must remain in the original workspace');
        assert(!ext.tilingManager._isSmartResizingBlocked,
            'Firefox restore must leave Smart Resize unblocked');

        assert(ext.miniatureManager.restoreMiniature(miniature, null, { reason: 'keyboard' }),
            'Second Firefox restore must also be accepted');
        assert(await waitFor(() =>
            !WindowState.get(miniature, WindowState.IS_MINIATURE) &&
            WindowState.get(normal, WindowState.IS_MINIATURE)),
        'Firefox miniature restoration must remain reversible');

        // The sibling just became miniature again. Focus it during the guard, then deliberately
        // leave before the deferred confirmation. The stale request must not bounce it back out.
        [miniature, normal] = [normal, miniature];
        assert(WindowState.get(miniature, 'justMiniaturized'),
            'Cancellation regression must run while the fresh miniature guard is armed');
        miniature.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === miniature),
            'Fresh miniature must receive focus before cancellation');
        normal.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === normal),
            'Moving focus away must cancel the deferred restore condition');
        await Scripting.sleep(650);
        assert(WindowState.get(miniature, WindowState.IS_MINIATURE) &&
            !WindowState.get(miniature, 'deferredMiniatureFocusRestoreId'),
        'A deferred fresh-miniature focus restore must expire harmlessly after focus moves away');
        console.log('[FIREFOX MINIATURE TEST] PASS: cold-start focus restore is deferred, reversible, and cancellation-safe');
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
        try {
            await Scripting.destroyTestWindows();
        } catch {
            // Test helper cleanup is best-effort.
        }
        for (const profile of tempProfiles) {
            try {
                Gio.Subprocess.new(['rm', '-rf', profile], Gio.SubprocessFlags.NONE).wait(null);
            } catch {
                // Disposable /tmp profile cleanup is best-effort.
            }
        }
    }
}
