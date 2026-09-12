// Run with scripts/test-headless.sh in a private GNOME Shell session.
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
function near(a, b) { return Math.abs(a - b) < 3; }
function rectCopy(rect) {
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, rect[key]]));
}

// Inspect painted frames, including the first one after the native resize request.
// Checking only the final MetaWindow frame misses an oversized stale client buffer.
async function checkUnmaximize(ext, window, expectedSize) {
    await Scripting.sleep(400);
    const actor = window.get_compositor_private();
    const source = rectCopy(window.get_frame_rect());
    const samples = [];
    const paintId = global.stage.connect('after-paint', () => {
        const [width, height] = actor.get_transformed_size();
        samples.push({width, height});
    });
    try {
        window.unmaximize();
        await Scripting.sleep(450);
    } finally {
        global.stage.disconnect(paintId);
    }
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
        await checkUnmaximize(ext, max, normalSize);
        const peers = [await create(500, 300)];
        for (let i = 0; i < 3; i++) {
            await maximize(peers);
            await checkUnmaximize(ext, max, normalSize);
        }
        peers.push(await create(400, 280));
        await maximize(peers);
        await checkUnmaximize(ext, max, normalSize);
        console.log('[UNMAXIMIZE ANIMATION TEST] PASS: native restore starts from the visible region with zero, one and multiple miniature peers');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        for (const w of windows) if (global.display.list_all_windows().includes(w)) w.delete(global.get_current_time());
    }
}
