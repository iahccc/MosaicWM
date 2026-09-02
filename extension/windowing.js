// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Window management utilities and workspace operations

import * as Logger from './logger.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import { TileZone, ZONE_SIDE, SIDE_ZONES, SLIDE_IN_FAILSAFE_MS } from './constants.js';
import * as WindowState from './windowState.js';
import { isWindowAlive, isWorkspaceAlive } from './liveness.js';

const BLACKLISTED_WM_CLASSES = [
    'org.gnome.Screenshot',
    'Gnome-screenshot',
];

import GObject from 'gi://GObject';

export const WindowingManager = GObject.registerClass({
    GTypeName: 'MosaicWindowingManager',
}, class WindowingManager extends GObject.Object {
    _init() {
        super._init();
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._tilingManager = null;
        this._timeoutRegistry = null;
        this._overflowStartCallback = null;
        this._overflowEndCallback = null;

        // Cache for getMonitorWorkspaceWindows; invalidated at start of each tiling operation
        // WeakMap<Workspace, Map<String, Window[]>>
        this._windowsCache = new WeakMap();
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }

    setTilingManager(manager) {
        this._tilingManager = manager;
    }

    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }

    setOverflowCallbacks(startCallback, endCallback) {
        this._overflowStartCallback = startCallback;
        this._overflowEndCallback = endCallback;
    }

    getTimestamp() {
        return global.get_current_time();
    }

    getWorkspace() {
        return global.workspace_manager.get_active_workspace();
    }

    getAllWorkspaceWindows(monitor, allow_unrelated) {
        return this.getMonitorWorkspaceWindows(this.getWorkspace(), monitor, allow_unrelated);
    }

    invalidateWindowsCache() {
        this._cacheVersion = (this._cacheVersion || 0) + 1;
    }

    getMonitorWorkspaceWindows(workspace, monitor, allow_unrelated) {
        if (!isWorkspaceAlive(workspace, global.workspace_manager)) return [];

        let workspaceCache = this._windowsCache.get(workspace);
        if (!workspaceCache || workspaceCache._version !== this._cacheVersion) {
            workspaceCache = new Map();
            workspaceCache._version = this._cacheVersion;
            this._windowsCache.set(workspace, workspaceCache);
        }

        const cacheKey = `${monitor}-${allow_unrelated ? 1 : 0}`;
        if (workspaceCache.has(cacheKey)) {
            return workspaceCache.get(cacheKey);
        }

        const _windows = [];
        const windows = workspace.list_windows();
        for (const window of windows)
            if (window.get_monitor() === monitor && (this.isRelated(window) || allow_unrelated))
                _windows.push(window);

        workspaceCache.set(cacheKey, _windows);
        return _windows;
    }

    // Always pass a workspace: the null path drops Mutter's real MRU list and
    // falls back to sorting by the coarser user_time.
    getMRUOrder(workspace) {
        const order = new Map();
        if (!isWorkspaceAlive(workspace, global.workspace_manager)) return order;

        global.display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .forEach((w, i) => order.set(w.get_id(), i));
        return order;
    }

    tryTileWithSnappedWindow(window, edgeTiledWindow, previousWorkspace) {
        if (!this._edgeTilingManager) {
            Logger.error('tryTileWithSnappedWindow: edgeTilingManager not set');
            return false;
        }

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        const tileState = this._edgeTilingManager.getWindowState(edgeTiledWindow);

        if (!tileState || tileState.zone === TileZone.NONE) {
            Logger.log('Existing window is not edge-tiled, cannot tile');
            return false;
        }

        const occupiedSide = ZONE_SIDE[tileState.zone];
        if (!occupiedSide) {
            Logger.log('Unsupported edge tile zone for dual-tiling');
            return false;
        }

        // We take whichever half the snapped window left free.
        const direction = occupiedSide === 'left' ? 'right' : 'left';

        const existingFrame = edgeTiledWindow.get_frame_rect();
        const existingWidth = existingFrame.width;
        const availableWidth = workArea.width - existingWidth;

        Logger.log(`Auto-tiling: existing window width=${existingWidth}px, available=${availableWidth}px`);

        const targetX = direction === 'left' ? workArea.x : workArea.x + existingWidth;
        const targetY = workArea.y;
        const targetWidth = availableWidth;
        const targetHeight = workArea.height;

        return this._applyDualTile(window, edgeTiledWindow, previousWorkspace, direction, {
            x: targetX, y: targetY, width: targetWidth, height: targetHeight
        });
    }

    _applyDualTile(window, edgeTiledWindow, previousWorkspace, direction, rect) {
        try {
            this._edgeTilingManager.saveWindowState(window);

            window.unmaximize();
            window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);

            const zone = SIDE_ZONES[direction].full;
            const state = this._edgeTilingManager.getWindowState(window);
            if (state) {
                state.zone = zone;
                Logger.log(`Dual-tiling: Updated window ${window.get_id()} state to zone ${zone}`);

                this._edgeTilingManager.setupResizeListener(window);
            }

            this._edgeTilingManager.registerAutoTileDependency(window, edgeTiledWindow);

            Logger.log(`Successfully dual-tiled window ${window.get_wm_class()} to ${direction} (${rect.width}x${rect.height})`);
            return true;
        } catch (error) {
            Logger.log(`Failed to tile window: ${error.message}`);
            // Undo the move that brought it here; leaving it stranded is worse than not tiling.
            if (previousWorkspace) {
                window.change_workspace(previousWorkspace);
            }
            return false;
        }
    }

    createOrReuseAdjacentWorkspace(originWorkspace) {
        const workspaceManager = global.workspace_manager;
        if (!isWorkspaceAlive(originWorkspace, workspaceManager)) {
            Logger.warn('[WORKSPACE] Refusing to create an adjacent workspace for a stale origin');
            return null;
        }

        const currentIndex = originWorkspace.index();
        const nextIndex = currentIndex + 1;
        const totalWorkspaces = workspaceManager.get_n_workspaces();
        const nextWorkspace = nextIndex < totalWorkspaces ? workspaceManager.get_workspace_by_index(nextIndex) : null;

        let targetWorkspace;
        if (nextWorkspace && nextWorkspace.list_windows().length === 0) {
            Logger.log(`[WORKSPACE] Reusing existing empty workspace at WS-${nextIndex}`);
            targetWorkspace = nextWorkspace;
        } else {
            Logger.log(`[WORKSPACE] Creating new workspace and inserting at WS-${nextIndex}`);
            targetWorkspace = workspaceManager.append_new_workspace(false, this.getTimestamp());
            workspaceManager.reorder_workspace(targetWorkspace, nextIndex);
        }

        return targetWorkspace;
    }

    // Sacred windows stay put while their siblings move to the workspace on the
    // left. Reuse it only when it is completely empty; otherwise insert a new one
    // so windows from another monitor are never mixed into the displaced group.
    createOrReuseLeftWorkspace(originWorkspace) {
        const workspaceManager = global.workspace_manager;
        if (!isWorkspaceAlive(originWorkspace, workspaceManager)) {
            Logger.warn('[WORKSPACE] Refusing to create a left workspace for a stale origin');
            return null;
        }

        const currentIndex = originWorkspace.index();
        const previousIndex = currentIndex - 1;

        if (previousIndex >= 0) {
            const previousWorkspace = workspaceManager.get_workspace_by_index(previousIndex);
            if (previousWorkspace && previousWorkspace.list_windows().length === 0) {
                Logger.log(`[WORKSPACE] Reusing existing empty workspace at WS-${previousIndex}`);
                return previousWorkspace;
            }
        }

        Logger.log(`[WORKSPACE] Creating new workspace and inserting at WS-${currentIndex}`);
        const targetWorkspace = workspaceManager.append_new_workspace(false, this.getTimestamp());
        workspaceManager.reorder_workspace(targetWorkspace, currentIndex);
        return targetWorkspace;
    }

    moveOversizedWindow(window, options = { switchFocus: true }) {
        return new Promise(resolve =>
            this._beginOverflowMove(window, options, resolve));
    }

    _beginOverflowMove(window, options, resolve) {
        const workspaceManager = global.workspace_manager;
        if (!isWindowAlive(window)) {
            resolve(null);
            return;
        }

        const previousWorkspace = window.get_workspace();
        if (!isWorkspaceAlive(previousWorkspace, workspaceManager)) {
            Logger.warn('moveOversizedWindow: refusing to move from a stale workspace');
            resolve(null);
            return;
        }

        const monitor = window.get_monitor();
        const targetWorkspace = this._selectOverflowTarget(
            window, previousWorkspace, monitor);
        if (!isWorkspaceAlive(targetWorkspace, workspaceManager)) {
            Logger.warn('moveOversizedWindow: no live target workspace');
            resolve(null);
            return;
        }

        let finished = false;
        const finish = result => {
            if (finished) return;
            finished = true;
            WindowState.remove(window, 'movedByOverflow');
            WindowState.remove(window, 'overflowOriginWorkspace');
            try {
                this._overflowEndCallback?.();
            } finally {
                resolve(result);
            }
        };

        this._overflowStartCallback?.();
        WindowState.set(window, 'movedByOverflow', true);
        this._prepareEntranceForWorkspaceMove(window);

        try {
            window.change_workspace(targetWorkspace);
            const context = {
                window,
                options,
                previousWorkspace,
                targetWorkspace,
                monitor,
                workspaceManager,
            };
            this._timeoutRegistry.addIdle(
                () => this._commitOverflowMove(context, finish),
                'windowing_commitOverflowMove',
                GLib.PRIORITY_DEFAULT_IDLE);
        } catch (error) {
            Logger.error(`moveOversizedWindow: failed to move window: ${error}`);
            finish(null);
        }
    }

    _prepareEntranceForWorkspaceMove(window) {
        const ownsInitialEntrance = WindowState.get(window, 'arrivalPending') ||
            WindowState.get(window, 'pendingFirstPlacement');
        if (!ownsInitialEntrance) return;

        // Keep both onWindowAdded/onWindowCreated from reclaiming the entrance
        // while the actor is being unmapped and remapped in its destination.
        WindowState.set(window, 'workspaceMoveEntranceGuard', true);
        this._animationsManager?.finishPendingEntrance(window, true);
        Logger.log(`[PLACEMENT] Finished initial entrance for ${window.get_id()} before workspace move`);

        this._timeoutRegistry.add(SLIDE_IN_FAILSAFE_MS, () => {
            WindowState.remove(window, 'workspaceMoveEntranceGuard');
            return GLib.SOURCE_REMOVE;
        }, 'windowing_workspaceMoveEntranceGuard');
    }

    _selectOverflowTarget(window, previousWorkspace, monitor) {
        const workspaceManager = global.workspace_manager;
        const nextIndex = previousWorkspace.index() + 1;
        const nextWorkspace = nextIndex < workspaceManager.get_n_workspaces()
            ? workspaceManager.get_workspace_by_index(nextIndex)
            : null;

        Logger.log(`moveOversizedWindow: origin=${previousWorkspace.index()}`);
        if (this.isMaximizedOrFullscreen(window)) {
            Logger.log(`[PLACEMENT] Sacred window detected - targeting strictly WS-${nextIndex} for isolation`);
            return this.createOrReuseAdjacentWorkspace(previousWorkspace);
        }

        Logger.log(`[PLACEMENT] Overflow window detected - targeting strictly WS-${nextIndex}`);
        if (nextWorkspace && this._tilingManager &&
            this._tilingManager.canFitWindow(window, nextWorkspace, monitor)) {
            Logger.log(`[PLACEMENT] Window fits in existing adjacent WS-${nextIndex}`);
            return nextWorkspace;
        }

        Logger.log(`[PLACEMENT] Adjacent WS-${nextIndex} is full or missing - creating new workspace`);
        return this.createOrReuseAdjacentWorkspace(previousWorkspace);
    }

    // One idle transaction is enough: validate object identity again, repair both
    // layouts, then activate at most once. A delayed second activate can race
    // Mutter's workspace removal/animation and crash inside Clutter.
    _commitOverflowMove(context, finish) {
        const {
            options,
            previousWorkspace,
            targetWorkspace,
            monitor,
            workspaceManager,
        } = context;

        try {
            if (!this._overflowMoveStillValid(context)) {
                Logger.warn('moveOversizedWindow: window or target disappeared before commit');
                finish(null);
                return GLib.SOURCE_REMOVE;
            }

            this._retileOverflowMove(
                previousWorkspace, targetWorkspace, monitor, workspaceManager);
            if (!this._overflowMoveStillValid(context)) {
                Logger.warn('moveOversizedWindow: move invalidated while retiling');
                finish(null);
                return GLib.SOURCE_REMOVE;
            }
            this._activateOverflowTarget(
                targetWorkspace, previousWorkspace, monitor, options, workspaceManager);
            finish(targetWorkspace);
        } catch (error) {
            Logger.error(`moveOversizedWindow: commit failed: ${error}`);
            finish(null);
        }
        return GLib.SOURCE_REMOVE;
    }

    _overflowMoveStillValid({ window, targetWorkspace, workspaceManager }) {
        return isWindowAlive(window) &&
            isWorkspaceAlive(targetWorkspace, workspaceManager) &&
            window.get_workspace() === targetWorkspace;
    }

    _retileOverflowMove(previousWorkspace, targetWorkspace, monitor,
        workspaceManager) {
        if (!this._tilingManager) return;

        if (previousWorkspace !== targetWorkspace &&
            isWorkspaceAlive(previousWorkspace, workspaceManager)) {
            this._tilingManager.tileWorkspaceWindows(
                previousWorkspace, null, monitor);
        }
        this._tilingManager.tileWorkspaceWindows(targetWorkspace, null, monitor);
    }

    _activateOverflowTarget(targetWorkspace, previousWorkspace, monitor, options,
        workspaceManager) {
        const stillOnOrigin = isWorkspaceAlive(previousWorkspace, workspaceManager) &&
            workspaceManager.get_active_workspace() === previousWorkspace;
        if (options.switchFocus === false || !stillOnOrigin) return;

        targetWorkspace.activate(this.getTimestamp());
        this.showWorkspaceSwitcher(targetWorkspace, monitor);
    }

    // The exclusion reasons that already hold before the window has any geometry.
    // Callers running that early (entrance setup) must ask this instead of
    // isExcluded, since an unmapped window reports 0x0 and reads as a 1×1 helper.
    isExcludedByPolicy(meta_window) {
        if (!this.isRelated(meta_window) || meta_window.minimized) {
            return true;
        }

        if (meta_window.is_above()) {
            return true;
        }

        const wmClass = meta_window.get_wm_class();
        if (wmClass && BLACKLISTED_WM_CLASSES.includes(wmClass)) {
            return true;
        }

        return false;
    }

    isExcluded(meta_window) {
        if (this.isExcludedByPolicy(meta_window)) {
            return true;
        }

        // 1×1 XWayland utility windows (clipboard helpers) must not enter the layout.
        // get_frame_rect on a disposed MetaWindow segfaults libmutter, so only
        // read it while the window is alive (dead windows keep prior semantics).
        if (isWindowAlive(meta_window)) {
            const frame = meta_window.get_frame_rect();
            if (frame.width <= 1 && frame.height <= 1) {
                return true;
            }
        }

        return false;
    }

    isRelated(meta_window) {
        if (meta_window.is_attached_dialog()) {
            return false;
        }

        if (meta_window.get_transient_for() !== null) {
            return false;
        }

        if (meta_window.window_type !== Meta.WindowType.NORMAL) {
            return false;
        }

        if (meta_window.is_skip_taskbar()) {
            return false;
        }

        if (this.isTrulySticky(meta_window)) {
            return false;
        }

        return true;
    }

    // With workspaces-only-on-primary, Mutter reports every window on a secondary monitor
    // as on-all-workspaces. That's the monitor policy talking, not the user pinning a
    // window, so it stays a normal mosaic member. The overview layout asks this too; both
    // have to agree on what sticky means or they end up laying out different mosaics.
    isTrulySticky(meta_window) {
        if (!meta_window.is_on_all_workspaces()) {
            return false;
        }

        const stickyByMonitorPolicy = Meta.prefs_get_workspaces_only_on_primary() &&
                                      !meta_window.is_on_primary_monitor();
        return !stickyByMonitorPolicy;
    }

    isNavigable(meta_window) {
        return this.getNavigationIneligibilityReason(meta_window) === null;
    }

    getNavigationIneligibilityReason(meta_window) {
        if (!meta_window) {
            return 'missing-window';
        }

        if (!isWindowAlive(meta_window)) {
            return 'dead-window';
        }

        if (meta_window.minimized) {
            return 'minimized';
        }

        if (meta_window.is_on_all_workspaces()) {
            return 'sticky';
        }

        const workspace = meta_window.get_workspace?.();
        if (!workspace) {
            return 'missing-workspace';
        }

        const monitor = meta_window.get_monitor?.();
        if (monitor === null || monitor === undefined || monitor < 0) {
            return 'missing-monitor';
        }

        const frame = meta_window.get_frame_rect?.();
        if (!frame || frame.width <= 0 || frame.height <= 0) {
            return 'missing-geometry';
        }

        if (meta_window.is_attached_dialog()) {
            return 'attached-dialog';
        }

        if (meta_window.get_transient_for() !== null) {
            return 'transient';
        }

        if (meta_window.is_skip_taskbar?.()) {
            return 'skip-taskbar';
        }

        return null;
    }

    isMaximizedOrFullscreen(window) {
        return window.is_maximized() || window.is_fullscreen() || this._looksNativelyFullscreen(window);
    }

    // Some game engines (Unity's borderless "Fullscreen Window" mode) resize to the monitor's
    // resolution without setting the WM's real maximize/fullscreen state, so nothing marks
    // them sacred and mosaic shrinks then miniaturizes them like any oversized window. Catch
    // the shape instead: no preferred/opening size captured yet, and the frame already covers
    // the whole physical monitor, which normal placement (even maximized) never reaches.
    _looksNativelyFullscreen(window) {
        if (WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize'))
            return false;

        const monitor = window.get_monitor();
        if (monitor === null || monitor === undefined || monitor < 0) return false;

        const geom = global.display.get_monitor_geometry(monitor);
        if (!geom) return false;

        const frame = window.get_frame_rect();
        return frame.width >= geom.width && frame.height >= geom.height;
    }

    hasSacredWindow(workspace, monitor, excludeWindowId = null) {
        if (!workspace || monitor === null || monitor === undefined)
            return false;

        const windows = this.getMonitorWorkspaceWindows(workspace, monitor);
        return windows.some(w =>
            (!excludeWindowId || w.get_id() !== excludeWindowId) &&
            this.isMaximizedOrFullscreen(w)
        );
    }

    renavigate(workspace, condition, lastVisitedIndex = null, monitorIndex = -1) {
        if (!condition) return;

        // Queue in idle with low priority to let GNOME settle its dynamic workspace states
        this._timeoutRegistry.addIdle(() => {
            const currentIndex = this._indexOfWorkspace(workspace);
            if (currentIndex < 0) return GLib.SOURCE_REMOVE;

            const target = this._pickRenavigateTarget(workspace, currentIndex, lastVisitedIndex);

            if (target && target.index() >= 0 && target.index() !== currentIndex) {
                const currentWindows = workspace.list_windows();
                if (currentWindows.some(w => w.is_on_all_workspaces())) {
                    Logger.log(
                        '[RENAVIGATE] Current WS has is_on_all_workspaces() windows; skipping to avoid GNOME Shell WorkspaceSwitcherPopup freeze'
                    );
                } else {
                    target.activate(this.getTimestamp());
                    this.showWorkspaceSwitcher(target, monitorIndex);
                }
            } else {
                Logger.log(`[RENAVIGATE] No suitable target found to navigate away from WS-${currentIndex}`);
            }

            return GLib.SOURCE_REMOVE;
        }, 'windowing_renavigate', GLib.PRIORITY_LOW);
    }

    // This workspace might already be gone by the time the caller's idle runs, and
    // workspace.index() crashes on a removed one, so match by identity instead.
    _indexOfWorkspace(workspace) {
        const workspaceManager = global.workspace_manager;
        for (let i = 0; i < workspaceManager.get_n_workspaces(); i++) {
            if (workspaceManager.get_workspace_by_index(i) === workspace) return i;
        }
        return -1;
    }

    _pickRenavigateTarget(workspace, currentIndex, lastVisitedIndex) {
        const lastWorkspaceIndex = global.workspace_manager.get_n_workspaces() - 1;

        let target = this._preferredNeighbor(workspace, currentIndex, lastWorkspaceIndex, lastVisitedIndex);

        if (!target || target.index() === currentIndex) {
            target = workspace.get_neighbor(Meta.MotionDirection.LEFT);

            if (!target || target.index() === currentIndex || target.index() < 0) {
                target = workspace.get_neighbor(Meta.MotionDirection.RIGHT);
            }

            // Final safety: never fallback to the placeholder workspace
            if (target && target.index() === lastWorkspaceIndex) {
                target = null;
            } else if (target) {
                Logger.log(`[RENAVIGATE] Falling back to available neighbor (WS-${target.index()})`);
            }
        }

        return this._guardLeftmostTarget(target, currentIndex);
    }

    // The leftmost workspace has nothing to return to; going right strands
    // the user in the overflow zone when the target is empty.
    _guardLeftmostTarget(target, currentIndex) {
        if (currentIndex === 0 && target && !this._workspaceHasWindows(target)) {
            Logger.log(`[RENAVIGATE] WS-0 is leftmost and WS-${target.index()} is empty; staying put`);
            return null;
        }
        return target;
    }

    _workspaceHasWindows(workspace) {
        return workspace.list_windows().some(w => !this.isExcluded(w));
    }

    // The last workspace is the placeholder, so from there the only way out is left.
    // Anywhere else, head back where we came from; null hands the choice to the fallback.
    _preferredNeighbor(workspace, currentIndex, lastWorkspaceIndex, lastVisitedIndex) {
        if (currentIndex === lastWorkspaceIndex) {
            const leftNeighbor = workspace.get_neighbor(Meta.MotionDirection.LEFT);
            if (leftNeighbor) {
                Logger.log(`[RENAVIGATE] On final workspace, moving to left neighbor (WS-${leftNeighbor.index()})`);
            }
            return leftNeighbor;
        }

        if (lastVisitedIndex === null || lastVisitedIndex === currentIndex) return null;

        const direction = lastVisitedIndex < currentIndex
            ? Meta.MotionDirection.LEFT
            : Meta.MotionDirection.RIGHT;

        const target = workspace.get_neighbor(direction);

        // Guard: Don't jump to the final empty workspace if we were going right
        if (target && target.index() === lastWorkspaceIndex) return null;
        if (target) {
            Logger.log(`[RENAVIGATE] Moving ${direction === Meta.MotionDirection.LEFT ? 'left' : 'right'} toward last visited WS-${lastVisitedIndex}`);
        }
        return target;
    }

    showWorkspaceSwitcher(workspace, monitorIndex = -1) {
        if (!isWorkspaceAlive(workspace, global.workspace_manager)) return;

        const wsWindows = workspace.list_windows();
        if (wsWindows.some(w => w.is_on_all_workspaces())) {
            Logger.log(
                '[SWITCHER] Workspace has is_on_all_workspaces() windows; skipping to avoid GNOME Shell WorkspaceSwitcherPopup freeze'
            );
            return;
        }

        const index = workspace.index();
        Logger.log(`[SWITCHER] Activating OSD for WS-${index}`);

        if (monitorIndex === -1) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }

        Logger.log(`showWorkspaceSwitcher: showing WorkspaceSwitcherPopup for workspace ${index} on monitor ${monitorIndex}`);

        try {
            if (!Main.wm._workspaceSwitcherPopup) {
                Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
            }

            if (!WindowState.get(Main.wm._workspaceSwitcherPopup, 'destroyConnected')) {
                Main.wm._workspaceSwitcherPopup.connect('destroy', () => {
                    Main.wm._workspaceSwitcherPopup = null;
                });
                WindowState.set(Main.wm._workspaceSwitcherPopup, 'destroyConnected', true);
            }

            Main.wm._workspaceSwitcherPopup.display(index);
        } catch (e) {
            Logger.warn(`WorkspaceSwitcherPopup failed: ${e.message}`);
        }
    }
    destroy() {
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._tilingManager = null;
        this._timeoutRegistry = null;
        this._overflowStartCallback = null;
        this._overflowEndCallback = null;
        this._windowsCache = new WeakMap();
    }
});
