// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Visual feedback and preview rendering
import * as Logger from './logger.js';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import GObject from 'gi://GObject';

const FOCUS_CORNER_SIZE = 18;
const FOCUS_CORNER_INSET = 0;

export const DrawingManager = GObject.registerClass({
    GTypeName: 'MosaicDrawingManager',
}, class DrawingManager extends GObject.Object {
    _init() {
        super._init();
        // Active feedback boxes
        this._boxes = [];
        // Pool of reusable boxes (avoids create/destroy churn)
        this._boxPool = [];

        // Tile preview overlay for edge tiling
        this._tilePreview = null;

        this._focusCorners = null;

        this._edgeTilingManager = null;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    rect(x, y, w, h) {
        // Reuse a pooled box when available; otherwise create a new one in the UI group
        let box;
        if (this._boxPool.length > 0) {
            box = this._boxPool.pop();
            box.show();
        } else {
            box = new St.Widget({
                style_class: 'mosaic-preview',
                opacity: 200 // Ensure it's visible
            });
            Main.uiGroup.add_child(box);
        }

        box.set_position(x, y);
        box.set_size(w, h);

        this._boxes.push(box);
    }

    removeBoxes() {
        // Recycle boxes instead of destroying
        while(this._boxes.length > 0) {
            const box = this._boxes.pop();
            box.hide();
            this._boxPool.push(box);
        }
    }

    showTilePreview(zone, workArea, window = null) {
        // Hide mosaic preview when showing edge tiling preview
        this.removeBoxes();

        if (!this._edgeTilingManager) {
            Logger.warn('showTilePreview: EdgeTilingManager not set');
            return;
        }

        const rect = this._edgeTilingManager.getZoneRect(zone, workArea, window);
        if (!rect) return;

        if (!this._tilePreview) {
            this._tilePreview = new St.Widget({
                style_class: 'tile-preview',
                opacity: 128
            });
            Main.uiGroup.add_child(this._tilePreview);
        }

        this._tilePreview.set_position(rect.x, rect.y);
        this._tilePreview.set_size(rect.width, rect.height);
        this._tilePreview.show();
    }

    hideTilePreview() {
        if (this._tilePreview) {
            this._tilePreview.hide();
        }
    }

    _ensureFocusCorners() {
        if (this._focusCorners)
            return;

        const cornerClasses = [
            'corner-top-left',
            'corner-top-right',
            'corner-bottom-left',
            'corner-bottom-right',
        ];

        this._focusCorners = cornerClasses.map(styleClass => {
            const corner = new St.Widget({
                style_class: 'mosaic-focus-corner',
                reactive: false,
                visible: false,
            });
            corner.add_style_class_name(styleClass);
            corner.set_size(FOCUS_CORNER_SIZE, FOCUS_CORNER_SIZE);
            Main.uiGroup.add_child(corner);
            return corner;
        });
    }

    showFocusCorners(rect) {
        if (!rect)
            return;

        this._ensureFocusCorners();

        const maxOffsetX = Math.max(0, rect.width - FOCUS_CORNER_SIZE - FOCUS_CORNER_INSET * 2);
        const maxOffsetY = Math.max(0, rect.height - FOCUS_CORNER_SIZE - FOCUS_CORNER_INSET * 2);
        const left = rect.x + FOCUS_CORNER_INSET;
        const right = rect.x + FOCUS_CORNER_INSET + maxOffsetX;
        const top = rect.y + FOCUS_CORNER_INSET;
        const bottom = rect.y + FOCUS_CORNER_INSET + maxOffsetY;

        const positions = [
            [left, top],
            [right, top],
            [left, bottom],
            [right, bottom],
        ];

        for (let index = 0; index < this._focusCorners.length; index++) {
            const corner = this._focusCorners[index];
            const [x, y] = positions[index];
            corner.set_position(x, y);
            corner.show();
        }
    }

    hideFocusCorners() {
        if (!this._focusCorners)
            return;

        for (const corner of this._focusCorners)
            corner.hide();
    }

    clearActors() {
        this.removeBoxes();
        this.hideFocusCorners();

        // Clean up pool
        while(this._boxPool.length > 0) {
            const box = this._boxPool.pop();
            if (box.get_parent())
                Main.uiGroup.remove_child(box);
            box.destroy();
        }

        if (this._tilePreview) {
            if (this._tilePreview.get_parent())
                Main.uiGroup.remove_child(this._tilePreview);
            this._tilePreview.destroy();
            this._tilePreview = null;
        }

        if (this._focusCorners) {
            for (const corner of this._focusCorners) {
                if (corner.get_parent())
                    Main.uiGroup.remove_child(corner);
                corner.destroy();
            }
            this._focusCorners = null;
        }
        this._edgeTilingManager = null;
    }

    destroy() {
        this.clearActors();
    }
});
