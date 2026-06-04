// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Super+h/j/k/l keyboard focus navigation with delayed miniature restore

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

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
import { ComputedLayouts } from './tiling.js';
import { afterWorkspaceSwitch } from './timing.js';

const DIRECTION_KEYSYMS = new Map([
    [Clutter.KEY_h, 'left'],
    [Clutter.KEY_H, 'left'],
    [Clutter.KEY_j, 'down'],
    [Clutter.KEY_J, 'down'],
    [Clutter.KEY_k, 'up'],
    [Clutter.KEY_K, 'up'],
    [Clutter.KEY_l, 'right'],
    [Clutter.KEY_L, 'right'],
]);

const PRIMARY_MODIFIER_KEYSYMS = new Set([
    Clutter.KEY_Super_L,
    Clutter.KEY_Super_R,
    Clutter.KEY_Meta_L,
    Clutter.KEY_Meta_R,
]);
const PRIMARY_SUPER_MASK = Clutter.ModifierType.SUPER_MASK ?? Clutter.ModifierType.MOD4_MASK;
const CROSS_WORKSPACE_SETTLE_MS = 40;

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
        this._modalActor = null;
        this._modalGrab = null;
        this._modalKeyPressId = 0;
        this._modalKeyReleaseId = 0;
        this._stageCapturedEventId = 0;

        this._selectedWindow = null;
        this._selectedRect = null;
        this._selectionWorkspace = null;
        this._currentMonitor = null;
        this._pendingMiniatureRestore = null;
        this._pendingActivationSerial = 0;
        this._pendingWorkspaceActivation = null;
        this._sessionWorkspaceAnchors = null;
        this._primaryModifierHeld = false;
    }

    enable() {
        if (this._enabled)
            return;

        this._ensureModalActor();
        this._enabled = true;
        Logger.log('[NAV] Keyboard navigator enabled');
    }

    disable() {
        this._cancelPendingWorkspaceActivation();
        this._pendingMiniatureRestore = null;
        this._sessionWorkspaceAnchors = null;
        this._disconnectModalSignals();
        this._disconnectStageCapture();
        this._releaseModalGrab();
        this._clearSelection();

        if (this._modalActor) {
            if (this._modalActor.get_parent())
                Main.uiGroup.remove_child(this._modalActor);
            this._modalActor.destroy();
            this._modalActor = null;
        }

        this._enabled = false;
        Logger.log('[NAV] Keyboard navigator disabled');
    }

    startOrAdvance(direction) {
        if (!this._enabled)
            return false;

        if (!this._modalGrab)
            return this._startSession(direction);

        this._navigate(direction);
        return true;
    }

    isSessionActive() {
        return !!this._modalGrab;
    }

    handleFocusedMiniature(window) {
        this._pendingMiniatureRestore = window ?? null;
    }

    finishSession() {
        this._finishSession({
            accept: true,
            allowPendingWorkspaceActivation: true,
        });
    }

    hasPendingWorkspaceActivationFor(workspace) {
        return this._pendingWorkspaceActivation?.workspace === workspace;
    }

    onWindowDestroyed(windowId) {
        if (this._pendingMiniatureRestore?.get_id?.() === windowId)
            this._pendingMiniatureRestore = null;

        if (this._pendingWorkspaceActivation?.window?.get_id?.() === windowId)
            this._cancelPendingWorkspaceActivation();

        if (this._selectedWindow?.get_id?.() !== windowId)
            return;

        const focusedWindow = global.display.focus_window;
        if (focusedWindow && this._isFocusableCandidate(focusedWindow)) {
            const rect = this._getVisualRect(focusedWindow);
            this._applySelection(
                focusedWindow,
                rect,
                focusedWindow.get_workspace(),
                focusedWindow.get_monitor()
            );
            return;
        }

        this._clearSelection();
    }

    _ensureModalActor() {
        if (this._modalActor)
            return;

        this._modalActor = new St.Widget({
            reactive: false,
            can_focus: true,
            opacity: 0,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        // Overview DnD hit-testing uses PickMode.ALL, so this fullscreen actor
        // must stay out of pointer picking even when it owns keyboard focus.
        Shell.util_set_hidden_from_pick(this._modalActor, true);
        Main.uiGroup.add_child(this._modalActor);
    }

    _startSession(initialDirection) {
        const initialSelection = this._findInitialSelection();
        if (!initialSelection) {
            Logger.log(`[NAV] No focusable candidate for ${initialDirection}`);
            return false;
        }

        if (!this._acquireModalGrab())
            return false;

        this._sessionWorkspaceAnchors = new WeakMap();
        this._primaryModifierHeld = true;
        this._connectStageCapture();
        this._ext.rememberNavigableFocusedWindow?.(initialSelection.window);
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
        this._pendingActivationSerial += 1;
        this._pendingWorkspaceActivation = null;
    }

    _connectStageCapture() {
        if (this._stageCapturedEventId)
            return;

        this._stageCapturedEventId = global.stage.connect('captured-event',
            (_actor, event) => this._onStageCapturedEvent(event));
    }

    _disconnectStageCapture() {
        if (!this._stageCapturedEventId) {
            this._primaryModifierHeld = false;
            return;
        }

        global.stage.disconnect(this._stageCapturedEventId);
        this._stageCapturedEventId = 0;
        this._primaryModifierHeld = false;
    }

    _onStageCapturedEvent(event) {
        const eventType = event.type();
        if (eventType !== Clutter.EventType.KEY_PRESS && eventType !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;

        const keysym = event.get_key_symbol();
        if (PRIMARY_MODIFIER_KEYSYMS.has(keysym)) {
            this._primaryModifierHeld = eventType === Clutter.EventType.KEY_PRESS;
            return Clutter.EVENT_PROPAGATE;
        }

        if (eventType === Clutter.EventType.KEY_PRESS && (event.get_state() & PRIMARY_SUPER_MASK) !== 0)
            this._primaryModifierHeld = true;

        return Clutter.EVENT_PROPAGATE;
    }

    _acquireModalGrab() {
        if (this._modalGrab)
            return true;

        this._ensureModalActor();
        this._modalActor.set_size(global.stage.width, global.stage.height);
        this._modalActor.reactive = true;

        let grab = Main.pushModal(this._modalActor);
        if (!grab) {
            try {
                grab = Main.pushModal(this._modalActor, {
                    options: Meta.ModalOptions.POINTER_ALREADY_GRABBED,
                });
            } catch (_e) {
                grab = null;
            }
        }

        if (!grab) {
            Logger.warn('[NAV] Failed to acquire modal grab');
            return false;
        }

        this._modalGrab = grab;
        this._modalActor.grab_key_focus();

        this._modalKeyPressId = this._modalActor.connect('key-press-event',
            (_actor, event) => this._onModalKeyPress(event));
        this._modalKeyReleaseId = this._modalActor.connect('key-release-event',
            (_actor, event) => this._onModalKeyRelease(event));

        return true;
    }

    _disconnectModalSignals() {
        if (this._modalActor && this._modalKeyPressId) {
            this._modalActor.disconnect(this._modalKeyPressId);
            this._modalKeyPressId = 0;
        }

        if (this._modalActor && this._modalKeyReleaseId) {
            this._modalActor.disconnect(this._modalKeyReleaseId);
            this._modalKeyReleaseId = 0;
        }
    }

    _releaseModalGrab() {
        if (!this._modalGrab)
            return;

        try {
            Main.popModal(this._modalGrab);
        } catch (e) {
            Logger.warn(`[NAV] Failed to release modal grab: ${e.message}`);
        }

        this._modalGrab = null;
        if (this._modalActor)
            this._modalActor.reactive = false;
    }

    _onModalKeyPress(event) {
        const keysym = event.get_key_symbol();
        if ((event.get_state() & PRIMARY_SUPER_MASK) !== 0)
            this._primaryModifierHeld = true;
        const direction = DIRECTION_KEYSYMS.get(keysym);
        if (direction) {
            this._navigate(direction);
            return Clutter.EVENT_STOP;
        }

        if (keysym === Clutter.KEY_Escape) {
            this._finishSession({
                accept: true,
                allowPendingWorkspaceActivation: false,
            });
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_STOP;
    }

    _onModalKeyRelease(event) {
        const keysym = event.get_key_symbol();
        if (PRIMARY_MODIFIER_KEYSYMS.has(keysym)) {
            this._primaryModifierHeld = false;
            this._finishSession({
                accept: true,
                allowPendingWorkspaceActivation: true,
            });
        }

        return Clutter.EVENT_STOP;
    }

    _finishSession({ accept, allowPendingWorkspaceActivation = false }) {
        const pendingMiniature = accept ? this._pendingMiniatureRestore : null;
        const focusedWindow = accept ? global.display.focus_window : null;
        const hasPendingWorkspaceActivation = accept &&
            allowPendingWorkspaceActivation &&
            this._pendingWorkspaceActivation?.serial === this._pendingActivationSerial;

        this._disconnectModalSignals();
        this._disconnectStageCapture();
        this._releaseModalGrab();
        this._clearSelection();
        this._pendingMiniatureRestore = null;
        this._sessionWorkspaceAnchors = null;

        if (!hasPendingWorkspaceActivation)
            this._cancelPendingWorkspaceActivation();

        if (hasPendingWorkspaceActivation)
            return;

        if (accept)
            this._ext.rememberNavigableFocusedWindow?.(focusedWindow);

        if (!accept || !pendingMiniature || !this._ext.miniatureManager)
            return;

        if (!focusedWindow || focusedWindow.get_id() !== pendingMiniature.get_id())
            return;
        if (!WindowState.get(pendingMiniature, IS_MINIATURE))
            return;

        Logger.log(`[NAV] Restoring miniature ${pendingMiniature.get_id()} on session finish`);
        this._ext.miniatureManager.restoreMiniature(pendingMiniature, null);
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
        this._pendingActivationSerial += 1;
        if (showFocusCorners)
            this._ext.drawingManager?.showFocusCorners(rect);
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
            neighbor.window.activate(global.get_current_time());
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

        const activationSerial = this._pendingActivationSerial;
        this._pendingWorkspaceActivation = {
            serial: activationSerial,
            window: crossWorkspaceSelection.window,
            rect: crossWorkspaceSelection.rect,
            workspace: crossWorkspaceSelection.workspace,
            monitor: crossWorkspaceSelection.monitor,
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
            pendingWorkspaceActivation.window.activate(global.get_current_time());

            this._ext._timeoutRegistry?.add(CROSS_WORKSPACE_SETTLE_MS, () => {
                if (this._pendingActivationSerial !== activationSerial)
                    return false;

                const modifierHeld = this._primaryModifierHeld;
                if (!this._modalGrab)
                    return false;

                if (modifierHeld) {
                    this._ext.drawingManager?.showFocusCorners(pendingWorkspaceActivation.rect);
                    return false;
                }

                this._finishSession({
                    accept: true,
                    allowPendingWorkspaceActivation: false,
                });
                return false;
            }, 'keyboardNavigator_crossWorkspaceSettle');
        }, this._ext._timeoutRegistry);
    }

    _findInitialSelection() {
        const focusedWindow = global.display.focus_window;
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        const workspace = focusedWindow?.get_workspace() ?? activeWorkspace;
        const monitor = focusedWindow?.get_monitor() ?? global.display.get_primary_monitor();

        if (!workspace || monitor === null || monitor === undefined)
            return null;

        const candidates = this._getWorkspaceCandidates(workspace, monitor);
        if (candidates.length === 0)
            return null;

        const focusedCandidate = focusedWindow ? this._getCandidateForWindow(candidates, focusedWindow) : null;
        if (focusedCandidate)
            return { ...focusedCandidate, workspace, monitor };

        const lastFocused = this._ext.getLastFocusedWindowForWorkspaceMonitor(workspace, monitor);
        const lastFocusedCandidate = lastFocused ? this._getCandidateForWindow(candidates, lastFocused) : null;
        if (lastFocusedCandidate)
            return { ...lastFocusedCandidate, workspace, monitor };

        return { ...candidates[0], workspace, monitor };
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
            if (!workspace)
                continue;

            const candidates = this._getWorkspaceCandidates(workspace, this._currentMonitor);
            if (candidates.length === 0)
                continue;

            const sessionAnchorCandidate = this._getSessionWorkspaceAnchorCandidate(
                workspace,
                this._currentMonitor,
                candidates
            );
            const preferredWindow = this._ext.getLastFocusedWindowForWorkspaceMonitor(workspace, this._currentMonitor);
            const preferredCandidate = preferredWindow
                ? this._getCandidateForWindow(candidates, preferredWindow)
                : null;

            const chosenCandidate = sessionAnchorCandidate
                ?? preferredCandidate
                ?? this._pickEdgeEntryCandidate(candidates, direction, this._selectedRect);

            if (chosenCandidate) {
                return {
                    ...chosenCandidate,
                    workspace,
                    monitor: this._currentMonitor,
                };
            }
        }

        return null;
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

            const overlay = WindowState.get(window, MINIATURE_OVERLAY);
            if (overlay) {
                const [x, y] = overlay.get_transformed_position?.() ?? overlay.get_position();
                const [width, height] = overlay.get_transformed_size?.() ?? overlay.get_size();

                if (width > 0 && height > 0) {
                    return {
                        x,
                        y,
                        width,
                        height,
                    };
                }
            }
        }

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
}
