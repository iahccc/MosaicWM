// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Delayed spatial letter hints, with release-to-focus

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Logger from './logger.js';
import * as WindowState from './windowState.js';
import {
    IS_MINIATURE,
    MINIATURE_OVERLAY,
    MINIATURE_SCALE,
    MINIATURE_TARGET_POS,
    PRE_MINIATURE_SIZE,
} from './windowState.js';
import { ComputedLayouts } from './mosaicModel.js';
import { assignWindowHints, FALLBACK_KEYS, HINT_KEYS } from './navigationHints.js';
import { WindowHintOverlay } from './windowHintOverlay.js';

// Key events can carry virtual SUPER; global.get_pointer() reports physical MOD4.
const PRIMARY_SUPER_MASK = Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;
const HINT_BINDING = 'mosaic-window-hints';
export class KeyboardNavigatorManager {
    constructor(extension) {
        this._ext = extension;

        this._enabled = false;
        this._sessionActive = false;
        this._settings = null;
        this._hintSettings = null;
        this._superPressedAt = null;
        this._superHoldThresholdMs = 0;
        this._holdTimeoutId = 0;
        this._overlayRestoreId = 0;
        this._overlayKeyHandlerId = 0;
        this._overlayKeySignalId = 0;
        this._overlayKeyBlocked = false;
        this._keymap = null;
        this._keymapStateChangedId = 0;
        this._overviewShowingId = 0;
        this._hintFrameId = 0;

        this._selectedWindow = null;
        this._primaryModifierHeld = false;
        this._holdUsed = false;
        this._holdAnchorWindow = null;
        this._acceleratorId = 0;
        this._workspaceChangedId = 0;
        this._hintOverlay = null;
        this._keybindingFilterId = 0;
        this._hintBindingActive = false;
        this._hintTargets = new Map();
        this._hintPrefix = '';
        this._hintWorkspace = null;
    }

    enable() {
        if (this._enabled)
            return;

        this._settings = this._ext.getSettings('org.gnome.shell.extensions.mosaic-wm');
        this._hintSettings = new Gio.Settings({
            settings_schema: this._settings.settings_schema,
            backend: Gio.memory_settings_backend_new(),
        });
        this._keybindingFilterId = global.window_manager.connect('filter-keybinding',
            (_wm, binding) => this._onKeybinding(binding));
        this._overlayKeyHandlerId = GObject.signal_handler_find(global.display, {
            signalId: 'overlay-key',
        });
        this._overlayKeySignalId = global.display.connect('overlay-key',
            () => this._onOverlayKey());
        this._enabled = true;
        this._keymap = global.stage.get_context().get_backend().get_default_seat().get_keymap();
        // Mutter can consume Super before it reaches stage captured-event.
        this._keymapStateChangedId = this._keymap.connect('state-changed',
            () => this._onModifierStateChanged());
        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._cancelHintActivation();
            if (this._hintOverlay) this._finishSession({accept: false});
        });
        this._workspaceChangedId = global.workspace_manager.connect('active-workspace-changed', () => {
            if (this._hintOverlay) this._finishSession({accept: false});
        });
        this._acceleratorId = global.display.connect('accelerator-activated', () => {
            if (!this._primaryModifierHeld) return;
            this._cancelHintActivation();
            if (this._hintOverlay) this._finishSession({accept: false});
        });
        this._onModifierStateChanged();
        Logger.log('[NAV] Keyboard navigator enabled');
    }

    disable() {
        this._enabled = false;
        this._finishSession({accept: false});
        this._stopSuperHoldTracking();
        this._settings = null;
        this._hintSettings = null;
        if (this._keybindingFilterId) global.window_manager.disconnect(this._keybindingFilterId);
        this._keybindingFilterId = 0;
        if (this._keymapStateChangedId)
            this._keymap.disconnect(this._keymapStateChangedId);
        this._keymapStateChangedId = 0;
        this._keymap = null;
        if (this._overviewShowingId)
            Main.overview.disconnect(this._overviewShowingId);
        this._overviewShowingId = 0;
        if (this._workspaceChangedId)
            global.workspace_manager.disconnect(this._workspaceChangedId);
        this._workspaceChangedId = 0;
        if (this._acceleratorId)
            global.display.disconnect(this._acceleratorId);
        this._acceleratorId = 0;
        this._primaryModifierHeld = false;
        this._sessionActive = false;
        this._selectedWindow = null;

        Logger.log('[NAV] Keyboard navigator disabled');
    }

    isSessionActive() {
        return this._sessionActive;
    }

    isTransitionActive() {
        return this._sessionActive;
    }

    finishSession() {
        this._finishSession({ accept: true });
    }

    onWindowDestroyed(windowId) {
        if (this._hintOverlay) this._removeHintWindow(windowId);
    }

    _onModifierStateChanged() {
        if (!this._enabled)
            return;

        const [, , modifiers] = global.get_pointer();
        const wasHeld = this._primaryModifierHeld;
        this._primaryModifierHeld = (modifiers & PRIMARY_SUPER_MASK) !== 0;
        if (this._primaryModifierHeld !== wasHeld)
            this._trackSuperHold();
        if (!this._primaryModifierHeld && this.isSessionActive()) {
            this.finishSession();
        } else if (this._hintOverlay && (modifiers & (Clutter.ModifierType.CONTROL_MASK |
            Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SHIFT_MASK))) {
            this._finishSession({accept: false});
        }
    }

    _isFocusPlacementPending(window) {
        return !!window && (WindowState.get(window, 'arrivalPending') ||
            WindowState.get(window, 'pendingFirstPlacement'));
    }

    _getRenderedFrameRect(window) {
        // Use the miniature icon overlay itself so its replacement shares the same center.
        if (WindowState.get(window, IS_MINIATURE)) {
            const rect = this._getMiniatureOverlayRect(window);
            if (rect) return rect;
        }
        const actor = window.get_compositor_private();
        if (!actor || !actor.is_mapped() || !actor.has_allocation() || actor.width <= 0 || actor.height <= 0)
            return null;

        // The actor includes shadows; transform the frame inside its buffer so
        // hints follow tiling animations without including the shadow.
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        const scaleX = width / actor.width;
        const scaleY = height / actor.height;
        const rect = {
            x: x + (frame.x - buffer.x) * scaleX,
            y: y + (frame.y - buffer.y) * scaleY,
            width: frame.width * scaleX,
            height: frame.height * scaleY,
        };
        return Object.values(rect).every(Number.isFinite) ? rect : null;
    }

    _stopHintTracking() {
        if (this._hintFrameId)
            global.stage.disconnect(this._hintFrameId);
        this._hintFrameId = 0;
    }

    _trackSuperHold() {
        if (this._primaryModifierHeld) {
            this._holdUsed = false;
            this._holdAnchorWindow = global.display.focus_window;
            this._restoreOverlayKey();
            this._superPressedAt = GLib.get_monotonic_time();
            this._superHoldThresholdMs = this._settings.get_uint('super-hold-threshold-ms');
            this._holdTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                this._superHoldThresholdMs, () => {
                    this._holdTimeoutId = 0;
                    this._blockOverlayKey();
                    if (!this._holdUsed) this._startHints();
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }

        this._cancelHoldTimeout();
        this._stopHintTracking();
        if (this._superPressedAt !== null &&
            (GLib.get_monotonic_time() - this._superPressedAt) / 1000 >= this._superHoldThresholdMs)
            this._blockOverlayKey();
        this._superPressedAt = null;
        this._holdAnchorWindow = null;
        // Keep blocking until overlay-key is consumed. A release-time idle can
        // run before Mutter dispatches that signal, especially during retiling.
        // Chords that emit no overlay-key are reset by the next Super press.
    }

    _onOverlayKey() {
        if (!this._overlayKeyBlocked || this._primaryModifierHeld || this._overlayRestoreId)
            return;

        this._overlayRestoreId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._overlayRestoreId = 0;
            this._restoreOverlayKey();
            return GLib.SOURCE_REMOVE;
        });
    }

    _blockOverlayKey() {
        if (this._overlayKeyBlocked || !this._overlayKeyHandlerId)
            return;
        if (!GObject.signal_handler_is_connected(global.display, this._overlayKeyHandlerId))
            return;
        GObject.signal_handler_block(global.display, this._overlayKeyHandlerId);
        this._overlayKeyBlocked = true;
    }

    _restoreOverlayKey() {
        if (this._overlayRestoreId)
            GLib.source_remove(this._overlayRestoreId);
        this._overlayRestoreId = 0;
        if (!this._overlayKeyBlocked)
            return;
        if (GObject.signal_handler_is_connected(global.display, this._overlayKeyHandlerId))
            GObject.signal_handler_unblock(global.display, this._overlayKeyHandlerId);
        this._overlayKeyBlocked = false;
    }

    _cancelHoldTimeout() {
        if (this._holdTimeoutId)
            GLib.source_remove(this._holdTimeoutId);
        this._holdTimeoutId = 0;
    }

    _cancelHintActivation() {
        this._holdUsed = true;
        this._cancelHoldTimeout();
    }

    noteShortcut() {
        this._cancelHintActivation();
    }

    _hasNormalInput() {
        return Main.actionMode === Shell.ActionMode.NORMAL && Main.modalCount === 0 && !global.display.is_grabbed();
    }

    _canStartHints() {
        const extraModifiers = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
            Clutter.ModifierType.SHIFT_MASK;
        return this._enabled && this._primaryModifierHeld && !this._sessionActive &&
            this._hasNormalInput() &&
            !(global.get_pointer()[2] & extraModifiers);
    }

    _startHints() {
        if (!this._canStartHints()) return;
        const workspace = global.workspace_manager.get_active_workspace();
        const candidates = [];
        for (let monitor = 0; monitor < global.display.get_n_monitors(); monitor++)
            candidates.push(...this._getWorkspaceCandidates(workspace, monitor)
                .filter(item => !this._isFocusPlacementPending(item.window) && this._getRenderedFrameRect(item.window)));
        const anchor = this._getCandidateForWindow(candidates, this._holdAnchorWindow) ?? candidates[0];
        if (!anchor) return;
        const availableKeys = this._getAvailableHintKeys();
        // At least two free letters are needed for unambiguous overflow sequences.
        if ([...FALLBACK_KEYS].filter(key => availableKeys.includes(key)).length < 2) return;
        this._hintWorkspace = workspace;
        this._hintTargets = assignWindowHints(candidates, anchor.id, availableKeys);
        this._hintPrefix = '';
        this._sessionActive = true;
        this._hintOverlay = new WindowHintOverlay(this._hintTargets,
            () => this._finishSession({accept: false}));
        if (!this._bindHintKeys()) {
            this._finishSession({accept: false});
            return;
        }
        this._ext.miniatureManager?.setNavigationPreview(true);
        this._hintFrameId = global.stage.connect('before-paint',
            () => this._syncHintPreview());
        this._syncHintPreview();
        // Super may have been released while the hint bindings were being registered.
        if (!(global.get_pointer()[2] & PRIMARY_SUPER_MASK)) this._finishSession({accept: false});
    }

    _getAvailableHintKeys() {
        return [...HINT_KEYS].filter(key => this._isHintKeyAvailable(key)).join('');
    }

    _isHintKeyAvailable(key) {
        // Mutter rejects occupied accelerators, including user and extension bindings.
        // Probe without changing their settings or retaining a competing shortcut.
        const action = global.display.grab_accelerator(`<Super>${key}`, Meta.KeyBindingFlags.NONE);
        if (action === Meta.KeyBindingAction.NONE) return false;
        global.display.ungrab_accelerator(action);
        return true;
    }

    _onKeybinding(binding) {
        if (!this._primaryModifierHeld || binding.get_name() === HINT_BINDING) return false;
        this._cancelHintActivation();
        if (this._hintOverlay) this._finishSession({accept: false});
        return false;
    }

    _bindHintKeys() {
        const letters = new Set([...this._hintTargets.keys()].flatMap(hint => [...hint]));
        const controls = ['Escape', 'BackSpace'].filter(key => this._isHintKeyAvailable(key));
        this._hintSettings.set_strv(HINT_BINDING,
            [...letters, ...controls].map(key => `<Super>${key}`));
        const action = Main.wm.addKeybinding(HINT_BINDING, this._hintSettings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL,
            () => this._onHintBinding());
        this._hintBindingActive = action !== Meta.KeyBindingAction.NONE;
        return this._hintBindingActive;
    }

    _onHintBinding() {
        if (!this._hintOverlay) return;
        const symbol = Clutter.get_current_event()?.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this._finishSession({accept: false});
        } else if (symbol === Clutter.KEY_BackSpace) {
            this._hintPrefix = '';
            this._clearHintSelection();
        } else {
            this._selectHint(String.fromCharCode(symbol).toLowerCase());
        }
    }

    _selectHint(letter) {
        const prefix = this._hintTargets.has(letter) ? letter : this._hintPrefix + letter;
        const candidate = this._hintTargets.get(prefix);
        if (!candidate) {
            if (![...this._hintTargets.keys()].some(key => key.startsWith(prefix))) return false;
            this._hintPrefix = prefix;
            this._clearHintSelection();
            return true;
        }
        if (!this._isFocusableCandidate(candidate.window)) return false;
        this._hintPrefix = '';
        this._selectedWindow = candidate.window;
        this._hintOverlay.select(candidate.window);
        this._ext.miniatureManager?.setNavigationPreview(true, candidate.window);
        return true;
    }

    _clearHintSelection() {
        this._selectedWindow = null;
        this._hintOverlay?.select(null, this._hintPrefix);
        this._ext.miniatureManager?.setNavigationPreview(true);
    }

    _syncHintPreview() {
        if (!this._hintOverlay) return;
        if (!this._enabled || this._hintWorkspace !== global.workspace_manager.get_active_workspace() ||
            !this._hasNormalInput()) {
            this._finishSession({accept: false});
            return;
        }
        for (const candidate of [...this._hintTargets.values()]) {
            if (!this._isFocusableCandidate(candidate.window) || candidate.window.get_workspace() !== this._hintWorkspace)
                this._removeHintWindow(candidate.id);
        }
        if (!this._hintOverlay) return;
        this._hintOverlay.updatePositions(window => this._getRenderedFrameRect(window));
    }

    _removeHintWindow(windowId) {
        this._hintOverlay?.remove(windowId);
        for (const [key, candidate] of this._hintTargets)
            if (candidate.id === windowId) this._hintTargets.delete(key);
        if (this._selectedWindow?.get_id() === windowId) this._clearHintSelection();
        if (!this._hintTargets.size) this._finishSession({accept: false});
    }

    _closeHints() {
        this._stopHintTracking();
        const overlay = this._hintOverlay;
        this._hintOverlay = null;
        if (this._hintBindingActive) Main.wm.removeKeybinding(HINT_BINDING);
        this._hintBindingActive = false;
        this._hintSettings?.set_strv(HINT_BINDING, []);
        this._hintTargets.clear();
        this._hintPrefix = '';
        this._hintWorkspace = null;
        this._ext.miniatureManager?.setNavigationPreview(false);
        overlay?.destroy();
    }

    _stopSuperHoldTracking() {
        this._cancelHoldTimeout();
        this._stopHintTracking();
        this._restoreOverlayKey();
        this._superPressedAt = null;
        this._holdAnchorWindow = null;
        this._overlayKeyHandlerId = 0;
        if (this._overlayKeySignalId)
            global.display.disconnect(this._overlayKeySignalId);
        this._overlayKeySignalId = 0;
    }

    _finishSession({ accept }) {
        if (!this._hasNormalInput()) accept = false;
        const selectedWindow = accept ? this._selectedWindow : null;
        this._sessionActive = false;
        this._closeHints();
        this._selectedWindow = null;
        if (selectedWindow) this._commitSelection(selectedWindow);
    }

    _commitSelection(window) {
        if (!window || !this._isFocusableCandidate(window))
            return false;
        if (window.get_workspace() !== global.workspace_manager.get_active_workspace())
            return false;

        if (WindowState.get(window, IS_MINIATURE) &&
            this._ext.miniatureManager?.restoreMiniature(window, null)) {
            Logger.log(`[NAV] Restored selected miniature ${window.get_id()} on session finish`);
            return true;
        }

        window.activate(global.get_current_time());
        return true;
    }

    _getWorkspaceCandidates(workspace, monitor) {
        return this._ext.windowingManager.getMonitorWorkspaceWindows(workspace, monitor, true)
            .filter(window => this._isFocusableCandidate(window))
            .map(window => {
                const rect = this._getVisualRect(window);
                return rect ? { id: window.get_id(), window, rect } : null;
            })
            .filter(candidate => candidate && candidate.rect.width > 0 && candidate.rect.height > 0)
            .sort((a, b) =>
                a.rect.y - b.rect.y ||
                a.rect.x - b.rect.x ||
                a.window.get_id() - b.window.get_id());
    }

    _getCandidateForWindow(candidates, window) {
        if (!window)
            return null;

        return candidates.find(candidate => candidate.window.get_id() === window.get_id()) ?? null;
    }

    _isFocusableCandidate(window) {
        return !!window && this._ext.windowingManager.isNavigable(window);
    }

    _getVisualRect(window) {
        const miniatureRect = this._getMiniatureVisualRect(window);
        if (miniatureRect)
            return miniatureRect;

        const computedRect = ComputedLayouts.get(window);
        if (computedRect)
            return { ...computedRect };

        const frame = window.get_frame_rect();
        return {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
        };
    }

    _getMiniatureVisualRect(window) {
        if (!WindowState.get(window, IS_MINIATURE))
            return null;

        return this._getMiniatureTargetRect(window) ?? this._getMiniatureOverlayRect(window);
    }

    _getMiniatureTargetRect(window) {
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

        return null;
    }

    _getMiniatureOverlayRect(window) {
        const overlay = WindowState.get(window, MINIATURE_OVERLAY);
        if (!overlay)
            return null;

        const [x, y] = overlay.get_transformed_position?.() ?? overlay.get_position();
        const [width, height] = overlay.get_transformed_size?.() ?? overlay.get_size();
        if (width <= 0 || height <= 0)
            return null;

        return { x, y, width, height };
    }
}
