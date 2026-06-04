// Copyright 2026 Mosaic WM contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class WindowHintOverlay {
    constructor(hints, onCancel) {
        this.actor = new St.Widget({name: 'mosaic-window-hints', reactive: true});
        this.actor.add_constraint(new Clutter.BindConstraint({
            source: global.stage, coordinate: Clutter.BindCoordinate.ALL,
        }));
        Main.layoutManager.addChrome(this.actor, {trackFullscreen: false});
        this.actor.connect('button-press-event', () => {
            onCancel();
            return Clutter.EVENT_STOP;
        });
        this._labels = new Map();
        for (const [key, candidate] of hints) {
            const label = new St.Label({style_class: 'mosaic-window-hint', text: key.toUpperCase(), reactive: false});
            this.actor.add_child(label);
            this._labels.set(key, {candidate, label});
        }
    }

    updatePositions(rectForWindow) {
        for (const {candidate, label} of this._labels.values()) {
            const rect = rectForWindow(candidate.window);
            const monitor = Main.layoutManager.monitors[candidate.window.get_monitor()];
            if (!rect || !monitor) {
                label.hide();
                continue;
            }
            const [, width] = label.get_preferred_width(-1);
            const [, height] = label.get_preferred_height(width);
            label.set_position(Math.round(Math.clamp(rect.x + (rect.width - width) / 2,
                monitor.x, monitor.x + monitor.width - width)),
            Math.round(Math.clamp(rect.y + (rect.height - height) / 2,
                monitor.y, monitor.y + monitor.height - height)));
            label.show();
        }
    }

    select(window, prefix = '') {
        for (const [key, {candidate, label}] of this._labels) {
            label.opacity = key.startsWith(prefix) ? 255 : 64;
            if (candidate.window === window) label.add_style_pseudo_class('selected');
            else label.remove_style_pseudo_class('selected');
        }
    }

    remove(windowId) {
        for (const [key, {candidate, label}] of this._labels) {
            if (candidate.id !== windowId) continue;
            label.destroy();
            this._labels.delete(key);
        }
    }

    destroy() {
        this._labels.clear();
        this.actor.destroy();
    }
}
