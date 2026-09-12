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
        const max = await create(600, 420);
        const workspace = max.get_workspace();
        const monitor = max.get_monitor();
        const area = workspace.get_work_area_for_monitor(monitor);
        const initialFrame = max.get_frame_rect();
        const normalSize = {width: initialFrame.width, height: initialFrame.height};
        max.maximize();
        await waitFor(() => max.is_maximized() && equalRect(max.get_frame_rect(), area), 'lone native maximize fills usable area');
        max.unmaximize();
        await waitFor(() => !max.is_maximized() && near(max.get_frame_rect().width, normalSize.width), 'unmaximize restores normal width');

        // Regression: repeated switching must not let a maximized miniature restore into a
        // smaller coexistence region just because the normal window would fit beside that
        // smaller rectangle. Start with a full native maximize, then admit a modest normal
        // window whose real minimum can coexist with max's raw client minimum (the old bug).
        max.maximize();
        await waitFor(() => max.is_maximized() && equalRect(max.get_frame_rect(), area),
            'regression setup: maximize owns the full work area');
        const admissionMiniatures = new Set();
        const admissionMiniatureId = ext.miniatureManager.connect('miniature-created', (_manager, window) => {
            admissionMiniatures.add(window);
        });
        const switchPeer = await create(500, 300);
        ext.miniatureManager.disconnect(admissionMiniatureId);
        assert(!admissionMiniatures.has(switchPeer),
            'new normal admission beside a maximized window must never enter the miniature rail');
        assert(admissionMiniatures.has(max) && !mini(switchPeer) && mini(max),
            'normal admission must send the existing maximized window directly to the rail');
        switchPeer.activate(global.get_current_time());
        await waitFor(() => !mini(switchPeer) && mini(max) && max.is_maximized(),
            'regression setup: normal focus miniatures the existing maximized region');
        for (let i = 0; i < 3; i++) {
            assert(ext.miniatureManager.restoreMiniature(max, null, {reason: 'click'}),
                `repeat ${i + 1}: maximized miniature click must be accepted`);
            await waitFor(() => !mini(max) && mini(switchPeer) && max.is_maximized(),
                `repeat ${i + 1}: maximized restore must recover its prior region`);
            await waitFor(() => noOverlap(max.get_frame_rect(), visualRect(switchPeer)),
                `repeat ${i + 1}: maximized restore geometry must settle before scene validation`);
            assertScene([max, switchPeer], area);

            const maxActor = max.get_compositor_private();
            const [actorStartX] = maxActor.get_position();
            assert(ext.miniatureManager.restoreMiniature(switchPeer, null, {reason: 'click'}),
                `repeat ${i + 1}: normal miniature click must be accepted`);
            if (i === 0) {
                // The maximized peer must fly directly toward the solved right-hand rail.
                // The old handoff first animated toward (workArea.x, workArea.y), visibly
                // shrinking at the upper-left before a later retile moved the miniature.
                await Scripting.sleep(40);
                const [pivotX] = maxActor.get_pivot_point();
                const [actorWidth] = maxActor.get_size();
                const visualX = actorStartX + pivotX * actorWidth * (1 - maxActor.scale_x) +
                    maxActor.translation_x;
                assert(visualX > actorStartX + 40,
                    'normal restore must move maximized peer toward its final rail while shrinking');
            }
            await waitFor(() => !mini(switchPeer) && mini(max) && max.is_maximized(),
                `repeat ${i + 1}: normal restore must miniature maximized peer`);
            await waitFor(() => noOverlap(switchPeer.get_frame_rect(), visualRect(max)),
                `repeat ${i + 1}: normal restore geometry must settle before scene validation`);
            assertScene([max, switchPeer], area);
        }
        switchPeer.delete(global.get_current_time());
        await waitFor(() => !global.display.list_all_windows().includes(switchPeer),
            'regression peer must close');
        max.unmaximize();
        await waitFor(() => !max.is_maximized(), 'regression setup must return max to normal');

        const peer = await create(1000, 650);
        // Large normal preference cannot coexist with the maximized minimum on 1200x800.
        State.set(peer, 'preferredSize', {width: area.width - 30, height: area.height - 30});

        // Top-edge drag is maximize intent, not an edge tile. The drag handler commits the
        // native state after grab teardown; MaximizedLayout must then own geometry immediately
        // and leave no zone-7 edgeTilingState behind.
        max.activate(global.get_current_time());
        ext.dragHandler._dropByMaximizing(max);
        await waitFor(() => max.is_maximized() && !mini(max) && mini(peer),
            'top-edge drag maximize must enter maximized layout instead of full-area edge tiling');
        assert(!ext.edgeTilingManager.isEdgeTiled(max),
            'top-edge maximize must never become persistent edge tiling state');
        assert(!equalRect(max.get_frame_rect(), area),
            'top-edge maximize with a peer must reserve the maximized-layout miniature rail');
        assertScene([max, peer], area);
        max.unmaximize();
        await waitFor(() => !max.is_maximized(), 'drag-maximize regression setup must unmaximize cleanly');

        max.activate(global.get_current_time());
        max.maximize();
        await waitFor(() => max.is_maximized() && mini(peer) && near(longEdge(ext, peer), 128), 'focused maximize makes compact miniature');
        await Scripting.sleep(450);
        assertScene([max, peer], area);
        assert(max.get_workspace() === workspace, 'maximize must preserve workspace');
        assertMiniVisual(ext, peer, 128);

        // A role transaction may cancel an in-flight miniature rail move. The cancelled
        // transition must not leave ANIMATING_MINIATURE stuck: in that state the enforce
        // effect deliberately stops correcting the actor while the independent overlay/icon
        // reaches the new slot, which looks like a transparent or overlapping miniature until
        // Overview performs an instant presentation reset.
        const peerSlot = State.get(peer, State.MINIATURE_TARGET_POS);
        const peerSize = ext.miniatureManager.getMiniatureSize(peer);
        const shiftedPeerSlot = {
            x: peerSlot.x,
            y: Math.max(area.y, peerSlot.y - 48),
            width: peerSize.width,
            height: peerSize.height,
        };
        assert(ext.miniatureManager.updateMiniatureLayout(peer, shiftedPeerSlot, {animate: true}),
            'interrupted-move regression must start a miniature rail move');
        await Scripting.sleep(40);
        assert(State.get(peer, State.ANIMATING_MINIATURE),
            'interrupted-move regression must sample the move while it is active');
        ext.animationsManager.claimWindowForRoleTransition(peer);
        assert(ext.miniatureManager.updateMiniatureLayout(peer, shiftedPeerSlot, {animate: true}),
            'role owner must be able to recommit the same target after cancelling its old move');
        await waitFor(() => !State.get(peer, State.ANIMATING_MINIATURE),
            'cancelled miniature move must not leave animation ownership stuck');
        const peerActor = peer.get_compositor_private();
        const peerExtLeft = State.get(peer, State.MINIATURE_EXT_LEFT) ?? 0;
        const peerExtTop = State.get(peer, State.MINIATURE_EXT_TOP) ?? 0;
        const [peerActorX, peerActorY] = peerActor.get_position();
        assert(near(peerActorX + peerActor.translation_x + peerExtLeft * peerActor.scale_x,
            shiftedPeerSlot.x) &&
            near(peerActorY + peerActor.translation_y + peerExtTop * peerActor.scale_y,
            shiftedPeerSlot.y),
        'cancelled miniature move must settle the actor at the same slot as its overlay');
        const peerOverlay = State.get(peer, State.MINIATURE_OVERLAY);
        assert(peerOverlay && near(peerOverlay.x, shiftedPeerSlot.x) &&
            near(peerOverlay.y, shiftedPeerSlot.y),
        'cancelled miniature move must leave overlay and compositor actor on the same slot');

        const otherWorkspace = global.workspace_manager.append_new_workspace(false, global.get_current_time());
        otherWorkspace.activate(global.get_current_time());
        const other = await create(500, 300);
        for (let i = 0; i < 3; i++) {
            workspace.activate_with_focus(max, global.get_current_time());
            await sampleSwitch(ext, peer, 128);
            otherWorkspace.activate_with_focus(other, global.get_current_time());
            await sampleSwitch(ext, peer, 128);
        }
        workspace.activate_with_focus(max, global.get_current_time());
        await sampleSwitch(ext, peer, 128);
        console.log('[MAXIMIZED TEST] workspace switches preserve miniature actor and overlay at every sample');

        Main.overview.show();
        await Scripting.sleep(350);
        Main.overview.hide();
        await sampleSwitch(ext, peer, 128);
        assert(max.is_maximized(), 'Overview must not alter native maximize');

        // A transient gets its parent's focus profile, without shrinking unrelated workspaces.
        const focusedBefore = ext.tilingManager.maximizedLayout.focusFor(workspace, monitor);
        ext.tilingManager.maximizedLayout.onFocusChanged(null);
        assert(ext.tilingManager.maximizedLayout.focusFor(workspace, monitor) === focusedBefore,
            'temporary null focus must preserve local focus');

        // Restoring a large ordinary miniature must not squeeze the already displayed
        // maximized region. The native maximized window stays maximized and moves to the
        // standard 256px rail while the focused normal window gets the remaining area.
        peer.activate(global.get_current_time());
        await waitFor(() => !mini(peer) && mini(max) && max.is_maximized(),
            'ordinary miniature restore must miniature the maximized peer instead of squeezing it');
        await Scripting.sleep(450);
        assertMiniVisual(ext, max, 256);
        assertScene([max, peer], area);

        // Put the original maximized window back on stage before testing max↔max selection.
        max.activate(global.get_current_time());
        await waitFor(() => !mini(max) && mini(peer) && max.is_maximized(),
            'refocusing native maximized miniature must restore maximized presentation');
        await Scripting.sleep(450);
        assertMiniVisual(ext, peer, 128);
        assertScene([max, peer], area);

        // A second native maximized window makes the first a miniature, no history API.
        peer.maximize();
        peer.activate(global.get_current_time());
        await waitFor(() => peer.is_maximized() && !mini(peer) && mini(max), 'focused native maximized peer must replace displayed one');
        assert(max.is_maximized(), 'maximized miniature must keep native state');
        await Scripting.sleep(450);
        assertScene([max, peer], area);
        max.make_fullscreen();
        await waitFor(() => max.is_fullscreen() && equalRect(max.get_frame_rect(), global.display.get_monitor_geometry(monitor)),
            'fullscreen from maximized miniature must release its region');
        max.unmake_fullscreen();
        await waitFor(() => !max.is_fullscreen(), 'fullscreen must exit');
        await Scripting.sleep(450);
        assert(max.is_maximized(), 'fullscreen roundtrip preserves original native maximize');
        assert(max.get_workspace() === workspace, 'fullscreen must not migrate workspace');

        peer.unmaximize();
        peer.activate(global.get_current_time());
        await Scripting.sleep(650);
        assert(!peer.is_maximized(), 'normal focus must stay normal');
        assertScene([max, peer], area);
        if (mini(max)) assertMiniVisual(ext, max, 256);
        // Explicit selection is accepted through the normal miniature gate.
        if (mini(max)) assert(ext.miniatureManager.restoreMiniature(max, null, {reason: 'click'}), 'maximized miniature must restore by click');
        await waitFor(() => !mini(max) && max.is_maximized(), 'selected maximize must be visible');

        if (global.display.get_n_monitors() > 1) {
            const destination = monitor === 0 ? 1 : 0;
            max.move_to_monitor(destination);
            await waitFor(() => max.get_monitor() === destination, 'monitor transfer completes');
            await Scripting.sleep(600);
            assertScene([max], workspace.get_work_area_for_monitor(destination));
            max.move_to_monitor(monitor);
            await Scripting.sleep(600);
        }
        for (let i = 0; i < 3; i++) {
            max.unmaximize(); await Scripting.sleep(350);
            max.maximize(); max.activate(global.get_current_time()); await Scripting.sleep(350);
            assert(max.is_maximized(), 'repeated toggles preserve native state');
        }
        // disableWorkspaceMosaic() performs cleanup after the workspace toggle has recorded
        // the disabled state; mirror that real call order in the direct automation test.
        ext._disabledWorkspaceStates.set(workspace, true);
        ext.disableWorkspaceMosaic(workspace);
        max.maximize();
        const r = max.get_frame_rect();
        max.move_resize_frame(false, r.x, r.y, r.width, r.height);
        await Scripting.sleep(350);
        assert(equalRect(max.get_frame_rect(), area), 'disabled workspace must remove all constraints');
        console.log('[MAXIMIZED TEST] PASS: native modes, focus selection, miniature restore, fullscreen, workspace animation and cleanup');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        for (const w of windows) if (global.display.list_all_windows().includes(w)) w.delete(global.get_current_time());
    }
}
