// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Window resize operations

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Logger from './logger.js';
import { afterAnimations, monotonicNow } from './timing.js';
import * as WindowState from './windowState.js';
import * as constants from './constants.js';
import { TileZone } from './constants.js';
import { isResizeGrabOp } from './grabOps.js';
import { isWindowAlive } from './liveness.js';
import { MosaicModel } from './mosaicModel.js';

import GObject from 'gi://GObject';

export const ResizeHandler = GObject.registerClass({
    GTypeName: 'MosaicResizeHandler',
}, class ResizeHandler extends GObject.Object {
    _init(extension) {
        super._init();
        this._ext = extension;

        this._sizeChanged = false;
        this._resizeOverflowWindow = null;
        this._resizeInOverflow = false;
        this._resizeGracePeriod = null;
        this._resizeDebounceTimeout = null;
        this._lastResizeWindow = null;
        this._lastResizeTime = 0;
        // A constrained window can publish a client-owned size while its arrival/layout
        // transaction is still locked. Those events are presentation drift, not new layout
        // intent. Keep one condition-driven reconcile per window instead of either dropping
        // the event or recursively invoking the solver inside the still-active transaction.
        this._constrainedReconciles = new Map();
    }

    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    get dragHandler() { return this._ext.dragHandler; }
    get _timeoutRegistry() { return this._ext._timeoutRegistry; }
    get _currentGrabOp() { return this.dragHandler._currentGrabOp; }
    get _skipNextTiling() { return this.dragHandler._skipNextTiling; }
    set _skipNextTiling(val) { this.dragHandler._skipNextTiling = val; }

    _queueConstraintRebalance(window) {
        if (this._constraintRebalanceQueued) return;

        // Suppress rebalance during queue evaluation, since the queue handles its own overflow
        if (this._ext.windowHandler && this._ext.windowHandler.isEvaluatingQueue) return;

        this._constraintRebalanceCount = (this._constraintRebalanceCount || 0) + 1;
        if (this._constraintRebalanceCount > 3) {
            Logger.log('[SMART RESIZE] Max rebalance attempts reached, skipping');
            return;
        }

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();

        this._constraintRebalanceQueued = true;
        this._timeoutRegistry.addIdle(() => {
            this._constraintRebalanceQueued = false;
            if (workspace && workspace.index() >= 0) {
                this.tilingManager.rebalanceSmartResize(workspace, monitor);
            }
            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_constraintRebalance');
    }

    resetConstraintRebalanceCount() {
        this._constraintRebalanceCount = 0;
    }

    revokeNormalResizeContract(window, reason = 'role-change', {clearRestoreBridge = false} = {}) {
        if (!window) return;
        this._cancelConstrainedReconcile(window);
        const hadTarget = WindowState.get(window, 'targetSmartResizeSize') !== null &&
            WindowState.get(window, 'targetSmartResizeSize') !== undefined;
        const hadVerify = WindowState.get(window, 'clampVerifyId') !== undefined;
        this._disarmClampVerification(window);
        WindowState.set(window, 'targetSmartResizeSize', null);
        WindowState.remove(window, 'targetSmartResizeSetAt');
        if (clearRestoreBridge)
            WindowState.remove(window, 'targetRestoredSize');
        if (hadTarget || hadVerify)
            Logger.log(`[SMART RESIZE] Revoked normal resize contract for ${window.get_id()} (${reason})`);
    }

    _roleOwnsLiveGeometry(window) {
        if (!window) return false;
        return !!(
            WindowState.get(window, WindowState.IS_MINIATURE) ||
            WindowState.get(window, WindowState.IS_DOMINANT) ||
            WindowState.get(window, WindowState.DOMINANT_APPLYING_LAYOUT) ||
            this._ext.dominantManager?.isReleaseSettling(window) ||
            this.windowingManager.isMaximizedOrFullscreen(window)
        );
    }

    // Once the client had its chance, a frame still above target is a genuine minimum.
    _commitClampedSize(window, pendingSmartSize, rect) {
        Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamped: target=${pendingSmartSize.width}×${pendingSmartSize.height}, actual=${rect.width}×${rect.height}`);
        WindowState.set(window, 'targetSmartResizeSize', { width: rect.width, height: rect.height });
        // Only the axis that stayed above target really clamped; the other reached
        // target and shouldn't be pinned as a minimum.
        if (rect.width > pendingSmartSize.width + 2) WindowState.set(window, 'actualMinWidth', rect.width);
        if (rect.height > pendingSmartSize.height + 2) WindowState.set(window, 'actualMinHeight', rect.height);
        this._disarmClampVerification(window);

        // A window we just placed can clamp a few px against its own minimum.
        // Rebalancing right away races the tiling pass that's still settling
        // it and can kick it right back out, so give it a moment first.
        const now = monotonicNow();
        if (WindowState.get(window, 'pendingFirstPlacement')) {
            // A hidden entrant whose client rejected the planned size needs a fresh layout
            // target before its visibility transaction can complete. Never leave this to the
            // normal grace suppression or the stale target would keep the actor hidden.
            this._queueConstraintRebalance(window);
        } else if (!this._resizeGracePeriod || (now - this._resizeGracePeriod) >= constants.REVERSE_RESIZE_PROTECTION_MS) {
            this._queueConstraintRebalance(window);
        } else {
            Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamp rebalance skipped; within grace period`);
        }
    }

    // A frame above target shortly after window creation might just be the client
    // still negotiating its own size, not a real minimum, so hold the commit.
    _shouldDeferClampCommit(window) {
        // The frame settles relative to when the target was applied, not when the window was born;
        // an old window handed a fresh target is still mid-shrink, not clamping.
        const setAt = WindowState.get(window, 'targetSmartResizeSetAt');
        if (setAt !== undefined && (monotonicNow() - setAt) < constants.RESIZE_CLAMP_SETTLE_WINDOW_MS)
            return true;
        const addedTime = WindowState.get(window, 'addedTime');
        if (addedTime === undefined) return false;
        return (monotonicNow() - addedTime) < constants.RESIZE_CLAMP_SETTLE_WINDOW_MS;
    }

    // Only the tiler sends geometry; a silent client gets its frame committed
    // as truth once the over-target signals go quiet.
    _armClampVerification(window, pendingSmartSize) {
        this._disarmClampVerification(window);

        const verifyId = this._timeoutRegistry.add(constants.RESIZE_CLAMP_VERIFY_DELAY_MS, () => {
            WindowState.remove(window, 'clampVerifyId');
            this._verifyClampTarget(window, pendingSmartSize);
            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_clampVerify');
        WindowState.set(window, 'clampVerifyId', verifyId);
    }

    _verifyClampTarget(window, pendingSmartSize) {
        if (!isWindowAlive(window)) return;
        if (this._clampOwnerChanged(window)) return;
        if (!this._sameSmartResizeTarget(window, pendingSmartSize)) return;

        const rect = window.get_frame_rect();
        if (!this._frameExceedsTarget(rect, pendingSmartSize)) {
            WindowState.set(window, 'targetSmartResizeSize', null);
            return;
        }
        if (this._shouldDeferClampCommit(window)) {
            Logger.log(`[SMART RESIZE] Window ${window.get_id()} still settling toward ${pendingSmartSize.width}×${pendingSmartSize.height}; extending clamp verification`);
            this._armClampVerification(window, pendingSmartSize);
            return;
        }
        if (this._consumeReleaseClamp(window, pendingSmartSize)) return;

        Logger.log(`[SMART RESIZE] Window ${window.get_id()} never applied ${pendingSmartSize.width}×${pendingSmartSize.height}; committing frame ${rect.width}×${rect.height}`);
        this._commitClampedSize(window, pendingSmartSize, rect);
    }

    _clampOwnerChanged(window) {
        if (!this._roleOwnsLiveGeometry(window) ||
            this._ext.dominantManager?.isReleaseSettling(window)) return false;
        this.revokeNormalResizeContract(window, 'clamp-owner-changed', {clearRestoreBridge: true});
        return true;
    }

    _sameSmartResizeTarget(window, target) {
        const current = WindowState.get(window, 'targetSmartResizeSize');
        return !!current && current.width === target.width && current.height === target.height;
    }

    _frameExceedsTarget(rect, target) {
        return rect.width > target.width + 2 || rect.height > target.height + 2;
    }

    _consumeReleaseClamp(window, target) {
        if (!this._ext.dominantManager?.isReleaseSettling(window)) return false;
        Logger.log(`[DOMINANT] Release target ${target.width}×${target.height} not committed by ${window.get_id()}; preserving compact presentation without learning a minimum`);
        WindowState.set(window, 'targetSmartResizeSize', null);
        WindowState.remove(window, 'targetSmartResizeSetAt');
        // This only rejects the observed configure as proof of a client minimum. The
        // release transaction still owns its normal-role restoration goal; dropping that
        // goal here would strand the compact presentation with no target left to retry.
        return true;
    }

    _disarmClampVerification(window) {
        const verifyId = WindowState.get(window, 'clampVerifyId');
        if (verifyId === undefined) return;
        this._timeoutRegistry.remove(verifyId);
        WindowState.remove(window, 'clampVerifyId');
    }

    onResizeBegin(window, grabpo) {
        this._cancelConstrainedReconcile(window);
        this._resizeInOverflow = false;
        this._lastResizeTileTime = 0;
        this.tilingManager.isResizing = true;
        this.animationsManager.setResizingWindow(window.get_id());

        // Always clear pending resize targets so manual resize takes precedence
        WindowState.set(window, 'targetSmartResizeSize', null);
        WindowState.remove(window, 'targetRestoredSize');
        if (WindowState.get(window, 'isSmartResizing')) {
            Logger.log(`Manual resize started for ${window.get_id()} - clearing smart-resize state`);
            WindowState.set(window, 'isSmartResizing', false);
        }

        Logger.log(`Tracking resize for window ${window.get_id()}, grabpo=${grabpo}`);
    }

    onResizeEnd(window, grabpo, skipTiling) {
        // Keep resizingWindowId set during final retile to prevent animation jiggle
        Logger.log(`Resize ended for window ${window.get_id()}`);

        // Clear before the final retile, same as disableDragMode ahead of a drop's retile: the
        // grab is over, so this pass is allowed to commit a real eviction.
        this.tilingManager.isResizing = false;

        const tileState = this.edgeTilingManager.getWindowState(window);
        const isEdgeTiled = tileState && tileState.zone !== TileZone.NONE;

        if (isEdgeTiled) {
            this._fixEdgeTiledSizesOnResizeEnd(window, tileState.zone, grabpo);
        }

        if (this._resizeDebounceTimeout) {
            this._timeoutRegistry.remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }

        this._resizeGracePeriod = monotonicNow();

        if (this._resizeInOverflow || this._resizeOverflowWindow === window) {
            this._finishOverflowResize(window);
        } else if (!isEdgeTiled && !skipTiling) {
            this.tilingManager.savePreferredSize(window);
            this.tilingManager.invalidateLayoutCache();
            this.tilingManager.tileWorkspaceWindows(window.get_workspace(), null, window.get_monitor(), true);
        }

        // Clear resizing state AFTER final retile to prevent animation jiggle on drop
        this.animationsManager.setResizingWindow(null);
    }

    _fixEdgeTiledSizesOnResizeEnd(window, zone, grabpo) {
        if (zone === TileZone.LEFT_FULL || zone === TileZone.RIGHT_FULL) {
            Logger.log(`Resize ended (grabpo=${grabpo}) for FULL edge-tiled window - fixing final sizes`);
            const adjacentWindow = this.edgeTilingManager._getAdjacentWindow(window, window.get_workspace(), window.get_monitor(), zone);
            if (adjacentWindow) {
                this.edgeTilingManager.fixTiledPairSizes(window, zone);
            } else {
                this.edgeTilingManager.fixMosaicAfterEdgeResize(window, zone);
            }
        } else if (this.edgeTilingManager.isQuarterZone(zone)) {
            Logger.log(`Resize ended (grabpo=${grabpo}) for QUARTER edge-tiled window - fixing final sizes`);
            this.edgeTilingManager.fixQuarterPairSizes(window, zone);
        }
    }

    _finishOverflowResize(window) {
        Logger.log('Resize ended with overflow - moving window to new workspace');
        this._resizeInOverflow = false;
        const actor = window.get_compositor_private();
        if (actor) actor.opacity = 255;

        const oldWorkspace = window.get_workspace();
        this.windowingManager.moveOversizedWindow(window).then(newWorkspace => {
            if (newWorkspace) {
                afterAnimations(this.animationsManager, () => {
                    const monitor = window.get_monitor();
                    if (monitor !== null) {
                        this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, monitor, false);
                    }
                }, this._timeoutRegistry);
            }
        });
        this._resizeOverflowWindow = null;
    }

    onSizeChange = (_, win, mode) => {
        const window = win.meta_window;
        if (this.windowingManager.isExcluded(window)) return;

        if (mode === Meta.SizeChange.MAXIMIZE) {
            // MAXIMIZE transfers geometry ownership away from the normal Smart Resize
            // contract. A pending normal target must die before Mutter exposes the native
            // maximized frame, otherwise the clamp verifier can mistake that role-change
            // frame for an application-enforced minimum.
            this.revokeNormalResizeContract(window, 'native-maximize', {clearRestoreBridge: true});
            this._ext.dominantManager?.handleNativeEnter(window, 'manual-maximize');
        } else if (mode === Meta.SizeChange.UNMAXIMIZE) {
            this._ext.dominantManager?.handleNativeExit(window, 'unmaximize');
        }
    };

    onSizeChanged = (_, win) => {
        const window = win.meta_window;
        // The latch is only false when no retile of ours is in flight; excluded windows never tile.
        if (this._sizeChanged || this.windowingManager.isExcluded(window)) return;

        const rect = window.get_frame_rect();
        const roleOwnedAtEntry = this._roleOwnsLiveGeometry(window);
        // First-placement visibility is gated on the client committing Mosaic's planned
        // geometry. Smart-resize configure acks are intentionally consumed below, so retry
        // the deferred entrance before any of those guards can swallow this size event.
        this.animationsManager?.runDeferredEntrance(window);
        // Dominant release uses the same rule at workspace scale: compact miniatures stay in
        // place until the compositor's live normal frames can safely coexist with the full-size
        // miniature rail. Notify before resize guards consume the configure ack.
        this._ext.dominantManager?.notifyGeometryChanged(window);
        if (this._consumeRoleOwnedSizeChange(window, rect, roleOwnedAtEntry)) return;
        if (this._ignoreSizeChange(window, rect)) return;

        if (this._handleClampAfterResize(window, rect)) return;

        // isConstrainedByMosaic is durable size ownership; targetSmartResizeSize only exists
        // while one Wayland configure is in flight. Firefox can acknowledge that configure and
        // then publish its startup/session-restored size again a frame later. Feeding that late
        // live frame back into canFitWindow turns presentation drift into new layout input and
        // can invalidate a perfectly valid miniature rail. Reconcile the presentation to the
        // committed model instead; if arrival/tiling is still active, defer until it is safe.
        if (this._handleConstrainedModelDrift(window, rect)) return;

        this._liftStaleMinConstraint(window, rect);

        const ctx = this._computeResizeContext(window, rect);
        this._updatePreferredSizeFromResize(window, rect, ctx);

        if (this._shouldSkipRetileAfterResize(window, ctx)) return;

        this._retileAfterSizeChange(window);
    };

    _consumeRoleOwnedSizeChange(window, rect, roleOwnedAtEntry) {
        if (!roleOwnedAtEntry) return false;
        // Release settling may still carry a fresh normal target whose ack needs to be
        // consumed, but no role-owned frame may reach the normal preferred/minimum
        // learners or generic resize retile path.
        if (this._ext.dominantManager?.isReleaseSettling(window))
            this._handleClampAfterResize(window, rect);
        else
            this.revokeNormalResizeContract(window, 'role-owned-geometry', {clearRestoreBridge: true});
        this._sizeChanged = false;
        return true;
    }

    _ignoreSizeChange(window, rect) {
        if (!this.windowingManager.isRelated(window)) return true;
        // A miniature's MetaWindow frame is only the backing surface being scaled by
        // MiniatureManager. Clients may settle that backing frame while the visible
        // miniature stays in its slot; those configure echoes are not layout intent.
        if (WindowState.get(window, WindowState.IS_MINIATURE)) {
            this._sizeChanged = false;
            return true;
        }
        // Windows pending in the evaluation queue haven't been processed yet, so ignore size changes
        if (WindowState.get(window, 'pendingInQueue')) return true;
        if (rect.width <= constants.ANIMATION_DIFF_THRESHOLD || rect.height <= constants.ANIMATION_DIFF_THRESHOLD) return true;

        if (WindowState.get(window, 'isSmartResizing') || WindowState.get(window, 'isReverseSmartResizing')) {
            Logger.log(`[GUARD-BLOCK] onSizeChanged short-circuited for ${window.get_id()} - isSmartResizing=${WindowState.get(window, 'isSmartResizing')} isReverseSmartResizing=${WindowState.get(window, 'isReverseSmartResizing')}`);
            this._sizeChanged = false;
            return true;
        }
        return false;
    }

    // Detect client-side clamping after smart resize. Returns true when the event is consumed.
    _handleClampAfterResize(window, rect) {
        const pendingSmartSize = WindowState.get(window, 'targetSmartResizeSize');
        if (!pendingSmartSize) return false;

        // Actual size above target means the client enforced a larger minimum.
        if (rect.width > pendingSmartSize.width + 2 || rect.height > pendingSmartSize.height + 2) {
            if (this._shouldDeferClampCommit(window)) {
                // A young client often acks a beat late, so this frame is stale
                // rather than a real minimum; the verification settles it.
                Logger.log(`[SMART RESIZE] Window ${window.get_id()} above target while settling: target=${pendingSmartSize.width}×${pendingSmartSize.height}, actual=${rect.width}×${rect.height}; deferring to verification`);
                this._armClampVerification(window, pendingSmartSize);
                this._sizeChanged = false;
                return true;
            }

            if (this._consumeReleaseClamp(window, pendingSmartSize)) {
                this._sizeChanged = false;
                return true;
            }

            this._commitClampedSize(window, pendingSmartSize, rect);
        } else {
            // A frame observed below a recorded minimum disproves it, so drop the pin.
            const minW = WindowState.get(window, 'actualMinWidth');
            const minH = WindowState.get(window, 'actualMinHeight');
            if ((minW && rect.width < minW - 2) || (minH && rect.height < minH - 2)) {
                WindowState.remove(window, 'actualMinWidth');
                WindowState.remove(window, 'actualMinHeight');
            }
            WindowState.set(window, 'targetSmartResizeSize', null);
            this._disarmClampVerification(window);
        }

        this._sizeChanged = false;
        return true;
    }

    _handleConstrainedModelDrift(window, rect) {
        if (!WindowState.get(window, 'isConstrainedByMosaic')) return false;
        if (this._currentGrabOp && isResizeGrabOp(this._currentGrabOp)) return false;

        const slot = MosaicModel.normalSlotFor(window);
        if (!slot || !this._sizeDiffers(rect, slot)) return false;

        Logger.log(`[MODEL RECONCILE] Constrained window ${window.get_id()} drifted from committed ${slot.width}x${slot.height} to live ${rect.width}x${rect.height}; deferring presentation reconcile`);
        this._queueConstrainedReconcile(window);
        this._sizeChanged = false;
        return true;
    }

    _sizeDiffers(actual, target) {
        return Math.abs(actual.width - target.width) > constants.ANIMATION_DIFF_THRESHOLD ||
            Math.abs(actual.height - target.height) > constants.ANIMATION_DIFF_THRESHOLD;
    }

    _queueConstrainedReconcile(window) {
        const id = window.get_id();
        if (this._constrainedReconciles.has(id)) return;

        const pending = {window, timeoutId: null};
        this._constrainedReconciles.set(id, pending);
        this._tryConstrainedReconcile(pending);
    }

    _tryConstrainedReconcile(pending) {
        const {window} = pending;
        const id = window?.get_id?.();
        if (id === undefined || this._constrainedReconciles.get(id) !== pending) return;

        if (!this._canKeepConstrainedReconcile(window)) {
            this._cancelConstrainedReconcile(window);
            return;
        }

        const slot = MosaicModel.normalSlotFor(window);
        const frame = window.get_frame_rect();
        if (!slot || !this._sizeDiffers(frame, slot)) {
            this._cancelConstrainedReconcile(window);
            return;
        }

        if (this._constrainedReconcileBlocked(window)) {
            this._scheduleConstrainedReconcileRetry(pending);
            return;
        }

        // Renew the transient configure bridge so normal clamp detection still works if the
        // client genuinely can no longer satisfy the committed slot. The model remains the
        // durable intent; this request only reconciles Mutter's live presentation to it.
        this._constrainedReconciles.delete(id);
        this.tilingManager.setSmartResizeTarget(window, slot);
        Logger.log(`[MODEL RECONCILE] Reasserting committed slot for ${id}: live=${frame.width}x${frame.height} → ${slot.width}x${slot.height}`);

        // Suppress a synchronous configure echo from recursively entering this same handler.
        this._sizeChanged = true;
        try {
            this.animationsManager.animateWindow(window, slot, {subtle: true});
        } finally {
            this._sizeChanged = false;
        }
    }

    _canKeepConstrainedReconcile(window) {
        if (!isWindowAlive(window) || !this._ext || this.windowingManager.isExcluded(window)) return false;
        if (!WindowState.get(window, 'isConstrainedByMosaic')) return false;
        if (this._roleOwnsLiveGeometry(window)) return false;
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        return !!workspace && workspace.index() >= 0 && monitor !== null && monitor >= 0;
    }

    _constrainedReconcileBlocked(window) {
        const workspace = window.get_workspace();
        return this._constrainedReconcileTransactionBusy(window, workspace) ||
            this._constrainedReconcileInteractionBusy();
    }

    _constrainedReconcileTransactionBusy(window, workspace) {
        return this._ext.windowHandler?.isWorkspaceLocked(workspace) ||
            this._ext.windowHandler?.isEvaluatingQueue ||
            WindowState.get(window, 'arrivalPending') ||
            WindowState.get(window, 'pendingInQueue') ||
            WindowState.get(window, 'pendingFirstPlacement') ||
            WindowState.get(window, 'isMosaicResizing');
    }

    _constrainedReconcileInteractionBusy() {
        return this.tilingManager._isSmartResizingBlocked ||
            this.tilingManager.isDragging ||
            this.tilingManager.isResizing ||
            this._isEdgeTileRestoreSettling(monotonicNow());
    }

    _scheduleConstrainedReconcileRetry(pending) {
        if (pending.timeoutId || !this._timeoutRegistry) return;
        pending.timeoutId = this._timeoutRegistry.add(constants.POLL_INTERVAL_MS, () => {
            pending.timeoutId = null;
            this._tryConstrainedReconcile(pending);
            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_constrainedModelReconcile');
    }

    _cancelConstrainedReconcile(window) {
        const id = window?.get_id?.();
        if (id === undefined) return;
        const pending = this._constrainedReconciles?.get(id);
        if (!pending) return;
        if (pending.timeoutId && this._timeoutRegistry)
            this._timeoutRegistry.remove(pending.timeoutId);
        this._constrainedReconciles.delete(id);
    }

    // A frame well above a recorded minimum disproves it (the window clearly can go bigger).
    _liftStaleMinConstraint(window, rect) {
        if (WindowState.get(window, 'actualMinWidth') && rect.width > WindowState.get(window, 'actualMinWidth') + 20) {
            WindowState.remove(window, 'actualMinWidth');
            WindowState.remove(window, 'actualMinHeight');
        }
    }

    _computeResizeContext(window, rect) {
        const isConstrained = WindowState.get(window, 'isConstrainedByMosaic');
        const userForcedResize = this._detectUserForcedResize(window, rect, isConstrained);
        const isMonitorSized = this._isMonitorSizedFrame(window, rect);
        const { isEaseEcho, clientOwnedSize } = this._classifyEase(window, rect);
        return { isConstrained, userForcedResize, isMonitorSized, isEaseEcho, clientOwnedSize };
    }

    // Manual grab, or a constrained window whose frame drifted far from its Smart Resize
    // target (an ambient/client-side resize), both count as the user forcing the size.
    _detectUserForcedResize(window, rect, isConstrained) {
        if (this._currentGrabOp && isResizeGrabOp(this._currentGrabOp)) return true;
        if (!isConstrained) return false;

        const target = WindowState.get(window, 'targetSmartResizeSize');
        if (!target) return false;

        const wDiff = Math.abs(rect.width - target.width);
        const hDiff = Math.abs(rect.height - target.height);
        if (wDiff > 10 || hDiff > 10) {
            Logger.log(`Detected ambient/client-side resize for constrained window ${window.get_id()} (delta: ${wDiff}x${hDiff})`);
            return true;
        }
        return false;
    }

    // A born-maximized window mid-unmaximize can report its still-fullscreen frame here before
    // tiling shrinks it; treating that as preferredSize makes it read as workspace-filling forever.
    _isMonitorSizedFrame(window, rect) {
        const sizeWorkspace = window.get_workspace();
        const sizeMonitor = window.get_monitor();
        const sizeWorkArea = sizeWorkspace && sizeMonitor !== null && sizeMonitor !== undefined
            ? sizeWorkspace.get_work_area_for_monitor(sizeMonitor) : null;
        return sizeWorkArea && rect.width >= sizeWorkArea.width && rect.height >= sizeWorkArea.height;
    }

    // An ease echoes back the size the layout picked, which says nothing about what the window
    // wants. Anything else arriving mid-ease is the client's own size. No target means no echo.
    _classifyEase(window, rect) {
        const easeTarget = WindowState.get(window, 'isMosaicResizing')
            ? this.animationsManager.getAnimatingTarget(window.get_id())
            : null;
        const isEaseEcho = !!easeTarget &&
            Math.abs(rect.width - easeTarget.width) <= constants.EASE_TARGET_TOLERANCE_PX &&
            Math.abs(rect.height - easeTarget.height) <= constants.EASE_TARGET_TOLERANCE_PX;
        return { isEaseEcho, clientOwnedSize: !!easeTarget && !isEaseEcho };
    }

    _updatePreferredSizeFromResize(window, rect, { isConstrained, userForcedResize, isMonitorSized, clientOwnedSize }) {
        // A dominant-release frame is owned by the transition until the live geometry solver
        // commits the normal presentation. The client may echo the old dominant/native size
        // while targetRestoredSize is already the real normal intent; learning that echo as
        // preferredSize would make later restores chase the dominant frame forever. An active
        // user resize still wins and is allowed to replace the intent explicitly.
        if (this._ext.dominantManager?.isReleaseSettling(window) && !userForcedResize) {
            Logger.log(`[DOMINANT] Preserving preferred size for ${window.get_id()} while release geometry settles`);
            return;
        }

        const edgeState = this.edgeTilingManager.getWindowState(window);
        const isEdgeTiledNow = edgeState && edgeState.zone !== TileZone.NONE;

        if (isEdgeTiledNow) {
            // An edge tile's frame comes from its zone, so preferredSize stays the pre-tiling value.
            Logger.log(`onSizeChanged: preferredSize preserved for edge-tiled ${window.get_id()}`);
        } else if (isMonitorSized) {
            Logger.log(`onSizeChanged: Rejected monitor-sized dimensions ${rect.width}x${rect.height} for ${window.get_id()}`);
        } else if (userForcedResize) {
            WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
            // The user dragged the edge, so the model takes that as the new intent rather
            // than reapplying a target they just overrode.
            MosaicModel.learn(window, rect);
            if (isConstrained) {
                WindowState.set(window, 'isConstrainedByMosaic', false);
                Logger.log(`Manual resize for ${window.get_id()} - cleared constraint`);
            }
            Logger.log(`Preferred size updated (manual): ${window.get_id()} = ${rect.width}x${rect.height}`);
        } else if (!isConstrained) {
            this._maybeSaveAmbientPreferredSize(window, rect, clientOwnedSize);
        }
    }

    _maybeSaveAmbientPreferredSize(window, rect, clientOwnedSize) {
        // Not constrained and not manual: an initial placement or a legitimate external
        // resize, but still guarded against transition states that report a transient size.
        if (this._inResizeTransition(window, clientOwnedSize)) {
            Logger.log(`onSizeChanged: Save blocked by transition flag for ${window.get_id()}`);
            return;
        }

        // Past the transition guard, whatever lands below is a size the client actually
        // settled on, so the model needs to match it or it keeps steering toward a stale slot.
        const currentPreferredSize = WindowState.get(window, 'preferredSize');
        if (currentPreferredSize) {
            const widthDiff = Math.abs(rect.width - currentPreferredSize.width);
            const heightDiff = Math.abs(rect.height - currentPreferredSize.height);
            if (widthDiff > constants.ANIMATION_DIFF_THRESHOLD || heightDiff > constants.ANIMATION_DIFF_THRESHOLD) {
                WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
                MosaicModel.learn(window, rect);
                Logger.log(`Preferred size updated (ambient): ${window.get_id()} = ${rect.width}x${rect.height}`);
            }
        } else if (WindowState.get(window, 'geometryReady')) {
            WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
            MosaicModel.learn(window, rect);
            Logger.log(`Initial preferred size saved: ${window.get_id()} = ${rect.width}x${rect.height}`);
        }
    }

    _inResizeTransition(window, clientOwnedSize) {
        return WindowState.get(window, 'isMosaicResizing') && !clientOwnedSize;
    }

    _shouldSkipRetileAfterResize(window, ctx) {
        if (this._skipNextTiling === window.get_id()) return true;

        // The ease owns the actor and its echo tells us nothing new; a client-picked size
        // must reach the layout, or it keeps placing the window at a size it doesn't have.
        if (ctx.isEaseEcho) {
            this._sizeChanged = false;
            return true;
        }

        // A new window commits its first size before the arrival pipeline places it, and this
        // global handler sees it ahead of the queue; the arrival evaluation runs the same pass.
        if (WindowState.get(window, 'arrivalPending')) {
            this._sizeChanged = false;
            return true;
        }

        const tileState = this.edgeTilingManager.getWindowState(window);
        return !!(tileState && tileState.zone !== TileZone.NONE);
    }

    // The latch (_sizeChanged) blocks re-entry while our own tileWorkspaceWindows below
    // fires more size-changes; every exit clears it.
    _retileAfterSizeChange(window) {
        this._sizeChanged = true;
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();

        if (WindowState.get(window, 'movedByOverflow')) {
            this._sizeChanged = false;
            return;
        }

        if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
            const isManualResize = this._currentGrabOp && isResizeGrabOp(this._currentGrabOp);
            const windowId = window.get_id();
            const resizeNow = monotonicNow();
            const isActiveResize = isManualResize ||
                (this._lastResizeWindow === windowId && (resizeNow - this._lastResizeTime) < constants.RESIZE_SETTLE_DELAY_MS * 2);
            this._lastResizeWindow = windowId;
            this._lastResizeTime = resizeNow;

            if (isActiveResize) {
                this._retileDuringActiveResize(window, workspace, monitor, resizeNow);
                this._sizeChanged = false;
                return;
            }

            if (this._retileAfterSettledResize(window, workspace, monitor)) return;
        }

        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
        this._sizeChanged = false;
    }

    _retileDuringActiveResize(window, workspace, monitor, resizeNow) {
        // Throttle: execute immediately, skip if too soon since last retile
        if (this._lastResizeTileTime && (resizeNow - this._lastResizeTileTime) < 16) {
            return;
        }
        this._lastResizeTileTime = resizeNow;

        if (this._resizeDebounceTimeout) {
            this._timeoutRegistry.remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }

        const canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
        const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
        const isSolo = mosaicWindows.length <= 1;

        // Block moves during smart resize to prevent expelling windows on revert.
        const isSmartResizing = this.tilingManager._isSmartResizingBlocked;
        // Skip ghost detection right after smart resize to prevent false positives from unsettled rects.
        const hasUnsettledSmartResize = WindowState.get(window, 'targetSmartResizeSize') !== null;

        if (!canFit && !this._resizeInOverflow && !isSolo && !isSmartResizing && !hasUnsettledSmartResize) {
            this._enterResizeGhostMode(window, workspace, monitor);
            return;
        }

        this._recoverAndTileDuringResize(window, workspace, monitor, mosaicWindows, canFit);
    }

    _enterResizeGhostMode(window, workspace, monitor) {
        if (WindowState.get(window, 'waitingForGeometry') || !WindowState.get(window, 'geometryReady')) {
            return;
        }

        // GHOST MODE: Reduce opacity to signal that the window no longer fits.
        this._resizeInOverflow = true;
        this._resizeOverflowWindow = window;
        const actor = window.get_compositor_private();
        if (actor) actor.opacity = 128;
        Logger.log(`Resize overflow detected for window ${window.get_id()} - enabling ghost mode`);
        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true, false);
    }

    _recoverAndTileDuringResize(window, workspace, monitor, mosaicWindows, canFit) {
        if (canFit && this._resizeInOverflow) {
            this._resizeInOverflow = false;
            this._resizeOverflowWindow = null;
            const actor = window.get_compositor_private();
            if (actor) actor.opacity = 255;
            Logger.log(`Window ${window.get_id()} recovered from resize overflow`);
        }

        const excludeWindow = this._resizeInOverflow ? window : null;
        const excludeFromTiling = this._resizeInOverflow;
        this.tilingManager.tileWorkspaceWindows(workspace, excludeWindow, monitor, true, excludeFromTiling);

        // Shrinking the dragged window can free up room for a sibling
        // miniature mid-drag. The overflow path only checks the inverse.
        if (!this._resizeInOverflow && this._ext.windowHandler) {
            this._ext.windowHandler._tryAutoRestoreMiniature(mosaicWindows, workspace, monitor);
        }
    }

    // Returns true when it fully handled the event (caller must stop); false to fall through
    // to the final catch-all retile.
    _retileAfterSettledResize(window, workspace, monitor) {
        const canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
        const now = monotonicNow();

        if (this._settledResizeShouldSkip(window, now)) {
            this._sizeChanged = false;
            return true;
        }

        // Throttle to avoid excessive calculations during smooth resizing
        if (canFit && this._lastTileTime && (now - this._lastTileTime < 30)) {
            this._sizeChanged = false;
            return true;
        }
        if (canFit) this._lastTileTime = now;

        return false;
    }

    // Reasons a settled-resize retile is a no-op: still in the reverse-resize grace window,
    // a smart resize owns the geometry, the arrival queue or a drag is already tiling, or an
    // edge-tile exit is restoring full size into a tight mosaic (must miniaturize, not eject).
    _settledResizeShouldSkip(window, now) {
        if (this._resizeGracePeriod && (now - this._resizeGracePeriod) < constants.REVERSE_RESIZE_PROTECTION_MS) {
            return true;
        }
        if (WindowState.get(window, 'isSmartResizing') || this.tilingManager._isSmartResizingBlocked) {
            return true;
        }
        if (this._ext.windowHandler && this._ext.windowHandler.isEvaluatingQueue) {
            return true;
        }
        if (this.tilingManager.isDragging) {
            return true;
        }
        if (this._isEdgeTileRestoreSettling(now)) {
            return true;
        }
        return false;
    }

    // The drag flag and the edge-tiling stamp both mean the same thing here, just raised by
    // different callers (mouse drag vs. every removeTile caller including the keyboard path).
    _isEdgeTileRestoreSettling(now) {
        return this._ext.dragHandler?._restoringFromEdgeTile ||
            this.edgeTilingManager.isRestoringFromEdgeTile(now);
    }


    destroy() {
        for (const pending of this._constrainedReconciles?.values() ?? []) {
            if (pending.timeoutId && this._timeoutRegistry)
                this._timeoutRegistry.remove(pending.timeoutId);
        }
        this._constrainedReconciles?.clear();
        if (this._resizeDebounceTimeout) {
            this._timeoutRegistry.remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }
        this._resizeInOverflow = false;
        this._resizeOverflowWindow = null;
        this._sizeChanged = false;
        this._resizeGracePeriod = null;
        this._lastResizeWindow = null;
        this._lastResizeTime = 0;
        this._lastResizeTileTime = 0;
        this._constraintRebalanceQueued = false;
        this._constraintRebalanceCount = 0;
        this._ext = null;
    }
} );
