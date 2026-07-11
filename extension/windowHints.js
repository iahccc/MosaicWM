// Copyright 2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Keyboard-driven window focus overlay.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Logger from './logger.js';
import { isWindowAlive } from './liveness.js';
import * as WindowState from './windowState.js';
import {
    IS_MINIATURE,
    MINIATURE_SCALE,
    MINIATURE_TARGET_POS,
    PRE_MINIATURE_SIZE,
} from './windowState.js';

// Match the physical QWERTY rows so labels are easy to scan and press.
const LABEL_ALPHABET = 'QWERTYUIOPASDFGHJKLZXCVBNM';
const OPEN_ANIMATION_MS = 140;

function makeLabels(count) {
    if (count === 0)
        return [];

    const base = LABEL_ALPHABET.length;
    let width = 1;
    let capacity = base;
    while (count > capacity) {
        width++;
        capacity *= base;
    }

    return Array.from({ length: count }, (_value, index) => {
        let label = '';
        let value = index;
        for (let position = 0; position < width; position++) {
            label = LABEL_ALPHABET[value % base] + label;
            value = Math.floor(value / base);
        }
        return label;
    });
}

export class WindowHintsOverlay {
    constructor() {
        this._overlay = null;
        this._header = null;
        this._entries = [];
        this._typedLabel = '';
        this._isOpen = false;
        this._modalGrab = null;
    }

    get isOpen() {
        return this._isOpen;
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._isOpen || Main.overview.visible)
            return;

        const windows = this._getTargetWindows();
        if (windows.length === 0) {
            Logger.log('Window hints: no focusable windows on the active workspace');
            return;
        }

        this._isOpen = true;
        this._typedLabel = '';
        this._entries = [];
        this._overlay = new St.Widget({
            style_class: 'mosaic-window-hints-overlay',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            can_focus: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
            opacity: 0,
        });
        // Attach before measuring child actors so their themed padding and borders
        // are included in the dimensions used to center them.
        Main.uiGroup.add_child(this._overlay);

        const headerBox = new St.BoxLayout({
            style_class: 'mosaic-window-hints-header',
            vertical: true,
        });
        this._header = new St.Label({
            style_class: 'mosaic-window-hints-header-title',
            text: 'Focus a window',
        });
        headerBox.add_child(this._header);
        headerBox.add_child(new St.Label({
            style_class: 'mosaic-window-hints-header-subtitle',
            text: 'Hold Super to choose · release to cancel',
        }));
        this._overlay.add_child(headerBox);
        headerBox.ensure_style();
        const [, headerWidth] = headerBox.get_preferred_width(-1);
        headerBox.set_position(Math.floor((global.stage.width - headerWidth) / 2), 18);

        const labels = makeLabels(windows.length);
        for (const [index, window] of windows.entries())
            this._addWindowHint(window, labels[index]);

        this._overlay.connect('captured-event', (_actor, event) => this._onCapturedEvent(event));
        this._overlay.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });

        this._modalGrab = Main.pushModal(this._overlay);
        if (!this._modalGrab) {
            this._isOpen = false;
            this._overlay.destroy();
            this._overlay = null;
            this._entries = [];
            this._header = null;
            return;
        }
        this._overlay.grab_key_focus();
        this._overlay.ease({
            opacity: 255,
            duration: OPEN_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        Logger.log(`Window hints: showing ${windows.length} window labels`);
    }

    close() {
        if (!this._isOpen)
            return;

        this._isOpen = false;
        this._entries = [];
        this._typedLabel = '';
        this._header = null;

        if (this._overlay) {
            if (this._modalGrab)
                Main.popModal(this._modalGrab);
            this._overlay.destroy();
            this._overlay = null;
        }
        this._modalGrab = null;
    }

    destroy() {
        this.close();
    }

    _getTargetWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .filter(window => {
                if (!isWindowAlive(window) ||
                    window.get_workspace() !== workspace ||
                    window.minimized) {
                    return false;
                }

                const rect = this._getWindowVisualRect(window);
                return rect.width > 0 && rect.height > 0;
            })
            .sort((first, second) => {
                const firstRect = this._getWindowVisualRect(first);
                const secondRect = this._getWindowVisualRect(second);
                return firstRect.y - secondRect.y || firstRect.x - secondRect.x;
            });
    }

    _getWindowVisualRect(window) {
        if (WindowState.get(window, IS_MINIATURE)) {
            const target = WindowState.get(window, MINIATURE_TARGET_POS);
            const scale = WindowState.get(window, MINIATURE_SCALE);
            const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
            if (target && scale && preSize) {
                return {
                    x: target.x,
                    y: target.y,
                    width: preSize.width * scale,
                    height: preSize.height * scale,
                };
            }
        }

        return window.get_frame_rect();
    }

    _addWindowHint(window, label) {
        const hint = new St.BoxLayout({
            style_class: 'mosaic-window-hint',
            reactive: true,
            vertical: true,
        });
        hint.add_child(new St.Label({
            style_class: 'mosaic-window-hint-key',
            text: label,
        }));
        hint.add_child(new St.Label({
            style_class: 'mosaic-window-hint-title',
            text: window.get_title() || window.get_wm_class() || 'Window',
        }));
        hint.connect('button-press-event', () => {
            this._focusWindow(window);
            return Clutter.EVENT_STOP;
        });

        this._overlay.add_child(hint);
        hint.ensure_style();
        const rect = this._getWindowVisualRect(window);
        const [, naturalWidth] = hint.get_preferred_width(-1);
        const [, naturalHeight] = hint.get_preferred_height(-1);
        const x = Math.max(12, Math.min(
            rect.x + (rect.width - naturalWidth) / 2,
            global.stage.width - naturalWidth - 12));
        const y = Math.max(12, Math.min(
            rect.y + (rect.height - naturalHeight) / 2,
            global.stage.height - naturalHeight - 12));
        hint.set_position(x, y);
        this._entries.push({ label, window, hint });
    }

    _onCapturedEvent(event) {
        const eventType = event.type();
        if (eventType === Clutter.EventType.KEY_RELEASE) {
            const keySymbol = event.get_key_symbol();
            if (keySymbol === Clutter.KEY_Super_L || keySymbol === Clutter.KEY_Super_R) {
                this.close();
                return Clutter.EVENT_STOP;
            }
        }

        if (eventType !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        return this._onKeyPress(event);
    }

    _onKeyPress(event) {
        const keySymbol = event.get_key_symbol();
        if (keySymbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (keySymbol === Clutter.KEY_BackSpace) {
            this._typedLabel = this._typedLabel.slice(0, -1);
            this._updateMatches();
            return Clutter.EVENT_STOP;
        }

        const keyName = Clutter.keyval_name(keySymbol);
        if (!keyName || keyName.length !== 1 || !/[a-z]/i.test(keyName))
            return Clutter.EVENT_STOP;

        this._typedLabel += keyName.toUpperCase();
        const matches = this._entries.filter(entry => entry.label.startsWith(this._typedLabel));
        if (matches.length === 0) {
            this._typedLabel = '';
            this._updateMatches();
            return Clutter.EVENT_STOP;
        }

        this._updateMatches(matches);
        const exactMatch = matches.find(entry => entry.label === this._typedLabel);
        if (exactMatch)
            this._focusWindow(exactMatch.window);
        return Clutter.EVENT_STOP;
    }

    _updateMatches(matches = null) {
        const activeEntries = matches ?? this._entries;
        const matchingEntries = new Set(activeEntries);
        for (const entry of this._entries) {
            if (matchingEntries.has(entry))
                entry.hint.remove_style_class_name('mosaic-window-hint-muted');
            else
                entry.hint.add_style_class_name('mosaic-window-hint-muted');
        }

        if (this._header) {
            this._header.text = this._typedLabel
                ? `Typing: ${this._typedLabel}`
                : 'Focus a window';
        }
    }

    _focusWindow(window) {
        const shouldActivate = isWindowAlive(window) && !window.minimized;
        this.close();
        if (shouldActivate)
            window.activate(global.get_current_time());
    }
}
