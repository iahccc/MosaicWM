// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Super+h/j/k/l keyboard focus navigation with delayed miniature restore

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
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
import { MosaicModel } from './mosaicModel.js';
import { afterWorkspaceSwitch } from './timing.js';

// Key events can carry virtual SUPER; global.get_pointer() reports physical MOD4.
const PRIMARY_SUPER_MASK = Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;
function centerOf(rect) {
    return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
    };
}

function centerDistance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
}

function overlapsOnOrthogonalAxis(direction, fromRect, toRect) {
    if (direction === 'left' || direction === 'right') {
        return !(fromRect.y + fromRect.height <= toRect.y || toRect.y + toRect.height <= fromRect.y);
    }

    return !(fromRect.x + fromRect.width <= toRect.x || toRect.x + toRect.width <= fromRect.x);
}

function getDirectionalMetrics(direction, fromRect, toRect) {
    const fromCenter = centerOf(fromRect);
    const toCenter = centerOf(toRect);

    switch (direction) {
        case 'left':
            if (toCenter.x >= fromCenter.x)
                return null;
            return {
                overlap: overlapsOnOrthogonalAxis(direction, fromRect, toRect),
                primaryGap: Math.max(0, fromRect.x - (toRect.x + toRect.width)),
                secondaryDelta: Math.abs(toCenter.y - fromCenter.y),
                centerDistance: centerDistance(fromCenter, toCenter),
            };
        case 'right':
            if (toCenter.x <= fromCenter.x)
                return null;
            return {
                overlap: overlapsOnOrthogonalAxis(direction, fromRect, toRect),
                primaryGap: Math.max(0, toRect.x - (fromRect.x + fromRect.width)),
                secondaryDelta: Math.abs(toCenter.y - fromCenter.y),
                centerDistance: centerDistance(fromCenter, toCenter),
            };
        case 'up':
            if (toCenter.y >= fromCenter.y)
                return null;
            return {
                overlap: overlapsOnOrthogonalAxis(direction, fromRect, toRect),
                primaryGap: Math.max(0, fromRect.y - (toRect.y + toRect.height)),
                secondaryDelta: Math.abs(toCenter.x - fromCenter.x),
                centerDistance: centerDistance(fromCenter, toCenter),
            };
        case 'down':
            if (toCenter.y <= fromCenter.y)
                return null;
            return {
                overlap: overlapsOnOrthogonalAxis(direction, fromRect, toRect),
                primaryGap: Math.max(0, toRect.y - (fromRect.y + fromRect.height)),
                secondaryDelta: Math.abs(toCenter.x - fromCenter.x),
                centerDistance: centerDistance(fromCenter, toCenter),
            };
        default:
            return null;
    }
}

function compareDirectionalMetrics(a, b) {
    if (a.metrics.overlap !== b.metrics.overlap)
        return a.metrics.overlap ? -1 : 1;
    if (a.metrics.primaryGap !== b.metrics.primaryGap)
        return a.metrics.primaryGap - b.metrics.primaryGap;
    if (a.metrics.secondaryDelta !== b.metrics.secondaryDelta)
        return a.metrics.secondaryDelta - b.metrics.secondaryDelta;
    if (a.metrics.centerDistance !== b.metrics.centerDistance)
        return a.metrics.centerDistance - b.metrics.centerDistance;
    return a.candidate.window.get_id() - b.candidate.window.get_id();
}

export class KeyboardNavigatorManager {
    constructor(extension) {
        this._ext = extension;

        this._enabled = false;
        this._sessionActive = false;
        this._stageCapturedEventId = 0;
        this._settings = null;
        this._superPressedAt = null;
        this._superHoldThresholdMs = 0;
        this._holdTimeoutId = 0;
        this._overlayRestoreId = 0;
        this._overlayKeyHandlerId = 0;
        this._overlayKeySignalId = 0;
        this._overlayKeyBlocked = false;
        this._keymap = null;
        this._keymapStateChangedId = 0;
        this._focusWindowChangedId = 0;
        this._overviewShowingId = 0;
        this._overviewHiddenId = 0;
        this._previewSyncId = 0;
        this._previewFrameId = 0;

        this._selectedWindow = null;
        this._selectedRect = null;
        this._selectionWorkspace = null;
        this._currentMonitor = null;
        this._workspaceSwitchSerial = 0;
        this._pendingWorkspaceActivation = null;
        this._sessionWorkspaceAnchors = null;
        this._primaryModifierHeld = false;
    }

    enable() {
        if (this._enabled)
            return;

        this._settings = this._ext.getSettings('org.gnome.shell.extensions.mosaic-wm');
        this._overlayKeyHandlerId = GObject.signal_handler_find(global.display, {
            signalId: 'overlay-key',
        });
        this._overlayKeySignalId = global.display.connect('overlay-key',
            () => this._onOverlayKey());
        this._stageCapturedEventId = global.stage.connect('captured-event',
            (_actor, event) => this._onStageCapturedEvent(event));
        this._enabled = true;
        this._keymap = global.stage.get_context().get_backend().get_default_seat().get_keymap();
        // Mutter can consume Super before it reaches stage captured-event.
        this._keymapStateChangedId = this._keymap.connect('state-changed',
            () => this._onModifierStateChanged());
        this._focusWindowChangedId = global.display.connect('notify::focus-window',
            () => this._syncFocusPreview());
        this._overviewShowingId = Main.overview.connect('showing',
            () => this._ext.drawingManager?.hideFocusCorners());
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            if (this._previewSyncId)
                return;
            // Overview releases its modal grab after emitting 'hidden'.
            this._previewSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._previewSyncId = 0;
                this._syncFocusPreview();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._onModifierStateChanged();
        Logger.log('[NAV] Keyboard navigator enabled');
    }

    disable() {
        this._enabled = false;
        this._stopSuperHoldTracking();
        this._settings = null;
        this._disconnectStageCapture();
        if (this._keymapStateChangedId)
            this._keymap.disconnect(this._keymapStateChangedId);
        this._keymapStateChangedId = 0;
        this._keymap = null;
        if (this._focusWindowChangedId)
            global.display.disconnect(this._focusWindowChangedId);
        this._focusWindowChangedId = 0;
        if (this._overviewShowingId)
            Main.overview.disconnect(this._overviewShowingId);
        this._overviewShowingId = 0;
        if (this._overviewHiddenId)
            Main.overview.disconnect(this._overviewHiddenId);
        this._overviewHiddenId = 0;
        if (this._previewSyncId)
            GLib.source_remove(this._previewSyncId);
        this._previewSyncId = 0;
        this._primaryModifierHeld = false;
        this._cancelPendingWorkspaceActivation();
        this._sessionWorkspaceAnchors = null;
        this._sessionActive = false;
        this._clearSelection();

        Logger.log('[NAV] Keyboard navigator disabled');
    }

    startOrAdvance(direction) {
        if (!this._enabled)
            return false;

        if (!this._sessionActive)
            return this._startSession(direction);

        this._navigate(direction);
        return true;
    }

    isSessionActive() {
        return this._sessionActive;
    }

    isTransitionActive() {
        return this._sessionActive || this._pendingWorkspaceActivation !== null;
    }

    finishSession() {
        this._finishSession({ accept: true });
    }

    onWindowDestroyed(windowId) {
        if (this._pendingWorkspaceActivation?.commitWindow?.get_id?.() === windowId)
            this._cancelPendingWorkspaceActivation();

        if (this._selectedWindow?.get_id?.() !== windowId)
            return;

        const replacement = this._getSelectionReplacement();
        if (replacement) {
            this._applySelection(
                replacement.window,
                replacement.rect,
                this._selectionWorkspace,
                this._currentMonitor
            );
            return;
        }

        this._finishSession({ accept: false });
    }

    _getSelectionReplacement() {
        if (!this._selectionWorkspace ||
            this._currentMonitor === null || this._currentMonitor === undefined)
            return null;

        return this._getWorkspaceCandidates(this._selectionWorkspace, this._currentMonitor)[0] ?? null;
    }

    _startSession(initialDirection) {
        const initialSelection = this._findInitialSelection();
        if (!initialSelection) {
            Logger.log(`[NAV] No focusable candidate for ${initialDirection}`);
            return false;
        }

        this._sessionActive = true;
        this._sessionWorkspaceAnchors = new WeakMap();
        this._primaryModifierHeld = true;
        this._applySelection(
            initialSelection.window,
            initialSelection.rect,
            initialSelection.workspace,
            initialSelection.monitor
        );

        this._navigate(initialDirection);
        return true;
    }

    _cancelPendingWorkspaceActivation() {
        this._workspaceSwitchSerial += 1;
        this._pendingWorkspaceActivation = null;
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
        } else {
            this._syncFocusPreview();
        }
    }

    _syncFocusPreview() {
        const drawing = this._ext.drawingManager;
        if (!drawing)
            return;

        if (!this._enabled || !this._primaryModifierHeld || Main.actionMode !== Shell.ActionMode.NORMAL) {
            drawing.hideFocusCorners();
            return;
        }

        if (this.isSessionActive()) {
            if (this._pendingWorkspaceActivation) {
                drawing.hideFocusCorners();
                return;
            }
            this._syncSelectionPreview();
            return;
        }

        const window = global.display.focus_window;
        // The entrant's initial position and slide-in path are not focus targets.
        if (this._isFocusPlacementPending(window)) {
            drawing.hideFocusCorners();
            return;
        }
        const rect = this._isFocusableCandidate(window) ? this._getFocusPreviewRect(window) : null;
        if (rect) {
            drawing.showFocusCorners(rect);
        } else {
            drawing.hideFocusCorners();
        }
    }

    _isFocusPlacementPending(window) {
        return !!window && (WindowState.get(window, 'arrivalPending') ||
            WindowState.get(window, 'pendingFirstPlacement'));
    }

    _syncSelectionPreview() {
        const window = this._selectedWindow;
        const drawing = this._ext.drawingManager;
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        if (!window || !this._isFocusableCandidate(window) ||
            window.get_workspace() !== this._selectionWorkspace ||
            this._selectionWorkspace !== activeWorkspace ||
            this._isFocusPlacementPending(window)) {
            drawing?.hideFocusCorners();
            return;
        }

        const rect = this._getFocusPreviewRect(window);
        if (!rect) {
            drawing?.hideFocusCorners();
            return;
        }

        this._selectedRect = this._getVisualRect(window);
        drawing?.showFocusCorners(rect);
    }

    _getFocusPreviewRect(window) {
        const actor = window.get_compositor_private();
        if (!actor || !actor.is_mapped() || !actor.has_allocation() || actor.width <= 0 || actor.height <= 0)
            return null;

        // The actor includes shadows; transform the frame inside its buffer so
        // corners follow entrance/tiling animations without including the shadow.
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

    _stopPreviewTracking() {
        if (this._previewFrameId)
            global.stage.disconnect(this._previewFrameId);
        this._previewFrameId = 0;
    }

    _disconnectStageCapture() {
        if (this._stageCapturedEventId)
            global.stage.disconnect(this._stageCapturedEventId);
        this._stageCapturedEventId = 0;
    }

    _onStageCapturedEvent(event) {
        if (this._sessionActive && event.type() === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape) {
            this._finishSession({ accept: true });
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _trackSuperHold() {
        if (this._primaryModifierHeld) {
            this._restoreOverlayKey();
            this._previewFrameId = global.stage.connect('before-paint',
                () => this._syncFocusPreview());
            this._superPressedAt = GLib.get_monotonic_time();
            this._superHoldThresholdMs = this._settings.get_uint('super-hold-threshold-ms');
            this._holdTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                this._superHoldThresholdMs, () => {
                    this._holdTimeoutId = 0;
                    this._blockOverlayKey();
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }

        this._cancelHoldTimeout();
        this._stopPreviewTracking();
        if (this._superPressedAt !== null &&
            (GLib.get_monotonic_time() - this._superPressedAt) / 1000 >= this._superHoldThresholdMs)
            this._blockOverlayKey();
        this._superPressedAt = null;
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

    _stopSuperHoldTracking() {
        this._cancelHoldTimeout();
        this._stopPreviewTracking();
        this._restoreOverlayKey();
        this._superPressedAt = null;
        this._overlayKeyHandlerId = 0;
        if (this._overlayKeySignalId)
            global.display.disconnect(this._overlayKeySignalId);
        this._overlayKeySignalId = 0;
    }

    _finishSession({ accept }) {
        const selectedWindow = accept ? this._selectedWindow : null;
        const pendingWorkspaceActivation = accept ? this._pendingWorkspaceActivation : null;
        this._sessionActive = false;
        this._clearSelection();
        this._sessionWorkspaceAnchors = null;

        if (pendingWorkspaceActivation) {
            pendingWorkspaceActivation.commitWindow = selectedWindow;
            return;
        }

        this._cancelPendingWorkspaceActivation();
        if (selectedWindow)
            this._commitSelection(selectedWindow);
    }

    _commitSelection(window) {
        if (!window || !this._isFocusableCandidate(window))
            return false;
        if (window.get_workspace() !== global.workspace_manager.get_active_workspace())
            return false;

        if (WindowState.get(window, IS_MINIATURE) &&
            this._ext.miniatureManager?.restoreMiniature(window, null, { reason: 'keyboard' })) {
            Logger.log(`[NAV] Restored selected miniature ${window.get_id()} on session finish`);
            return true;
        }

        window.activate(global.get_current_time());
        return true;
    }

    _clearSelection() {
        this._selectedWindow = null;
        this._selectedRect = null;
        this._selectionWorkspace = null;
        this._currentMonitor = null;
        this._ext.drawingManager?.hideFocusCorners();
    }

    _applySelection(window, rect, workspace, monitor, options = {}) {
        const { showFocusCorners = true } = options;
        this._selectedWindow = window;
        this._selectedRect = rect;
        this._selectionWorkspace = workspace;
        this._currentMonitor = monitor;
        this._rememberSessionWorkspaceAnchor(window, workspace, monitor);
        if (showFocusCorners) {
            if (this._isFocusPlacementPending(window))
                this._ext.drawingManager?.hideFocusCorners();
            else
                this._ext.drawingManager?.showFocusCorners(this._getFocusPreviewRect(window));
        }
    }

    _navigate(direction) {
        if (!this._selectedWindow || !this._selectedRect || !this._selectionWorkspace) {
            const initialSelection = this._findInitialSelection();
            if (!initialSelection)
                return;

            this._applySelection(
                initialSelection.window,
                initialSelection.rect,
                initialSelection.workspace,
                initialSelection.monitor
            );
        }

        const neighbor = this._findDirectionalNeighbor(
            this._selectionWorkspace,
            this._currentMonitor,
            this._selectedWindow,
            this._selectedRect,
            direction
        );

        if (neighbor) {
            this._applySelection(neighbor.window, neighbor.rect, this._selectionWorkspace, this._currentMonitor);
            return;
        }

        if (direction !== 'left' && direction !== 'right')
            return;

        const crossWorkspaceSelection = this._findCrossWorkspaceSelection(direction);
        if (!crossWorkspaceSelection)
            return;

        this._applySelection(
            crossWorkspaceSelection.window,
            crossWorkspaceSelection.rect,
            crossWorkspaceSelection.workspace,
            crossWorkspaceSelection.monitor,
            { showFocusCorners: false }
        );

        const activationSerial = ++this._workspaceSwitchSerial;
        this._pendingWorkspaceActivation = {
            serial: activationSerial,
            workspace: crossWorkspaceSelection.workspace,
            monitor: crossWorkspaceSelection.monitor,
            commitWindow: null,
        };
        this._ext.drawingManager?.hideFocusCorners();
        crossWorkspaceSelection.workspace.activate(global.get_current_time());
        this._ext.windowingManager.showWorkspaceSwitcher(
            crossWorkspaceSelection.workspace,
            crossWorkspaceSelection.monitor
        );
        afterWorkspaceSwitch(() => {
            if (this._pendingWorkspaceActivation?.serial !== activationSerial)
                return;

            const pendingWorkspaceActivation = this._pendingWorkspaceActivation;
            this._pendingWorkspaceActivation = null;
            if (global.workspace_manager.get_active_workspace() !== pendingWorkspaceActivation.workspace)
                return;

            if (pendingWorkspaceActivation.commitWindow) {
                this._commitSelection(pendingWorkspaceActivation.commitWindow);
                return;
            }

            if (!this._sessionActive)
                return;
            if (!this._primaryModifierHeld) {
                this._finishSession({ accept: true });
                return;
            }

            this._syncFocusPreview();
        }, this._ext._timeoutRegistry);
    }

    _findInitialSelection() {
        const context = this._getInitialSelectionContext();
        if (!context)
            return null;

        const { focusedWindow, workspace, monitor } = context;
        const candidates = this._getWorkspaceCandidates(workspace, monitor);
        if (candidates.length === 0)
            return null;

        const candidate = this._getCandidateForWindow(candidates, focusedWindow) ?? candidates[0];
        return { ...candidate, workspace, monitor };
    }

    _getInitialSelectionContext() {
        const focusedWindow = global.display.focus_window;
        const workspace = focusedWindow?.get_workspace()
            ?? global.workspace_manager.get_active_workspace();
        const monitor = focusedWindow?.get_monitor()
            ?? global.display.get_primary_monitor();

        if (!workspace || monitor === null || monitor === undefined)
            return null;

        return { focusedWindow, workspace, monitor };
    }

    _findDirectionalNeighbor(workspace, monitor, currentWindow, currentRect, direction) {
        const rankedCandidates = [];

        for (const candidate of this._getWorkspaceCandidates(workspace, monitor)) {
            if (candidate.window.get_id() === currentWindow.get_id())
                continue;

            const metrics = getDirectionalMetrics(direction, currentRect, candidate.rect);
            if (!metrics)
                continue;

            rankedCandidates.push({ candidate, metrics });
        }

        rankedCandidates.sort(compareDirectionalMetrics);
        return rankedCandidates[0]?.candidate ?? null;
    }

    _findCrossWorkspaceSelection(direction) {
        const workspaceManager = global.workspace_manager;
        const activeWorkspace = this._selectionWorkspace ?? workspaceManager.get_active_workspace();
        if (!activeWorkspace || this._currentMonitor === null || this._currentMonitor === undefined)
            return null;

        const lastWorkspaceIndex = this._getLastSearchableWorkspaceIndex(workspaceManager);
        const startIndex = activeWorkspace.index();
        const step = direction === 'left' ? -1 : 1;

        for (let index = startIndex + step;
            index >= 0 && index <= lastWorkspaceIndex;
            index += step) {
            const workspace = workspaceManager.get_workspace_by_index(index);
            const selection = this._getWorkspaceEntrySelection(workspace, direction);
            if (selection)
                return selection;
        }

        return null;
    }

    _getWorkspaceEntrySelection(workspace, direction) {
        if (!workspace)
            return null;

        const candidates = this._getWorkspaceCandidates(workspace, this._currentMonitor);
        if (candidates.length === 0)
            return null;

        const sessionAnchorCandidate = this._getSessionWorkspaceAnchorCandidate(
            workspace,
            this._currentMonitor,
            candidates
        );
        const candidate = sessionAnchorCandidate
            ?? this._pickEdgeEntryCandidate(candidates, direction, this._selectedRect);
        if (!candidate)
            return null;

        return {
            ...candidate,
            workspace,
            monitor: this._currentMonitor,
        };
    }

    _rememberSessionWorkspaceAnchor(window, workspace, monitor) {
        if (!this._sessionWorkspaceAnchors || !window || !workspace)
            return;
        if (monitor === null || monitor === undefined || monitor < 0)
            return;

        let monitorAnchors = this._sessionWorkspaceAnchors.get(workspace);
        if (!monitorAnchors) {
            monitorAnchors = new Map();
            this._sessionWorkspaceAnchors.set(workspace, monitorAnchors);
        }

        monitorAnchors.set(monitor, window.get_id());
    }

    _getSessionWorkspaceAnchorCandidate(workspace, monitor, candidates) {
        const monitorAnchors = this._sessionWorkspaceAnchors?.get(workspace);
        const windowId = monitorAnchors?.get(monitor);
        if (!windowId)
            return null;

        return candidates.find(candidate => candidate.window.get_id() === windowId) ?? null;
    }

    _getLastSearchableWorkspaceIndex(workspaceManager) {
        let lastIndex = workspaceManager.get_n_workspaces() - 1;
        if (lastIndex <= 0)
            return lastIndex;

        const lastWorkspace = workspaceManager.get_workspace_by_index(lastIndex);
        if (lastWorkspace && lastWorkspace.list_windows().length === 0)
            lastIndex -= 1;

        return lastIndex;
    }

    _pickEdgeEntryCandidate(candidates, direction, sourceRect) {
        const sourceCenter = centerOf(sourceRect);

        return [...candidates].sort((a, b) => {
            const aCenter = a.center;
            const bCenter = b.center;

            if (direction === 'left') {
                if (aCenter.x !== bCenter.x)
                    return bCenter.x - aCenter.x;
            } else if (aCenter.x !== bCenter.x) {
                return aCenter.x - bCenter.x;
            }

            const aSecondary = Math.abs(aCenter.y - sourceCenter.y);
            const bSecondary = Math.abs(bCenter.y - sourceCenter.y);
            if (aSecondary !== bSecondary)
                return aSecondary - bSecondary;

            return a.window.get_id() - b.window.get_id();
        })[0] ?? null;
    }

    _getWorkspaceCandidates(workspace, monitor) {
        return this._ext.windowingManager.getMonitorWorkspaceWindows(workspace, monitor, true)
            .filter(window => this._isFocusableCandidate(window))
            .map(window => {
                const rect = this._getVisualRect(window);
                return rect ? { window, rect, center: centerOf(rect) } : null;
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

        const computedRect = MosaicModel.presentationSlotFor(window);
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
