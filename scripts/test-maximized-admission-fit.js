// Run with scripts/test-headless.sh in a private GNOME Shell session.
//
// Regression: a normal window that cannot keep its requested frame beside a native-maximized
// peer must be shrunk into place after admission hands the peer to the rail, not ejected to
// a newly created workspace. The old fit path filtered the maximized peer out of the
// resizable set without noticing the rail handoff, so Smart Resize was skipped and overflow
// claimed the arrival.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
        const arrival = await create(500, 300);
        const workspace = max.get_workspace();
        const monitor = max.get_monitor();
        assert(arrival.get_workspace() === workspace, 'setup windows must share a workspace');
        assert(!mini(max) && !mini(arrival), 'setup must start with two normal windows');
        const usable = ext.tilingManager.getUsableWorkArea(workspace, monitor);

        // Build the admission handoff synchronously, before any queued idle can observe the
        // native maximize: the peer becomes a staged rail seat, and the arrival asks for a
        // frame that cannot stay whole in the workspace.
        max.maximize();
        State.set(arrival, 'preferredSize', {width: usable.width - 60, height: usable.height + 12});
        ext.tilingManager.stagePendingMiniatures(
            [{window: max, preSize: max.get_frame_rect()}], workspace, monitor);
        assert(State.get(max, State.PENDING_MINIATURE), 'maximized peer must be staged for the rail');

        const result = await ext.windowHandler._fitByResizeOrOverflow(arrival, workspace, monitor);
        assert(result === workspace, 'oversized arrival must resolve in its own workspace');
        assert(arrival.get_workspace() === workspace, 'arrival must not migrate workspaces');
        assert(mini(max), 'maximized peer must move to the miniature rail');
        assert(!mini(arrival), 'arrival must remain a normal tiled window');

        await waitFor(() => {
            const frame = arrival.get_frame_rect();
            return frame.width <= usable.width + 3 && frame.height <= usable.height + 3;
        }, 'arrival must be shrunk into the usable area');

        // Exercise admission with committed rail seats as well as the pending seat above.
        // Native-maximized miniatures retain their maximize flag; that must not turn
        // their small presentation back into a full-size admission blocker.
        arrival.maximize();
        await waitFor(() => arrival.is_maximized() && !mini(arrival) && mini(max),
            'maximized arrival must own the main region');
        for (let i = 0; i < 3; i++) {
            const peer = await create(500, 300);
            assert(peer.get_workspace() === workspace, 'rail setup must remain local');
            peer.maximize();
            await waitFor(() => peer.is_maximized() && !mini(peer) &&
                windows.every(w => w === peer || mini(w)),
            'each maximized peer must send the previous peers to the rail');
        }
        const maximizedPeers = [...windows];
        // PerfHelper uses its requested dimensions as GTK minimums. Map a resizable
        // client first, then replay admission with the large preferred startup size.
        const newcomer = await create(400, 260);
        State.set(newcomer, 'preferredSize', {
            width: Math.floor(usable.width * 0.88), height: Math.floor(usable.height * 0.88),
        });
        State.remove(newcomer, 'isConstrainedByMosaic');
        State.remove(newcomer, 'targetSmartResizeSize');
        State.remove(newcomer, 'targetRestoredSize');
        const admitted = await ext.windowHandler._fitByResizeOrOverflow(newcomer, workspace, monitor);
        assert(admitted === workspace, 'committed maximized rail seats must allow local smart resize');
        await Scripting.sleep(350);
        assert(!newcomer.is_maximized(), 'regression requires a normal arriving window');
        assert(newcomer.get_workspace() === workspace,
            'large normal arrival beside native-maximized miniatures must not overflow');
        assert(!State.get(newcomer, 'movedByOverflow') && !mini(newcomer),
            'newcomer must stay in the normal presentation throughout admission');
        await waitFor(() => maximizedPeers.every(w => w.is_maximized() && mini(w)),
            'all maximized peers must retain native mode in the miniature rail');
        assert(State.get(newcomer, 'isConstrainedByMosaic'),
            'smart resize must fit the newcomer beside the reserved rail');
        console.log('[MAXIMIZED ADMISSION FIT TEST] PASS: oversized arrival settles beside a rail-handoff maximized peer');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        for (const w of windows) if (global.display.list_all_windows().includes(w)) w.delete(global.get_current_time());
    }
}
