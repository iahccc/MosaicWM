// Run with scripts/test-headless.sh in a private GNOME Shell session.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as State from '../extension/windowState.js';
import {TileZone} from '../extension/constants.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
async function waitFor(predicate, message, timeout = 6000) {
    const end = GLib.get_monotonic_time() + timeout * 1000;
    while (!predicate() && GLib.get_monotonic_time() < end) await Scripting.sleep(30);
    assert(predicate(), message);
}
const mini = w => !!State.get(w, State.IS_MINIATURE);
function longEdge(ext, window) {
    const size = ext.miniatureManager.getMiniatureSize(window);
    return size ? Math.max(size.width, size.height) : 0;
}
function near(a, b) { return Math.abs(a - b) < 3; }
function equalRect(a, b) { return ['x', 'y', 'width', 'height'].every(k => near(a[k], b[k])); }
function visualRect(w) {
    if (!mini(w)) return w.get_frame_rect();
    const source = State.get(w, State.PRE_MINIATURE_SIZE);
    const scale = State.get(w, State.MINIATURE_SCALE);
    const target = State.get(w, State.MINIATURE_TARGET_POS);
    return {...target, width: source.width * scale, height: source.height * scale};
}
function noOverlap(a, b) {
    return a.x + a.width <= b.x + 3 || b.x + b.width <= a.x + 3 ||
        a.y + a.height <= b.y + 3 || b.y + b.height <= a.y + 3;
}
function assertScene(windows, area) {
    const rects = windows.map(visualRect);
    for (const r of rects) assert(r.x >= area.x - 3 && r.y >= area.y - 3 &&
        r.x + r.width <= area.x + area.width + 3 && r.y + r.height <= area.y + area.height + 3,
    `window must stay inside work area: ${JSON.stringify(r)}`);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++)
        assert(noOverlap(rects[i], rects[j]), `windows must not overlap: ${JSON.stringify(rects)}`);
}
function assertMiniVisual(ext, w, size) {
    assert(near(longEdge(ext, w), size), `miniature must remain ${size}px`);
    const source = State.get(w, State.PRE_MINIATURE_SIZE);
    const actor = w.get_compositor_private();
    const overlay = State.get(w, State.MINIATURE_OVERLAY);
    assert(near(Math.max(source.width, source.height) * actor.scale_x, size),
        'actor must not replay a scale transition while switching workspaces');
    const [ow, oh] = overlay.get_size();
    assert(near(Math.max(ow, oh), size), 'click overlay must match miniature throughout switch');
}
async function sampleSwitch(ext, peer, size, duration = 500) {
    const end = GLib.get_monotonic_time() + duration * 1000;
    while (GLib.get_monotonic_time() < end) {
        assertMiniVisual(ext, peer, size);
        await Scripting.sleep(16);
    }
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
        const max = await create(400, 260);
        const peer = await create(320, 220);
        const edge = await create(320, 220);
        const workspace = max.get_workspace(), monitor = max.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const area = Object.fromEntries(['x', 'y', 'width', 'height'].map(axis => [axis, workArea[axis]]));
        // Equal-sized peer strips at different origins must not share absolute coordinates.
        const items = [{id: peer.get_id(), width: 128, height: 96}];
        const strip = {x: area.x + 8, y: area.y + area.height - 120, width: 500, height: 112};
        const movedStrip = {...strip, x: strip.x + 100, y: strip.y - 120};
        const tiling = ext.tilingManager;
        tiling.invalidateLayoutCache();
        assert(tiling.packMaximizedPeers(items, strip, false).fits, 'first peer strip must fit');
        const moved = tiling.packMaximizedPeers(items, movedStrip, false);
        assert(moved.fits && [...moved.slots.values()].every(r =>
            r.x >= movedStrip.x && r.y >= movedStrip.y &&
            r.x + r.width <= movedStrip.x + movedStrip.width &&
            r.y + r.height <= movedStrip.y + movedStrip.height),
        'peer strip must use its current origin, not coordinates cached for the bottom strip');
        const resized = tiling.packMaximizedPeers([{...items[0], height: 97}], movedStrip, false);
        assert(resized.fits && resized.slots.get(peer.get_id()).height === 97,
            'peer packing must retain a one-pixel footprint change near the fit boundary');
        tiling.invalidateLayoutCache();
        max.activate(global.get_current_time());
        max.maximize();
        await waitFor(() => max.is_maximized() && !mini(max) && mini(peer) && mini(edge),
            'maximized focus must miniature ordinary peers');
        ext.miniatureManager.restoreMiniature(edge, null,
            {activate: false, layoutBypass: true, instant: true});
        assert(ext.edgeTilingManager.applyTile(edge, TileZone.LEFT_FULL, area, true), 'left edge tile must fit');
        await waitFor(() => ext.edgeTilingManager.isEdgeTiled(edge) && near(edge.get_frame_rect().x, area.x),
            'edge tile must settle');
        max.activate(global.get_current_time());
        ext.tilingManager.maximizedLayout.reconcile(workspace, monitor);
        await waitFor(() => max.get_frame_rect().x >= edge.get_frame_rect().x + edge.get_frame_rect().width,
            'main region must respect the reserved edge area');
        await Scripting.sleep(500);
        assertScene([max, peer, edge], area);
        assert(near(longEdge(ext, peer), 128), 'edge layout must keep the same miniature floor');

        const edgeManager = ext.edgeTilingManager;
        const getEdges = edgeManager.getEdgeTiledWindows;
        edgeManager.getEdgeTiledWindows = () => [
            {zone: TileZone.LEFT_FULL, window: {get_frame_rect: () => ({...area, width: area.width / 2})}},
            {zone: TileZone.RIGHT_FULL, window: {get_frame_rect: () =>
                ({...area, x: area.x + area.width / 2, width: area.width / 2})}},
        ];
        try { assert(ext.tilingManager.getUsableWorkArea(workspace, monitor).width === 0,
            'both edge reservations must bound the maximum region'); }
        finally { edgeManager.getEdgeTiledWindows = getEdges; }

        const nav = ext.keyboardNavigator, active = nav.isTransitionActive;
        const sceneSnapshot = () => JSON.stringify([max, peer].map(w => {
            const rect = visualRect(w);
            return Object.fromEntries(['x', 'y', 'width', 'height'].map(axis => [axis, rect[axis]]));
        }));
        const before = sceneSnapshot();
        nav.isTransitionActive = () => true;
        try {
            peer.activate(global.get_current_time());
            ext.tilingManager.retileWithAllocation(workspace, monitor);
            await Scripting.sleep(100);
            assert(mini(peer) && sceneSnapshot() === before,
                'navigation preview must suppress automatic restoration and relayout');
        } finally { nav.isTransitionActive = active; }
        max.activate(global.get_current_time());

        // Refuse peer packing to exercise the same fallback as a workspace full at 128px.
        const pack = ext.tilingManager.packMaximizedPeers;
        ext.tilingManager.packMaximizedPeers = () => ({fits: false});
        try {
            ext.tilingManager.maximizedLayout.reconcile(workspace, monitor, {focus: max});
            await waitFor(() => peer.get_workspace() !== workspace || edge.get_workspace() !== workspace,
                'floor overflow must migrate a cold peer');
        } finally { ext.tilingManager.packMaximizedPeers = pack; }
        assert(max.get_workspace() === workspace && max.is_maximized() && !mini(max),
            'overflow must protect the main window and its native maximize state');
        ext.tilingManager.maximizedLayout.reconcile(workspace, monitor, {focus: max});
        await Scripting.sleep(500);
        assertScene(windows.filter(w => w.get_workspace() === workspace), area);
        console.log('[MAXIMIZED BOUNDARIES TEST] PASS: edge reservations, navigation preview and protected overflow');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        for (const w of windows) if (global.display.list_all_windows().includes(w)) w.delete(global.get_current_time());
        // Drain Wayland destruction before Scripting synchronously exits PerfHelper.
        await Scripting.sleep(500);
    }
}
