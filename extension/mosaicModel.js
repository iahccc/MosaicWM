// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Mosaic geometry model. Normal geometry intent and current presentation are deliberately
// separate: miniatures/dominant roles can move the presentation without changing the normal
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

function entryFor(window, workspace, monitor) {
    const id = idOf(window);
    let entry = _entries.get(id);
    if (!entry) {
        entry = {window, normalSlot: null, presentationSlot: null};
        _entries.set(id, entry);
    } else {
        entry.window = window;
    }
    entry.workspaceIndex = workspace?.index?.() ?? entry.workspaceIndex ?? null;
    entry.monitor = monitor ?? entry.monitor ?? null;
    return entry;
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

    // Role presentations (miniature/dominant) move visually without replacing normal intent.
    setPresentationSlot(window, slot, workspace, monitor) {
        const id = idOf(window);
        if (id === undefined) return;
        entryFor(window, workspace, monitor).presentationSlot = copyRect(slot);
    },

    normalSlotFor(window) {
        const id = idOf(window);
        return id === undefined ? null : (_entries.get(id)?.normalSlot ?? null);
    },

    presentationSlotFor(window) {
        const id = idOf(window);
        if (id === undefined) return null;
        const entry = _entries.get(id);
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
        const wsIndex = workspace?.index?.();
        const out = [];
        for (const entry of _entries.values()) {
            const slot = entry.presentationSlot ?? entry.normalSlot;
            if (slot && entry.workspaceIndex === wsIndex && entry.monitor === monitor)
                out.push({window: entry.window, slot});
        }
        return out;
    },

    // Explicit user geometry becomes both normal intent and current presentation.
    learn(window, frame) {
        const id = idOf(window);
        const entry = id !== undefined ? _entries.get(id) : undefined;
        if (!entry) return;
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
