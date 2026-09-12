// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Enforces mosaic regions from inside Mutter's own constraint pass

import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as Logger from './logger.js';
import { isWindowAlive } from './liveness.js';

// The interface predates the rect being writable; without set_rect (Mutter 51) the vfunc
// can only read, so the whole path stays off. Feature-detected since a backport would
// make a version check lie.
let _supported = null;
export function constraintSupported() {
    if (_supported === null) {
        _supported = typeof Meta.ExternalConstraintInfo?.prototype?.set_rect === 'function' &&
            typeof Meta.Window?.prototype?.add_external_constraint === 'function';
        Logger.log(`External constraint support: ${_supported}`);
    }
    return _supported;
}

const MosaicRegionConstraint = GObject.registerClass({
    GTypeName: 'MosaicRegionConstraint',
    Implements: [Meta.ExternalConstraint],
}, class MosaicRegionConstraint extends GObject.Object {
    _init() {
        super._init();
        this.armed = null;
        this.maximizedRegion = null;
        this.maximizedMonitor = -1;
    }

    // The solver runs this on every pass for the window: user grabs and client resizes
    // included, with nothing saying who initiated. Ordinary regions are armed only around
    // our own commits; a maximized region persists until its presentation is released.
    vfunc_constrain(window, info) {
        const region = this.armed ?? this._maximizedRegionFor(window, info);
        if (!region) return false;
        info.set_rect(new Mtk.Rectangle({
            x: region.x, y: region.y, width: region.width, height: region.height,
        }));
        return true;
    }
    _maximizedRegionFor(window, info) {
        if (!this.maximizedRegion || !window.is_maximized() || window.is_fullscreen()) return null;
        if (this._targetsDifferentMonitor(info)) {
            // Allow Mutter's native monitor migration before the destination layout is known.
            // Keeping the source pin here would move the frame straight back to its old monitor.
            this.maximizedRegion = null;
            return null;
        }
        return this.maximizedRegion;
    }

    _targetsDifferentMonitor(info) {
        if (this.maximizedMonitor < 0 || this.maximizedMonitor >= global.display.get_n_monitors()) return true;
        const bounds = global.display.get_monitor_geometry(this.maximizedMonitor);
        const rect = info.new_rect;
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        return cx < bounds.x || cx >= bounds.x + bounds.width ||
            cy < bounds.y || cy >= bounds.y + bounds.height;
    }

});

export class MosaicConstraintManager {
    constructor() {
        // Keyed by window ID, not the GObject, to survive GI reference churn (same
        // reason windowState.js exists).
        this._entries = new Map();
        this._moving = new Map();
    }

    // A move_resize_frame the solver cannot amend, since the armed constraint outranks
    // the work-area clamp.
    commitRegion(window, region, userOp = false) {
        if (!constraintSupported()) {
            window.move_resize_frame(userOp, region.x, region.y, region.width, region.height);
            return;
        }

        const { constraint } = this._ensure(window);
        constraint.armed = region;
        try {
            window.move_resize_frame(userOp, region.x, region.y, region.width, region.height);
        } finally {
            constraint.armed = null;
        }
    }

    setMaximizedRegion(window, region) {
        if (!constraintSupported()) return false;
        const {constraint} = this._ensure(window);
        constraint.maximizedMonitor = window.get_monitor();
        constraint.maximizedRegion = {
            x: Math.round(region.x), y: Math.round(region.y),
            width: Math.max(1, Math.round(region.width)),
            height: Math.max(1, Math.round(region.height)),
        };
        return true;
    }

    clearMaximizedRegion(window) {
        const entry = this._entries.get(window.get_id());
        if (entry) entry.constraint.maximizedRegion = null;
    }

    // Unarmed, Mutter clamps the move against the size the window still has, so near an edge the
    // frame lands short of the region before the resize ever reaches the client.
    moveThenCommit(window, region, userOp = false) {
        const id = window.get_id();
        this._moving.set(id, region);
        try {
            if (!constraintSupported()) {
                window.move_frame(userOp, region.x, region.y);
            } else {
                const { constraint } = this._ensure(window);
                const frame = window.get_frame_rect();
                constraint.armed = { x: region.x, y: region.y, width: frame.width, height: frame.height };
                try {
                    window.move_frame(userOp, region.x, region.y);
                } finally {
                    constraint.armed = null;
                }
            }
        } finally {
            this._moving.delete(id);
        }
        this.commitRegion(window, region, userOp);
    }

    // What the window is being moved to while the move's own position-changed is firing. The
    // frame then still has the old size, so learning it would overwrite the size we're committing.
    regionInFlight(window) {
        return this._moving.get(window.get_id()) ?? null;
    }

    _ensure(window) {
        const id = window.get_id();
        let entry = this._entries.get(id);
        if (!entry) {
            entry = { window, constraint: new MosaicRegionConstraint() };
            window.add_external_constraint(entry.constraint);
            this._entries.set(id, entry);
            Logger.log(`External constraint attached to window ${id}`);
        }
        return entry;
    }

    detach(window) {
        const id = window?.get_id?.();
        if (id === undefined) return;
        const entry = this._entries.get(id);
        if (!entry) return;
        // A dead window segfaults libmutter, so only live ones get the removal call.
        if (isWindowAlive(entry.window))
            entry.window.remove_external_constraint(entry.constraint);
        this._entries.delete(id);
    }

    // A constraint left behind after unload keeps a dead JS object pinned in the solver.
    destroy() {
        for (const entry of this._entries.values()) {
            if (isWindowAlive(entry.window))
                entry.window.remove_external_constraint(entry.constraint);
        }
        this._entries.clear();
    }
}

// The geometry writers are plain classes (Level, WindowDescriptor) with no path back to the
// extension object, so the manager is reached the same way MosaicModel is. Constructing it
// touches nothing in the Shell; the first GObject only appears when a window is committed.
export const MosaicConstraints = new MosaicConstraintManager();
