// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import * as WindowState from './windowState.js';
import {IS_MINIATURE, PENDING_MINIATURE, PRE_MINIATURE_SIZE, APPLYING_LAYOUT} from './windowState.js';
import * as constants from './constants.js';
import {isWindowAlive} from './liveness.js';
import {MosaicModel} from './mosaicModel.js';
import {WindowRegionConstraint} from './windowRegionConstraint.js';
import {planMaximizedLayout} from './maximizedLayoutPlanner.js';

// A tiler component: native state is the only mode/eligibility source. The maps
// own geometry resources and per-workspace presentation, never maximize intent.
export class MaximizedLayout {
    constructor(extension) {
        this._ext = extension;
        this._constraints = new Map();
        this._views = new WeakMap();
        this._queued = new Map();
        this.applying = false;
    }

    _windows(workspace, monitor) {
        const rank = this._ext.windowingManager.getMRUOrder(workspace);
        return this._ext.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => isWindowAlive(w) && !this._ext.windowingManager.isExcluded(w) &&
                !this._ext.windowingManager.isFullscreenLike(w) &&
                !this._ext.edgeTilingManager.isEdgeTiled(w))
            .sort((a, b) => (rank.get(a.get_id()) ?? Infinity) - (rank.get(b.get_id()) ?? Infinity));
    }

    _view(workspace, monitor) {
        let monitors = this._views.get(workspace);
        if (!monitors) this._views.set(workspace, monitors = new Map());
        if (!monitors.has(monitor)) monitors.set(monitor, {focus: null, side: null});
        return monitors.get(monitor);
    }

    _focusOwner(window) {
        const visited = new Set();
        while (window && isWindowAlive(window) && !visited.has(window)) {
            visited.add(window);
            if (!this._ext.windowingManager.isExcluded(window)) return window;
            window = window.get_transient_for?.();
        }
        return null;
    }

    focusFor(workspace, monitor) {
        const belongs = w => w && isWindowAlive(w) && w.get_workspace() === workspace &&
            w.get_monitor() === monitor && !this._ext.windowingManager.isExcluded(w);
        const view = this._view(workspace, monitor);
        // Explicit layout transactions and focus-change signals update the per-view cache before
        // Mutter necessarily publishes the same window through global.display.focus_window.
        // Preserve that logical focus for the whole transaction; native focus is only an
        // initialization fallback when the view has no usable owner yet.
        if (belongs(view.focus)) return view.focus;
        const focused = this._focusOwner(global.display.focus_window);
        if (belongs(focused)) {
            view.focus = focused;
            return focused;
        }
        if (!belongs(view.focus)) view.focus = this._windows(workspace, monitor)[0] ?? null;
        return view.focus;
    }

    targetSize(workspace, monitor) {
        if (!workspace || monitor === null || monitor === undefined)
            return constants.MINIATURE_TARGET_SIZE_PX;
        const focus = this.focusFor(workspace, monitor);
        return focus?.is_maximized() && !focus.is_fullscreen() &&
            !WindowState.get(focus, IS_MINIATURE)
            ? constants.MINIATURE_TARGET_SIZE_PX / 2 : constants.MINIATURE_TARGET_SIZE_PX;
    }

    hasWindows(workspace, monitor) {
        return this._windows(workspace, monitor).some(w => w.is_maximized());
    }

    _items(windows, preserveMaximizedSize = false) {
        return windows.map(window => {
            const frame = window.get_frame_rect();
            const preferred = WindowState.get(window, 'targetRestoredSize') ??
                WindowState.get(window, 'preferredSize') ?? WindowState.get(window, 'openingSize') ?? frame;
            const minimum = this._ext.tilingManager.getWindowMinimumSize(window);
            const normalSize = {
                width: Math.max(96, preferred.width),
                height: Math.max(96, preferred.height),
            };
            return {id: window.get_id(), maximized: window.is_maximized(),
                miniature: !!WindowState.get(window, IS_MINIATURE),
                normalSize,
                minimum: this._maximizedMinimum(window, minimum, normalSize, preserveMaximizedSize),
                sourceSize: WindowState.get(window, PRE_MINIATURE_SIZE) ?? frame};
        });
    }

    _maximizedMinimum(window, minimum, normalSize, preserveMaximizedSize) {
        const constrained = preserveMaximizedSize && window.is_maximized()
            ? this._constraints.get(window)?.rect : null;
        // Smart Resize learns actualMin* from configure clamping, but that observation can
        // become stale across role transitions. A saved normal size is stronger evidence:
        // the client has already rendered at that frame size successfully. Never let a stale
        // learned minimum make a focused native-maximized window ineligible to be presented.
        const width = Math.min(minimum.width, normalSize.width);
        const height = Math.min(minimum.height, normalSize.height);
        return {
            width: Math.max(96, width, constrained?.width ?? 0),
            height: Math.max(96, height, constrained?.height ?? 0),
        };
    }

    _plan(workspace, monitor, windows, {focus, restore = null, passive = false} = {}) {
        const selected = focus ?? this.focusFor(workspace, monitor);
        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        // A normal focus may reuse an existing constrained maximized region but must not
        // squeeze it further. Focused-maximized priority is derived by the pure planner from
        // the current sibling set (all peers miniature first), rather than from historical
        // constraint geometry, so a newly-added rail can still consume its legitimate space.
        const preserveMaximizedSize = this._shouldPreserveMaximizedSize(selected);
        return planMaximizedLayout({items: this._items(windows, preserveMaximizedSize), focusId: selected?.get_id(),
            restoreId: restore?.get_id(), workArea, passive,
            spacing: constants.WINDOW_SPACING,
            outerGap: this._outerGap(windows, workspace, monitor),
            standardSize: constants.MINIATURE_TARGET_SIZE_PX,
            targetSize: selected?.is_maximized() ? constants.MINIATURE_TARGET_SIZE_PX / 2 : constants.MINIATURE_TARGET_SIZE_PX,
            previousSide: this._view(workspace, monitor).side});
    }

    _shouldPreserveMaximizedSize(selected) {
        return !!selected && !selected.is_maximized();
    }

    _outerGap(windows, workspace, monitor) {
        return windows.length === 1 &&
            !this._ext.edgeTilingManager.getEdgeTiledWindows(workspace, monitor).length
            ? 0 : constants.WINDOW_SPACING;
    }

    // The dominant presentation is focus-driven: only a focused native-maximized window owns
    // the main region. Any other focus keeps the ordinary mosaic untouched.
    _isDominantFocus(window) {
        return !!window && window.is_maximized() && !window.is_fullscreen();
    }

    reconcile(workspace, monitor, options = {}) {
        if (this.applying) return true;
        this._pruneConstraints();
        if (!workspace || !this._ext.isMosaicEnabledForWorkspace(workspace)) return false;
        const windows = this._windows(workspace, monitor);
        if (!windows.some(w => w.is_maximized())) return false;
        const selected = options.focus ?? this.focusFor(workspace, monitor);
        if (!this._isDominantFocus(selected)) {
            this._releaseDominantConstraints(workspace, monitor);
            return false;
        }
        return this._reconcileDominant(workspace, monitor, windows, options);
    }

    _reconcileDominant(workspace, monitor, windows, options) {
        // Fullscreen controls its own presentation. Do not restore peers behind it.
        if (workspace.list_windows().some(w => w.get_monitor() === monitor && w.is_fullscreen()))
            return true;
        const plan = this._plan(workspace, monitor, windows, options);
        if (plan) return this._commit(plan, windows, workspace, monitor, options);
        if (options.passive) return false;
        // Hand an unsatisfied normal admission back to the ordinary tiler, with
        // maximized peers represented by existing miniature machinery.
        this._miniaturizeMaximized(windows, workspace, monitor);
        return false;
    }

    _commit(plan, windows, workspace, monitor, {animate = true} = {}) {
        const byId = new Map(windows.map(w => [w.get_id(), w]));
        const selected = byId.get(plan.windowId);
        const minis = this._ext.miniatureManager;
        if (!selected || plan.placements.some(p => p.kind === 'mini' &&
            !minis.canApplyMiniaturePresentation(byId.get(p.id), p.rect))) return false;
        this.applying = true;
        try {
            for (const window of windows) {
                this._ext.animationsManager.claimWindowForRoleTransition(window);
                WindowState.set(window, APPLYING_LAYOUT, true);
            }
            this.setRegion(selected, plan.rect);
            for (const placement of plan.placements)
                this._applyPlacement(byId.get(placement.id), placement, workspace, monitor, animate);
            this._restoreDirect(selected, animate);
            const r = plan.rect;
            selected.move_resize_frame(false, r.x, r.y, r.width, r.height);
            MosaicModel.setPresentationSlot(selected, r, workspace, monitor);
            this._view(workspace, monitor).side = plan.side;
            this._ext.mosaicRenderer?.publishToOverview(workspace, monitor);
        } finally {
            for (const window of windows) WindowState.remove(window, APPLYING_LAYOUT);
            this.applying = false;
        }
        return true;
    }

    _applyPlacement(window, placement, workspace, monitor, animate) {
        const minis = this._ext.miniatureManager;
        const r = placement.rect;
        if (placement.kind === 'mini') {
            if (window.is_maximized() && !this._constraints.has(window))
                this.setRegion(window, window.get_frame_rect());
            if (WindowState.get(window, IS_MINIATURE))
                minis.updateMiniatureLayout(window, r, {animate});
            else
                minis.createMiniature(window, r, placement.sourceSize, {animate});
            MosaicModel.setPresentationSlot(window, r, workspace, monitor);
        } else {
            this._restoreDirect(window, animate);
            WindowState.set(window, 'isConstrainedByMosaic', true);
            window.move_resize_frame(false, r.x, r.y, r.width, r.height);
            MosaicModel.commitNormalSlot(window, r, workspace, monitor);
        }
    }

    _restoreDirect(window, animate) {
        if (WindowState.get(window, IS_MINIATURE))
            this._ext.miniatureManager.restoreMiniature(window, null,
                {activate: false, layoutBypass: true, instant: !animate});
    }

    _miniaturizeMaximized(windows, workspace, monitor) {
        const pending = [];
        for (const window of windows.filter(w => w.is_maximized())) {
            if (WindowState.get(window, IS_MINIATURE) || WindowState.get(window, PENDING_MINIATURE)) continue;
            const frame = window.get_frame_rect();
            this.setRegion(window, frame);
            pending.push({window, preSize: frame});
        }
        // Do not invent a temporary top-left miniature target here. The ordinary unified rail
        // solver owns this handoff: it computes the final slot first, then createMiniature()
        // animates directly from the maximized frame to that slot in one continuous motion.
        this._ext.tilingManager.stagePendingMiniatures(pending, workspace, monitor);
    }

    admit(window) {
        if (!isWindowAlive(window)) return false;
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        // Admission is a focus transaction even when Mutter has not published focus_window yet.
        // Cache it before planning so native-state idles that were queued for an older sibling
        // cannot replay the previous focus profile and briefly send the entrant to the rail.
        this._view(workspace, monitor).focus = window;
        if (!this._isDominantFocus(window) && !this._ext.windowingManager.isFullscreenLike(window))
            this._yieldMaximizedForArrival(workspace, monitor);
        return this.reconcile(workspace, monitor, {focus: window});
    }

    // An ordinary admission is the arrival-side twin of an ordinary restore: it ends the
    // dominant presentation, so every native-maximized peer without a rail seat yields to the
    // unified rail before the fit probe runs. Without this handoff the ordinary tiler sees a
    // full-size native-maximized peer, cannot fit the newcomer locally, and ejects it to
    // another workspace instead of shrinking the maximized peer into the rail.
    _yieldMaximizedForArrival(workspace, monitor) {
        if (!workspace || !this._ext.isMosaicEnabledForWorkspace(workspace)) return;
        const windows = this._windows(workspace, monitor);
        const yieldable = windows.some(w => w.is_maximized() &&
            !WindowState.get(w, IS_MINIATURE) && !WindowState.get(w, PENDING_MINIATURE));
        if (yieldable) this._miniaturizeMaximized(windows, workspace, monitor);
    }

    restore(window, {activate = true, reason = 'auto'} = {}) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const passive = reason === 'auto' || reason === 'hover';
        if (this.hasWindows(workspace, monitor)) {
            const result = this._restoreWithMaximized(window, workspace, monitor, activate, passive);
            if (result !== null) return result;
        }
        const windows = this._windows(workspace, monitor);
        const area = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        if (!this._ext.tilingManager.canRestoreMiniature(window, windows, area,
            {requireStableNormal: passive})) return false;
        return this._ext.miniatureManager.restoreMiniature(window, null,
            {activate, reason, layoutBypass: true});
    }

    _restoreWithMaximized(window, workspace, monitor, activate, passive) {
        const focus = passive ? this.focusFor(workspace, monitor) : window;
        if (!this._isDominantFocus(focus))
            return this._yieldMaximizedForRestore(window, workspace, monitor, passive);
        if (!passive)
            this._view(workspace, monitor).focus = window;
        const windows = this._windows(workspace, monitor);
        const plan = this._plan(workspace, monitor, windows, {focus, restore: window, passive});
        if (this._planRestores(plan, window) && this._commit(plan, windows, workspace, monitor)) {
            if (activate) window.activate(global.get_current_time());
            return true;
        }
        if (passive || window.is_maximized()) return false;
        this._miniaturizeMaximized(windows, workspace, monitor);
        return null;
    }

    // Explicit restore of an ordinary miniature ends the dominant presentation: every maximized
    // peer yields by becoming a miniature, then the generic restore path lays out the workspace.
    _yieldMaximizedForRestore(window, workspace, monitor, passive) {
        if (!passive)
            this._view(workspace, monitor).focus = window;
        if (passive || window.is_maximized()) return null;
        this._miniaturizeMaximized(this._windows(workspace, monitor), workspace, monitor);
        return null;
    }

    _planRestores(plan, window) {
        return plan && (plan.windowId === window.get_id() ||
            plan.placements.some(p => p.id === window.get_id() && p.kind === 'normal'));
    }

    onFocusChanged(window) {
        const focus = this._focusOwner(window);
        if (!focus) return;
        // A maximized miniature still represents native maximized intent. Focusing it selects
        // which native maximized window the unified layout presents; ordinary miniatures keep
        // using the generic restore path instead.
        if (WindowState.get(focus, IS_MINIATURE) && !focus.is_maximized()) return;
        const workspace = focus.get_workspace();
        const monitor = focus.get_monitor();
        if (!workspace || !this._ext.isMosaicEnabledForWorkspace(workspace)) return;
        this._view(workspace, monitor).focus = focus;
        // Updating only the destination preserves the old workspace's miniature scale.
        this.queue(focus);
    }

    queue(window) {
        // A focus/native-state notification may arrive synchronously while _commit() owns
        // geometry. Do not re-enter the transaction, but do retain the notification: the
        // idle callback runs after the current synchronous commit and reconciles the latest
        // native/focus state. Dropping it here leaves the presentation stale indefinitely.
        if (!window || this._queued.has(window)) return;
        const id = this._ext._timeoutRegistry.addIdle(() => {
            this._queued.delete(window);
            if (isWindowAlive(window))
                this._ext.tilingManager.tileWorkspaceWindows(
                    window.get_workspace(), null, window.get_monitor());
            return GLib.SOURCE_REMOVE;
        }, 'windowRegion_retile');
        this._queued.set(window, id);
    }

    _nativeFocusOwner(workspace, monitor) {
        const focused = this._focusOwner(global.display.focus_window);
        if (!focused || focused.get_workspace() !== workspace || focused.get_monitor() !== monitor)
            return null;
        if (WindowState.get(focused, IS_MINIATURE) && !focused.is_maximized())
            return null;
        return focused;
    }

    nativeStateChanged(window) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const focused = this._nativeFocusOwner(workspace, monitor);
        if (focused)
            this._view(workspace, monitor).focus = focused;

        this.forget(window);
        if (window.is_maximized() && !window.is_fullscreen()) {
            this._ext.edgeTilingManager.releaseForMaximize(window);
            this.queue(window);
        } else if (!window.is_fullscreen()) {
            // Returning from native maximize: the preferred frame may exceed the work area,
            // so the handler's Smart Resize path re-fits the window (or miniaturizes peers)
            // before the ordinary retile. A plain retile here just overflows and aborts.
            if (!this._ext.windowHandler?.settleReturnedWindow?.(window))
                this.queue(window);
        }
    }

    prepareWorkspace(workspace, monitor) {
        if (!workspace || !this._ext.isMosaicEnabledForWorkspace(workspace)) return;
        // Called before switch clones are built. Never start or replay an actor ease here.
        this.reconcile(workspace, monitor, {animate: false, passive: true});
        for (const window of this._windows(workspace, monitor)) {
            if (!WindowState.get(window, IS_MINIATURE)) continue;
            const slot = MosaicModel.presentationSlotFor(window);
            if (slot) this._ext.miniatureManager.updateMiniatureLayout(window, slot, {animate: false});
        }
    }

    setRegion(window, rect) {
        let entry = this._constraints.get(window);
        if (!entry) {
            entry = {constraint: new WindowRegionConstraint(), workspace: window.get_workspace(),
                monitor: window.get_monitor(), rect: null};
            this._constraints.set(window, entry);
        }
        entry.workspace = window.get_workspace();
        entry.monitor = window.get_monitor();
        entry.rect = {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
        entry.constraint.setTarget(rect);
        entry.constraint.attach(window);
    }

    forget(window) {
        const entry = this._constraints.get(window);
        if (!entry) return;
        if (isWindowAlive(window)) entry.constraint.detach();
        this._constraints.delete(window);
    }

    // Leaving the dominant presentation restores the pre-commit behavior: drop the region
    // pin and let the window keep Mutter's native maximized geometry again. Miniature backing
    // frames stay pinned so their actor transform keeps a stable surface to scale.
    _releaseDominantConstraints(workspace, monitor) {
        if (this._constraints.size === 0) return;
        for (const [window, entry] of this._constraints) {
            if (entry.workspace !== workspace || entry.monitor !== monitor) continue;
            if (this._keepsPinnedPresentation(window)) continue;
            this._releaseConstraint(window, workspace, monitor);
        }
    }

    _keepsPinnedPresentation(window) {
        return WindowState.get(window, IS_MINIATURE) ||
            WindowState.get(window, PENDING_MINIATURE);
    }

    _releaseConstraint(window, workspace, monitor) {
        this.forget(window);
        if (!isWindowAlive(window) || !window.is_maximized() || window.is_fullscreen()) return;
        const area = workspace.get_work_area_for_monitor(monitor);
        if (area) window.move_resize_frame(false, area.x, area.y, area.width, area.height);
    }

    _pruneConstraints() {
        for (const [window, entry] of this._constraints) {
            if (!isWindowAlive(window) || !window.is_maximized() || window.is_fullscreen() ||
                window.get_workspace() !== entry.workspace || window.get_monitor() !== entry.monitor ||
                this._ext.windowingManager.isExcluded(window) ||
                !this._ext.isMosaicEnabledForWorkspace(entry.workspace)) this.forget(window);
        }
    }

    clearWorkspace(workspace) {
        for (const [window, entry] of this._constraints)
            if (entry.workspace === workspace) this.forget(window);
        this._views.delete(workspace);
    }

    destroy() {
        for (const window of this._constraints.keys()) this.forget(window);
        for (const id of this._queued.values()) this._ext._timeoutRegistry.remove(id);
        this._queued.clear();
        this._views = new WeakMap();
    }
}
