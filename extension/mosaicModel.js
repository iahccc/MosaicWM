// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Mosaic geometry model. Normal geometry intent and current presentation are deliberately
// separate: miniatures/maximized roles can move the presentation without changing the normal
// size that Smart Resize owns and must restore later.

// Keyed by window ID, not the GObject, to survive GI reference churn (same reason
// windowState.js exists). Each entry carries its workspace/monitor so a flush can
// target one workspace without asking which is active.
const _entries = new Map();

function idOf(window) {
    return window?.get_id?.();
}

function copyRect(rect) {
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

// Scope follows the caller. An explicit workspace/monitor is authoritative *including when it is
// null*: a caller that could not resolve one must not leave the entry pointing at wherever the
// window used to be, because entryMatchesWindowScope demands an exact workspace and monitor
// match, so a stale scope silently turns every later lookup into a miss (which is how a
// constrained window stops being reconciled). Only an omitted argument (undefined) means "leave
// the stored scope alone" -- the drag path in _applyDragLayoutMiniature relies on that, since it
// has no workspace of its own to report.
function entryFor(window, workspace, monitor) {
    const id = idOf(window);
    let entry = _entries.get(id);
    if (!entry) {
        entry = {window, normalSlot: null, presentationSlot: null};
        _entries.set(id, entry);
    } else {
        entry.window = window;
    }
    applyScope(entry, workspace, monitor);
    return entry;
}

// undefined keeps what is stored, anything else (including null) replaces it. See entryFor.
function applyScope(entry, workspace, monitor) {
    if (workspace !== undefined) {
        entry.workspace = workspace;
        entry.workspaceIndex = workspace?.index?.() ?? null;
    } else {
        entry.workspace ??= null;
        entry.workspaceIndex ??= null;
    }
    entry.monitor = monitor === undefined ? entry.monitor ?? null : monitor;
}

function entryWorkspaceMatches(entry, workspace) {
    if (!entry || !workspace) return false;
    if (entry.workspace) return entry.workspace === workspace;
    return entry.workspaceIndex === workspace.index?.();
}

function entryMatchesWindowScope(entry, window) {
    if (!entry || !window) return false;
    const workspace = window.get_workspace?.();
    if (!workspace) return false;
    const monitor = window.get_monitor?.();
    if (monitor === null || monitor === undefined) return false;
    return entryWorkspaceMatches(entry, workspace) && entry.monitor === monitor;
}

function syncEntryScope(entry, window) {
    const workspace = window.get_workspace?.();
    if (workspace) {
        entry.workspace = workspace;
        entry.workspaceIndex = workspace.index?.() ?? entry.workspaceIndex ?? null;
    }

    const monitor = window.get_monitor?.();
    if (monitor !== null && monitor !== undefined)
        entry.monitor = monitor;
}

export const MosaicModel = {
    // A normal layout commit owns both the future normal intent and what is currently shown.
    commitNormalSlot(window, slot, workspace, monitor) {
        const id = idOf(window);
        if (id === undefined) return;
        const entry = entryFor(window, workspace, monitor);
        entry.normalSlot = copyRect(slot);
        entry.presentationSlot = copyRect(slot);
    },

    // Role presentations (miniature/maximized) move visually without replacing normal intent.
    setPresentationSlot(window, slot, workspace, monitor) {
        const id = idOf(window);
        if (id === undefined) return;
        entryFor(window, workspace, monitor).presentationSlot = copyRect(slot);
    },

    // Read-only view for the normal (layout intent) geometry. The returned object IS the
    // stored slot, so a caller must not write to it: the tile pass mutates the sizes it is
    // handed (see _updateMiniatureDescriptors and _resolveExistingDescriptorSizes), and the
    // auto-restore probe simulates layouts, so both copy before writing and the model stays
    // the durable intent they read from. Copy where a size may be written back.
    normalSlotFor(window) {
        const id = idOf(window);
        if (id === undefined) return null;
        const entry = _entries.get(id);
        if (!entryMatchesWindowScope(entry, window)) return null;
        return entry.normalSlot ?? null;
    },

    // Same contract as normalSlotFor: the returned object is the stored slot, not a copy.
    // The fallback keeps a presentation-only consumer working for a window whose role has not
    // produced a presentation slot yet.
    presentationSlotFor(window) {
        const id = idOf(window);
        if (id === undefined) return null;
        const entry = _entries.get(id);
        if (!entryMatchesWindowScope(entry, window)) return null;
        return entry?.presentationSlot ?? entry?.normalSlot ?? null;
    },

    // Visual consumers want the current presentation; live frame is only a fallback.
    geometryOf(window) {
        const slot = this.presentationSlotFor(window);
        if (slot) return slot;
        const frame = window?.get_frame_rect?.();
        return frame ? copyRect(frame) : null;
    },

    entriesFor(workspace, monitor) {
        const out = [];
        for (const entry of _entries.values()) {
            const slot = entry.presentationSlot ?? entry.normalSlot;
            if (slot && entryWorkspaceMatches(entry, workspace) && entry.monitor === monitor)
                out.push({window: entry.window, slot});
        }
        return out;
    },

    // Explicit user geometry becomes both normal intent and current presentation.
    learn(window, frame) {
        const id = idOf(window);
        const entry = id !== undefined ? _entries.get(id) : undefined;
        if (!entry) return;
        syncEntryScope(entry, window);
        entry.normalSlot = copyRect(frame);
        entry.presentationSlot = copyRect(frame);
    },

    forget(window) {
        const id = idOf(window);
        if (id !== undefined) _entries.delete(id);
    },

    forgetById(id) { _entries.delete(id); },

    clear() { _entries.clear(); },
};
