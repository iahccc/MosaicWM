// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import * as WindowState from './windowState.js';
import {DominantGeometryConstraint} from './dominantGeometryConstraint.js';
import {isWindowAlive, isWorkspaceAlive} from './liveness.js';
import {MosaicModel} from './mosaicModel.js';
import {
    MiniatureLayoutProfile,
    miniatureSizeForSource,
    miniatureTargetSize,
    solveDominantRail,
} from './mosaicLayoutSolver.js';
import {
    IS_MINIATURE,
    PRE_MINIATURE_SIZE,
    IS_DOMINANT,
    DOMINANT_KEEP_NORMAL,
    DOMINANT_APPLYING_LAYOUT,
    DOMINANT_FORCED_MINIATURE,
    DOMINANT_RESTORE_IN_PROGRESS,
    MOSAIC_FULLSCREEN,
    DOMINANT_SUSPENDED_FOR_FULLSCREEN,
} from './windowState.js';

const DOMINANT_MIN_EDGE = 96;

function rectForSize(size) {
    return {
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height)),
    };
}

export class DominantManager {
    constructor(extension) {
        this._ext = extension;
        this._scopes = new WeakMap();
        this._geometryConstraints = new Map();
        this._destroyed = false;
        // Layout presentation follows the last focus change that actually belongs to the
        // Mosaic layout. Floating/excluded windows are focus-neutral: opening a transient,
        // always-on-top utility, sticky helper, etc. must not resize the layout underneath
        // it. Transients are first resolved back to their nearest managed ancestor so a
        // dialog still counts as focus on its owning Mosaic window.
        this._layoutFocusedWindow = this._resolveLayoutFocusOwner(global.display.focus_window);
    }

    destroy() {
        for (const window of [...this._geometryConstraints.keys()])
            this._detachGeometryConstraint(window, {forget: true});
        this._destroyed = true;
        this._scopes = new WeakMap();
        this._geometryConstraints.clear();
    }

    hasActive(workspace, monitor) {
        return !!this.getActive(workspace, monitor);
    }

    hasIntent(workspace, monitor) {
        const scope = this._getScope(workspace, monitor, false);
        this._pruneScope(scope, workspace, monitor);
        return (scope?.stack.length ?? 0) > 0;
    }

    hasIntentForWindow(window) {
        return this._isInAnyStack(window);
    }

    getActive(workspace, monitor) {
        const scope = this._getScope(workspace, monitor, false);
        this._pruneScope(scope, workspace, monitor);
        return scope?.active ?? null;
    }

    isActive(window) {
        if (!window) return false;
        return this.getActive(window.get_workspace?.(), window.get_monitor?.()) === window;
    }

    ownsLayout(workspace, monitor) {
        if (monitor === null || monitor === undefined) return false;
        return this.hasActive(workspace, monitor);
    }

    getLayoutProfile(workspace, monitor) {
        const scope = this._getScope(workspace, monitor, false);
        this._pruneScope(scope, workspace, monitor);
        if (scope?.releasePresentationWindow)
            return MiniatureLayoutProfile.DOMINANT_FOCUSED;
        const active = scope?.active ?? null;
        return active && this._layoutFocusedWindow === active
            ? MiniatureLayoutProfile.DOMINANT_FOCUSED
            : MiniatureLayoutProfile.NORMAL;
    }

    getMiniatureTargetSize(workspace, monitor) {
        return miniatureTargetSize(
            this.getLayoutProfile(workspace, monitor),
            constants.MINIATURE_TARGET_SIZE_PX);
    }

    getRailSideConstraint(workspace, monitor) {
        const scope = this._getScope(workspace, monitor, false);
        this._pruneScope(scope, workspace, monitor);
        if (!scope?.railSide) return null;
        return scope.active || scope.releasePresentationWindow || scope.committingReleasePresentation
            ? scope.railSide
            : null;
    }

    onFocusChanged(window) {
        const current = this._resolveLayoutFocusOwner(window);
        if (!current) return;

        const previous = this._layoutFocusedWindow;
        if (previous === current) return;

        this._layoutFocusedWindow = current;
        for (const coordinates of this._focusAffectedScopes(previous, current))
            this._syncFocusProfile(coordinates.workspace, coordinates.monitor);
    }

    _resolveLayoutFocusOwner(window) {
        let candidate = window;
        const visited = new Set();

        while (candidate && isWindowAlive(candidate) && !visited.has(candidate)) {
            visited.add(candidate);

            if (!this._ext.windowingManager.isExcluded(candidate))
                return candidate;

            candidate = candidate.get_transient_for?.() ?? null;
        }

        // No managed ancestor means this focus target is layout-neutral. Keep the previous
        // layout focus/profile instead of manufacturing a transition to NORMAL.
        return null;
    }

    _focusAffectedScopes(previous, current) {
        const scopes = new Map();
        for (const candidate of [previous, current])
            this._addFocusScope(scopes, candidate);
        return scopes.values();
    }

    _addFocusScope(scopes, window) {
        if (!window || !isWindowAlive(window)) return;
        const workspace = window.get_workspace?.();
        const monitor = window.get_monitor?.();
        if (!this._hasScopeCoordinates(workspace, monitor)) return;
        scopes.set(`${workspace.index()}:${monitor}`, {workspace, monitor});
    }

    _syncFocusProfile(workspace, monitor) {
        const scope = this._getScope(workspace, monitor, false);
        if (!scope?.active) return;
        const profile = this.getLayoutProfile(workspace, monitor);
        if (scope.layoutProfile === profile) return;
        Logger.log(`[DOMINANT] Focus profile ${scope.layoutProfile ?? 'unset'} → ${profile} on WS-${workspace.index()} M${monitor}`);
        this._applyScope(scope, workspace, monitor);
    }

    handleWindowCreated(window) {
        if (!window || this._ext.windowingManager.isExcluded(window)) return false;
        if (this._ext.windowingManager.isFullscreenLike(window)) return false;
        // Creation/readiness/evaluation all sample born native state because different
        // clients expose it at different times. Once first admission (or a post-admission
        // native maximize event) consumed the initial-mode window, later readiness callbacks
        // must never manufacture a second born transition.
        if (WindowState.get(window, 'dominantBornConsumed')) return false;
        if (WindowState.get(window, 'dominantBornOrigin')) return true;
        if (!window.is_maximized?.()) return false;

        const origin = 'born-maximized';
        WindowState.set(window, 'dominantBornOrigin', origin);
        Logger.log(`[DOMINANT] Window ${window.get_id()} born with native ${origin}`);
        return true;
    }

    handleNativeEnter(window, origin = 'manual-maximize') {
        if (!window || this._destroyed) return false;
        if (this._ext.windowingManager.isFullscreenLike(window)) return false;

        // A maximize notification while first admission is still pending is part of the
        // client's initial state. Keep it in the born-state path so a following startup
        // fullscreen can still discard that transient maximize intent. Conversely, once
        // admission finished, seeing MAXIMIZE is definitive evidence that any later
        // readiness sample must not relabel this user/application action as "born".
        if (WindowState.get(window, 'arrivalPending') &&
            !WindowState.get(window, 'dominantBornConsumed')) {
            if (!WindowState.get(window, 'dominantBornOrigin')) {
                WindowState.set(window, 'dominantBornOrigin', 'born-maximized');
                Logger.log(`[DOMINANT] Captured native maximize during first admission for ${window.get_id()}`);
            }
            return true;
        }
        if (WindowState.get(window, 'dominantBornOrigin')) return true;
        WindowState.remove(window, 'dominantBornOrigin');
        WindowState.set(window, 'dominantBornConsumed', true);

        if (this.isActive(window)) {
            Logger.log(`[DOMINANT] Consuming duplicate native ${origin} for active dominant ${window.get_id()}; maximized state remains native`);
            return true;
        }
        return this.requestDominance(window, origin);
    }

    handleNativeExit(window, reason = 'native-exit') {
        if (!window || this._destroyed) return false;
        if (WindowState.get(window, MOSAIC_FULLSCREEN) || window.is_fullscreen?.()) return true;
        if (!this._isInAnyStack(window) && !this.isActive(window)) return false;
        this.releaseDominance(window, {reason, removeIntent: true});
        return true;
    }

    handleBornArrival(window, workspace, monitor) {
        if (!window || !workspace || monitor === null || monitor === undefined)
            return {handled: false};

        const bornOrigin = WindowState.get(window, 'dominantBornOrigin');
        if (!bornOrigin) return {handled: false};

        WindowState.remove(window, 'dominantBornOrigin');
        WindowState.set(window, 'dominantBornConsumed', true);
        this.requestDominance(window, bornOrigin);
        return {handled: true};
    }

    discardBornMaximizeForFullscreen(window) {
        if (!window) return false;

        const pending = WindowState.get(window, 'dominantBornOrigin') === 'born-maximized';
        const consumed = WindowState.get(window, 'dominantOrigin') === 'born-maximized' &&
            this._isInAnyStack(window);
        if (!pending && !consumed) return false;

        WindowState.remove(window, 'dominantBornOrigin');
        if (consumed)
            this.releaseDominance(window, {
                reason: 'born-fullscreen-precedence',
                removeIntent: true,
                retile: false,
            });
        WindowState.remove(window, 'dominantOrigin');
        WindowState.set(window, 'dominantBornConsumed', true);
        Logger.log(`[FULLSCREEN] Dropped startup maximize intent for ${window.get_id()}; fullscreen takes precedence`);
        return true;
    }

    tryAdmitNormal(window, workspace, monitor) {
        if (!window || !workspace || monitor === null || monitor === undefined)
            return {handled: false};

        const active = this.getActive(workspace, monitor);
        if (!active || active === window)
            return {handled: false};

        if (this._tryKeepNormalWithDominant(window, active, workspace, monitor)) {
            Logger.log(`[DOMINANT] Normal arrival ${window.get_id()} coexists with dominant ${active.get_id()}`);
            return {handled: true};
        }

        Logger.log(`[DOMINANT] Normal arrival ${window.get_id()} cannot coexist; demoting ${active.get_id()} to miniature`);
        this._demoteActiveToMiniature(workspace, monitor, {keepIntent: true});
        return {handled: false};
    }

    requestDominance(window, origin = 'manual-maximize') {
        if (!this._canManage(window)) return false;
        if (this._ext.windowingManager.isFullscreenLike(window)) return false;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        this._ext.edgeTilingManager?.releaseForDominance?.(window);
        const scope = this._getScope(workspace, monitor, true);
        this._pruneScope(scope, workspace, monitor);
        this._logDominanceRequest(window, origin, scope);
        this._cancelReleasePresentationFor(scope, window);
        this._rememberIntent(scope, window, origin);

        const current = scope.active;
        if (current && current !== window) {
            WindowState.remove(current, IS_DOMINANT);
            WindowState.remove(current, DOMINANT_KEEP_NORMAL);
        }

        scope.active = window;
        WindowState.set(window, IS_DOMINANT, true);
        WindowState.remove(window, DOMINANT_KEEP_NORMAL);
        this._clearNormalCoexistence(workspace, monitor, window);

        this._takeDominantGeometryOwnership(window, workspace, monitor);
        return this._applyScope(scope, workspace, monitor);
    }

    _logDominanceRequest(window, origin, scope) {
        const focused = global.display.focus_window;
        const previous = scope.active;
        const focusId = focused ? focused.get_id() : 'none';
        const previousId = previous ? previous.get_id() : 'none';
        Logger.log(`[DOMINANT] Request ${window.get_id()} origin=${origin} ` +
            `focus=${focusId} previous=${previousId}`);
    }

    _takeDominantGeometryOwnership(window, workspace, monitor) {
        this._capturePreDominantSize(window, workspace, monitor);
        this._ext.resizeHandler?.revokeNormalResizeContract?.(
            window, 'dominant-enter', {clearRestoreBridge: true});
    }

    releaseDominance(window, {reason = 'release', removeIntent = true, retile = true} = {}) {
        if (!window) return false;
        const workspace = window.get_workspace?.();
        const monitor = window.get_monitor?.();
        const scope = this._getScope(workspace, monitor, false);
        if (!scope) return false;

        if (this._shouldHoldReleasePresentation(scope, window, workspace, monitor))
            this._beginReleasePresentation(scope, window);

        const wasActive = this._releaseState(scope, window, removeIntent);

        Logger.log(`[DOMINANT] Released ${window.get_id()} (${reason}), active=${wasActive}, stack=${scope.stack.length}`);
        this._finishReleaseIfActive(wasActive, window, workspace, monitor, retile);
        return wasActive;
    }

    _finishReleaseIfActive(wasActive, window, workspace, monitor, retile) {
        if (!wasActive) return;
        if (this.isReleaseSettling(window)) {
            const scope = this._getScope(workspace, monitor, false);
            if (scope) scope.releaseRetile = retile;
            this._prepareReleasePresentation(window, workspace, monitor);
            this._scheduleReleasePresentationCommit(window, workspace, monitor);
            return;
        }
        this._settleReleasedScope(window, workspace, monitor, retile);
    }

    _prepareReleasePresentation(window, workspace, monitor) {
        if (!this.isReleaseSettling(window)) return false;
        const prepared = this._ext.tilingManager.prepareMiniaturePresentationTransition(
            workspace, monitor, constants.MINIATURE_TARGET_SIZE_PX);
        if (!prepared) {
            Logger.log(`[DOMINANT] Normal presentation preparation for ${window.get_id()} has no legal target yet`);
            return false;
        }
        Logger.log(`[DOMINANT] Prepared normal geometry before expanding miniature presentation for ${window.get_id()}`);
        return true;
    }

    _shouldHoldReleasePresentation(scope, window, workspace, monitor) {
        return scope.active === window &&
            this.getLayoutProfile(workspace, monitor) === MiniatureLayoutProfile.DOMINANT_FOCUSED;
    }

    _beginReleasePresentation(scope, window) {
        scope.releasePresentationWindow = window;
        scope.releaseRetile = true;
        Logger.log(`[DOMINANT] Holding compact miniature presentation while ${window.get_id()} settles from dominant`);
    }

    _cancelReleasePresentationFor(scope, window) {
        if (scope?.releasePresentationWindow !== window) return;
        if (scope.releaseCommitId !== null) {
            this._ext._timeoutRegistry?.remove(scope.releaseCommitId);
            scope.releaseCommitId = null;
        }
        scope.releasePresentationWindow = null;
        scope.releaseRetile = true;
        Logger.log(`[DOMINANT] Cancelled release presentation hold for ${window.get_id()} due to renewed dominance`);
    }

    isReleaseSettling(window) {
        if (!window) return false;
        const scope = this._getScope(window.get_workspace?.(), window.get_monitor?.(), false);
        return scope?.releasePresentationWindow === window;
    }

    notifyGeometryChanged(window) {
        if (!this.isReleaseSettling(window)) return false;
        // A release configure can be stale (for example the native-maximized frame) and
        // the resize handler may consume its Smart Resize target instead of learning a
        // fake minimum. Re-prepare the legal normal target before each commit attempt so
        // that consuming a stale target never strands the two-phase release transaction.
        this._prepareReleasePresentation(
            window, window.get_workspace?.(), window.get_monitor?.());
        this._scheduleReleasePresentationCommit(
            window, window.get_workspace?.(), window.get_monitor?.());
        return true;
    }

    _scheduleReleasePresentationCommit(window, workspace, monitor) {
        const scope = this._getScope(workspace, monitor, false);
        if (!scope || scope.releasePresentationWindow !== window || scope.releaseCommitId !== null)
            return;
        scope.releaseCommitId = this._ext._timeoutRegistry?.addIdle(() => {
            scope.releaseCommitId = null;
            this._tryCommitReleasePresentation(window, workspace, monitor, scope);
            return GLib.SOURCE_REMOVE;
        }, 'dominant_releasePresentationCommit') ?? null;
    }

    _tryCommitReleasePresentation(window, workspace, monitor, scope) {
        if (this._destroyed || scope.releasePresentationWindow !== window) return false;
        if (!this._candidateBelongsToScope(window, workspace, monitor)) {
            scope.releasePresentationWindow = null;
            return false;
        }
        if (window.is_maximized?.()) return false;

        const canExpand = this._ext.tilingManager.canUseMiniatureTargetSizeFromLiveFrames(
            workspace, monitor, constants.MINIATURE_TARGET_SIZE_PX);
        if (!canExpand) return false;

        const releaseRetile = scope.releaseRetile;
        scope.releasePresentationWindow = null;
        scope.releaseRetile = true;
        scope.committingReleasePresentation = true;
        Logger.log(`[DOMINANT] Release geometry for ${window.get_id()} is live-safe; committing normal miniature presentation`);
        try {
            if (scope.active)
                this._applyScope(scope, workspace, monitor);
            else
                this._settleReleasedScope(window, workspace, monitor, releaseRetile);
        } finally {
            scope.committingReleasePresentation = false;
        }
        return true;
    }

    _settleReleasedScope(window, workspace, monitor, retile) {
        if (this.reconcile(workspace, monitor)) return;
        if (!retile || !this._hasScopeCoordinates(workspace, monitor)) return;

        this._restoreForcedMiniatures(workspace, monitor);
        this._settleReleasedWindowInWorkspace(window, workspace, monitor);
    }

    _settleReleasedWindowInWorkspace(window, workspace, monitor) {
        const tiling = this._ext.tilingManager;
        const workArea = tiling.getUsableWorkArea(workspace, monitor);
        const siblings = this._managedWindows(workspace, monitor)
            .filter(candidate => candidate !== window)
            .filter(candidate => !this._ext.windowingManager.isMaximizedOrFullscreen(candidate));
        const resizeResult = tiling.tryFitWithResize(window, siblings, workArea, workspace, window);

        if (!resizeResult?.success) {
            // The dominant layout we are leaving was non-overlapping. If the pre-dominant
            // preferred size cannot coexist yet, keep that last valid frame as the current
            // Mosaic slot rather than committing an overflowing normal layout. preferredSize
            // remains the future restoration goal when space later becomes available.
            const frame = window.get_frame_rect();
            WindowState.remove(window, 'targetRestoredSize');
            WindowState.set(window, 'isConstrainedByMosaic', true);
            MosaicModel.commitNormalSlot(window, frame, workspace, monitor);
            Logger.log(`[DOMINANT] Release ${window.get_id()} cannot settle at preferred size; preserving last valid in-workspace frame`);
            return false;
        }

        return tiling.withSmartResizeBlock(() => {
            tiling._pendingMiniatureWindows = resizeResult.pendingWindows ?? [];
            const result = tiling.tileWorkspaceWindows(workspace, null, monitor, false);
            return !result?.overflow;
        });
    }

    _removeIntent(scope, window) {
        const wasDormant = scope.active !== window &&
            scope.stack.some(entry => entry.window === window);
        scope.stack = scope.stack.filter(entry => entry.window !== window);
        if (wasDormant)
            this._detachGeometryConstraint(window, {forget: true});
    }

    _releaseState(scope, window, removeIntent) {
        if (removeIntent) this._removeIntent(scope, window);
        return this._deactivate(scope, window);
    }

    _deactivate(scope, window) {
        if (scope.active !== window) return false;
        this._detachGeometryConstraint(window, {forget: true});
        scope.active = null;
        WindowState.remove(window, IS_DOMINANT);
        WindowState.remove(window, DOMINANT_KEEP_NORMAL);
        WindowState.remove(window, 'isConstrainedByMosaic');
        MosaicModel.forget(window);
        this._restorePreDominantSize(window);
        return true;
    }

    onGrabBegin(window) {
        if (!window || WindowState.get(window, DOMINANT_APPLYING_LAYOUT)) return;
        if (!this.isActive(window)) return;
        this.releaseDominance(window, {reason: 'manual-grab', removeIntent: true, retile: false});
    }

    onWindowDestroyed(window) {
        if (!window) return;
        this._geometryConstraints.delete(window);
        for (const [workspace, monitor, scope] of this._scopeEntriesForWindow(window)) {
            if (scope.releasePresentationWindow === window) {
                if (scope.releaseCommitId !== null)
                    this._ext._timeoutRegistry?.remove(scope.releaseCommitId);
                scope.releasePresentationWindow = null;
                scope.releaseCommitId = null;
            }
            scope.stack = scope.stack.filter(entry => entry.window !== window);
            if (scope.active === window)
                scope.active = null;
            if (isWorkspaceAlive(workspace, global.workspace_manager))
                this.reconcile(workspace, monitor);
        }
    }

    transferWindowScope(window, sourceWorkspace, sourceMonitor, targetWorkspace, targetMonitor) {
        if (!window || !sourceWorkspace || !targetWorkspace)
            return false;
        if (sourceWorkspace === targetWorkspace && sourceMonitor === targetMonitor)
            return false;

        const sourceScope = this._getScope(sourceWorkspace, sourceMonitor, false);
        const transfer = this._takeTransferIntent(window, sourceScope);
        if (!transfer) return false;

        const targetScope = this._getScope(targetWorkspace, targetMonitor, true);
        this._pruneScope(targetScope, targetWorkspace, targetMonitor);
        this._installTransferIntent(window, targetScope, transfer);

        if (sourceScope && isWorkspaceAlive(sourceWorkspace, global.workspace_manager))
            this.reconcile(sourceWorkspace, sourceMonitor);

        Logger.log(`[DOMINANT] Transferred ${window.get_id()} from WS-${sourceWorkspace.index()} M${sourceMonitor} to WS-${targetWorkspace.index()} M${targetMonitor}; active=${targetScope.active === window}`);
        return targetScope.active === window
            ? this._applyScope(targetScope, targetWorkspace, targetMonitor)
            : true;
    }

    _takeTransferIntent(window, sourceScope) {
        const sourceEntry = this._findTransferEntry(sourceScope, window);
        const origin = sourceEntry ? sourceEntry.origin : WindowState.get(window, 'dominantOrigin');
        const wasActive = this._wasActiveForTransfer(sourceScope, window);
        if (!sourceEntry && !origin && !wasActive) return null;

        if (sourceScope) {
            this._clearTransferPresentation(window, sourceScope);
            sourceScope.stack = sourceScope.stack.filter(entry => entry.window !== window);
            if (sourceScope.active === window)
                sourceScope.active = null;
        }
        return {origin: origin ?? 'workspace-transfer', wasActive};
    }

    _findTransferEntry(scope, window) {
        if (!scope) return null;
        return scope.stack.find(entry => entry.window === window) ?? null;
    }

    _wasActiveForTransfer(scope, window) {
        if (WindowState.get(window, IS_DOMINANT)) return true;
        return !!scope && scope.active === window;
    }

    _clearTransferPresentation(window, scope) {
        if (scope.releasePresentationWindow !== window) return;
        if (scope.releaseCommitId !== null)
            this._ext._timeoutRegistry?.remove(scope.releaseCommitId);
        scope.releasePresentationWindow = null;
        scope.releaseCommitId = null;
        scope.releaseRetile = true;
    }

    _installTransferIntent(window, scope, transfer) {
        this._cancelReleasePresentationFor(scope, window);
        this._rememberIntent(scope, window, transfer.origin);
        if (!transfer.wasActive && scope.active) {
            WindowState.remove(window, IS_DOMINANT);
            return;
        }

        if (scope.active && scope.active !== window) {
            WindowState.remove(scope.active, IS_DOMINANT);
            WindowState.remove(scope.active, DOMINANT_KEEP_NORMAL);
        }
        scope.active = window;
        WindowState.set(window, IS_DOMINANT, true);
        WindowState.remove(window, DOMINANT_KEEP_NORMAL);
    }

    reconcile(workspace, monitor) {
        if (!this._hasScopeCoordinates(workspace, monitor)) return false;
        if (this._scopeHasFullscreen(workspace, monitor)) return false;
        const scope = this._getScope(workspace, monitor, false);
        if (!scope) return false;
        this._pruneScope(scope, workspace, monitor);

        if (scope.active)
            return this._applyScope(scope, workspace, monitor);

        return this._restoreTopCandidate(scope, workspace, monitor);
    }

    _restoreTopCandidate(scope, workspace, monitor) {
        for (let i = scope.stack.length - 1; i >= 0; i--) {
            const candidate = scope.stack[i].window;
            if (!this._candidateBelongsToScope(candidate, workspace, monitor)) continue;
            if (!this._canActivateCandidate(candidate, workspace, monitor)) continue;

            scope.active = candidate;
            WindowState.set(candidate, IS_DOMINANT, true);
            Logger.log(`[DOMINANT] Restoring stack candidate ${candidate.get_id()} on WS-${workspace.index()} M${monitor}`);
            return this._applyScope(scope, workspace, monitor);
        }

        return false;
    }

    _candidateBelongsToScope(candidate, workspace, monitor) {
        return this._canManage(candidate)
            && candidate.get_workspace() === workspace
            && candidate.get_monitor() === monitor;
    }

    relayout(workspace, monitor) {
        const scope = this._getScope(workspace, monitor, false);
        if (!scope?.active) return false;
        return this._applyScope(scope, workspace, monitor);
    }

    requestMiniatureRestore(window, {activate = true, reason = 'auto'} = {}) {
        if (!window || !WindowState.get(window, IS_MINIATURE)) return false;
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const active = this.getActive(workspace, monitor);

        if (this._shouldRestoreStackMiniature(window, active))
            return this._restoreStackMiniature(window, activate, reason);

        if (!active || window === active)
            return this._restoreOrdinaryMiniature(window, workspace, monitor, activate, reason);

        return this._restoreMiniatureAroundDominant(window, active, workspace, monitor, {activate, reason});
    }

    _restoreOrdinaryMiniature(window, workspace, monitor, activate, reason) {
        if (!this._canRestoreOrdinaryMiniature(window, workspace, monitor, reason))
            return false;
        return this._restoreMiniatureDirect(window, {activate});
    }

    _canRestoreOrdinaryMiniature(window, workspace, monitor, reason) {
        const windows = this._managedWindows(workspace, monitor);
        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        const requireStableNormal = this._isPassiveRestore(reason);
        if (workArea && this._ext.tilingManager.canRestoreMiniature(
            window, windows, workArea, {requireStableNormal}))
            return true;

        Logger.log(`[MINIATURE] ${reason} restore ${window.get_id()} rejected: no non-overlapping in-workspace layout`);
        return false;
    }

    _shouldRestoreStackMiniature(window, active) {
        return window !== active && this._isInAnyStack(window);
    }

    _restoreStackMiniature(window, activate, reason) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const scope = this._getScope(workspace, monitor, false);

        // Dominant intent is history, not a veto on explicit user intent. First ask the
        // solver, without mutating scope.active/stack/KEEP_NORMAL, whether this miniature
        // can actually become dominant now. The old path called requestDominance first;
        // when its plan failed it left the window in the stack but inactive, so every
        // later click repeated the same impossible dominant attempt forever.
        if (scope && this._buildPlan(scope, workspace, monitor, {
            dominant: window,
            targetSize: constants.MINIATURE_TARGET_SIZE_PX,
            forceMiniatureSiblings: true,
            layoutProfile: MiniatureLayoutProfile.NORMAL,
        })) {
            const restored = this.requestDominance(window, `restore-${reason}`);
            if (restored && activate)
                window.activate(global.get_current_time());
            return restored;
        }

        if (this._isPassiveRestore(reason)) {
            Logger.log(`[DOMINANT] Passive stack miniature restore ${window.get_id()} blocked: dominant layout unavailable`);
            return false;
        }

        // A click/focus/keyboard/drag is an explicit request to use this window. If its
        // historical dominant role cannot be realized, restore it as an ordinary normal
        // window in-place. Keep its stack entry intact so dominance can recover later when
        // space returns; only the temporary forced-miniature presentation is cleared.
        Logger.log(`[DOMINANT] Explicit stack miniature ${window.get_id()} cannot dominate; restoring normal while preserving intent`);
        const active = this.getActive(workspace, monitor);
        const restored = active && active !== window
            ? this._restoreMiniatureAroundDominant(
                window, active, workspace, monitor, {activate, reason})
            : this._restoreOrdinaryMiniature(window, workspace, monitor, activate, reason);
        if (restored)
            WindowState.remove(window, DOMINANT_FORCED_MINIATURE);
        return restored;
    }

    _restoreMiniatureAroundDominant(window, active, workspace, monitor, {activate, reason}) {
        WindowState.set(window, DOMINANT_KEEP_NORMAL, true);
        const scope = this._getScope(workspace, monitor, false);
        const plan = this._buildPlan(scope, workspace, monitor);
        if (plan)
            return this._commitCoexistingRestore(window, plan, scope, workspace, monitor, activate);

        WindowState.remove(window, DOMINANT_KEEP_NORMAL);
        if (this._isPassiveRestore(reason)) {
            Logger.log(`[DOMINANT] Passive miniature restore ${window.get_id()} blocked to preserve dominant ${active.get_id()}`);
            return false;
        }

        return this._restoreByDemotingDominant(window, workspace, monitor, activate, reason);
    }

    _commitCoexistingRestore(window, plan, scope, workspace, monitor, activate) {
        const restored = this._restoreMiniatureDirect(window, {
            activate: false,
            suppressRetile: true,
        });
        if (!restored) return false;
        this._applyPlan(plan, scope, workspace, monitor);
        if (activate) window.activate(global.get_current_time());
        return true;
    }

    _isPassiveRestore(reason) {
        return reason === 'hover' || reason === 'auto';
    }

    _restoreByDemotingDominant(window, workspace, monitor, activate, reason) {
        this._demoteActiveToMiniature(workspace, monitor, {keepIntent: true});
        return this._restoreMiniatureDirect(window, {
            activate,
            suppressRetile: reason === 'drag',
        });
    }

    _tryKeepNormalWithDominant(window, active, workspace, monitor) {
        WindowState.set(window, DOMINANT_KEEP_NORMAL, true);
        const scope = this._getScope(workspace, monitor, false);
        const plan = this._buildPlan(scope, workspace, monitor);
        if (!plan) {
            WindowState.remove(window, DOMINANT_KEEP_NORMAL);
            return false;
        }

        this._applyPlan(plan, scope, workspace, monitor);
        if (window !== global.display.focus_window)
            window.activate(global.get_current_time());
        return true;
    }

    _canActivateCandidate(candidate, workspace, monitor) {
        if (WindowState.get(candidate, MOSAIC_FULLSCREEN) ||
            this._ext.windowingManager.isFullscreenLike(candidate))
            return false;
        const scope = this._getScope(workspace, monitor, false);
        const previous = scope.active;
        scope.active = candidate;
        WindowState.set(candidate, IS_DOMINANT, true);

        const markedNormal = [];
        for (const window of this._managedWindows(workspace, monitor)) {
            if (window === candidate || WindowState.get(window, IS_MINIATURE)) continue;
            WindowState.set(window, DOMINANT_KEEP_NORMAL, true);
            markedNormal.push(window);
        }

        const plan = this._buildPlan(scope, workspace, monitor);
        if (!plan) {
            for (const window of markedNormal)
                WindowState.remove(window, DOMINANT_KEEP_NORMAL);
            WindowState.remove(candidate, IS_DOMINANT);
            scope.active = previous;
            return false;
        }
        return true;
    }

    _applyScope(scope, workspace, monitor) {
        if (!scope?.active || !this._canManage(scope.active)) return false;
        const plan = this._buildPlan(scope, workspace, monitor);
        if (!plan) {
            const activeId = scope.active.get_id();
            Logger.log(`[DOMINANT] Cannot maintain canonical layout for ${activeId}; suspending active dominance`);
            this._detachGeometryConstraint(scope.active, {forget: true});
            WindowState.remove(scope.active, IS_DOMINANT);
            scope.active = null;
            this._clearNormalCoexistence(workspace, monitor, null);
            return false;
        }
        return this._applyPlan(plan, scope, workspace, monitor);
    }

    _buildPlan(scope, workspace, monitor, options = {}) {
        const {
            dominant,
            actualTargetSize,
            forceMiniatureSiblings,
            layoutProfile,
        } = this._resolvePlanOptions(scope, workspace, monitor, options);
        if (!dominant || !this._canManage(dominant)) return null;

        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        if (!this._usableWorkArea(workArea)) {
            Logger.log(`[DOMINANT] Plan rejected for ${dominant.get_id()}: unusable work area`);
            return null;
        }

        // Fullscreen is an exclusive presentation role. It stays on the workspace, but it
        // must never become a dominant-rail sibling (and therefore must never be turned into
        // a miniature by _applyPlacement). Edge-tiled peers still count toward composition
        // occupancy below, preserving the existing outer-gap semantics.
        const workspacePeers = this._ext.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(window => window !== dominant)
            .filter(window => isWindowAlive(window))
            .filter(window => !this._ext.windowingManager.isExcluded(window))
            .filter(window => !this._ext.windowingManager.isFullscreenLike(window));
        const siblings = workspacePeers
            .filter(window => !this._ext.edgeTilingManager?.isEdgeTiled?.(window));
        // Focus only changes presentation. Role feasibility stays anchored to the global
        // miniature size so a previously valid normal peer cannot suspend dominance merely
        // because the dominant gained focus and compacted its miniatures.
        const canonicalItems = siblings.map(window =>
            this._miniItem(window, constants.MINIATURE_TARGET_SIZE_PX));
        const actualItems = this._buildActualRailItems(
            siblings, actualTargetSize, forceMiniatureSiblings);
        const min = this._ext.tilingManager.getWindowMinimumSize(dominant);
        const structuralRailSide = scope.railSide
            ?? this._ext.tilingManager.getMiniatureRailSide?.(workspace, monitor)
            ?? null;
        const solution = solveDominantRail({
            workArea,
            canonicalItems: canonicalItems.map(item => ({
                id: item.window.get_id(),
                width: item.size.width,
                height: item.size.height,
            })),
            actualItems: actualItems.map(item => ({
                id: item.window.get_id(),
                width: item.size.width,
                height: item.size.height,
            })),
            spacing: constants.WINDOW_SPACING,
            // A lone dominant/maximized window should occupy the whole usable area.
            // As soon as another managed window exists on this workspace/monitor,
            // restore the normal Mosaic outer gap around the shared composition.
            outerGap: workspacePeers.length === 0 ? 0 : constants.WINDOW_SPACING,
            dominantMinimum: {
                width: Math.max(DOMINANT_MIN_EDGE, min.width),
                height: Math.max(DOMINANT_MIN_EDGE, min.height),
            },
            previousSide: structuralRailSide,
            requiredSide: structuralRailSide,
        });
        if (!solution) {
            Logger.log(`[DOMINANT] Plan rejected for ${dominant.get_id()}: no unified rail layout fits`);
            return null;
        }

        const placements = actualItems.map(item => ({
            ...item,
            rect: solution.slots.get(item.window.get_id()),
        }));
        return {
            dominant,
            dominantRect: solution.dominantRect,
            placements,
            railSide: solution.side,
            layoutProfile,
        };
    }

    _resolvePlanOptions(scope, workspace, monitor, options) {
        return {
            dominant: Object.hasOwn(options, 'dominant') ? options.dominant : scope?.active,
            actualTargetSize: options.targetSize ?? this.getMiniatureTargetSize(workspace, monitor),
            forceMiniatureSiblings: options.forceMiniatureSiblings ?? false,
            layoutProfile: options.layoutProfile ?? this.getLayoutProfile(workspace, monitor),
        };
    }

    _buildActualRailItems(siblings, targetSize, forceMiniatureSiblings) {
        if (forceMiniatureSiblings)
            return siblings.map(window => this._visualMiniItem(window, targetSize));
        return siblings.map(window => this._actualRailItem(window, targetSize));
    }

    _usableWorkArea(workArea) {
        return !!workArea && workArea.width > 0 && workArea.height > 0;
    }

    _actualRailItem(window, targetSize) {
        return WindowState.get(window, DOMINANT_KEEP_NORMAL)
            ? this._normalItem(window)
            : this._visualMiniItem(window, targetSize);
    }

    _applyPlan(plan, scope, workspace, monitor) {
        if (!plan || scope.active !== plan.dominant) return false;

        this._claimPlanPresentationOwnership(plan);

        WindowState.set(plan.dominant, DOMINANT_APPLYING_LAYOUT, true);
        try {
            if (WindowState.get(plan.dominant, IS_MINIATURE))
                this._restoreMiniatureDirect(plan.dominant, {
                    activate: false,
                    suppressRetile: true,
                    instant: false,
                });
            WindowState.remove(plan.dominant, DOMINANT_FORCED_MINIATURE);
            WindowState.set(plan.dominant, IS_DOMINANT, true);
            WindowState.set(plan.dominant, 'isConstrainedByMosaic', true);

            // The solver owns the settled geometry; MiniatureManager owns presentation.
            // Dominant transitions deliberately use the same miniature create/move/restore
            // animations as ordinary Mosaic transitions. Intermediate visual overlap is
            // acceptable, while the final solver slots remain strictly non-overlapping.
            for (const placement of plan.placements)
                this._applyPlacement(placement, workspace, monitor);

            this._setGeometryConstraint(plan.dominant, plan.dominantRect);
            plan.dominant.move_resize_frame(false,
                plan.dominantRect.x, plan.dominantRect.y,
                plan.dominantRect.width, plan.dominantRect.height);
            MosaicModel.setPresentationSlot(plan.dominant, plan.dominantRect, workspace, monitor);
        } finally {
            WindowState.remove(plan.dominant, DOMINANT_APPLYING_LAYOUT);
        }

        scope.railSide = plan.railSide;
        scope.layoutProfile = plan.layoutProfile;

        this._ext.mosaicRenderer?.publishToOverview?.(workspace, monitor);
        return true;
    }

    _claimPlanPresentationOwnership(plan) {
        const animations = this._ext.animationsManager;
        if (!animations?.claimWindowForRoleTransition) return;
        animations.claimWindowForRoleTransition(plan.dominant);
        for (const placement of plan.placements)
            animations.claimWindowForRoleTransition(placement.window);
    }

    _applyPlacement(placement, workspace, monitor) {
        const {window, rect, kind, preSize} = placement;
        if (kind === 'mini') {
            WindowState.remove(window, DOMINANT_KEEP_NORMAL);
            if (WindowState.get(window, IS_MINIATURE))
                this._ext.miniatureManager.updateMiniatureLayout(window, rect);
            else {
                WindowState.set(window, DOMINANT_FORCED_MINIATURE, true);
                if (!this._ext.miniatureManager.createMiniature(window, rect, preSize))
                    WindowState.remove(window, DOMINANT_FORCED_MINIATURE);
            }
            MosaicModel.setPresentationSlot(window, rect, workspace, monitor);
        } else {
            if (WindowState.get(window, IS_MINIATURE))
                this._restoreMiniatureDirect(window, {
                    activate: false,
                    suppressRetile: true,
                    instant: false,
                });
            WindowState.remove(window, DOMINANT_FORCED_MINIATURE);
            WindowState.set(window, DOMINANT_KEEP_NORMAL, true);
            WindowState.set(window, 'isConstrainedByMosaic', true);
            window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
            MosaicModel.commitNormalSlot(window, rect, workspace, monitor);
        }
    }

    _miniItem(window, targetSize = constants.MINIATURE_TARGET_SIZE_PX) {
        const preSize = this._preMiniatureSize(window);
        return {
            window,
            kind: 'mini',
            preSize,
            size: miniatureSizeForSource(preSize, targetSize),
        };
    }

    _visualMiniItem(window, targetSize = constants.MINIATURE_TARGET_SIZE_PX) {
        const preSize = this._visualPreMiniatureSize(window);
        return {
            window,
            kind: 'mini',
            preSize,
            size: miniatureSizeForSource(preSize, targetSize),
        };
    }

    _normalItem(window) {
        const frame = window.get_frame_rect();
        // A fullscreen/native-state return can still expose monitor-sized live geometry while
        // Mosaic already knows the normal size it intends to restore. Use that settle bridge
        // before preferred/opening size so dominant reconciliation never reasons from fullscreen.
        const requested = WindowState.get(window, 'targetRestoredSize')
            ?? WindowState.get(window, 'preferredSize')
            ?? WindowState.get(window, 'openingSize')
            ?? frame;
        return {
            window,
            kind: 'normal',
            preSize: null,
            size: rectForSize(requested),
        };
    }

    _preMiniatureSize(window) {
        const frame = window.get_frame_rect();

        // Once a miniature exists, its stored source size is the geometry the actor is
        // actually scaled from. Reusing preferredSize here can make a dominant mini's
        // logical slot differ from its transformed actor and therefore offset its overlay/icon.
        if (WindowState.get(window, IS_MINIATURE)) {
            const stored = WindowState.get(window, PRE_MINIATURE_SIZE);
            if (stored) {
                return {
                    x: frame.x,
                    y: frame.y,
                    width: Math.max(1, stored.width),
                    height: Math.max(1, stored.height),
                };
            }
        }

        // A dominant window's live frame is the dominantRect, while preferredSize is its
        // pre-dominant normal size. Miniaturization transforms the live actor, so scale from
        // the live frame; preDominantSize remains separately available for later normal restore.
        if (WindowState.get(window, 'preDominantSize')) {
            return {
                x: frame.x,
                y: frame.y,
                width: Math.max(1, frame.width),
                height: Math.max(1, frame.height),
            };
        }

        const requested = WindowState.get(window, 'preferredSize')
            ?? WindowState.get(window, 'openingSize')
            ?? frame;
        return {
            x: frame.x,
            y: frame.y,
            width: Math.max(1, requested.width),
            height: Math.max(1, requested.height),
        };
    }

    _visualPreMiniatureSize(window) {
        const frame = window.get_frame_rect();

        // PRE_MINIATURE_SIZE is the frame the compositor actor was actually scaled from.
        // Once a miniature exists that remains the only valid visual source, even if the
        // client's preferred/restore size changes underneath it.
        if (WindowState.get(window, IS_MINIATURE)) {
            const stored = WindowState.get(window, PRE_MINIATURE_SIZE);
            if (stored) {
                return {
                    x: frame.x,
                    y: frame.y,
                    width: Math.max(1, stored.width),
                    height: Math.max(1, stored.height),
                };
            }
        }

        // A newly-miniaturized actor always scales the live compositor frame. Preferred,
        // opening and target-restored sizes belong to role/canonical reasoning, not visual
        // geometry. Mixing them here creates a rail slot and overlay larger/smaller than the
        // actor that is actually painted, which is most visible with the 128px profile.
        return {
            x: frame.x,
            y: frame.y,
            width: Math.max(1, frame.width),
            height: Math.max(1, frame.height),
        };
    }

    _demoteActiveToMiniature(workspace, monitor, {keepIntent}) {
        const scope = this._getScope(workspace, monitor, false);
        const active = scope?.active;
        if (!active) return false;

        // A dormant dominant is still natively maximized. Keep its per-window
        // constraint while its intent remains stacked so the miniature keeps a
        // stable real source frame instead of snapping back to Mutter's work area.
        if (!keepIntent)
            this._detachGeometryConstraint(active, {forget: true});
        scope.active = null;
        WindowState.remove(active, IS_DOMINANT);
        if (!keepIntent)
            scope.stack = scope.stack.filter(entry => entry.window !== active);

        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        if (workArea) {
            const item = this._visualMiniItem(active, constants.MINIATURE_TARGET_SIZE_PX);
            const rect = {
                x: workArea.x + Math.max(0, (workArea.width - item.size.width) / 2),
                y: workArea.y + Math.max(0, (workArea.height - item.size.height) / 2),
                width: item.size.width,
                height: item.size.height,
            };
            if (!WindowState.get(active, IS_MINIATURE))
                this._ext.miniatureManager.createMiniature(active, rect, item.preSize);
        }

        this._clearNormalCoexistence(workspace, monitor, null);
        return true;
    }

    _restoreForcedMiniatures(workspace, monitor) {
        const windows = this._managedWindows(workspace, monitor);
        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        for (const window of windows) {
            if (!WindowState.get(window, DOMINANT_FORCED_MINIATURE)) continue;

            // A maximized stack member is not an ordinary forced miniature. Its native
            // maximize state is deliberately preserved while dormant and only the dominant
            // state machine may restore it. Restoring it through the generic normal path
            // produces a real maximized frame outside the solver, which can overlap the
            // just-unmaximized window underneath it.
            if (this._isInAnyStack(window) || window.is_maximized?.())
                continue;

            WindowState.remove(window, DOMINANT_FORCED_MINIATURE);
            if (!WindowState.get(window, IS_MINIATURE)) continue;
            if (!this._ext.tilingManager.canRestoreMiniature(
                window, windows, workArea, {requireStableNormal: true})) continue;
            this._restoreMiniatureDirect(window, {activate: false, suppressRetile: true});
        }
    }

    suspendForFullscreen(window) {
        if (!window) return false;
        const workspace = window.get_workspace?.();
        const monitor = window.get_monitor?.();
        const scope = this._getScope(workspace, monitor, false);
        if (!scope || scope.active !== window) return false;

        this._detachGeometryConstraint(window);
        scope.active = null;
        WindowState.remove(window, IS_DOMINANT);
        WindowState.remove(window, DOMINANT_KEEP_NORMAL);
        WindowState.set(window, DOMINANT_SUSPENDED_FOR_FULLSCREEN, true);
        Logger.log(`[DOMINANT] Suspended ${window.get_id()} for native fullscreen; intent preserved`);
        return true;
    }

    resumeAfterFullscreen(window) {
        if (!window || !WindowState.get(window, DOMINANT_SUSPENDED_FOR_FULLSCREEN)) return false;
        WindowState.remove(window, DOMINANT_SUSPENDED_FOR_FULLSCREEN);
        const workspace = window.get_workspace?.();
        const monitor = window.get_monitor?.();
        if (!this._hasScopeCoordinates(workspace, monitor)) return false;
        return this.reconcile(workspace, monitor);
    }

    _setGeometryConstraint(window, rect) {
        let constraint = this._geometryConstraints.get(window);
        if (!constraint) {
            constraint = new DominantGeometryConstraint();
            this._geometryConstraints.set(window, constraint);
        }
        constraint.setTarget(rect);
        if (constraint.attach(window))
            Logger.log(`[DOMINANT] Attached per-window geometry constraint to ${window.get_id()}; native maximize state is preserved`);
    }

    _detachGeometryConstraint(window, {forget = false} = {}) {
        const constraint = this._geometryConstraints.get(window);
        if (!constraint) return;

        try {
            constraint.detach();
        } catch (error) {
            Logger.log(`[DOMINANT] Failed to detach geometry constraint from ${window.get_id?.() ?? 'dead'}: ${error}`);
        }
        if (forget)
            this._geometryConstraints.delete(window);
    }

    _capturePreDominantSize(window, workspace, monitor) {
        if (WindowState.get(window, 'preDominantSize')) return;
        const frame = window.get_frame_rect();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const requested = WindowState.get(window, 'targetRestoredSize')
            ?? WindowState.get(window, 'preferredSize')
            ?? WindowState.get(window, 'openingSize');
        const monitorSized = workArea && frame.width >= workArea.width && frame.height >= workArea.height;
        const size = requested
            ? {width: requested.width, height: requested.height}
            : monitorSized
                ? {width: Math.floor(workArea.width * 0.95), height: Math.floor(workArea.height * 0.95)}
                : {width: frame.width, height: frame.height};
        WindowState.set(window, 'preDominantSize', size);
    }

    _restorePreDominantSize(window) {
        const size = WindowState.get(window, 'preDominantSize');
        if (!size) return;
        WindowState.set(window, 'preferredSize', size);
        WindowState.set(window, 'openingSize', size);
        // The live frame is still the dominantRect until the next generic tiling pass. Bridge
        // that settle exactly like edge-untile does so WindowDescriptor does not treat the stale
        // dominant frame as the window's new normal size and immediately sacrifice siblings.
        WindowState.set(window, 'targetRestoredSize', size);
        this._ext._timeoutRegistry?.add(
            constants.RETILE_DELAY_MS + constants.RESIZE_SETTLE_DELAY_MS,
            () => {
                WindowState.remove(window, 'targetRestoredSize');
                return GLib.SOURCE_REMOVE;
            },
            'dominant_restoreSizeSettle');
        WindowState.remove(window, 'preDominantSize');
    }

    _restoreMiniatureDirect(window, {activate, suppressRetile = false, instant = false}) {
        if (!suppressRetile) {
            return this._ext.miniatureManager.restoreMiniature(window, null, {
                activate,
                dominantBypass: true,
                instant,
            });
        }

        WindowState.set(window, DOMINANT_RESTORE_IN_PROGRESS, true);
        try {
            return this._ext.miniatureManager.restoreMiniature(window, null, {
                activate,
                dominantBypass: true,
                instant,
            });
        } finally {
            WindowState.remove(window, DOMINANT_RESTORE_IN_PROGRESS);
        }
    }

    _rememberIntent(scope, window, origin) {
        scope.stack = scope.stack.filter(entry => entry.window !== window);
        scope.stack.push({window, origin});
        WindowState.set(window, 'dominantOrigin', origin);
    }

    _clearNormalCoexistence(workspace, monitor, exceptWindow) {
        for (const window of this._managedWindows(workspace, monitor)) {
            if (window !== exceptWindow)
                WindowState.remove(window, DOMINANT_KEEP_NORMAL);
        }
    }

    _managedWindows(workspace, monitor) {
        if (!workspace || monitor === null || monitor === undefined) return [];
        return this._ext.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(window => isWindowAlive(window))
            .filter(window => !this._ext.windowingManager.isExcluded(window))
            .filter(window => !this._ext.windowingManager.isFullscreenLike(window))
            .filter(window => !this._ext.edgeTilingManager?.isEdgeTiled?.(window));
    }

    _scopeHasFullscreen(workspace, monitor) {
        return this._ext.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .some(window => isWindowAlive(window) &&
                (WindowState.get(window, MOSAIC_FULLSCREEN) ||
                    this._ext.windowingManager.isFullscreenLike(window)));
    }

    _canManage(window) {
        if (!window || !isWindowAlive(window)) return false;
        if (this._ext.windowingManager.isExcluded(window)) return false;
        const workspace = window.get_workspace?.();
        const monitor = window.get_monitor?.();
        return !!workspace && monitor !== null && monitor !== undefined && monitor >= 0;
    }

    _getScope(workspace, monitor, create) {
        if (!this._hasScopeCoordinates(workspace, monitor)) return null;
        let monitors = this._scopes.get(workspace);
        if (!monitors && create) {
            monitors = new Map();
            this._scopes.set(workspace, monitors);
        }
        if (!monitors) return null;

        let scope = monitors.get(monitor);
        if (!scope && create) {
            scope = {
                active: null,
                stack: [],
                railSide: null,
                layoutProfile: null,
                releasePresentationWindow: null,
                releaseCommitId: null,
                releaseRetile: true,
                committingReleasePresentation: false,
            };
            monitors.set(monitor, scope);
        }
        return scope ?? null;
    }

    _hasScopeCoordinates(workspace, monitor) {
        return !!workspace && monitor !== null && monitor !== undefined;
    }

    _pruneScope(scope, workspace, monitor) {
        if (!scope) return;
        scope.stack = this._pruneStack(scope.stack, workspace, monitor);
        if (scope.active && !scope.stack.some(entry => entry.window === scope.active)) {
            this._detachGeometryConstraint(scope.active, {forget: true});
            WindowState.remove(scope.active, IS_DOMINANT);
            scope.active = null;
        }
        if (scope.releasePresentationWindow &&
            !this._candidateBelongsToScope(scope.releasePresentationWindow, workspace, monitor)) {
            if (scope.releaseCommitId !== null)
                this._ext._timeoutRegistry?.remove(scope.releaseCommitId);
            scope.releasePresentationWindow = null;
            scope.releaseCommitId = null;
            scope.releaseRetile = true;
        }
    }

    _pruneStack(stack, workspace, monitor) {
        const kept = [];
        for (const entry of stack) {
            const belongs = this._canManage(entry.window) &&
                entry.window.get_workspace() === workspace &&
                entry.window.get_monitor() === monitor;
            if (belongs) {
                kept.push(entry);
            } else if (isWindowAlive(entry.window)) {
                this._detachGeometryConstraint(entry.window, {forget: true});
            } else {
                this._geometryConstraints.delete(entry.window);
            }
        }
        return kept;
    }

    _isInAnyStack(window) {
        const workspace = window.get_workspace?.();
        const monitor = window.get_monitor?.();
        const scope = this._getScope(workspace, monitor, false);
        return !!scope?.stack.some(entry => entry.window === window);
    }

    _scopeEntriesForWindow(window) {
        const workspace = window.get_workspace?.();
        const monitor = window.get_monitor?.();
        const scope = this._getScope(workspace, monitor, false);
        return scope ? [[workspace, monitor, scope]] : [];
    }
}
