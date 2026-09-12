// Copyright 2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// A maximized presentation shares the same Mutter 51 constraint as ordinary mosaic commits.
import {MosaicConstraints} from './mosaicConstraint.js';

export class WindowRegionConstraint {
    constructor() {
        this._window = null;
        this._rect = null;
    }

    setTarget(rect) {
        this._rect = rect;
        if (this._window) MosaicConstraints.setMaximizedRegion(this._window, rect);
    }

    attach(window) {
        if (this._window && this._window.get_id() !== window.get_id())
            throw new Error('Window region constraint already belongs to another window');
        this._window = window;
        return MosaicConstraints.setMaximizedRegion(window, this._rect);
    }

    detach() {
        if (this._window) MosaicConstraints.clearMaximizedRegion(this._window);
        this._window = null;
    }
}
