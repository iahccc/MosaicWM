// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Authoritative mosaic geometry: what the layout wants, independent of what Mutter applied

import { MosaicTileGroupStore } from './mosaicTileGroup.js';

// Groups own the regions; this is the window-keyed view onto them that the rest of the
// extension already speaks. Keyed by window ID, not the GObject, to survive GI reference
// churn (same reason windowState.js exists).
const _store = new MosaicTileGroupStore();
const _normalSlots = new Map();

function idOf(window) {
    return window?.get_id?.();
}

export const MosaicModel = {
    store: _store,

    commitNormalSlot(window, region, workspace, monitor) {
        const id = idOf(window);
        if (id === undefined) return;
        _normalSlots.set(id, {region: {...region}, workspace, monitor});
        this.setRegion(window, region, workspace, monitor);
    },

    setPresentationSlot(window, region, workspace, monitor) {
        const group = _store.groupOfWindow(idOf(window));
        this.setRegion(window, region,
            workspace === undefined ? window.get_workspace?.() : workspace,
            monitor === undefined ? group?.monitor : monitor);
    },

    presentationSlotFor(window) {
        const group = _store.groupOfWindow(idOf(window));
        if (!group || group.workspaceIndex !== window.get_workspace?.()?.index?.() ||
            group.monitor !== window.get_monitor?.()) return null;
        return group.regionOf(idOf(window));
    },

    normalSlotFor(window) {
        const slot = _normalSlots.get(idOf(window));
        if (!slot || slot.workspace !== window.get_workspace?.() ||
            slot.monitor !== window.get_monitor?.()) return null;
        return slot.region;
    },

    entriesFor(workspace, monitor) {
        return (_store.groupFor(workspace.index(), monitor)?.members() ?? [])
            .map(member => ({window: member.window, slot: member.region}));
    },

    setRegion(window, region, workspace, monitor) {
        const id = idOf(window);
        if (id === undefined) return;
        _store.setMember(workspace?.index?.() ?? null, monitor ?? null, null, id, { window, region });
    },

    regionFor(window) {
        const id = idOf(window);
        if (id === undefined) return null;
        return _store.groupOfWindow(id)?.regionOf(id) ?? null;
    },

    // The layout's intent beats the live frame: mid-animation the frame is a transient
    // size, and with the overview open Mutter drops our moves entirely.
    geometryOf(window) {
        const region = this.regionFor(window);
        if (region) return region;
        const frame = window?.get_frame_rect?.();
        return frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null;
    },

    // The client refused or changed the size on its own, so the model takes the real
    // frame as the new intent instead of fighting it back.
    learn(window, frame) {
        const id = idOf(window);
        const group = id !== undefined ? _store.groupOfWindow(id) : null;
        const member = group?.memberOf(id);
        if (!member) return;
        // Store's setMember also updates the reverse index, but this call never moves the
        // window to a different group, and there's no workspace/monitor to give it here anyway.
        group.setMember(id, { ...member, region: frame });
        const normal = _normalSlots.get(id);
        if (normal && normal.workspace === window.get_workspace?.() &&
            normal.monitor === window.get_monitor?.()) normal.region = {...frame};
    },

    forget(window) {
        const id = idOf(window);
        if (id !== undefined) {
            _store.removeWindow(id);
            _normalSlots.delete(id);
        }
    },

    forgetById(id) { _store.removeWindow(id); _normalSlots.delete(id); },

    clear() { _store.clear(); _normalSlots.clear(); },
};

// Existing call sites speak this shape; kept so moving the store is not also an API churn.
export const ComputedLayouts = {
    get(mw) { return MosaicModel.regionFor(mw) ?? undefined; },
    set(mw, layout) { MosaicModel.setRegion(mw, layout, mw?.get_workspace?.(), mw?.get_monitor?.()); },
    delete(mw) { MosaicModel.forget(mw); },
    deleteById(id) { MosaicModel.forgetById(id); },
    clear() { MosaicModel.clear(); },
};
