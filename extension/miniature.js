// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Logger from './logger.js';
import * as WindowState from './windowState.js';
import {
    IS_MINIATURE,
    MINIATURE_SCALE,
    PRE_MINIATURE_SIZE,
    MINIATURE_TARGET_POS,
} from './windowState.js';

export const MiniatureManager = GObject.registerClass({
    GTypeName: 'MosaicMiniatureManager',
    Signals: {
        'miniature-created':  { param_types: [GObject.TYPE_OBJECT] },
        'miniature-restored': { param_types: [GObject.TYPE_OBJECT] },
    },
}, class MiniatureManager extends GObject.Object {
    _init() {
        super._init();
        this._miniatureWindows = new Set();
    }

    createMiniature(window, computedSlot) {
        const windowActor = window.get_compositor_private();
        if (!windowActor) return false;

        const preSize = window.get_frame_rect();
        const scale = 256 / Math.max(preSize.width, preSize.height);

        const targetX = computedSlot.x;
        const targetY = computedSlot.y;

        windowActor.set_pivot_point(0, 0);
        windowActor.remove_all_transitions();
        windowActor.set_scale(scale, scale);

        window.move_frame(false, targetX, targetY);

        const [actorX, actorY] = windowActor.get_position();
        windowActor.set_translation(targetX - actorX, targetY - actorY, 0);

        WindowState.set(window, IS_MINIATURE,        true);
        WindowState.set(window, MINIATURE_SCALE,      scale);
        WindowState.set(window, PRE_MINIATURE_SIZE,   { width: preSize.width, height: preSize.height });
        WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });

        // Prevent focus handler from immediately restoring (expires in 500 ms)
        WindowState.set(window, 'justMiniaturized', true);
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            WindowState.remove(window, 'justMiniaturized');
            return GLib.SOURCE_REMOVE;
        });
        WindowState.set(window, 'miniatureJustMiniaturizedTimeoutId', timeoutId);

        // Re-apply scale+translation whenever actor is re-shown (workspace return safety net)
        const showSignalId = windowActor.connect('show', () => {
            const targetPos  = WindowState.get(window, MINIATURE_TARGET_POS);
            const savedScale = WindowState.get(window, MINIATURE_SCALE);
            if (!targetPos || !savedScale) return;
            windowActor.set_pivot_point(0, 0);
            windowActor.remove_all_transitions();
            windowActor.set_scale(savedScale, savedScale);
            const [ax, ay] = windowActor.get_position();
            windowActor.set_translation(targetPos.x - ax, targetPos.y - ay, 0);
        });
        WindowState.set(window, 'miniatureShowSignalId', showSignalId);

        this._miniatureWindows.add(window.get_id());
        this.emit('miniature-created', window);

        Logger.log(`[MINIATURE] Created miniature for ${window.get_id()}, scale=${scale.toFixed(4)}`);
        return true;
    }

    restoreMiniature(window, _newSlot) {
        const windowActor = window.get_compositor_private();

        WindowState.remove(window, IS_MINIATURE);
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);

        if (windowActor) {
            windowActor.remove_all_transitions();
            windowActor.set_scale(1.0, 1.0);
            windowActor.set_translation(0, 0, 0);

            const showSignalId = WindowState.get(window, 'miniatureShowSignalId');
            if (showSignalId) windowActor.disconnect(showSignalId);
        }
        WindowState.remove(window, 'miniatureShowSignalId');

        const timeoutId = WindowState.get(window, 'miniatureJustMiniaturizedTimeoutId');
        if (timeoutId) GLib.source_remove(timeoutId);
        WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
        WindowState.remove(window, 'justMiniaturized');

        this._miniatureWindows.delete(window.get_id());
        this.emit('miniature-restored', window);

        Logger.log(`[MINIATURE] Restored miniature ${window.get_id()}`);
        return true;
    }

    destroyMiniature(window) {
        const windowActor = window.get_compositor_private();

        WindowState.remove(window, IS_MINIATURE);
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);

        if (windowActor) {
            const showSignalId = WindowState.get(window, 'miniatureShowSignalId');
            if (showSignalId) windowActor.disconnect(showSignalId);
        }
        WindowState.remove(window, 'miniatureShowSignalId');

        const timeoutId = WindowState.get(window, 'miniatureJustMiniaturizedTimeoutId');
        if (timeoutId) GLib.source_remove(timeoutId);
        WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
        WindowState.remove(window, 'justMiniaturized');

        this._miniatureWindows.delete(window.get_id());
        Logger.log(`[MINIATURE] Destroyed miniature ${window.get_id()} (window closed)`);
    }

    getMiniatureSize(window) {
        if (!WindowState.get(window, IS_MINIATURE)) return null;
        const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
        const scale   = WindowState.get(window, MINIATURE_SCALE);
        if (!preSize || !scale) return null;
        return {
            width:  Math.round(preSize.width  * scale),
            height: Math.round(preSize.height * scale),
        };
    }
});

// Module-level helper — used by tiling.js without importing the full manager.
export function getMiniatureSize(window) {
    return global.MosaicExtension?.miniatureManager?.getMiniatureSize(window) ?? null;
}
