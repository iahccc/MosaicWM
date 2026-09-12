// Run with scripts/test-headless.sh: use Shell's real idle loop without creating windows.
import Gio from 'gi://Gio';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {MaximizedLayout} from '../extension/maximizedLayout.js';
import {TimeoutRegistry} from '../extension/timing.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function windowFor(id, workspace, monitor = 0, maximized = false) {
    return {
        workspace, monitor, maximized, alive: true,
        get_id() { return id; },
        get_workspace() { return this.workspace; },
        get_monitor() { return this.monitor; },
        get_compositor_private() { return this.alive ? {is_destroyed: () => false} : null; },
        is_maximized() { return this.maximized; },
        is_fullscreen() { return false; },
    };
}

export async function run() {
    // The runner uses an isolated memory settings backend. Keep empty workspaces alive
    // while testing scope ownership without real client windows.
    const mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    const wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
    mutterSettings.set_boolean('dynamic-workspaces', false);
    wmSettings.set_int('num-workspaces', 2);
    await Scripting.sleep(50);
    const registry = new TimeoutRegistry();
    const calls = [];
    const workspace = global.workspace_manager.get_active_workspace();
    const otherWorkspace = global.workspace_manager.get_workspace_by_index(1);
    const normal = windowFor(1, workspace);
    const peer = windowFor(2, workspace);
    const max = windowFor(3, workspace, 0, true);
    const otherMonitor = windowFor(4, workspace, 1);
    const other = windowFor(5, otherWorkspace);
    const dialog = {...windowFor(6, workspace), excluded: true, get_transient_for: () => max};
    let duringRetile = null;
    const layout = new MaximizedLayout({
        _timeoutRegistry: registry,
        isMosaicEnabledForWorkspace: () => true,
        windowingManager: {isExcluded: window => !!window.excluded},
        tilingManager: {
            tileWorkspaceWindows(ws, _reference, monitor) {
                calls.push({workspace: ws, monitor});
                duringRetile?.();
            },
        },
    });
    const flush = () => Scripting.sleep(30);

    try {
        layout.onFocusChanged(normal);
        layout.onFocusChanged(peer);
        await flush();
        assert(calls.length === 0, 'Ordinary focus changes must not retile');
        assert(layout.focusFor(workspace, 0) === peer, 'Skipped retiles must still update logical focus');

        layout.onFocusChanged(max);
        layout.queue(peer);
        layout.queue(max);
        await flush();
        assert(calls.length === 1, 'Focus and native-state requests from different windows must coalesce');
        assert(layout.focusFor(workspace, 0) === max, 'Merged requests must preserve the latest focus');

        calls.length = 0;
        layout.onFocusChanged(max);
        layout.onFocusChanged(dialog);
        layout.onFocusChanged(null);
        await flush();
        assert(calls.length === 0, 'Repeated/transient/null focus must not replay the same presentation');

        layout.onFocusChanged(normal);
        layout.onFocusChanged(peer);
        await flush();
        assert(calls.length === 1, 'Leaving maximized focus must retile exactly once');
        assert(layout.focusFor(workspace, 0) === peer, 'The last normal focus must win before the idle');

        calls.length = 0;
        layout.queue(normal);
        layout.queue(peer);
        layout.queue(otherMonitor);
        layout.queue(other);
        // Moving the first requester must not redirect the origin's already merged request.
        normal.workspace = otherWorkspace;
        layout.queue(normal);
        await flush();
        assert(calls.length === 3, 'Workspaces and monitors must have independent merged requests');
        assert(calls.some(call => call.workspace === workspace && call.monitor === 0), 'Origin must still retile');
        assert(calls.some(call => call.workspace === workspace && call.monitor === 1), 'Other monitor must still retile');
        assert(calls.some(call => call.workspace === otherWorkspace), 'Destination must still retile');
        normal.workspace = workspace;

        calls.length = 0;
        layout.queue(normal);
        layout.queue(peer);
        normal.alive = false;
        await flush();
        assert(calls.length === 1, 'Closing the first requester must not drop a surviving peer request');
        normal.alive = true;

        calls.length = 0;
        duringRetile = () => {
            duringRetile = null;
            layout.queue(peer);
        };
        layout.queue(normal);
        await flush();
        assert(calls.length === 2, 'A notification during a commit must schedule a subsequent pass');

        calls.length = 0;
        layout.queue(normal);
        layout.queue(otherMonitor);
        layout.queue(other);
        layout.clearWorkspace(workspace);
        await flush();
        assert(calls.length === 1 && calls[0].workspace === otherWorkspace,
            'Workspace cleanup must cancel only that workspace’s pending retiles');

        calls.length = 0;
        layout.queue(normal);
        layout.destroy();
        await flush();
        assert(calls.length === 0 && registry.count === 0, 'Destroy must cancel all queued work');
        console.log('[MAXIMIZED QUEUE TEST] PASS: focus filtering, scope coalescing, moves, close, reentrancy and cleanup');
    } finally {
        layout.destroy();
        registry.destroy();
    }
}
