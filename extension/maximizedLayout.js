// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import * as Logger from './logger.js';
import * as WindowState from './windowState.js';
import {IS_MINIATURE, PENDING_MINIATURE, PRE_MINIATURE_SIZE, APPLYING_LAYOUT} from './windowState.js';
import * as constants from './constants.js';
import {isWindowAlive, isWorkspaceAlive} from './liveness.js';
import {MosaicModel} from './mosaicModel.js';
import {WindowRegionConstraint} from './windowRegionConstraint.js';
import {planMaximizedLayout} from './maximizedLayoutPlanner.js';

// A tiler component: native state is the only mode/eligibility source. The maps
// own geometry resources and per-workspace presentation, never maximize intent.

// Focus profile decides the rail scale: a native-maximized dominant focus presents its
// peers at half size. Shared with the planner so a focused maximized miniature cannot
// advertise a different target than the transaction that is about to display it.
function targetSizeForFocus(focus) {
    return focus?.is_maximized() && !focus.is_fullscreen()
        ? constants.MINIATURE_TARGET_SIZE_PX / 2
        : constants.MINIATURE_TARGET_SIZE_PX;
}

export class MaximizedLayout {
    constructor(extension) {
        this._ext = extension;
        this._constraints = new Map();
        this._orphaned = new Map();
        this._views = new WeakMap();
        this._queued = new Map(); // Per-view idle IDs: one retile per workspace/monitor.
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

    // windows is optional: transaction callers already hold one snapshot and pass it down so a
    // single reconcile does not re-query (and re-sort) Mutter's MRU list for every helper.
    focusFor(workspace, monitor, windows = null) {
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
        if (!belongs(view.focus))
            view.focus = (windows ?? this._windows(workspace, monitor))[0] ?? null;
        return view.focus;
    }

    targetSize(workspace, monitor, windows = null) {
        if (!workspace || monitor === null || monitor === undefined)
            return constants.MINIATURE_TARGET_SIZE_PX;
        return targetSizeForFocus(this.focusFor(workspace, monitor, windows));
    }

    hasWindows(workspace, monitor, windows = null) {
        return (windows ?? this._windows(workspace, monitor)).some(w => w.is_maximized());
    }

    _items(windows) {
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
                minimum: this._maximizedMinimum(window, minimum, normalSize),
                sourceSize: WindowState.get(window, PRE_MINIATURE_SIZE) ?? frame};
        });
    }

    // Smart Resize learns actualMin* from configure clamping, but that observation can become
    // stale across role transitions. A saved normal size is stronger evidence: the client has
    // already rendered at that frame size successfully. Never let a stale learned minimum make
    // a focused native-maximized window ineligible to be presented.
    _maximizedMinimum(window, minimum, normalSize) {
        const width = Math.min(minimum.width, normalSize.width);
        const height = Math.min(minimum.height, normalSize.height);
        return {
            width: Math.max(96, width),
            height: Math.max(96, height),
        };
    }

    _plan(workspace, monitor, windows, {focus, restore = null, passive = false} = {}) {
        const selected = focus ?? this.focusFor(workspace, monitor, windows);
        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        // The maximized region is always re-derived from the current window set, never from the
        // window's own last committed constraint rectangle: role feasibility is decided by the
        // canonical rail solve in planMaximizedLayout, so folding historic geometry back in as a
        // minimum would let a stale pin reject the very layout that supersedes it.
        return planMaximizedLayout({items: this._items(windows), focusId: selected?.get_id(),
            restoreId: restore?.get_id(), workArea, passive,
            spacing: constants.WINDOW_SPACING,
            outerGap: this._outerGap(windows, workspace, monitor),
            standardSize: constants.MINIATURE_TARGET_SIZE_PX,
            targetSize: targetSizeForFocus(selected),
            previousSide: this._view(workspace, monitor).side});
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
        this._drainOrphans();
        this._pruneConstraints();
        if (!workspace || !this._ext.isMosaicEnabledForWorkspace(workspace)) return false;
        const windows = options.windows ?? this._windows(workspace, monitor);
        if (!windows.some(w => w.is_maximized())) return false;
        const selected = options.focus ?? this.focusFor(workspace, monitor, windows);
        if (!this._isDominantFocus(selected)) {
            this._releaseDominantConstraints(workspace, monitor);
            return false;
        }
        return this._reconcileDominant(workspace, monitor, windows, {...options, focus: selected});
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
        // Overview preparation reconciles every workspace on the way in and out; a plan that
        // is already on screen must not claim actors (cancelling in-flight eases) and re-issue
        // the same move_resize_frame. Skipping keeps repeat transactions free.
        if (this._planIsApplied(plan, byId, workspace, monitor)) return true;
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

    // True when every role and rectangle the plan asks for is already committed. The view side
    // and the selected window's constraint are part of the presentation contract, so a missing
    // or stale constraint must still fall through to a real commit.
    _planIsApplied(plan, byId, workspace, monitor) {
        if (this._view(workspace, monitor).side !== plan.side) return false;

        const selected = byId.get(plan.windowId);
        // A miniature backing a native maximized window can already own the same constraint
        // rect as the dominant plan (single-window layouts commit the work area either way).
        // Role is the missing half of that comparison: a mini selected window still needs
        // _restoreDirect(), which only runs inside a real commit.
        if (!selected || WindowState.get(selected, IS_MINIATURE) ||
            WindowState.get(selected, PENDING_MINIATURE)) return false;

        const region = this._constraints.get(selected);
        if (!region || region.workspace !== workspace || region.monitor !== monitor ||
            !this._rectEquals(region.rect, plan.rect)) return false;

        return plan.placements.every(placement => {
            const window = byId.get(placement.id);
            if (!window || !this._rectEquals(
                MosaicModel.presentationSlotFor(window), placement.rect)) return false;
            return placement.kind === 'mini'
                ? !!WindowState.get(window, IS_MINIATURE)
                : !WindowState.get(window, IS_MINIATURE) &&
                    !WindowState.get(window, PENDING_MINIATURE) &&
                    !!WindowState.get(window, 'isConstrainedByMosaic');
        });
    }

    _rectEquals(a, b) {
        return !!a && !!b && a.x === b.x && a.y === b.y &&
            a.width === b.width && a.height === b.height;
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

    // Every entry point needs the same scope gate. get_workspace() is NULL until Mutter places
    // the window (and Mutter's own meta_window_get_workspace() returns it verbatim), while
    // _view() keys a WeakMap -- so building a view from a null workspace throws
    // "Invalid value used as weak map key" out of a signal handler, aborting the whole handler
    // rather than declining the request. Monitor -1 is Mutter's unmapped value and reaches
    // get_work_area_for_monitor(-1) further down.
    _scopeOf(window) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (!workspace || monitor === null || monitor === undefined || monitor < 0) return null;
        return {workspace, monitor};
    }

    admit(window) {
        if (!isWindowAlive(window)) return false;
        const scope = this._scopeOf(window);
        if (!scope) return false;
        const {workspace, monitor} = scope;
        // A window Mosaic deliberately floats owns no layout transaction. The callers gate on
        // this too, but admit() is the one that miniaturizes maximized peers, so it must not
        // depend on every caller remembering.
        if (this._ext.windowingManager.isExcluded(window)) return false;
        // Admission is a focus transaction even when Mutter has not published focus_window yet.
        // Cache it before planning so native-state idles that were queued for an older sibling
        // cannot replay the previous focus profile and briefly send the entrant to the rail.
        this._view(workspace, monitor).focus = window;
        const windows = this._windows(workspace, monitor);
        if (!this._isDominantFocus(window) && !this._ext.windowingManager.isFullscreenLike(window))
            this._yieldMaximizedForArrival(workspace, monitor, windows);
        return this.reconcile(workspace, monitor, {focus: window, windows});
    }

    // An ordinary admission is the arrival-side twin of an ordinary restore: it ends the
    // dominant presentation, so every native-maximized peer without a rail seat yields to the
    // unified rail before the fit probe runs. Without this handoff the ordinary tiler sees a
    // full-size native-maximized peer, cannot fit the newcomer locally, and ejects it to
    // another workspace instead of shrinking the maximized peer into the rail.
    _yieldMaximizedForArrival(workspace, monitor, windows = null) {
        if (!workspace || !this._ext.isMosaicEnabledForWorkspace(workspace)) return;
        const list = windows ?? this._windows(workspace, monitor);
        const yieldable = list.some(w => w.is_maximized() &&
            !WindowState.get(w, IS_MINIATURE) && !WindowState.get(w, PENDING_MINIATURE));
        if (yieldable) this._miniaturizeMaximized(list, workspace, monitor);
    }

    restore(window, {activate = true, reason = 'auto'} = {}) {
        // restore() is the miniature restore gate, reachable for any window that can still be
        // a miniature, so it needs the same scope gate as admit() before it queries or plans.
        // A refused gate must return false: reporting success would tell the caller its retile
        // is unnecessary when nothing was actually restored.
        const scope = this._scopeOf(window);
        if (!scope) return false;
        const {workspace, monitor} = scope;
        const passive = reason === 'auto' || reason === 'hover';
        const windows = this._windows(workspace, monitor);
        if (windows.some(w => w.is_maximized())) {
            const result = this._restoreWithMaximized(window, workspace, monitor, windows, activate, passive);
            if (result !== null) return result;
        }
        const area = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        if (!this._ext.tilingManager.canRestoreMiniature(window, windows, area,
            {requireStableNormal: passive})) return false;
        return this._ext.miniatureManager.restoreMiniature(window, null,
            {activate, reason, layoutBypass: true});
    }

    _restoreWithMaximized(window, workspace, monitor, windows, activate, passive) {
        const focus = passive ? this.focusFor(workspace, monitor, windows) : window;
        if (!this._isDominantFocus(focus))
            return this._yieldMaximizedForRestore(window, workspace, monitor, windows, passive);
        if (!passive)
            this._view(workspace, monitor).focus = window;
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
    _yieldMaximizedForRestore(window, workspace, monitor, windows, passive) {
        if (!passive)
            this._view(workspace, monitor).focus = window;
        if (passive || window.is_maximized()) return null;
        this._miniaturizeMaximized(windows, workspace, monitor);
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
        const view = this._view(workspace, monitor);
        const previous = view.focus;
        view.focus = focus;
        if (previous === focus) return;
        // Ordinary-to-ordinary focus changes do not alter presentation. Still cache focus
        // for later admission, and retile when entering/leaving maximized focus or selecting
        // another maximized window. Native mode changes queue their own geometry updates.
        // Updating only the destination preserves the old workspace's miniature scale.
        if (this._isDominantFocus(focus) ||
            (isWindowAlive(previous) && this._isDominantFocus(previous)))
            this.queue(focus);
    }

    queue(window) {
        // A focus/native-state notification may arrive synchronously while _commit() owns
        // geometry. Do not re-enter the transaction, but do retain the notification: the
        // idle callback runs after the current synchronous commit and reconciles the latest
        // native/focus state. Dropping it here leaves the presentation stale indefinitely.
        if (!isWindowAlive(window)) return;
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (!workspace || monitor === null || monitor === undefined || monitor < 0) return;
        const view = this._view(workspace, monitor);
        if (this._queued.has(view)) return;
        const id = this._ext._timeoutRegistry.addIdle(() => {
            this._queued.delete(view);
            // The scope owns this request, not its first window: that window may have moved
            // or closed while another notification still needs to settle the same view.
            if (isWorkspaceAlive(workspace))
                this._ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor);
            return GLib.SOURCE_REMOVE;
        }, 'windowRegion_retile');
        this._queued.set(view, id);
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
        const windows = this._windows(workspace, monitor);
        this.reconcile(workspace, monitor, {animate: false, passive: true, windows});
        for (const window of windows) {
            if (!WindowState.get(window, IS_MINIATURE)) continue;
            const slot = MosaicModel.presentationSlotFor(window);
            if (slot) this._ext.miniatureManager.updateMiniatureLayout(window, slot, {animate: false});
        }
    }

    setRegion(window, rect) {
        let entry = this._constraints.get(window);
        if (!entry) {
            // An orphan can survive the drain when the window's actor is missing right now.
            // Reuse that constraint instead of building a second one: two attached constraints
            // on one window both write new_rect, Mutter iterates them in unspecified order, and
            // the stale one (has_target with an old rectangle) can win. Reusing also keeps the
            // handle reachable, so a later detach can still find it.
            const orphan = this._orphaned.get(window);
            if (orphan) {
                this._drainOrphan(window);
                if (this._orphaned.get(window) === orphan) {
                    // Still not detachable: take ownership rather than leak it.
                    this._orphaned.delete(window);
                    Logger.warn(`Reusing an undetached window region constraint for ${window.get_id?.() ?? '?'}`);
                }
            }
            entry = {constraint: orphan ?? new WindowRegionConstraint(), workspace: window.get_workspace(),
                monitor: window.get_monitor(), rect: null};
            this._constraints.set(window, entry);
        }
        entry.workspace = window.get_workspace();
        entry.monitor = window.get_monitor();
        entry.rect = {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
        entry.constraint.setTarget(rect);
        entry.constraint.attach(window);
    }

    // Detaches an orphan and forgets it, but only when the detach actually happened: the whole
    // point of _orphaned is that an undetached constraint stays reachable, so dropping the
    // handle on a window whose actor is merely missing would recreate the duplicate-constraint
    // hazard this map exists to prevent.
    _drainOrphan(window) {
        const constraint = this._orphaned.get(window);
        if (!constraint) return;
        // isWindowAlive is an actor-liveness proxy, so false means "cannot detach right now",
        // not "the window is gone".
        if (!isWindowAlive(window)) return;
        try {
            constraint.detach();
        } catch (error) {
            // The window can be finalized between the check above and the call. The handle
            // stays in the map: dropping it would leave the native constraint attached and
            // unreachable from JS, which is the duplicate-constraint hazard this map exists
            // to prevent, and a future reconcile may still be able to detach it.
            Logger.warn(`Could not detach a stale window region constraint yet: ${error}`);
            return;
        }
        this._orphaned.delete(window);
    }

    // A window that has left Mutter's lists can never be re-pinned, so its orphan protects
    // nothing and its entry would otherwise sit in the map (and be scanned on every reconcile)
    // for the rest of the session. Only call this from a terminal path.
    dropOrphan(window) {
        this._orphaned.delete(window);
    }

    // isWindowAlive is an actor-liveness proxy (compositor private present and not destroyed),
    // which is false both for a finalized MetaWindow and for a live one whose actor is simply
    // missing right now. Only the first case may skip the detach, so an undetached constraint
    // is kept in _orphaned instead of being dropped with the entry: deleting the entry would
    // leave the native object attached to the window and unreachable from JS, and a later pin
    // would attach a *second* constraint to the same window. Mutter iterates its external
    // constraints in unspecified order and each one overwrites the same new_rect, so the
    // orphaned one still holds has_target=TRUE with a stale rectangle and can win the constrain
    // pass for as long as the window lives.
    forget(window) {
        const entry = this._constraints.get(window);
        if (!entry) return;
        this._constraints.delete(window);
        if (isWindowAlive(window)) {
            entry.constraint.detach();
            this._orphaned.delete(window);
        } else if (!this._orphaned.has(window)) {
            // set(), not overwrite: a handle already parked for this window must stay
            // reachable, and two attached constraints can never be told apart afterwards.
            this._orphaned.set(window, entry.constraint);
        }
    }

    // Retries the detaches forget() had to skip. Cheap when there is nothing orphaned, and it
    // runs at the top of every reconcile - the same cadence as _pruneConstraints, which is
    // where these orphans are created.
    _drainOrphans() {
        if (this._orphaned.size === 0) return;
        for (const window of [...this._orphaned.keys()]) this._drainOrphan(window);
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

    // Workspace shutdown must return every constrained window to its native state, exactly
    // like the ordinary release path. Merely forgetting the entry would leave a natively
    // maximized window at the smaller constrained frame.
    clearWorkspace(workspace) {
        for (const [window, entry] of this._constraints) {
            if (entry.workspace === workspace)
                this._releaseConstraint(window, workspace, entry.monitor);
        }
        for (const view of this._views.get(workspace)?.values() ?? []) {
            const id = this._queued.get(view);
            if (id !== undefined) this._ext._timeoutRegistry.remove(id);
            this._queued.delete(view);
        }
        this._views.delete(workspace);
    }

    destroy() {
        for (const window of this._constraints.keys()) this.forget(window);
        // A window whose actor was gone at forget() time may be alive again by teardown, and
        // this is the last chance to hand its constraint back: after disable nothing else
        // reaches the orphan map.
        //
        // _drainOrphan, not forget: an orphaned window has no _constraints entry any more, so
        // forget() returns immediately for it and would silently do nothing. Survivors are
        // kept deliberately -- each one is a native constraint Mutter may still be applying,
        // and dropping the last JS handle to it is exactly what this map exists to prevent.
        // Holding them costs one reference until this object is collected.
        for (const window of [...this._orphaned.keys()]) this._drainOrphan(window);
        for (const id of this._queued.values()) this._ext._timeoutRegistry.remove(id);
        this._queued.clear();
        this._views = new WeakMap();
    }
}
