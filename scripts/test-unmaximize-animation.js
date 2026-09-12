// Run with scripts/test-headless.sh in a private GNOME Shell session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as State from '../extension/windowState.js';
import {MosaicConstraints} from '../extension/mosaicConstraint.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
async function waitFor(predicate, message, timeout = 6000) {
    const end = GLib.get_monotonic_time() + timeout * 1000;
    while (!predicate() && GLib.get_monotonic_time() < end) await Scripting.sleep(30);
    assert(predicate(), message);
}
const mini = w => !!State.get(w, State.IS_MINIATURE);
function near(a, b) { return Math.abs(a - b) < 3; }
function rectCopy(rect) {
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, rect[key]]));
}
function paintedRect(window) {
    const actor = window.get_compositor_private();
    return [...actor.get_transformed_position(), ...actor.get_transformed_size()];
}
function miniatureGoal(window) {
    const target = State.get(window, State.MINIATURE_TARGET_POS);
    return [target.x, target.y, State.get(window, State.MINIATURE_SCALE)];
}

// Inspect painted frames, including the first one after the native resize request.
// Checking only the final MetaWindow frame misses an oversized stale client buffer.
async function checkUnmaximize(ext, window, expectedSize, peers = []) {
    await Scripting.sleep(400);
    const actor = window.get_compositor_private();
    const source = rectCopy(window.get_frame_rect());
    const samples = [];
    const peerSources = new Map(peers.map(w => {
        const a = w.get_compositor_private();
        return [w, [...a.get_transformed_position(), ...a.get_transformed_size()]];
    }));
    const movingPeersDuringRestore = new Set();
    const jumps = [];
    const miniatureManager = ext.miniatureManager;
    const reshrink = miniatureManager.reshrinkMiniature;
    const move = ext.tilingManager._animateMiniatureRegion;
    function inspectRetarget(window, operation) {
        const before = paintedRect(window);
        const result = operation();
        const after = paintedRect(window);
        if (after.some((value, i) => Math.abs(value - before[i]) > 1))
            jumps.push({id: window.get_id(), before, after});
        return result;
    }
    miniatureManager.reshrinkMiniature = function (window, ...args) {
        return inspectRetarget(window, () => reshrink.call(this, window, ...args));
    };
    ext.tilingManager._animateMiniatureRegion = function (window, ...args) {
        return inspectRetarget(window, () => move.call(this, window, ...args));
    };
    let flushedDuringRestore = false;
    let nativeRetiles = 0;
    const commit = MosaicConstraints.commitRegion;
    MosaicConstraints.commitRegion = function (target, ...args) {
        if (target === window && actor.__animationInfo && !window.is_maximized()) nativeRetiles++;
        return commit.call(this, target, ...args);
    };
    const paintId = global.stage.connect('after-paint', () => {
        const [width, height] = actor.get_transformed_size();
        samples.push({width, height});
        if (actor.__animationInfo) {
            if (!flushedDuringRestore && State.get(window, State.NATIVE_SIZE_RETURN)) {
                ext.mosaicRenderer.flushToWindows(window.get_workspace(), window.get_monitor());
                flushedDuringRestore = true;
            }
            for (const peer of peers) {
                const a = peer.get_compositor_private();
                const painted = [...a.get_transformed_position(), ...a.get_transformed_size()];
                if (painted.some((value, i) => Math.abs(value - peerSources.get(peer)[i]) > 1))
                    movingPeersDuringRestore.add(peer);
            }
        }
    });
    try {
        window.unmaximize();
        const continuations = peers.filter(mini).map(peer => ({
            window: peer,
            goal: miniatureGoal(peer),
            transition: peer.get_compositor_private().get_transition('scale-x'),
        }));
        // Native size notifications can replay the same layout before the next paint.
        ext.tilingManager.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), true);
        for (const continuation of continuations) {
            const goal = miniatureGoal(continuation.window);
            if (continuation.transition && goal.every((value, i) => value === continuation.goal[i]))
                assert(continuation.window.get_compositor_private().get_transition('scale-x') === continuation.transition,
                    'replaying the same miniature layout must retain the running scale transition');
        }
        await Scripting.sleep(450);
    } finally {
        global.stage.disconnect(paintId);
        MosaicConstraints.commitRegion = commit;
        miniatureManager.reshrinkMiniature = reshrink;
        ext.tilingManager._animateMiniatureRegion = move;
    }
    assert(jumps.length === 0,
        `miniature move/resize retargeting must preserve the live painted rectangle: ${JSON.stringify(jumps)}`);
    assert(nativeRetiles === 0, 'ordinary layout must not move or resize a window during its native unmaximize animation');
    assert(peers.every(w => movingPeersDuringRestore.has(w)),
        'miniature peers must begin their painted transition before the native restore animation finishes');
    assert(samples.length > 0, 'unmaximize must paint frames');
    // Restored CSD shadows are included in the actor bounds; allow their scaled extents.
    const limit = {width: Math.max(source.width, expectedSize.width) + 80,
        height: Math.max(source.height, expectedSize.height) + 80};
    for (const sample of samples)
        assert(sample.width <= limit.width && sample.height <= limit.height,
            `unmaximize must start from the visible region, without enlarging the old buffer: ${JSON.stringify({source, sample, limit})}`);
    const frame = window.get_frame_rect();
    assert(!window.is_maximized() && near(frame.width, expectedSize.width) &&
        near(frame.height, expectedSize.height), 'unmaximize must restore the normal size');
    assert(near(actor.scale_x, 1) && near(actor.scale_y, 1) &&
        near(actor.translation_x, 0) && near(actor.translation_y, 0),
    'unmaximize must finish with no actor transform');
    assert(!actor.__animationInfo && !ext.animationsManager.hasActiveAnimations(),
        'native and Mosaic animation ownership must settle');
    assert(!mini(window) && !State.get(window, State.NATIVE_SIZE_RETURN) &&
        ext.windowHandler._nativeReturns.size === 0,
    'native return must finish as an ordinary window and release its deferred transaction');
}

export async function run() {
    const extensionPath = GLib.getenv('MOSAIC_TEST_EXTENSION_DIR');
    const dir = Gio.File.new_for_path(extensionPath);
    const metadata = JSON.parse(new TextDecoder().decode(dir.get_child('metadata.json').load_contents(null)[1]));
    const ext = new Mosaic({...metadata, dir, path: extensionPath});
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    const stylesheet = dir.get_child('stylesheet.css');
    theme.load_stylesheet(stylesheet);
    ext.enable();
    Main.overview.hide();
    await Scripting.sleep(700);
    const windows = [];
    const interrupted = [];
    const manager = ext.animationsManager;
    const claim = manager.claimWindowForRoleTransition;
    manager.claimWindowForRoleTransition = function (window) {
        const actor = window.get_compositor_private();
        const native = actor?.__animationInfo;
        const wasMiniature = mini(window);
        claim.call(this, window);
        if (native && !wasMiniature && actor.__animationInfo !== native)
            interrupted.push(window.get_id());
    };
    async function create(width, height) {
        const before = new Set(global.display.list_all_windows());
        await Scripting.createTestWindow({width, height});
        await Scripting.waitTestWindows();
        const w = global.display.list_all_windows().find(w => !before.has(w));
        assert(w, 'test client must map');
        windows.push(w);
        await waitFor(() => !State.get(w, 'arrivalPending') && !State.get(w, 'pendingInQueue'), 'window must finish admission');
        await Scripting.sleep(350);
        return w;
    }
    try {
        const max = await create(600, 420);
        const normalSize = rectCopy(max.get_frame_rect());
        const area = max.get_workspace().get_work_area_for_monitor(max.get_monitor());
        async function maximize(peers) {
            max.activate(global.get_current_time());
            max.maximize();
            await waitFor(() => max.is_maximized() && !mini(max) && peers.every(mini),
                'maximize must show the main window and miniature its peers');
            await Scripting.sleep(400);
            if (peers.length)
                assert(max.get_frame_rect().width < area.width || max.get_frame_rect().height < area.height,
                    'miniature peers must reserve space beside the maximized window');
        }
        await maximize([]);
        assert(interrupted.length === 0, 'maximized layout must not cancel the native maximize animation');
        await checkUnmaximize(ext, max, normalSize);
        const peers = [await create(500, 300)];
        for (let i = 0; i < 3; i++) {
            await maximize(peers);
            await checkUnmaximize(ext, max, normalSize, peers);
        }
        peers.push(await create(400, 280));
        await maximize(peers);
        await checkUnmaximize(ext, max, normalSize, peers);
        peers.push(await create(600, 450));
        await maximize(peers);
        await checkUnmaximize(ext, max, normalSize, peers);
        console.log('[UNMAXIMIZE ANIMATION TEST] PASS: native restore starts from the visible region with zero, one and multiple miniature peers');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        for (const w of windows) if (global.display.list_all_windows().includes(w)) w.delete(global.get_current_time());
        // Drain Wayland destruction before Scripting synchronously exits PerfHelper.
        await Scripting.sleep(500);
    }
}
