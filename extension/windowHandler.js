// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// WindowHandler manages window lifecycle signals and state transitions.

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import { TileZone } from './constants.js';
import * as WindowState from './windowState.js';
import {
    IS_MINIATURE,
    PENDING_MINIATURE,
    MOSAIC_FULLSCREEN,
    MOSAIC_FULLSCREEN_KIND,
    MINIATURE_FULLSCREEN_PAUSE,
} from './windowState.js';
import { MosaicModel } from './mosaicModel.js';
import { TileLockLedger } from './tileLockLedger.js';
import { isWindowAlive } from './liveness.js';
import { afterWorkspaceSwitch, afterAnimations, afterWindowClose, monotonicNow } from './timing.js';

export const WindowHandler = GObject.registerClass({
    GTypeName: 'MosaicWindowHandler',
}, class WindowHandler extends GObject.Object {
    _init(extension) {
        super._init();
        this._ext = extension;
        // Reference-counted tile locks, with the exception net and fallback release built in.
        // The entry is registered when the lock is taken, so a pass that dies before it can
        // schedule its deferred unlock still has something to reclaim.
        this._locks = new TileLockLedger(extension?._timeoutRegistry ?? null,
            (workspace, message) => Logger.log(`Workspace ${workspace?.index?.()} ${message}`));

        // One automatic-restore chain, tracked so it cannot re-restore a window it already
        // brought back. Every restore re-enters the tile pass synchronously, so an unstable
        // fit used to ping-pong restore -> reject -> miniaturize -> restore until the JS
        // stack blew up and left the workspace lock behind.
        this._cascadeRestoring = false;
        this._cascadeAttempted = new Set();
        this._cascadeGuardReleaseId = 0;
        // True while the set above is deliberately held across a settle window.
        this._cascadeGuardHeld = false;

        this._evaluationQueue = [];
        this._isEvaluatingQueue = false;

        this._windowSignals = new WeakMap(); // WeakMap so signal IDs are released when the window is GC'd
        this._readinessWaiters = new Set();
    }

    destroy() {
        this._locks.clear();
        this._cascadeAttempted.clear();
        this._cascadeRestoring = false;
        this._cascadeGuardHeld = false;
        if (this._cascadeGuardReleaseId) {
            this._timeoutRegistry?.remove(this._cascadeGuardReleaseId);
            this._cascadeGuardReleaseId = 0;
        }
        this.releaseRoleState();

        for (const entry of this._evaluationQueue)
            WindowState.remove(entry.window, 'pendingInQueue');
        this._evaluationQueue = [];
        this._isEvaluatingQueue = false;
        for (const waiter of this._readinessWaiters) {
            for (const id of waiter.ids) waiter.window.disconnect(id);
        }
        this._readinessWaiters.clear();
    }

    // Role flags describe state *Mosaic* put a window in, and their only owner is the
    // 'notify::fullscreen' handler that disable() just disconnected. A window that leaves
    // fullscreen while the extension is off therefore never reaches _leaveFullscreen, and
    // the surviving MOSAIC_FULLSCREEN flag keeps reporting it as fullscreen-like forever:
    // _nativeStateBlocksLayout then aborts every tile pass for its workspace, so that
    // workspace silently stops tiling (no layout, no miniature restore, no overflow
    // handling) until the user happens to toggle fullscreen again. Hand the role back on
    // the way out instead of leaving it to a signal that will never arrive.
    releaseRoleState() {
        for (const window of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)) {
            WindowState.remove(window, MOSAIC_FULLSCREEN);
            WindowState.remove(window, MOSAIC_FULLSCREEN_KIND);
            WindowState.remove(window, MINIATURE_FULLSCREEN_PAUSE);
        }
    }

    // Some windows aren't identifiable at map time (wm_class can arrive seconds
    // late), so retry the gate whenever the relevant state changes.
    _awaitWindowReadiness(window, tryProceed) {
        const waiter = { window, ids: [] };
        const finish = () => {
            for (const id of waiter.ids) window.disconnect(id);
            waiter.ids = [];
            this._readinessWaiters.delete(waiter);
        };
        const retry = () => {
            if (!isWindowAlive(window)) {
                finish();
                return;
            }
            if (tryProceed()) finish();
        };
        for (const signal of ['notify::wm-class', 'size-changed', 'notify::minimized'])
            waiter.ids.push(window.connect(signal, retry));
        waiter.ids.push(window.connect('unmanaged', finish));
        this._readinessWaiters.add(waiter);
    }

    // Claiming the entrance hides the actor and cancels Mutter's open animation,
    // betting the tile pass eases it in. Whoever the tile pass won't touch (disabled
    // workspace or opening alone) can't take that bet: the failsafe a full
    // second later would be their only way back to visible.
    shouldSkipSlideIn(window) {
        return WindowState.get(window, 'movedByOverflow') || this._ext._overflowInProgress
            || !this._ext.isMosaicEnabledForWorkspace(window.get_workspace())
            || this.windowingManager.isMaximizedOrFullscreen(window)
            || this.windowingManager.isExcludedByPolicy(window)
            || !this._hasSiblings(window);
    }

    // Floating windows never enter the tile pass that would clear opacity=0;
    // reveal so the slide-in failsafe isn't their only path to visibility.
    revealPendingEntrance(window) {
        if (!WindowState.get(window, 'pendingFirstPlacement')) return;
        WindowState.remove(window, 'pendingFirstPlacement');
        this.animationsManager.cancelPendingEntrance(window);
        const actor = isWindowAlive(window) ? window.get_compositor_private() : null;
        if (actor && !actor.is_destroyed()) {
            actor.remove_transition('opacity');
            actor.opacity = 255;
        }
    }

    // Lock a workspace to prevent recursive or conflicting tiling triggers.
    // Reference-counted: overlapping tileWorkspaceWindows calls (e.g. drag-end and resize-end
    // firing close together) each hold their own depth, so the workspace stays locked until
    // every holder has unlocked. Returns the ledger token that owns this depth, or null when
    // there is no workspace to lock.
    lockWorkspace(workspace, fallbackDelayMs = 0) {
        return this._locks.acquire(workspace, fallbackDelayMs);
    }

    // A raw decrement, for a caller that holds a workspace rather than a token. Nothing in the
    // tile-pass lifecycle uses it any more: a pass retires its ledger entry through
    // releaseTileLock/scheduleWorkspaceUnlock so the entry and the depth move together. Kept
    // because it is the handler's only way to drop a depth it has no token for.
    unlockWorkspace(workspace) {
        this._locks.releaseWorkspace(workspace);
    }

    // Converts a pass's lock into a delayed unlock: the entry already exists, so this only
    // decides *when* the lock comes back, never *whether* it does.
    scheduleWorkspaceUnlock(token, delayMs, name) {
        this._locks.defer(token, delayMs, name);
    }

    // Returns a lock synchronously, for paths that finish positioning without a deferred
    // unlock (early bail, dry run, abort, synchronous draw). The ledger leaves a deferred
    // token to its own timer.
    releaseTileLock(token) {
        this._locks.release(token);
    }

    // Scoped reclaim, for a caller that knows which pass it is retiring.
    //
    // The token is required on purpose. The ledger holds an entry for every lock that exists,
    // in-flight passes included, so a blanket release would end other passes' settle delays and
    // leave their own finally to decrement a depth that is already gone. A caller that cannot
    // name the pass it is retiring has no business releasing anything: the pass's finally and
    // the ledger's fallback timer already cover every way a pass can end.
    releaseLocks(token) {
        if (!token) {
            Logger.error('releaseLocks called without a token; a pass releases its own lock in its finally');
            return;
        }
        this._locks.releaseAll(token);
    }

    // Runs a tile-pass entry point with the exception net above.
    //
    // It deliberately does NOT release anything. The net used to call releaseLocks() here, but
    // the ledger now registers locks at acquire time, so "release everything" would reach the
    // in-flight locks of other passes and end their settle delays (and their own finally would
    // then decrement a second time). A tile pass releases its own token in
    // TilingManager._runTileWorkspacePass's finally, which runs while this error unwinds, and
    // the ledger's fallback timer covers a caller that never gets there. All this wrapper has
    // to do is make the failure visible.
    guardTilePass(fn) {
        try {
            return fn();
        } catch (error) {
            Logger.error(`Tile pass failed: ${error}`);
            throw error;
        }
    }

    // Every tile pass this handler starts goes through the net, so a throw inside the pass
    // cannot strand the workspace lock it took. The pass owns its lock's lifecycle now
    // (lockWorkspace registers the ledger entry), so the net only has to let the pass's own
    // finally run.
    _tileWorkspace(workspace, referenceWindow, monitor, keepOversized) {
        return this.guardTilePass(() =>
            this.tilingManager.tileWorkspaceWindows(workspace, referenceWindow, monitor, keepOversized));
    }

    isWorkspaceLocked(workspace) {
        return this._locks.isLocked(workspace);
    }

    get isEvaluatingQueue() {
        return this._isEvaluatingQueue;
    }

    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    // Also keeps the ledger's fallback timers on the same registry everything else uses,
    // including when the extension hands it over after construction.
    get _timeoutRegistry() {
        const registry = this._ext._timeoutRegistry;
        this._locks.setTimeoutRegistry(registry);
        return registry;
    }

    connectWindowSignals(window) {
        if (!window || this._windowSignals.has(window)) return;

        Logger.log(`Connecting signals for window ${window.get_id()}`);
        const ids = [];

        ids.push(window.connect('unmanaged', (win) => {
            Logger.log(`Window ${win.get_id()} (unmanaged) - cleaning up`);
            this.animationsManager.removeAnimatingWindow(win.get_id());
            this.animationsManager.cancelPendingEntrance(win);
            this.forgetCascadeGuard(win);
            // The close path tiles and auto-restores synchronously; if any of it throws,
            // releaseLocks reclaims the workspace lock the aborted pass would have leaked.
            // The teardown below runs in a finally: guardTilePass rethrows, and skipping it
            // would strand this window in MosaicModel (a module-level Map that only forget()
            // and clear() shrink) while its layout slots kept being handed to the overview.
            try {
                this.guardTilePass(() => {
                    const ws = win.get_workspace();
                    if (ws) this.onWindowRemoved(ws, win);
                });
            } finally {
                this.disconnectWindowSignals(win);
            }
        }));

        // Fullscreen transitions are not guaranteed to emit Mutter's size-change signal
        // (notably MetaWindow.make_fullscreen()), so fullscreen has one dedicated owner here.
        ids.push(window.connect('notify::maximized-horizontally', win =>
            this.tilingManager.maximizedLayout.nativeStateChanged(win)));
        ids.push(window.connect('notify::maximized-vertically', win =>
            this.tilingManager.maximizedLayout.nativeStateChanged(win)));
        ids.push(window.connect('notify::fullscreen', (win) => {
            if (win.is_fullscreen())
                this._enterFullscreen(win, 'native', false);
            else
                this._leaveFullscreen(win);
        }));

        ids.push(window.connect('notify::above', (win) => this.handleExclusionStateChange(win)));
        ids.push(window.connect('notify::on-all-workspaces', (win) => this.handleExclusionStateChange(win)));
        ids.push(window.connect('notify::minimized', (win) => this.handleExclusionStateChange(win)));
        // skip-taskbar decides TabList.NORMAL membership, which is the MRU ranking every
        // ranker reads, and it is also an exclusion reason. Without this the flip is invisible
        // until some unrelated event invalidates the cache.
        ids.push(window.connect('notify::skip-taskbar', (win) => this.handleExclusionStateChange(win)));

        this._windowSignals.set(window, ids);

        const currentExclusion = this.windowingManager.isExcluded(window);
        WindowState.set(window, 'previousExclusionState', currentExclusion);

        const currentWorkspace = window.get_workspace();
        if (currentWorkspace) {
            WindowState.set(window, 'previousWorkspace', currentWorkspace.index());
        }
    }

    _captureBornFullscreen(window) {
        if (WindowState.get(window, MOSAIC_FULLSCREEN)) return true;
        // Fullscreen is a compositor/window-state role, not a geometry shape. Normal clients
        // can legitimately restore a frame that fills the monitor/work area (WPS, Settings,
        // browsers, etc.); treating that shape as fullscreen bypasses Mosaic admission and
        // lets the client cover the existing layout. PR118 made the same distinction in its
        // fullscreen admission paths: only Mutter's native fullscreen state creates the role.
        if (!window.is_fullscreen?.()) return false;
        // Initial mode can arrive as maximize first, fullscreen a few configure cycles later.
        // Fullscreen wins that startup race: it is not a latent maximize/maximized request.
        this._enterFullscreen(window, 'native', true);
        return true;
    }

    _sampleInitialWindowMode(window) {
        this._captureBornFullscreen(window);
    }

    _enterFullscreen(window, source, born) {
        if (!window || WindowState.get(window, MOSAIC_FULLSCREEN)) return false;

        const role = born ? 'born' : WindowState.get(window, IS_MINIATURE) ? 'miniature' : 'normal';

        WindowState.set(window, MOSAIC_FULLSCREEN, true);
        WindowState.set(window, MOSAIC_FULLSCREEN_KIND, { source, role });
        this.tilingManager.maximizedLayout.forget(window);
        this._ext.miniatureManager?.pauseForFullscreen(window);
        this.revealPendingEntrance(window);
        Logger.log(`[FULLSCREEN] ${window.get_id()} entered ${source} fullscreen from ${role}; workspace membership preserved`);
        return true;
    }

    _leaveFullscreen(window) {
        const state = WindowState.get(window, MOSAIC_FULLSCREEN_KIND);
        if (!WindowState.get(window, MOSAIC_FULLSCREEN) || !state) return false;

        WindowState.remove(window, MOSAIC_FULLSCREEN);
        WindowState.remove(window, MOSAIC_FULLSCREEN_KIND);
        this._ext.miniatureManager?.resumeFromFullscreen(window);

        Logger.log(`[FULLSCREEN] ${window.get_id()} left ${state.source} fullscreen; restoring ${state.role} role in-place`);
        this._restoreFullscreenRole(window, state.role);
        return true;
    }

    _restoreFullscreenRole(window, role) {
        if (window.is_maximized() || role === 'miniature') {
            this.tilingManager.maximizedLayout.queue(window);
            return;
        }
        this.settleReturnedWindow(window);
    }

    // A window leaving a role that owned its geometry (fullscreen, native maximize) must
    // re-fit the mosaic at its preferred size. Smart Resize first, because the preferred
    // frame can exceed the work area and a plain retile would just overflow and abort.
    // Returns false when there is nothing to settle (dead window, disabled workspace).
    settleReturnedWindow(window) {
        const context = this._returnContext(window);
        if (!context) return false;
        const { workspace, monitor, workArea, siblings } = context;

        const size = WindowState.get(window, 'preferredSize') ?? WindowState.get(window, 'openingSize');
        if (size) {
            const target = {width: size.width, height: size.height};
            WindowState.set(window, 'targetRestoredSize', target);
            // Unlike the other bridges this one has no grow settle to clean it up; drop it on
            // the same delay so a stale entry cannot suppress later preferredSize learning.
            this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                WindowState.removeIfCurrent(window, 'targetRestoredSize', target);
                return GLib.SOURCE_REMOVE;
            }, 'windowHandler_returnedSize');
        }

        if (this.tilingManager.maximizedLayout.admit(window)) return true;

        const resizeResult = this.tilingManager.tryFitWithResize(window, siblings, workArea, workspace, window);

        if (resizeResult?.success) {
            this._commitReturnedWindow(workspace, monitor, resizeResult);
            return true;
        }

        Logger.log(`[RESTORE] ${window.get_id()} cannot yet rejoin normal layout; preserving workspace and last valid Mosaic layout`);
        this._tileWorkspace(workspace, null, monitor, false);
        return true;
    }

    _returnContext(window) {
        if (!isWindowAlive(window)) return null;
        const workspace = window.get_workspace?.();
        const monitor = window.get_monitor?.();
        if (!workspace || monitor === null || monitor === undefined || monitor < 0) return null;
        if (!this._ext.isMosaicEnabledForWorkspace(workspace)) return null;
        if (!this._canSettleReturn(window)) return null;

        return {
            workspace,
            monitor,
            workArea: this.tilingManager.getUsableWorkArea(workspace, monitor),
            siblings: this._returnSiblings(window, workspace, monitor),
        };
    }

    // The window being settled needs the same gate its siblings get below. Fullscreen is a
    // role any window can hold, including an excluded one (always-on-top, a dialog), and this
    // path settles a return by Smart Resizing normal mosaic windows to make room. An excluded
    // window never owned Mosaic geometry, so it must not start that transaction: the role is
    // still cleared by _leaveFullscreen, only the re-fit is skipped.
    _canSettleReturn(window) {
        return !this.windowingManager.isExcluded(window) &&
            this.windowingManager.isRelated(window);
    }

    _returnSiblings(window, workspace, monitor) {
        return this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(candidate => candidate !== window)
            .filter(candidate => !this.edgeTilingManager.isEdgeTiled(candidate))
            .filter(candidate => !this.windowingManager.isExcluded(candidate))
            .filter(candidate => !this.windowingManager.isFullscreenLike(candidate));
    }

    _commitReturnedWindow(workspace, monitor, resizeResult) {
        this.tilingManager.withSmartResizeBlock(() => {
            this.tilingManager.mergePendingMiniatures(resizeResult.pendingWindows);
            this._tileWorkspace(workspace, null, monitor, false);
        });
    }

    disconnectWindowSignals(window) {
        const ids = this._windowSignals.get(window);
        if (ids) {
            ids.forEach(id => window.disconnect(id));
            this._windowSignals.delete(window);
            Logger.log(`Disconnected signals for window ${window.get_id()}`);
        }

        MosaicModel.forget(window);

        WindowState.remove(window, 'previousExclusionState');
        WindowState.remove(window, 'previousWorkspace');
        WindowState.remove(window, 'previousWorkspaceObject');
        WindowState.remove(window, 'previousMonitor');
    }

    handleExclusionStateChange(window) {
        const windowId = window.get_id();
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();

        const isNowExcluded = this.windowingManager.isExcluded(window);
        const wasExcluded = WindowState.get(window, 'previousExclusionState') || false;
        WindowState.set(window, 'previousExclusionState', isNowExcluded);

        if (wasExcluded === isNowExcluded) {
            return;
        }

        // Mutter's tab list is the MRU ranking, and an exclusion flip changes it (skip-taskbar
        // and focusability both gate membership). Every ranker reads a missing id as coldest,
        // so a stale ranking picks the wrong window to restore and the wrong one to sacrifice.
        this.windowingManager.invalidateWindowsCache();

        if (isNowExcluded) {
            this.tilingManager.maximizedLayout.forget(window);
            Logger.log(`Window ${windowId} became excluded; retiling without it`);

            // Exclusion arriving after opacity=0 was set (e.g. always-on-top
            // toggled mid-entrance) strands the actor invisible; reveal now.
            this.revealPendingEntrance(window);

            const frame = window.get_frame_rect();
            const freedWidth = frame.width;
            const freedHeight = frame.height;

            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== windowId && !this.windowingManager.isExcluded(w));

                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                let restored = false;
                if (workArea) {
                    restored = this.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, freedWidth, freedHeight, workspace, monitor);
                } else {
                    Logger.log('WindowHandler: Skipped restore - invalid workArea');
                }

                this._tileWorkspace(workspace, null, monitor, false);

                if (restored) {
                    this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                        for (const w of remainingWindows) {
                            WindowState.remove(w, 'isReverseSmartResizing');
                        }
                        return GLib.SOURCE_REMOVE;
                    }, 'windowHandler_excludeRestoreSettle');
                }
                return GLib.SOURCE_REMOVE;
            }, 'windowHandler_excludeRetile');
        } else {
            Logger.log(`Window ${windowId} became included; treating as new window arrival`);

            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                if (!workArea) {
                    Logger.log('WindowHandler: Skipped include - invalid workArea');
                    return GLib.SOURCE_REMOVE;
                }
                const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== window.get_id() && !this.windowingManager.isExcluded(w));

                if (this.tilingManager.maximizedLayout.admit(window)) {
                    Logger.log('Re-include: admitted by active maximized layout in-place');
                    WindowState.set(window, 'justReturnedFromExclusion', true);
                    return GLib.SOURCE_REMOVE;
                }

                if (this.tilingManager.canFitWindow(window, workspace, monitor)) {
                    Logger.log('Re-included window fits without resize');
                    WindowState.set(window, 'justReturnedFromExclusion', true);
                    this._tileWorkspace(workspace, window, monitor, false);
                    return GLib.SOURCE_REMOVE;
                }

                // Try smart resize (now synchronous). Treat the re-included window
                // as focused, since Mutter's focus_window may still point at the
                // previously focused sibling, which would otherwise be excluded
                // from miniaturization candidates alongside newWindow.
                const resizeResult = this.tilingManager.tryFitWithResize(window, existingWindows, workArea, workspace, window);

                if (resizeResult?.success) {
                    Logger.log('Re-include: Smart resize applied - tiling workspace');
                    WindowState.set(window, 'justReturnedFromExclusion', true);
                    this.tilingManager.withSmartResizeBlock(() => {
                        this.tilingManager.mergePendingMiniatures(resizeResult.pendingWindows);
                        this._tileWorkspace(workspace, null, monitor, false);
                    });
                } else {
                    // Re-inclusion is a role change for an existing window, not a new-window
                    // admission. It never owns workspace membership. Give the unified local
                    // solver one final chance to sacrifice other candidates; if it still has no
                    // legal composition, tileWorkspaceWindows preserves the last valid layout.
                    Logger.log('Re-include: Smart resize not applicable - preserving workspace and resolving locally');
                    WindowState.set(window, 'justReturnedFromExclusion', true);
                    this._tileWorkspace(workspace, null, monitor, false);
                }

                return GLib.SOURCE_REMOVE;
            });
        }
    }

    onWindowLeftMonitor(monitor, window) {
        if (!this._windowSignals.has(window)) return;

        // Mutter flips on_all_workspaces (workspaces-only-on-primary) before emitting this,
        // so the window may already report no workspace of its own.
        const workspace = window.get_workspace() ?? global.workspace_manager.get_active_workspace();
        if (!workspace) return;

        Logger.log(`Window ${window.get_id()} left monitor ${monitor}`);

        // onWindowRemoved runs before this signal and can only see the destination
        // monitor, so leave the source behind for its deferred count to pick up.
        WindowState.set(window, 'leftMonitor', monitor);
        WindowState.set(window, 'leftMonitorAt', monotonicNow());

        this.windowingManager.invalidateWindowsCache();

        // Under a grab the drag passes own the layout; retiling here on top of them feeds
        // reverse smart resize back into tiling forever. stopDrag retiles the source.
        if (this._ext.dragHandler._draggedWindow) return;

        const windowId = window.get_id();

        this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
            this.windowingManager.invalidateWindowsCache();

            // A monitor change on its own never reaches onWindowRemoved, so the miniatures this
            // window was crowding would stay shrunk. Restoring retiles on its own.
            if (!WindowState.get(window, 'movedByOverflow')) {
                const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== windowId &&
                                 !this._ext.edgeTilingManager.isEdgeTiled(w) &&
                                 !this.windowingManager.isExcluded(w));

                if (this._tryAutoRestoreMiniature(remainingWindows, workspace, monitor))
                    return GLib.SOURCE_REMOVE;
            }

            this._tileWorkspace(workspace, null, monitor, false);
            return GLib.SOURCE_REMOVE;
        }, 'windowHandler_leftMonitorRetile');
    }

    onWindowEnteredMonitor(monitor, window) {
        if (!this._windowSignals.has(window)) return;

        const workspace = window.get_workspace() ?? global.workspace_manager.get_active_workspace();
        if (!workspace) return;

        // An on-all-workspaces window reports no workspace of its own, but it does show
        // up in every workspace's list, so the active one is the right context to tile in.
        //
        // Excluded first, before the layout calls below: an excluded window (always-on-top
        // -- including this extension's own Shift-launch, skip-taskbar, a dialog) owns no
        // layout transaction, yet admit() calls _yieldMaximizedForArrival -> miniaturize
        // every native-maximized peer of the destination workspace, and caches the excluded
        // window as that view's focus. A floating window crossing monitors would rail the
        // whole workspace.
        if (this.windowingManager.isExcluded(window)) return;

        this.tilingManager.maximizedLayout.forget(window);
        if (this.tilingManager.maximizedLayout.admit(window)) {
            this.windowingManager.invalidateWindowsCache();
            return;
        }

        // A grab drag ends in stopDrag, which tiles the destination itself. Overview
        // drags, keyboard moves and monitor hotplug have no grab, so this is the only
        // place that gets the arriving window into the mosaic.
        if (this._ext.dragHandler._draggedWindow) return;

        Logger.log(`Window ${window.get_id()} entered monitor ${monitor}; evaluating for mosaic`);

        this.windowingManager.invalidateWindowsCache();

        this.enqueueWindowForEvaluation(window, workspace, monitor);
    }

    // Brings back the most recently used miniature when space frees up. Shared by
    // the close, move and live-resize paths so they don't duplicate the fit check.
    //
    // Each restore re-enters this method synchronously through 'miniature-restored' ->
    // _onMiniatureRestored -> _tryCascadeMiniatureRestore, so the outermost call owns a
    // guard: a window this chain already restored is never restored again inside it.
    // Without that, a fit the live tile pass keeps rejecting (canRestoreMiniature simulates
    // with miniature siblings, the pass then validates real geometry and rejects the
    // overlap) made restore and miniaturize ping-pong until the stack overflowed.
    _tryAutoRestoreMiniature(remainingWindows, workspace, monitor) {
        if (!this._ext.miniatureManager) return false;

        const isOutermost = !this._cascadeRestoring;
        // Only when nothing is holding the set. After a chain ends, _armCascadeGuardRelease
        // keeps the set alive across the settle window; clearing here would discard exactly
        // what that hold is protecting, because the settle path re-enters this method from a
        // callback outside the original call (so it is "outermost" by this test).
        if (isOutermost && !this._cascadeGuardHeld)
            this._cascadeAttempted.clear();
        this._cascadeRestoring = true;

        try {
            return this._tryAutoRestoreMiniatureInner(remainingWindows, workspace, monitor);
        } finally {
            if (isOutermost) {
                this._cascadeRestoring = false;
                // Held past the chain, not just to the next idle: the settle path
                // (miniatureRestoreGrowSettle) retiles and re-cascades ~150ms later from a
                // callback that is outside this call, so an idle-scoped guard would already be
                // empty and would let the pass it just ran re-miniaturize and re-restore the
                // same window. See _armCascadeGuardRelease.
                this._armCascadeGuardRelease();
            }
        }
    }

    // Keeps the "already restored in this chain" set alive across the settle window that
    // follows a restore, so the settle retile cannot restart the same restore. The hold is what
    // stops the settle's own outermost call from clearing the set out from under it; the timer
    // releases it, so the set only ever holds one chain's candidates.
    _armCascadeGuardRelease() {
        if (this._cascadeGuardReleaseId) {
            this._timeoutRegistry?.remove(this._cascadeGuardReleaseId);
            this._cascadeGuardReleaseId = 0;
        }

        // Don't zero the id before deciding: if the timer fires while a chain is on the stack
        // it must stay armed, otherwise the hold would outlive its timer and nothing would
        // ever release the set.
        const release = () => {
            if (this._cascadeRestoring) return GLib.SOURCE_CONTINUE;
            this._cascadeGuardReleaseId = 0;
            this._cascadeGuardHeld = false;
            this._cascadeAttempted.clear();
            return GLib.SOURCE_REMOVE;
        };

        // Arm first, publish second: if add() throws, the hold must not be left set with no
        // timer to clear it.
        const id = this._timeoutRegistry
            ? this._timeoutRegistry.add(
                constants.RESIZE_SETTLE_DELAY_MS + constants.ANIMATION_DURATION_MS,
                release, 'windowHandler_cascadeGuardRelease')
            : 0;
        if (!id) {
            this._cascadeGuardHeld = false;
            this._cascadeAttempted.clear();
            return;
        }

        this._cascadeGuardReleaseId = id;
        this._cascadeGuardHeld = true;
    }

    // A closed window must not stay pinned in the guard set.
    forgetCascadeGuard(window) {
        if (window) this._cascadeAttempted.delete(window);
    }

    _tryAutoRestoreMiniatureInner(remainingWindows, workspace, monitor) {
        if (this.tilingManager.maximizedLayout.hasWindows(workspace, monitor) &&
            this.tilingManager.maximizedLayout.reconcile(workspace, monitor, {passive: true}))
            return true;

        const mru  = this.windowingManager.getMRUOrder(workspace);
        const rank = w => mru.get(w.get_id()) ?? Number.MAX_SAFE_INTEGER;

        // Ascending here, unlike the sacrifice sites: index 0 is the most recent,
        // and that's the miniature to bring back first.
        const miniatureWindows = remainingWindows
            .filter(w => WindowState.get(w, IS_MINIATURE))
            // Native-maximized miniatures belong to maximized history and fullscreen
            // miniatures are presentation-paused. Neither may be resurrected as an ordinary
            // normal window by the generic free-space recovery path.
            .filter(w => !this.windowingManager.isMaximizedOrFullscreen(w))
            .sort((a, b) => rank(a) - rank(b));

        if (miniatureWindows.length === 0) return false;

        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);

        // canRestoreMiniature only simulates, so falling through to the next candidate
        // costs nothing; the most recent may not fit while an older one still does.
        for (const candidate of miniatureWindows) {
            if (this._cascadeAttempted.has(candidate)) {
                // continue, not break: the set already retires this candidate, and every
                // candidate behind it is still worth probing. A member is usually MRU-first,
                // so breaking would abandon the whole rest of the list whenever the member is
                // a miniature again -- exactly the settle re-entry this guard exists for.
                Logger.log(`_tryAutoRestoreMiniature: ${candidate.get_id()} already restored in this chain, skipping it`);
                continue;
            }

            if (!this._ext.tilingManager.canRestoreMiniature(
                candidate, remainingWindows, workArea, { requireStableNormal: true })) {
                Logger.log(`_tryAutoRestoreMiniature: keeping mini ${candidate.get_id()}, would overflow if restored`);
                continue;
            }

            // The solver's fit and the tile pass's geometry validation can disagree. A restore
            // picked on the solver alone is undone by the very next pass, which is what fed the
            // restore/miniaturize loop; only start a restore this pass can actually keep.
            if (!this._ext.tilingManager.canRestoreMiniatureAtPreferredFit(
                candidate, remainingWindows, workArea)) {
                Logger.log(`_tryAutoRestoreMiniature: keeping mini ${candidate.get_id()}, the tile pass would reject the restored layout`);
                continue;
            }

            this._ext._miniatureCascadeIds?.delete(candidate.get_id());
            // restoreMiniature refuses through the restore gate (MaximizedLayout owns the
            // maximized/fullscreen roles) or on a fullscreen presentation. Both refusals are
            // silent: no 'miniature-restored' signal, nothing restored. Reporting that as
            // success makes the caller skip the retile it would have run instead, so a closed
            // or moved window's space is never reclaimed -- the probe approved a candidate the
            // gate then declined. Only a real restore may claim the caller's retile.
            const restored = this._ext.miniatureManager.restoreMiniature(
                candidate, null, { activate: false });
            if (restored) {
                // Recorded only on success. The loop head treats membership as "this chain
                // already restored it" and stops; a refused candidate is still a miniature and
                // its fit can change precisely because a later candidate got restored, so
                // marking it here would retire it and everything after it for the whole chain
                // on the strength of a refusal that never happened.
                this._cascadeAttempted.add(candidate);
                return true;
            }

            Logger.log(`_tryAutoRestoreMiniature: restore gate refused ${candidate.get_id()}, trying the next candidate`);
        }

        return false;
    }

    // Deduped via closeRetileHandledAt since both close signals land here; whichever
    // gets here first does the work, the other (often arriving much later behind
    // afterAnimations) skips. No time expiry: a close never repeats, a DnD move clears
    // the flag on re-enqueue, and an overflow move never claims at all since it never
    // re-enqueues (a stale claim would block the retile at the window's real close).
    // Options below capture real behavioral differences between the two callers, not duplication.
    // A workspace captured before a deferred retile can go stale by the time that
    // retile runs: GNOME's own dynamic-workspace pruning removes a workspace this same
    // window-close just emptied, reindexing everything and re-firing active-workspace-changed
    // as a side effect. Falling back to whatever ended up active resyncs the workspace the
    // reindex actually landed on, instead of silently dropping the retile pass.
    _resolveRetileWorkspace(workspace) {
        if (workspace && workspace.index() >= 0) return workspace;
        return global.workspace_manager.get_active_workspace();
    }

    _retileAfterWindowGone(removedWindow, remainingWindows, workspace, monitor, freedWidth, freedHeight, options = {}) {
        const opts = this._retileOptions(options);

        if (WindowState.get(removedWindow, 'closeRetileHandledAt')) {
            Logger.log(`_retileAfterWindowGone: already handled for ${removedWindow.get_id()} - skipping duplicate`);
            return;
        }
        if (!opts.wasMovedByOverflow)
            WindowState.set(removedWindow, 'closeRetileHandledAt', true);

        if (opts.cleanSmartResizingFlags) {
            Logger.log('[SMART RESIZE] Cleaning up transient flags for remaining windows');
            for (const w of remainingWindows) {
                WindowState.set(w, 'isSmartResizing', false);
            }
        }

        if (!opts.wasMovedByOverflow && this._tryAutoRestoreMiniature(remainingWindows, workspace, monitor)) {
            return;
        }

        const restorableWindows = remainingWindows.filter(w => !WindowState.get(w, IS_MINIATURE));

        const restored = this._maybeReverseRestore(
            remainingWindows, restorableWindows, workspace, monitor, freedWidth, freedHeight, opts);

        // Resettling because a window just left, so bounce it like an entrance.
        if (restored) {
            this._scheduleRestoreSettle(restorableWindows, workspace, monitor, opts);
        } else {
            this._retileWithoutRestore(workspace, monitor);
        }
    }

    _retileOptions(options) {
        return {
            wasMovedByOverflow: false,
            requireConstrainedCheck: false,
            passFreedDimsToRestore: true,
            includeMinisInRestoreCall: false,
            cleanSmartResizingFlags: false,
            requireBothFreedDims: false,
            reverseLogLabel: '[REVERSE]',
            settleLogLabel: null,
            settleTimeoutName: 'windowHandler_closeRetileSettle',
            ...options,
        };
    }

    // Whether reclaiming the freed space is worth attempting: there must be freed space
    // (or a caller that measures it itself) and at least one restorable window, and under
    // requireConstrainedCheck at least one that mosaic actually shrank.
    _shouldReverseRestore(restorableWindows, freedWidth, freedHeight, opts) {
        // When the caller doesn't trust its own freedWidth/freedHeight enough to pass
        // them through (passFreedDimsToRestore: false), gating the attempt on those same
        // values is pointless; e.g. 'unmanaged' fires early enough that the closed
        // window's frame already reads 0x0, which used to block the attempt outright
        // even though tryRestoreWindowSizes would have computed available space itself.
        const hasFreedSpace = !opts.passFreedDimsToRestore || (opts.requireBothFreedDims
            ? (freedWidth > 0 && freedHeight > 0)
            : (freedWidth > 0 || freedHeight > 0));
        if (!(hasFreedSpace && restorableWindows.length > 0)) return false;
        if (!opts.requireConstrainedCheck) return true;

        return restorableWindows.some(w => {
            const hasTarget = WindowState.get(w, 'targetSmartResizeSize') !== null;
            const isConstrained = WindowState.get(w, 'isConstrainedByMosaic') === true;
            return hasTarget || isConstrained;
        });
    }

    _maybeReverseRestore(remainingWindows, restorableWindows, workspace, monitor, freedWidth, freedHeight, opts) {
        if (!this._shouldReverseRestore(restorableWindows, freedWidth, freedHeight, opts)) return false;

        // Printing the freed dims where they're ignored sends readers chasing the
        // 0x0 that 'window-removed' always reports; say where the space came from.
        const freedDesc = opts.passFreedDimsToRestore
            ? `freed ${freedWidth}x${freedHeight}`
            : 'free space measured from the work area';
        Logger.log(`${opts.reverseLogLabel}: attempting reverse smart resize with ${freedDesc}`);
        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        const target = opts.includeMinisInRestoreCall ? remainingWindows : restorableWindows;
        return this._ext.tilingManager.tryRestoreWindowSizes(
            target, workArea,
            opts.passFreedDimsToRestore ? freedWidth : null,
            opts.passFreedDimsToRestore ? freedHeight : null,
            workspace, monitor);
    }

    _scheduleRestoreSettle(restorableWindows, workspace, monitor, opts) {
        // move_resize_frame above hasn't settled yet; retiling now would read
        // get_frame_rect() before the client acks the new size, hit the layout
        // cache with the stale dimensions, and redraw right back over the restore.
        const restoreBridges = restorableWindows.map(window => ({
            window,
            target: WindowState.get(window, 'targetRestoredSize'),
        }));
        this._ext._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
            if (opts.settleLogLabel) Logger.log(opts.settleLogLabel);
            for (const w of restorableWindows) {
                WindowState.remove(w, 'isReverseSmartResizing');
            }
            this.animationsManager.setMembershipChangeBounce(true);
            this._tileWorkspace(workspace, null, monitor, true);
            this.animationsManager.setMembershipChangeBounce(false);
            for (const {window, target} of restoreBridges)
                WindowState.removeIfCurrent(window, 'targetRestoredSize', target);
            return GLib.SOURCE_REMOVE;
        }, opts.settleTimeoutName);
    }

    _retileWithoutRestore(workspace, monitor) {
        this.animationsManager.setMembershipChangeBounce(true);
        this._tileWorkspace(workspace, null, monitor, true);
        this.animationsManager.setMembershipChangeBounce(false);
    }

    onWindowDestroyed(window) {
        const monitor = window.get_monitor();
        const windowId = window.get_id();
        const windowWorkspace = window.get_workspace();

        Logger.log(`onWindowDestroyed: ${windowId}`);
        // A first-placement transaction may still be waiting for actor allocation/buffer
        // convergence. It owns an actor signal whose closure captures this MetaWindow, so
        // destruction must explicitly end that transaction rather than relying on a later
        // stale-animation poll to notice the disposed actor.
        this.animationsManager.cancelPendingEntrance(window);
        this._ext.keyboardNavigator?.onWindowDestroyed(windowId);
        this.tilingManager.maximizedLayout.forget(window);
        // Terminal: this window is out of Mutter's lists, so it can never be re-pinned and a
        // parked constraint handle protects nothing. forget() has to keep that handle while
        // the window might still come back; here it cannot, and the map is otherwise scanned
        // on every reconcile.
        this.tilingManager.maximizedLayout.dropOrphan(window);
        // The 'unmanaged' handler does this too, but it is disconnected below, and on the
        // actor-destroy path it may never run.
        this.forgetCascadeGuard(window);

        this.disconnectWindowSignals(window);

        if (this._ext.miniatureManager && WindowState.get(window, IS_MINIATURE)) {
            this._ext.miniatureManager.destroyMiniature(window);
        }

        this.edgeTilingManager.clearWindowState(window);

        if (this.windowingManager.isExcluded(window)) {
            Logger.log('Excluded window closed - no workspace navigation');
            return;
        }

        if (!windowWorkspace)
            return;

        this._scheduleDestroyedWindowRetile(window, windowWorkspace, monitor, windowId);
        this._renavigateEmptyWorkspaceAfterDestroy(windowWorkspace, monitor);
    }

    _scheduleDestroyedWindowRetile(window, workspace, monitor, windowId) {
        // Capture destroyed window size for reverse smart resize. The actor
        // may already be disposed during signal delivery, and get_frame_rect
        // on a dead MetaWindow segfaults libmutter.
        const destroyedFrame = isWindowAlive(window) ? window.get_frame_rect() : null;
        const freedWidth = destroyedFrame?.width ?? 0;
        const freedHeight = destroyedFrame?.height ?? 0;

        this.edgeTilingManager.checkQuarterExpansion(workspace, monitor);

        afterWindowClose(() => {
            afterAnimations(this._ext.animationsManager, () => {
                // Both waits run inline when animations are off, so this can still
                // execute inside the destroy signal, with the dying window listed.
                const retileWorkspace = this._resolveRetileWorkspace(workspace);
                const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(retileWorkspace, monitor)
                    .filter(w => w.get_id() !== windowId &&
                                 !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));

                this._retileAfterWindowGone(window, remainingWindows, retileWorkspace, monitor, freedWidth, freedHeight, {
                    requireConstrainedCheck: true,
                    reverseLogLabel: '[REVERSE-DESTROYED] Window closed',
                    settleTimeoutName: 'windowHandler_destroyedRestoreSettle',
                });
            }, this._ext._timeoutRegistry);
        }, this._ext._timeoutRegistry);
    }

    _renavigateEmptyWorkspaceAfterDestroy(workspace, monitor) {
        const windows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        const managedWindows = windows.filter(w => !this.windowingManager.isExcluded(w));
        if (managedWindows.length !== 0)
            return;

        // Skip if overflow is in progress; window is being moved and will arrive soon
        if (this._ext._overflowInProgress) {
            Logger.log('Workspace is empty but overflow in progress; skipping navigation');
            return;
        }

        this.windowingManager.renavigate(workspace, true, this._ext._lastVisitedWorkspace, monitor);
    }

    enqueueWindowForEvaluation(window, workspace, monitor) {
        const windowId = window.get_id();
        // A (re)considered window voids any earlier close-retile dedup claim; cleared
        // before the dedupe returns below so a skipped re-enqueue still resets it.
        WindowState.remove(window, 'closeRetileHandledAt');
        if (this._evaluationQueue.some(entry => entry.window.get_id() === windowId)) {
            Logger.log(`Skipping duplicate enqueue for window ${windowId}`);
            return;
        }
        // window-created and window-added both land here for a new window, so
        // skip if we just evaluated it.
        const lastEvaluatedAt = WindowState.get(window, 'lastEvaluatedAt');
        if (lastEvaluatedAt && (monotonicNow() - lastEvaluatedAt) < constants.DUPLICATE_EVALUATION_WINDOW_MS) {
            Logger.log(`Skipping re-enqueue for window ${windowId} - evaluated ${Math.round(monotonicNow() - lastEvaluatedAt)}ms ago`);
            return;
        }
        Logger.log(`Enqueueing window ${windowId} for evaluation`);
        WindowState.set(window, 'pendingInQueue', true);
        this._evaluationQueue.push({ window, workspace, monitor });
        if (!this._isEvaluatingQueue) {
            this._processEvaluationQueue().catch(e => {
                Logger.error(`Evaluation queue failed: ${e}\n${e.stack}`);
                for (const entry of this._evaluationQueue)
                    WindowState.remove(entry.window, 'pendingInQueue');
                this._evaluationQueue = [];
                this._isEvaluatingQueue = false;
            });
        }
    }

    async _processEvaluationQueue() {
        if (this._isEvaluatingQueue || this._evaluationQueue.length === 0) {
            return;
        }

        this._isEvaluatingQueue = true;
        const state = {
            // Only a move from batch start counts as a user switch: a batch spanning
            // workspaces (monitor re-plug) has no expected workspace to compare against.
            batchActiveWorkspace: this.windowingManager.getWorkspace(),
        };

        while (this._evaluationQueue.length > 0) {
            let { window, workspace, monitor } = this._evaluationQueue.shift();
            WindowState.remove(window, 'pendingInQueue');
            WindowState.set(window, 'lastEvaluatedAt', monotonicNow());

            if (!isWindowAlive(window)) {
                Logger.log('Evaluation queue: window destroyed before evaluation, skipping');
                continue;
            }

            // Capture once per evaluation and clear now, so no later early return in
            // _ensureWindowFits can strand it; both consumers below read this value.
            const arrivedFromDnD = WindowState.get(window, 'arrivedFromDnD');
            WindowState.remove(window, 'arrivedFromDnD');

            const resolved = this._resolveQueueItemWorkspace(window, workspace);
            if (resolved.skip) continue;
            workspace = this._applyQueueWorkspace(window, resolved.workspace, arrivedFromDnD, state);

            Logger.log(`Evaluating queued window ${window.get_id()} on WS-${workspace.index()} (remaining: ${this._evaluationQueue.length})`);
            await this._evaluateQueuedWindowFit(window, workspace, monitor, arrivedFromDnD);

            WindowState.remove(window, 'arrivalPending');
            await this._queueSettleDelay();
        }

        this._isEvaluatingQueue = false;
    }

    // Recover from a workspace removed mid-flight (async smart resize can leave index -1),
    // falling back to the window's current one; {skip:true} when there's nowhere valid.
    _resolveQueueItemWorkspace(window, workspace) {
        if (workspace.index() >= 0) return { skip: false, workspace };

        const currentWorkspace = window.get_workspace();
        if (currentWorkspace && currentWorkspace.index() >= 0) {
            Logger.log(`Evaluation queue: stale workspace (index -1), using window's current WS-${currentWorkspace.index()}`);
            return { skip: false, workspace: currentWorkspace };
        }
        Logger.log(`Evaluation queue: window ${window.get_id()} has invalid workspace, skipping`);
        WindowState.remove(window, 'arrivalPending');
        return { skip: true };
    }

    // A manual workspace switch can intentionally redirect a still-pending launch. Overflow
    // from another window in the same batch never can: every arrival earns its own fit/admission
    // decision instead of being pre-moved to a previous window's overflow destination.
    _applyQueueWorkspace(window, workspace, arrivedFromDnD, state) {
        const activeWorkspace = this.windowingManager.getWorkspace();

        // A drop is a destination the user chose, so "they navigated away" doesn't apply; without
        // this the overview drag lands the window and the cascade immediately drags it back.
        if (!arrivedFromDnD && activeWorkspace && state.batchActiveWorkspace &&
            activeWorkspace.index() !== state.batchActiveWorkspace.index()) {
            Logger.log(`Evaluation queue: User switched to WS-${activeWorkspace.index()} during processing (batch started on WS-${state.batchActiveWorkspace.index()}) - following user`);
            window.change_workspace(activeWorkspace);
            return activeWorkspace;
        }
        return workspace;
    }

    async _evaluateQueuedWindowFit(window, workspace, monitor, arrivedFromDnD) {
        try {
            const resultWorkspace = await this._ensureWindowFits(window, workspace, monitor, arrivedFromDnD);
            const movedByOwnAdmission = resultWorkspace && resultWorkspace.index() !== workspace.index();

            const managedWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                .filter(w => !this.windowingManager.isExcluded(w) && !WindowState.get(w, 'pendingInQueue'));

            if (managedWindows.length === 0) {
                this._renavigateIfTrulyEmpty(window, workspace, monitor, movedByOwnAdmission);
            }
        } catch (e) {
            Logger.error(`Error in evaluation queue for window ${window.get_id()}: ${e}`);
        }
    }

    _renavigateIfTrulyEmpty(window, workspace, monitor, movedByOwnAdmission) {
        // Don't renavigate a workspace that's empty only because overflow is mid-transition.
        if (!movedByOwnAdmission) {
            Logger.log(`Queue: Window ${window.get_id()} moved and left WS-${workspace.index()} empty - renavigating`);
            this.windowingManager.renavigate(workspace, true, this._ext._lastVisitedWorkspace, monitor);
        } else {
            Logger.log(`Queue: WS-${workspace.index()} empty due to this window's own overflow admission - skipping renavigate`);
        }
    }

    // Small delay to let animations/mutter settle before evaluating the next window.
    _queueSettleDelay() {
        return new Promise(resolve => {
            if (this._timeoutRegistry) {
                this._timeoutRegistry.add(constants.QUEUE_PROCESS_DELAY_MS || 50, resolve, '_processEvaluationQueue');
            } else {
                resolve();
            }
        });
    }

    async _ensureWindowFits(window, workspace, monitor, arrivedFromDnD) {
        if (this._ensureFitsBlocked(window, workspace)) return workspace;
        const earlyAdmission = this._tryEarlyFitAdmission(window, workspace, monitor, arrivedFromDnD);
        if (earlyAdmission === 'handled') return workspace;

        // Native fullscreen owns the workspace presentation exclusively. It is not a normal
        // tiling participant, but it still blocks admission: allowing canFit/Smart Resize to
        // ignore it makes the answer depend on whether some unrelated normal sibling happens
        // to exist beside it. Reject before any DnD restore/resize side effects so a failed
        // cross-workspace drop remains a clean transaction.
        if (earlyAdmission === 'fullscreen-blocked') {
            this.tilingManager.savePreferredSize(window);
            Logger.log(`[FULLSCREEN] WS-${workspace.index()} M${monitor} blocks normal admission for ${window.get_id()}; overflowing`);
            return await this.windowingManager.moveOversizedWindow(window);
        }

        this.tilingManager.savePreferredSize(window);

        if (this.tilingManager.maximizedLayout.admit(window)) return workspace;

        this._prepareDnDArrival(window, workspace, monitor, arrivedFromDnD);

        // Use the newest pending target for restoration flows to avoid transient overflow
        // ejection. A smart-resize target may supersede an older restore-settle bridge.
        const targetSize = WindowState.get(window, 'targetSmartResizeSize')
            || WindowState.get(window, 'targetRestoredSize');
        const canFit = this.tilingManager.canFitWindow(window, workspace, monitor, false, targetSize);

        if (canFit) {
            Logger.log('Window fits - tiling workspace directly');
            this._tileWorkspace(workspace, null, monitor, false);
            return workspace;
        }

        return await this._fitByResizeOrOverflow(window, workspace, monitor);
    }

    _tryEarlyFitAdmission(window, workspace, monitor, arrivedFromDnD) {
        if (WindowState.get(window, MOSAIC_FULLSCREEN) || this._captureBornFullscreen(window)) {
            Logger.log(`ensureWindowFits: Window ${window.get_id()} is fullscreen; keeping it on WS-${workspace.index()} outside Mosaic layout`);
            this.revealPendingEntrance(window);
            return 'handled';
        }

        if (this._hasFullscreenAdmissionBlocker(window, workspace, monitor))
            return 'fullscreen-blocked';

        if (window.is_maximized() && this.tilingManager.maximizedLayout.admit(window))
            return 'handled';

        return this._tryConstrainedFitAdmission(window, workspace, monitor, arrivedFromDnD);
    }

    _tryConstrainedFitAdmission(window, workspace, monitor, arrivedFromDnD) {
        // A constrained flag survives workspace/monitor moves; it is not proof that the
        // destination admits this window. Only reuse a local layout outside an explicit move.
        // Preserve preferred sizes and the durable resize contract while replanning admission.
        if (arrivedFromDnD || !WindowState.get(window, 'isConstrainedByMosaic') ||
            !MosaicModel.normalSlotFor(window)) return null;
        Logger.log(`ensureWindowFits: Window ${window.get_id()} already constrained by mosaic - tiling directly`);
        const result = this._tileWorkspace(workspace, null, monitor, false);
        return result?.overflow ? null : 'handled';
    }

    _hasFullscreenAdmissionBlocker(window, workspace, monitor) {
        return this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .some(candidate => candidate !== window &&
                isWindowAlive(candidate) &&
                this.windowingManager.isFullscreenLike(candidate));
    }

    _prepareDnDArrival(window, workspace, monitor, arrivedFromDnD) {
        if (arrivedFromDnD)
            this._handleDnDArrival(window, workspace, monitor);
    }

    _ensureFitsBlocked(window, workspace) {
        if (this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log('ensureWindowFits: Skipping - mosaic disabled for workspace');
            return true;
        }
        if (WindowState.get(window, 'isSmartResizing')) {
            Logger.log('ensureWindowFits: Skipping - smart resize in progress');
            return true;
        }
        if (WindowState.get(window, 'restoringFromMiniature')) {
            Logger.log(`ensureWindowFits: Skipping - restoring from miniature for ${window.get_id()}`);
            return true;
        }
        return false;
    }

    _handleDnDArrival(window, workspace, monitor) {
        const monitorWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
        const preferredSize = this.tilingManager.getPreferredSize(window);

        if (preferredSize && monitorWindows.length === 1) {
            this._dndRestoreSolo(monitorWindows[0], workspace, monitor, preferredSize);
        } else {
            this._dndRestoreExpansion(monitorWindows, workspace, monitor);
        }
    }

    _dndRestoreSolo(win, workspace, monitor, preferredSize) {
        const wa = workspace.get_work_area_for_monitor(monitor);
        const currentRect = win.get_frame_rect();
        const targetW = Math.min(preferredSize.width, wa.width - constants.WINDOW_SPACING * 2);
        const targetH = Math.min(preferredSize.height, wa.height - constants.WINDOW_SPACING * 2);
        Logger.log(`DnD Solo: Fully restoring window to ${targetW}x${targetH}`);
        win.move_resize_frame(true, currentRect.x, currentRect.y, targetW, targetH);
    }

    _dndRestoreExpansion(monitorWindows, workspace, monitor) {
        const usedWidth = monitorWindows.reduce((sum, w) => sum + w.get_frame_rect().width, 0);
        const wa = workspace.get_work_area_for_monitor(monitor);
        const availableExtra = wa.width - usedWidth - (monitorWindows.length + 1) * constants.WINDOW_SPACING;
        if (availableExtra <= constants.ANIMATION_DIFF_THRESHOLD) return;

        Logger.log(`DnD arrival: Extra space ${availableExtra}px - trying expansion`);
        const restored = this.tilingManager.tryRestoreWindowSizes(monitorWindows, wa, availableExtra, wa.height, workspace, monitor);
        if (!restored) return;

        this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
            for (const w of monitorWindows) {
                WindowState.remove(w, 'isReverseSmartResizing');
            }
            return GLib.SOURCE_REMOVE;
        }, 'windowHandler_dndRestoreSettle');
    }

    async _fitByResizeOrOverflow(window, workspace, monitor) {
        const workArea = this.tilingManager.getUsableWorkArea(workspace, monitor);

        const allExistingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => w.get_id() !== window.get_id() && !this.edgeTilingManager.isEdgeTiled(w)
                && !WindowState.get(w, 'pendingInQueue'));

        // Both staged and committed miniatures belong to the unified rail. Their native
        // maximize flag describes the backing window, not its occupied layout space;
        // Smart Resize reserves their rail seats independently of resizable participants.
        // Only windows without that presentation handoff can block normal coexistence.
        const blockingWindows = allExistingWindows.filter(w =>
            !WindowState.get(w, IS_MINIATURE) && !WindowState.get(w, PENDING_MINIATURE)
        );

        // Rail seats are collected from the workspace by tryFitWithResize; pass only
        // normal peers as resize participants.
        const existingWindows = blockingWindows.filter(w =>
            !this.windowingManager.isMaximizedOrFullscreen(w)
        );

        // Smart Resize can also admit a lone oversized normal window by shrinking the
        // arriving window itself into Mosaic's usable area. This matters for clients that
        // restore a normal (non-maximized) frame exactly equal to Mutter's work area: treating
        // that as overflow would eject the only window to another dynamic workspace.
        //
        // Do not generalize "no resizable peers" to "solo", though. Maximized/fullscreen
        // peers that have no rail handoff are intentionally filtered out of existingWindows
        // and must keep blocking coexistence rather than being silently ignored by Smart Resize.
        const canTrySmartResize = existingWindows.length > 0 || blockingWindows.length === 0;
        if (canTrySmartResize) {
            // Pass the new window as focused override, since Mutter's focus_window
            // may still be the previously focused sibling at this point, which
            // would exclude it from miniaturization alongside newWindow.
            const resizeResult = this.tilingManager.tryFitWithResize(window, existingWindows, workArea, workspace, window);
            if (resizeResult?.success) {
                Logger.log('Smart resize applied, tiling directly');
                this.tilingManager.withSmartResizeBlock(() => {
                    this.tilingManager.mergePendingMiniatures(resizeResult.pendingWindows);
                    this._tileWorkspace(workspace, null, monitor, false);
                });
                return workspace;
            }
        }

        Logger.log(`Smart resize failed or skipped - applying Overflow logic (existingWindows=${existingWindows.length}, blocked=${this.tilingManager._isSmartResizingBlocked})`);
        return await this.windowingManager.moveOversizedWindow(window);
    }

    // A window opening alone should keep Mutter's native animation instead of
    // getting hidden and swapped for our fade-only entrance, since there's nothing
    // to slide in against. onWindowCreated and onWindowAdded both call this and need
    // to agree, so the result is cached instead of each side recomputing on its own
    // (workspace/monitor can resolve differently by the time the second one runs,
    // and disagreeing would leave the actor hidden with no entrance ever claimed).
    // Defaults to true when workspace/monitor aren't ready yet, since losing a real
    // slide-in is more noticeable than an unnecessary one.
    //
    // TODO: only checks whether any sibling exists, not whether the window ends up
    // boxed in by siblings on every side, which also has no real direction to slide
    // from and should get the native animation too. Telling that apart needs the
    // final tiled layout, which isn't computed yet at this point (skipNextEffect
    // has to be called here, before the layout exists). Options: run an early
    // dry-run tiling pass with the new window included (geometry isn't always
    // settled yet here, so the prediction could be wrong), or a cheaper heuristic
    // from the current siblings alone (e.g. a fully packed grid with no free edge),
    // which would only catch that one shape of enclosure, not every possible one.
    _hasSiblings(window) {
        const cached = WindowState.get(window, 'hasEntranceSiblings');
        if (cached !== undefined) return cached;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (!workspace || monitor === null || monitor < 0) return true;

        const result = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .some(w => w.get_id() !== window.get_id());
        WindowState.set(window, 'hasEntranceSiblings', result);
        return result;
    }

    onWindowCreated(window) {
        this.windowingManager.invalidateWindowsCache();

        // Shift held at launch: make always-on-top before any tiling runs
        const [, , creationMods] = global.get_pointer();
        if (creationMods & Clutter.ModifierType.SHIFT_MASK) {
            window.make_above();
            Logger.log(`Window ${window.get_id()} opened with Shift, set always-on-top`);
        }

        this._sampleInitialWindowMode(window);

        const processWindowCallback = () => this._processCreatedWindow(window);

        const actor = window.get_compositor_private();
        if (actor) {
            const isRelated = this.windowingManager.isRelated(window);
            if (isRelated && !this.shouldSkipSlideIn(window)) {
                // Ask Mutter to skip its own open animation outright (the same public
                // API altTab.js uses to skip the unminimize effect) instead of fighting
                // it after the fact. Our own pipeline drives the entrance once it knows
                // the real tiled target and siblings, on its own timeline.
                Main.wm.skipNextEffect(actor);

                // onWindowAdded tries to hide the actor too, but it usually runs before
                // the actor even exists yet (get_compositor_private() is still null there
                // most of the time). This is the first point we're guaranteed to have it,
                // so the fade-in actually has something to fade from instead of starting
                // (and silently staying) at the default opacity of 255.
                actor.opacity = 0;

                // Mapping is one half of the entrance gate. animateWindow may also keep
                // the actor hidden while a Wayland resize configure is still unacked; the
                // resize handler retries the same gate when the live frame changes.
                // One-shot: mapped flips on and off repeatedly later on (e.g. every time
                // the Overview opens/closes), and after the first placement commits there
                // is no deferred entrance left to run.
                if (actor.mapped) {
                    this._ext.animationsManager.runDeferredEntrance(window);
                } else {
                    const mappedSignalId = actor.connect('notify::mapped', () => {
                        if (!actor.mapped) return;
                        actor.disconnect(mappedSignalId);
                        this._ext.animationsManager.runDeferredEntrance(window);
                    });
                }
            }

            let signalId = null;
            let timeoutId = null;
            let processed = false;

            const processOnce = () => {
                if (processed) return;
                processed = true;

                if (signalId) actor.disconnect(signalId);
                if (timeoutId) this._timeoutRegistry.remove(timeoutId);

                if (processWindowCallback() === GLib.SOURCE_CONTINUE) {
                    // Gate closed (e.g. wm_class still unset); retry on state changes
                    this._awaitWindowReadiness(window, () => processWindowCallback() === GLib.SOURCE_REMOVE);
                }

                this.connectWindowSignals(window);
            };

            // USE MAPPED SIGNAL: Triggers when the window is added to the scene but before paint.
            // This allows us to position it "before" it appears, effectively skipping the spawn animation.
            if (actor.mapped) {
                processOnce();
            } else {
                signalId = actor.connect('notify::mapped', () => {
                    if (actor.mapped) processOnce();
                });
            }

            timeoutId = this._timeoutRegistry.add(400, () => {
                // Pre-flight check: If the actor was disposed while waiting, abort safely.
                if (!isWindowAlive(window)) {
                    Logger.log('window map timeout - window already disposed, aborting process');
                    return GLib.SOURCE_REMOVE;
                }

                Logger.log('window map timeout - falling back to immediate processing');
                processOnce();
                return GLib.SOURCE_REMOVE;
            }, 'windowHandler_mapSafety');
        } else {
            // Fallback for non-actor windows (rare in Shell): same signal-driven gate
            if (processWindowCallback() === GLib.SOURCE_CONTINUE)
                this._awaitWindowReadiness(window, () => processWindowCallback() === GLib.SOURCE_REMOVE);
            this.connectWindowSignals(window);
        }
    }

    // Runs once the window is ready enough to place. SOURCE_CONTINUE re-arms the readiness
    // gate; SOURCE_REMOVE means placement is resolved (tiled, queued, or deferred).
    _processCreatedWindow(window) {
        const monitor = window.get_monitor();
        const workspace = window.get_workspace();

        if (!(monitor !== null &&
              window.wm_class !== null &&
              isWindowAlive(window) &&
              workspace.list_windows().length !== 0 &&
              !window.is_hidden()))
            return GLib.SOURCE_CONTINUE;

        if (this.windowingManager.isExcluded(window)) {
            Logger.log('Window excluded from tiling');
            WindowState.remove(window, 'arrivalPending');
            this.revealPendingEntrance(window);
            return GLib.SOURCE_REMOVE;
        }

        // window-created can precede the client's initial maximize/fullscreen configure.
        // Fullscreen wins over maximize semantics and is kept native/in-place; otherwise
        // re-sample maximize intent before first admission.
        this._sampleInitialWindowMode(window);
        this._captureOpeningSize(window, workspace, monitor);

        const edgeResult = this._tryTileNewWithEdge(window, workspace, monitor);
        if (edgeResult !== null) return edgeResult;

        // The model carries the geometry now, so the pass is worth running even though
        // Mutter will drop the frame moves; the overview renders from the model and the
        // flag still gets the real windows placed once it hides.
        if (Main.overview.visible)
            Logger.log(`Window ${window.get_id()} created while overview visible; tiling into the model`);

        this.enqueueWindowForEvaluation(window, workspace, monitor);
        return GLib.SOURCE_REMOVE;
    }

    // Use saved_rect for natural size (get_frame_rect matches monitor if Maximized).
    _captureOpeningSize(window, workspace, monitor) {
        if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
            // ONLY save preferred size if the window is NOT maximized/fullscreen upon creation.
            // This prevents capturing "almost-maximized" frames during the opening animation.
            this.tilingManager.savePreferredSize(window);
            return;
        }

        try {
            const saved = window.saved_rect || (window.get_saved_rect ? window.get_saved_rect() : null);
            if (saved && saved.width > 0 && saved.height > 0) {
                WindowState.set(window, 'openingSize', { width: saved.width, height: saved.height });
                Logger.log(`onWindowCreated: Captured openingSize fallback from saved_rect: ${saved.width}x${saved.height}`);
            } else {
                // Fallback for natively fullscreen apps with no saved_rect:
                // Use 80% of work area as a reasonable default window size
                const workArea = workspace.get_work_area_for_monitor(monitor);
                if (workArea) {
                    const fallbackWidth = Math.floor(workArea.width * 0.8);
                    const fallbackHeight = Math.floor(workArea.height * 0.8);
                    WindowState.set(window, 'openingSize', { width: fallbackWidth, height: fallbackHeight });
                    Logger.log(`onWindowCreated: No saved_rect for fullscreen window - using 80% fallback: ${fallbackWidth}x${fallbackHeight}`);
                }
            }
        } catch (e) {
            Logger.warn(`onWindowCreated: Failed to capture saved_rect: ${e.message}`);
        }
    }

    // Pairs a brand-new window with a lone edge-tiled sibling. Returns a GLib source
    // verdict when it took over placement, or null to fall through to the normal flow.
    _tryTileNewWithEdge(window, workspace, monitor) {
        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        const edgeTiledWindows = workspaceWindows.filter(w => {
            const tileState = this.edgeTilingManager.getWindowState(w);
            return tileState && tileState.zone !== TileZone.NONE && w.get_id() !== window.get_id();
        });

        if (!(edgeTiledWindows.length === 1 && workspaceWindows.length === 2)) return null;

        Logger.log('New window: Attempting to tile with edge-tiled window');
        const tileSuccess = this.windowingManager.tryTileWithSnappedWindow(window, edgeTiledWindows[0], null);
        if (tileSuccess) {
            Logger.log('New window: Successfully tiled with edge-tiled window');
            WindowState.remove(window, 'arrivalPending');
            this.connectWindowSignals(window);
            return GLib.SOURCE_REMOVE;
        }
        Logger.log('New window: Tiling failed, continuing with normal flow');
        return null;
    }

    onWindowAdded(_workspace, window) {
        this.windowingManager.invalidateWindowsCache();
        if (!this._ext.windowingManager.isRelated(window)) {
            return;
        }

        // Going on-all-workspaces (sticky, or landing on a secondary monitor under
        // workspaces-only-on-primary) re-adds the window to every workspace at once.
        // It isn't arriving anywhere; the monitor signals own its placement, and
        // running the arrival pipeline here overflows it to another workspace.
        if (window.is_on_all_workspaces()) {
            return;
        }

        this._ext.tilingManager.savePreferredSize(window);

        // addedTime feeds the resize settle check and the rebalance's newest-window pick;
        // arrivalPending shields the window until its arrival evaluation resolves placement.
        WindowState.set(window, 'addedTime', monotonicNow());
        WindowState.set(window, 'arrivalPending', true);

        const firstWorkspaceAdmission = !WindowState.get(window, 'workspaceAdmissionSeen');
        WindowState.set(window, 'workspaceAdmissionSeen', true);
        const previousWorkspaceObject = WindowState.get(window, 'previousWorkspaceObject');
        if (!firstWorkspaceAdmission && previousWorkspaceObject &&
            previousWorkspaceObject !== window.get_workspace()) {
            // A workspace migration is a fresh placement decision, not a duplicate of the
            // evaluation that ran on the source workspace. Leaving the recent-evaluation
            // stamp in place lets a fast move back within DUPLICATE_EVALUATION_WINDOW_MS
            // swallow the arrival enqueue, stranding arrivalPending with no retile.
            WindowState.remove(window, 'lastEvaluatedAt');
            this.animationsManager.claimWindowForWorkspaceTransition(window);
        }

        // Flag the first-ever tiling pass for this window so it slides in instead
        // of using the "no jump" continuity math meant for windows that already
        // have a real visual position. onWindowCreated separately asks Mutter to
        // skip its own open animation (skipNextEffect) and nudges animateWindow's
        // deferred entrance once the actor is actually mapped.
        if (firstWorkspaceAdmission && !this.shouldSkipSlideIn(window)) {
            WindowState.set(window, 'pendingFirstPlacement', true);
            const actor = window.get_compositor_private();
            // onWindowCreated races independently and may have already started (or
            // queued) the real entrance ease by the time this runs. Resetting opacity
            // here would stomp that mid-flight (a direct property write the ease's own
            // next frame then overwrites again), which is exactly what shows up as a blink.
            if (actor && !this._ext.animationsManager.hasActiveOrPendingEntrance(window))
                actor.opacity = 0;

            // Failsafe: if animateWindow never claims this window (e.g. excluded
            // right after creation), don't leave it invisible or the flag stuck.
            // pendingFirstPlacement stays true for the entire span of a genuinely
            // running ease (cleared only by its own onStopped), and a slowed-down
            // slow_down_factor easily outlasts this fixed timeout, so re-arm instead
            // of yanking opacity to its final value out from under an ease that's
            // still legitimately mid-flight.
            const scheduleFirstPlacementFailsafe = () => {
                this._timeoutRegistry.add(constants.SLIDE_IN_FAILSAFE_MS, () => {
                    if (!WindowState.get(window, 'pendingFirstPlacement')) return GLib.SOURCE_REMOVE;
                    if (this._ext.animationsManager.hasActiveOrPendingEntrance(window)) {
                        scheduleFirstPlacementFailsafe();
                        return GLib.SOURCE_REMOVE;
                    }
                    WindowState.remove(window, 'pendingFirstPlacement');
                    const a = isWindowAlive(window) ? window.get_compositor_private() : null;
                    if (a && !a.is_destroyed()) a.opacity = 255;
                    return GLib.SOURCE_REMOVE;
                }, 'windowHandler_firstPlacementFailsafe');
            };
            scheduleFirstPlacementFailsafe();
        }

        const proceedWhenValid = () => {
            const WORKSPACE = window.get_workspace();
            if (!WORKSPACE) return false;

            const WINDOW = window;
            const MONITOR = WINDOW.get_monitor();

            if (!this._ext.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false))
                return false;

            const frame = WINDOW.get_frame_rect();
            if (frame.width <= 0 || frame.height <= 0)
                return false;

            this._handleCrossWorkspaceDnD(WINDOW, WORKSPACE);

            // Mark window as waiting for geometry; prevents premature overflow
            WindowState.set(WINDOW, 'waitingForGeometry', true);

            // Repoll while waitForGeometry returns SOURCE_CONTINUE, bounded
            // so a window that never reports geometry can't poll forever.
            let geometryAttempts = 0;
            this._timeoutRegistry.add(constants.GEOMETRY_CHECK_DELAY_MS, () => {
                if (++geometryAttempts > constants.GEOMETRY_WAIT_MAX_ATTEMPTS || !isWindowAlive(WINDOW)) {
                    // Giving up here used to strand arrivalPending, and everything that
                    // reads it as "placement unresolved" would shield the window forever.
                    WindowState.remove(WINDOW, 'arrivalPending');
                    return GLib.SOURCE_REMOVE;
                }
                return this.waitForGeometry(WINDOW, WORKSPACE, MONITOR);
            }, 'windowHandler_geometryCheck');

            return true;
        };

        // First attempt runs on idle, keeping it out of the window-added emission
        this._timeoutRegistry.addIdle(() => {
            if (isWindowAlive(window) && !proceedWhenValid())
                this._awaitWindowReadiness(window, proceedWhenValid);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Detect a DnD across workspaces: window was just removed from a different
    // workspace within SAFETY_TIMEOUT_BUFFER_MS, so this add is the drop side.
    _handleCrossWorkspaceDnD(WINDOW, WORKSPACE) {
        const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');
        const removedTimestamp = WindowState.get(WINDOW, 'removedTimestamp');
        const timeSinceRemoved = removedTimestamp ? monotonicNow() - removedTimestamp : Infinity;

        const isCrossWorkspaceDrop = previousWorkspaceIndex !== undefined
            && previousWorkspaceIndex !== WORKSPACE.index()
            && timeSinceRemoved < constants.SAFETY_TIMEOUT_BUFFER_MS;
        if (!isCrossWorkspaceDrop || WindowState.get(WINDOW, 'movedByOverflow')) return;

        // Mark as DnD arrival; triggers expansion after tiling
        WindowState.set(WINDOW, 'arrivedFromDnD', true);

        this.tilingManager.maximizedLayout.forget(WINDOW);

        WindowState.remove(WINDOW, 'previousWorkspace');
        WindowState.remove(WINDOW, 'previousWorkspaceObject');
        WindowState.remove(WINDOW, 'previousMonitor');
        WindowState.remove(WINDOW, 'removedTimestamp');
        WindowState.remove(WINDOW, 'manualWorkspaceMove');
    }

    onWindowRemoved(workspace, window) {
        this.windowingManager.invalidateWindowsCache();
        if (!this._ext.windowingManager.isRelated(window)) {
            return;
        }

        // On destroy, both the 'unmanaged' handler and the workspace
        // 'window-removed' signal land here, so dedupe to keep the retile/restore
        // pipeline (and miniature auto-restore) from running twice.
        const now = monotonicNow();
        const lastHandled = WindowState.get(window, 'removalHandledAt');
        if (lastHandled && now - lastHandled < constants.SAFETY_TIMEOUT_BUFFER_MS) {
            Logger.log(`onWindowRemoved: duplicate removal event for ${window.get_id()} - skipping`);
            return;
        }
        WindowState.set(window, 'removalHandledAt', now);

        WindowState.set(window, 'previousWorkspace', workspace.index());
        WindowState.set(window, 'removedTimestamp', now);

        const wasMovedByOverflow = WindowState.get(window, 'movedByOverflow');

        // Capture removed window's size before any operations. Guarded since the
        // window may already be disposed when removal comes from a destroy.
        const removedFrame = isWindowAlive(window) ? window.get_frame_rect() : null;
        const freedWidth = removedFrame ? removedFrame.width : 0;
        const freedHeight = removedFrame ? removedFrame.height : 0;

        this._claimRemovedWindowPresentation(window, workspace);

        // Capture monitor at event time (window may move monitors during DnD)
        const removedMonitor = window.get_monitor();
        WindowState.set(window, 'previousWorkspaceObject', workspace);
        WindowState.set(window, 'previousMonitor', removedMonitor);

        const actor = window.get_compositor_private();
        if (!actor || actor.is_destroyed()) {
            this._ext.tilingManager.clearPreferredSize(window);
        } else {
            Logger.log('_windowRemoved: Window still exists (DnD move); keeping preferred size');
            this.tilingManager.maximizedLayout.forget(window);
        }

        this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = this._resolveRetileWorkspace(workspace);

            // A window leaving for another monitor already reports the destination here,
            // which counts the siblings it left behind as zero and reads as an empty
            // workspace. onWindowLeftMonitor fires right after us with the real source.
            const leftMonitorAt = WindowState.get(window, 'leftMonitorAt');
            const cameFromMonitorMove = leftMonitorAt &&
                monotonicNow() - leftMonitorAt < constants.SAFETY_TIMEOUT_BUFFER_MS;
            const MONITOR = cameFromMonitorMove
                ? WindowState.get(window, 'leftMonitor')
                : removedMonitor;

            if (!WORKSPACE || WORKSPACE.index() < 0) {
                return GLib.SOURCE_REMOVE;
            }

            const removedId = window.get_id();
            const remainingWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                .filter(w => w.get_id() !== removedId &&
                             !this._ext.edgeTilingManager.isEdgeTiled(w) &&
                             !this._ext.windowingManager.isExcluded(w));

            Logger.log(`_windowRemoved: ${remainingWindows.length} remaining windows, wasOverflowMove=${wasMovedByOverflow}`);

            // Try to restore window sizes with freed space (Reverse Smart Resize)
            // Miniatures are excluded since their slot is fixed and shouldn't be grown to preferred.
            if (remainingWindows.length > 0) {
                this._retileAfterWindowGone(window, remainingWindows, WORKSPACE, MONITOR, freedWidth, freedHeight, {
                    wasMovedByOverflow,
                    cleanSmartResizingFlags: true,
                    includeMinisInRestoreCall: true,
                    passFreedDimsToRestore: false,
                    requireBothFreedDims: true,
                    reverseLogLabel: '[REVERSE-REMOVED] Window removed',
                    settleLogLabel: 'Retiling after restore delay',
                    settleTimeoutName: 'windowHandler_restoreSettle',
                });
            } else {
                const allRelatedWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                    .filter(w => w.get_id() !== removedId);
                if (allRelatedWindows.length === 0) {
                    if (WORKSPACE.index() < 0) {
                        Logger.log('_windowRemoved: Workspace already destroyed, skipping navigation');
                        return GLib.SOURCE_REMOVE;
                    }
                    if (wasMovedByOverflow) {
                        Logger.log('_windowRemoved: Workspace empty but window was moved by overflow; skipping navigation');
                    } else {
                        Logger.log('_windowRemoved: Workspace truly empty, navigating away');
                        this._ext.windowingManager.renavigate(WORKSPACE, global.workspace_manager.get_active_workspace() === WORKSPACE, this._ext._lastVisitedWorkspace, MONITOR);
                    }

                }
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _claimRemovedWindowPresentation(window, sourceWorkspace) {
        if (!isWindowAlive(window)) return;
        const liveWorkspace = window.get_workspace();
        if (!liveWorkspace || liveWorkspace === sourceWorkspace) return;
        this.animationsManager.claimWindowForWorkspaceTransition(window);
    }

    waitForGeometry(WINDOW, WORKSPACE, MONITOR) {
        const rect = WINDOW.get_frame_rect();

        if (rect.width > 0 && rect.height > 0) {
            WindowState.set(WINDOW, 'waitingForGeometry', false);
            WindowState.set(WINDOW, 'geometryReady', true);

            if (this._ext.windowingManager.isExcluded(WINDOW)) {
                Logger.log('waitForGeometry: Window is excluded - connecting signals but skipping tiling');
                WindowState.remove(WINDOW, 'arrivalPending');
                this.connectWindowSignals(WINDOW);
                this.revealPendingEntrance(WINDOW);
                return GLib.SOURCE_REMOVE;
            }

            const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
            Logger.log(`Window ${WINDOW.get_id()} ready: size=${rect.width}x${rect.height}, workArea=${wa.width}x${wa.height}`);

            if (WindowState.get(WINDOW, 'movedByOverflow')) {
                Logger.log('Skipping early tile in waitForGeometry - overflow transition still owns placement');
                WindowState.remove(WINDOW, 'arrivalPending');
                return GLib.SOURCE_REMOVE;
            }

            if (Main.overview.visible) {
                Logger.log('Window created while overview visible; tiling into the model');
                this._ext.tilingManager.savePreferredSize(WINDOW);
                this.connectWindowSignals(WINDOW);
                this.enqueueWindowForEvaluation(WINDOW, WORKSPACE, MONITOR);
                return GLib.SOURCE_REMOVE;
            }

            const performTiling = async () => {
                if (WindowState.get(WINDOW, 'movedByOverflow')) {
                    Logger.log('Skipping duplicate evaluation queueing - window was already evaluated and moved by overflow');
                    WindowState.remove(WINDOW, 'arrivalPending');
                    return;
                }
                this.enqueueWindowForEvaluation(WINDOW, WORKSPACE, MONITOR);
            };

            const isDnDArrival = WindowState.get(WINDOW, 'arrivedFromDnD');
            const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');

            if (isDnDArrival || WindowState.get(WINDOW, 'movedByOverflow') || (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index())) {
                Logger.log('Cross-workspace move: Waiting for workspace animation');
                afterWorkspaceSwitch(performTiling, this._ext._timeoutRegistry);
            } else {
                void performTiling();
            }

            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

});
