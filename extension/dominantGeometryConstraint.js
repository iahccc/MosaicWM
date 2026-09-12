// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GIRepository from 'gi://GIRepository';

const moduleDirectory = Gio.File.new_for_uri(import.meta.url).get_parent();
const nativeDirectory = moduleDirectory.get_child('native').get_path();
const repository = GIRepository.Repository.dup_default();
repository.prepend_search_path(nativeDirectory);
repository.prepend_library_path(nativeDirectory);

let Native;
try {
    Native = (await import('gi://MosaicWMNative?version=1.0')).default;
} catch (error) {
    throw new Error(`Failed to load Mosaic's GNOME 50 native constraint bridge from ${nativeDirectory}`, {
        cause: error,
    });
}

export class DominantGeometryConstraint {
    constructor() {
        this._native = Native.DominantConstraint.new();
        this._window = null;
    }

    setTarget(rect) {
        this._native.set_target(
            Math.round(rect.x),
            Math.round(rect.y),
            Math.max(1, Math.round(rect.width)),
            Math.max(1, Math.round(rect.height)));
    }

    attach(window) {
        if (this._window === window) return false;
        if (this._window)
            throw new Error('Dominant geometry constraint is already attached to another window');
        window.add_external_constraint(this._native);
        this._window = window;
        return true;
    }

    detach() {
        if (!this._window) return;
        const window = this._window;
        this._window = null;
        window.remove_external_constraint(this._native);
    }
}
