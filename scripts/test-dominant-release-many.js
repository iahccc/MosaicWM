// Multi-window visual-transition regression for dominant release.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import Mosaic from '../extension/extension.js';
import * as WindowState from '../extension/windowState.js';

const WAIT_MS = 10000;
const EPSILON = 3;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeoutMs = WAIT_MS) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (predicate()) return true;
        await Scripting.sleep(30);
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

function overlaps(a, b) {
    return a.x < b.x + b.width - EPSILON && b.x < a.x + a.width - EPSILON &&
        a.y < b.y + b.height - EPSILON && b.y < a.y + a.height - EPSILON;
}

function actorVisualRect(window) {
    const actor = window.get_compositor_private();
    if (!actor || actor.is_destroyed() || actor.opacity === 0) return null;
    const frame = window.get_frame_rect();
    const extX = frame.x - actor.x;
    const extY = frame.y - actor.y;
    return {
        // Meta's frame and Clutter's actor allocation are different coordinate boxes
        // (Alacritty commonly has a 35px vertical decoration delta). Reconstruct the
        // transformed frame exactly like MiniatureManager does instead of treating the
        // actor content allocation itself as the window frame.
        x: actor.x + actor.translation_x + extX * actor.scale_x,
        y: actor.y + actor.translation_y + extY * actor.scale_y,
        width: frame.width * actor.scale_x,
        height: frame.height * actor.scale_y,
    };
}

function firstVisualOverlap(windows) {
    const rects = windows.map(window => ({window, rect: actorVisualRect(window)}))
        .filter(entry => entry.rect);
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            if (overlaps(rects[i].rect, rects[j].rect))
                return [rects[i], rects[j]];
        }
    }
    return null;
}

function miniLongEdge(ext, window) {
    const size = ext.miniatureManager.getMiniatureSize(window);
    return size ? Math.max(size.width, size.height) : 0;
}

function visualBounds(windows) {
    const rects = windows.map(actorVisualRect).filter(Boolean);
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map(rect => rect.x));
    const top = Math.min(...rects.map(rect => rect.y));
    const right = Math.max(...rects.map(rect => rect.x + rect.width));
    const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
    return {x: left, y: top, width: right - left, height: bottom - top};
}

function clusterIsCentered(ext, windows, workspace, monitor) {
    const bounds = visualBounds(windows);
    const workArea = ext.tilingManager.getUsableWorkArea(workspace, monitor);
    if (!bounds || !workArea) return false;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const wx = workArea.x + workArea.width / 2;
    const wy = workArea.y + workArea.height / 2;
    return Math.abs(cx - wx) <= EPSILON && Math.abs(cy - wy) <= EPSILON;
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
        const windows = [];
        for (let i = 0; i < 5; i++) {
            const child = launchAlacritty();
            children.push(child);
            windows.push(await waitForChildWindow(child));
        }
        await Scripting.sleep(500);
        const normal = [...windows].reverse().find(window => !WindowState.get(window, WindowState.IS_MINIATURE));
        assert(normal, 'At least one normal Alacritty must remain');
        const workspace = normal.get_workspace();
        const monitor = normal.get_monitor();
        const structuralSide = ext.tilingManager.getMiniatureRailSide(workspace, monitor);
        assert(structuralSide, 'Multi-window baseline must establish a structural miniature rail side');
        normal.activate(global.get_current_time());
        assert(await waitFor(() => global.display.focus_window === normal), 'Target normal must receive focus');

        normal.maximize();
        assert(await waitFor(() => ext.dominantManager.isActive(normal) && normal.is_maximized()),
            'Target must become Mosaic dominant');
        assert(await waitFor(() => windows.filter(w => WindowState.get(w, WindowState.IS_MINIATURE))
            .every(w => miniLongEdge(ext, w) <= 131)),
        'Focused dominant must compact all miniature presentation');
        assert(ext.dominantManager.getRailSideConstraint(workspace, monitor) === structuralSide,
            'Dominant entry must preserve the workspace structural rail side');

        normal.unmaximize();
        assert(await waitFor(() => {
            const miniatures = windows.filter(w => WindowState.get(w, WindowState.IS_MINIATURE));
            return !ext.dominantManager.isActive(normal) &&
                !ext.dominantManager.isReleaseSettling(normal) &&
                miniatures.every(w => miniLongEdge(ext, w) >= 253) &&
                miniatures.every(w => !WindowState.get(w, WindowState.ANIMATING_MINIATURE)) &&
                !firstVisualOverlap(windows);
        }), 'Dominant release must settle to a non-overlapping 256px miniature layout');
        assert(ext.tilingManager.getMiniatureRailSide(workspace, monitor) === structuralSide,
            'Dominant release must not rotate the structural miniature rail');
        assert(clusterIsCentered(ext, windows, workspace, monitor),
            'Final normal/miniature visual cluster must be centered in the usable work area');
        console.log('[DOMINANT MANY TEST] PASS: settled role layouts are non-overlapping, rail-stable, centered, and restore 256px miniatures');
    } finally {
        ext.disable();
        theme.unload_stylesheet(stylesheet);
        for (const child of children) {
            try { child.force_exit(); } catch { /* already exited */ }
        }
    }
}
