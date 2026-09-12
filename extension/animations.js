// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Smooth window animations for mosaic tiling

import * as Logger from './logger.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as constants from './constants.js';
import * as WindowState from './windowState.js';
import { MINIATURE_ANIM_KIND } from './windowState.js';
import { getAnimationsEnabled, getSlowDownFactor } from './timing.js';

import GObject from 'gi://GObject';

const ANIMATION_DURATION = constants.ANIMATION_DURATION_MS;
const ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_BACK;
const ANIMATION_MODE_SUBTLE = Clutter.AnimationMode.EASE_OUT_QUAD;

export const AnimationsManager = GObject.registerClass({
    GTypeName: 'MosaicAnimationsManager',
    Signals: {
        'animations-completed': {},
    },
}, class AnimationsManager extends GObject.Object {
    _init() {
        super._init();
        this._isDragging = false;
        this._animatingWindows = new Map(); // Window ID -> actor, drives animations-completed signal
        this._animatingTargets = new Map(); // Window ID -> last targetRect, to detect redundant retile calls
        // First-placement entrances stay hidden until the logical frame and compositor actor
        // both represent the presentation Mosaic planned. Mapping/frame_rect alone is not
        // enough: slow Wayland clients can still be painting their old oversized buffer after
        // move_resize_frame(), which would cover siblings that have already moved aside.
        this._pendingEntranceEases = new Map(); // Window ID -> {windowActor, targetRect, ...ease params}
        this._justEndedDrag = false;
        this._resizingWindowId = null;
        this._timeoutRegistry = null;
        this._isOverviewActive = false;
        // Toggled by setMembershipChangeBounce around a close-triggered retile pass.
        this._membershipChangeBounce = false;
    }

    setMembershipChangeBounce(active) {
        this._membershipChangeBounce = active;
    }

    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }

    setResizingWindow(windowId) {
        this._resizingWindowId = windowId;
    }

    getResizingWindowId() {
        return this._resizingWindowId;
    }

    // Drops entries whose actor no longer has the translation transition we
    // started. Something else (a miniature ease, an edge-tile preview) can take
    // over the actor and call remove_all_transitions() without going through
    // removeAnimatingWindow, which would otherwise wedge animations-completed
    // for the rest of the session. Checking the real Clutter state here means
    // a future leak site like that self-heals instead of needing to be hunted down.
    _pruneStaleAnimations() {
        for (const [id, actor] of this._animatingWindows) {
            let stale;
            try {
                stale = !actor || actor.is_destroyed() ||
                    (!this._pendingEntranceEases.has(id) && !actor.get_transition('translation_x'));
            } catch (_e) {
                // Actor's underlying GObject was fully disposed (e.g. window destroyed
                // mid-animation), not merely Clutter-destroyed, so any method call
                // on it throws instead of returning a clean false/null.
                stale = true;
            }
            if (stale) {
                this._animatingWindows.delete(id);
                this._animatingTargets.delete(id);
            }
        }
    }

    // Used by async utilities to wait for animations to complete
    hasActiveAnimations() {
        this._pruneStaleAnimations();
        return this._animatingWindows.size > 0;
    }

    _checkAllAnimationsComplete() {
        this._pruneStaleAnimations();
        if (this._animatingWindows.size === 0) {
            this.emit('animations-completed');
        }
    }

    setOverviewActive(active) {
        this._isOverviewActive = active;
    }

    setDragging(dragging) {
        if (this._isDragging && !dragging) {
            this._justEndedDrag = true;
            this._timeoutRegistry.add(constants.DEBOUNCE_DELAY_MS, () => {
                this._justEndedDrag = false;
                return GLib.SOURCE_REMOVE;
            }, 'animations_dragEndDebounce');
        }
        this._isDragging = dragging;
    }

    shouldAnimateWindow(window, draggedWindow = null) {
        if (!getAnimationsEnabled()) return false;
        if (Main.overview.visible) return false;
        // During active resize, position all sibling windows instantly (real-time retile)
        if (this._resizingWindowId !== null) {
            // A leaked id here would quietly stop every window animating, so log it
            Logger.log(`[ANIM-DIAG] shouldAnimate ${window.get_id()}: no ease (resizingWindowId=${this._resizingWindowId})`);
            return false;
        }

        if (draggedWindow && window.get_id() === draggedWindow.get_id()) {
            return false;
        }

        return true;
    }

    _animOptions(options) {
        const {
            duration = ANIMATION_DURATION,
            mode = null,
            onComplete = null,
            draggedWindow = null,
            subtle = false,
            userOp = false,
            firstPlacement = false,
            slideInOffset = null,
        } = options;
        return { duration, mode, onComplete, draggedWindow, subtle, userOp, firstPlacement, slideInOffset };
    }

    animateWindow(window, targetRect, options = {}) {
        const { duration, mode, onComplete, draggedWindow, subtle, userOp, firstPlacement, slideInOffset } =
            this._animOptions(options);

        if (!this.shouldAnimateWindow(window, draggedWindow)) {
            this._applyWithoutAnimation(window, targetRect, { userOp, firstPlacement, onComplete });
            return;
        }

        const windowActor = window.get_compositor_private();
        if (!windowActor) {
            this._applyNoActor(window, targetRect, { firstPlacement, onComplete });
            return;
        }

        if (this._isRedundantRetile(window, targetRect)) {
            if (onComplete) onComplete();
            return;
        }

        // Must read translation/scale BEFORE remove_all_transitions(), since they reset after.
        const currentFrame = window.get_frame_rect();
        const currentTx = windowActor.translation_x;
        const currentTy = windowActor.translation_y;
        const currentScaleX = windowActor.scale_x;
        const currentScaleY = windowActor.scale_y;

        // A miniature restore animates scale on this same actor and owns recovery
        // if we cut it off below (see continueScaleUp in miniature.js), so piling our
        // own scale ease on top would fight it for the same property.
        const skipScale = WindowState.get(window, MINIATURE_ANIM_KIND) !== undefined;

        // remove_all_transitions fires old onStopped(isFinished=false);
        // the guard at the ease callback returns early without double cleanup.
        windowActor.remove_all_transitions();

        this._animatingWindows.set(window.get_id(), windowActor);
        this._animatingTargets.set(window.get_id(), targetRect);

        const effectiveDuration = Math.ceil(duration * getSlowDownFactor());
        const animationMode = this._pickAnimationMode({ mode, subtle, firstPlacement });

        const { initialTx, initialTy, initialScaleX, initialScaleY } = this._computeInitialTransform(
            { currentFrame, currentTx, currentTy, currentScaleX, currentScaleY, targetRect, slideInOffset, firstPlacement });

        WindowState.set(window, 'isMosaicResizing', true);
        // A pure move applies to the actor's allocation immediately, but a Wayland
        // client only commits a matching buffer for an actual size change some time
        // after the configure request, not synchronously here. Moving first, before
        // asking for the new size, means the position component is already correct
        // by the time set_translation reads it below, regardless of how long the
        // resize itself takes to land. The size mismatch in the meantime is already
        // covered by the scale animation below, which doesn't depend on this.
        window.move_frame(userOp, targetRect.x, targetRect.y);
        window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);

        windowActor.set_translation(initialTx, initialTy, 0);
        if (!skipScale) {
            windowActor.set_pivot_point(0, 0);
            windowActor.set_scale(initialScaleX, initialScaleY);
        }

        const easeParams = { effectiveDuration, animationMode, skipScale, firstPlacement, onComplete };

        // First placement is a visibility transaction. Clutter cannot ease an unmapped actor,
        // and a mapped Wayland actor may still carry the pre-layout buffer while its configure
        // request is in flight. Keep it hidden until both conditions are true so the planned
        // sibling/miniature geometry can never be exposed next to a stale oversized entrant.
        if (firstPlacement &&
            (!windowActor.mapped || !this._firstPlacementPresentationReady(window, windowActor, targetRect))) {
            this._storeDeferredEntrance(window, windowActor, targetRect, easeParams);
            return;
        }

        this._runEntranceEase(window, windowActor, easeParams);
    }

    _applyWithoutAnimation(window, targetRect, { userOp, firstPlacement, onComplete }) {
        // move_resize_frame is a no-op while the overview is open (Mutter discards it), and
        // the flush places this window for real once it hides, so skip entirely rather than
        // snapping to a position that never took effect and losing the animation.
        if (Main.overview.visible) {
            if (onComplete) onComplete();
            return;
        }

        WindowState.set(window, 'isMosaicResizing', true);
        const actor = window.get_compositor_private();
        if (firstPlacement && actor) actor.opacity = 0;
        window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);

        if (firstPlacement && this._deferOrFinishInstantFirstPlacement(
            window, actor, targetRect, onComplete)) return;
        this._clearMosaicResizingSoon(window);
        if (onComplete) onComplete();
    }

    _deferOrFinishInstantFirstPlacement(window, actor, targetRect, onComplete) {
        if (!actor?.mapped || !this._firstPlacementPresentationReady(window, actor, targetRect)) {
            this._storeDeferredEntrance(window, actor, targetRect,
                this._instantEntranceParams(onComplete));
            return true;
        }
        WindowState.remove(window, 'pendingFirstPlacement');
        actor.opacity = 255;
        return false;
    }

    _applyNoActor(window, targetRect, { firstPlacement, onComplete }) {
        Logger.log(`No actor for window ${window.get_id()}, skipping animation`);
        WindowState.set(window, 'isMosaicResizing', true);
        window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        if (firstPlacement) {
            this._storeDeferredEntrance(window, null, targetRect,
                this._instantEntranceParams(onComplete));
            return;
        }
        this._clearMosaicResizingSoon(window);
        if (onComplete) onComplete();
    }

    _instantEntranceParams(onComplete) {
        return {
            effectiveDuration: 0,
            animationMode: ANIMATION_MODE_SUBTLE,
            skipScale: true,
            firstPlacement: true,
            onComplete,
        };
    }

    _storeDeferredEntrance(window, windowActor, targetRect, easeParams) {
        const id = window.get_id();
        const previous = this._pendingEntranceEases.get(id);
        if (previous) this._disconnectDeferredEntranceRetry(previous);

        const pending = {
            windowActor,
            targetRect: {...targetRect},
            ...easeParams,
        };
        this._pendingEntranceEases.set(id, pending);
        this._armDeferredEntranceRetry(window, pending);
        if (windowActor) this._animatingWindows.set(id, windowActor);
        this._animatingTargets.set(id, targetRect);
        const live = window.get_frame_rect();
        Logger.log(`[ANIM] Deferring first placement ${id}: mapped=${windowActor?.mapped ?? false}, live=${live.width}x${live.height}@${live.x},${live.y}, target=${targetRect.width}x${targetRect.height}@${targetRect.x},${targetRect.y}`);
    }

    _armDeferredEntranceRetry(window, pending) {
        const actor = pending.windowActor;
        if (!actor || actor.is_destroyed() || pending.allocationSignalId) return;

        // MetaWindow::size-changed fires as soon as the logical frame reaches the configure
        // target, but Wayland clients can still be presenting the previous buffer for another
        // compositor frame. Clutter updates the window actor allocation when that buffer catches
        // up, which is the presentation-level event the entrance gate actually depends on.
        pending.allocationSignalId = actor.connect('notify::allocation', () => {
            if (this._pendingEntranceEases.get(window.get_id()) !== pending) return;
            this.runDeferredEntrance(window);
        });
    }

    _disconnectDeferredEntranceRetry(pending) {
        if (!pending?.allocationSignalId || !pending.windowActor) return;
        try {
            pending.windowActor.disconnect(pending.allocationSignalId);
        } catch (_e) {
            // Actor may already have been disposed with the window.
        }
        pending.allocationSignalId = 0;
    }

    _clearDeferredEntrance(windowId) {
        const pending = this._pendingEntranceEases.get(windowId);
        if (!pending) return null;
        this._disconnectDeferredEntranceRetry(pending);
        this._pendingEntranceEases.delete(windowId);
        return pending;
    }

    // Redundant retile to the same destination already in flight (e.g. the
    // window-open queue re-evaluates the same window ~100ms later). Restarting
    // the ease would cut the original transition off before its EASE_OUT_BACK
    // overshoot plays, replacing a full bounce with an imperceptible one.
    _isRedundantRetile(window, targetRect) {
        const lastTarget = this._animatingTargets.get(window.get_id());
        return this._animatingWindows.has(window.get_id()) && lastTarget &&
            lastTarget.x === targetRect.x && lastTarget.y === targetRect.y &&
            lastTarget.width === targetRect.width && lastTarget.height === targetRect.height;
    }

    // Bounce is reserved for a window joining or leaving the workspace. Everything
    // else (miniaturize, swap, monitor change, exclusion, smart resize, edge snap)
    // keeps the same membership and stays subtle.
    _pickAnimationMode({ mode, subtle, firstPlacement }) {
        if (mode !== null) return mode;

        const isMembershipChange = firstPlacement || this._membershipChangeBounce;
        if (subtle || this._justEndedDrag || !isMembershipChange) return ANIMATION_MODE_SUBTLE;
        return ANIMATION_MODE;
    }

    _computeInitialTransform({ currentFrame, currentTx, currentTy, currentScaleX, currentScaleY, targetRect, slideInOffset, firstPlacement = false }) {
        // idle  (currentTx=0): initialTx = frameX - targetX
        // moving (currentTx!=0): initialTx = (frameX + currentTx) - targetX  (no jump)
        // First placement has no prior visual position worth preserving, so start
        // from the slide-in offset instead of the "no jump" continuity math.
        const initialTx = slideInOffset ? slideInOffset.x : currentFrame.x + currentTx - targetRect.x;
        const initialTy = slideInOffset ? slideInOffset.y : currentFrame.y + currentTy - targetRect.y;

        // Existing windows need visual-size continuity when a resize ease is redirected.
        // A first placement has no previous Mosaic presentation to preserve: its raw spawn
        // size is merely client startup geometry. Reusing that size as an entrance scale can
        // expose a freshly admitted large window at >1x after its target frame has committed,
        // covering siblings/miniatures that the same layout pass already moved aside.
        const initialScaleX = firstPlacement
            ? 1
            : (targetRect.width > 0 ? (currentFrame.width * currentScaleX) / targetRect.width : 1);
        const initialScaleY = firstPlacement
            ? 1
            : (targetRect.height > 0 ? (currentFrame.height * currentScaleY) / targetRect.height : 1);

        return { initialTx, initialTy, initialScaleX, initialScaleY };
    }

    // Runs the actual translation/scale ease. Called either immediately from
    // animateWindow (actor already mapped) or later via runDeferredEntrance,
    // once windowHandler.js confirms the actor is mapped.
    _runEntranceEase(window, windowActor, { effectiveDuration, animationMode, skipScale, firstPlacement, onComplete }) {
        // Position keeps its own bounce; scale and opacity run as separate eases so
        // they can use a different curve. EASE_OUT_BACK overshoots past its target
        // and clamps there, so bundled into the same ease as translation it finishes
        // (and visually settles) well before the bouncy slide-in does. A resize that
        // overshoots reads as a glitch, and a fade that overshoots reads as already
        // finished while the window is still visibly sliding.
        if (!skipScale) {
            windowActor.ease({
                scale_x: 1,
                scale_y: 1,
                duration: effectiveDuration,
                mode: ANIMATION_MODE_SUBTLE,
                onStopped: (isFinished) => {
                    if (!isFinished) return;
                    if (windowActor && !windowActor.is_destroyed())
                        windowActor.set_scale(1, 1);
                }
            });
        }

        // The map-time opacity=0 was only ever a placeholder until this real pass
        // knew where to slide in from. Needed even with no offset (e.g. the very
        // first window in an empty workspace), otherwise it never finishes fading in.
        if (firstPlacement) {
            windowActor.ease({
                opacity: 255,
                duration: effectiveDuration,
                mode: ANIMATION_MODE_SUBTLE,
                onStopped: (isFinished) => {
                    if (!isFinished) return;
                    if (windowActor && !windowActor.is_destroyed())
                        windowActor.opacity = 255;
                }
            });
        }

        windowActor.ease({
            translation_x: 0,
            translation_y: 0,
            duration: effectiveDuration,
            mode: animationMode,
            onStopped: (isFinished) => {
                if (!isFinished) return; // redirect in progress; new animation owns cleanup
                if (windowActor && !windowActor.is_destroyed())
                    windowActor.set_translation(0, 0, 0);
                if (firstPlacement) WindowState.remove(window, 'pendingFirstPlacement');
                this._animatingWindows.delete(window.get_id());
                this._animatingTargets.delete(window.get_id());
                this._checkAllAnimationsComplete();
                WindowState.set(window, 'isMosaicResizing', false);
                if (onComplete) onComplete();
            }
        });
    }

    // Called from windowHandler.js's onWindowCreated once the actor is confirmed
    // mapped, safe to ease now that Clutter will no longer skip the transition outright.
    runDeferredEntrance(window) {
        const pending = this._pendingEntranceEases.get(window.get_id());
        if (!pending) return false;
        const {windowActor: storedActor, targetRect, ...easeParams} = pending;
        const windowActor = storedActor ?? window.get_compositor_private();
        if (!windowActor || windowActor.is_destroyed()) {
            if (windowActor?.is_destroyed()) {
                this._clearDeferredEntrance(window.get_id());
                this.removeAnimatingWindow(window.get_id());
            }
            return false;
        }
        if (!storedActor) {
            pending.windowActor = windowActor;
            this._animatingWindows.set(window.get_id(), windowActor);
            this._armDeferredEntranceRetry(window, pending);
        }
        if (!windowActor.mapped || !this._firstPlacementPresentationReady(window, windowActor, targetRect))
            return false;

        this._clearDeferredEntrance(window.get_id());
        this._animatingWindows.set(window.get_id(), windowActor);
        const committedBuffer = window.get_buffer_rect();
        Logger.log(`[ANIM] First placement presentation committed for ${window.get_id()}: actor=${windowActor.width}x${windowActor.height}@${windowActor.x},${windowActor.y} buffer=${committedBuffer.width}x${committedBuffer.height}@${committedBuffer.x},${committedBuffer.y}; releasing entrance`);
        this._runEntranceEase(window, windowActor, easeParams);
        return true;
    }

    _firstPlacementPresentationReady(window, actor, targetRect) {
        if (!targetRect) return true;
        if (!this._rectMatches(window.get_frame_rect(), targetRect)) return false;

        // The logical frame can lead the compositor presentation by one or more frames on
        // Wayland. A fresh Firefox window is the common case: frame_rect already reports the
        // resized target while MetaWindowActor still owns the old near-fullscreen allocation.
        // Releasing opacity in that interval paints the stale buffer over siblings even though
        // the solver's final rectangles do not overlap. Buffer rect is the actor's untransformed
        // presentation bounds, so allocation equality is the correct visibility commit point.
        if (!actor || !actor.has_allocation()) return false;
        const buffer = window.get_buffer_rect();
        return this._rectMatches({
            x: actor.x,
            y: actor.y,
            width: actor.width,
            height: actor.height,
        }, buffer);
    }

    _rectMatches(actual, target) {
        const epsilon = constants.ANIMATION_DIFF_THRESHOLD;
        return ['x', 'y', 'width', 'height'].every(key =>
            Math.abs(actual[key] - target[key]) <= epsilon);
    }

    // onWindowAdded and onWindowCreated race independently (no guaranteed order), and
    // both can claim a window's entrance. If onWindowCreated already started or queued
    // the real ease, onWindowAdded must not reset opacity back to 0 behind its back.
    // That's a direct, non-eased property write, which stomps the fade mid-flight and
    // reads as a visible blink once the ease's own next frame overwrites it again.
    hasActiveOrPendingEntrance(window) {
        const id = window.get_id();
        return this._pendingEntranceEases.has(id) || this._animatingWindows.has(id);
    }

    animateReTiling(windowLayouts, draggedWindow = null, miniLayouts = []) {
        // A new window pushes siblings to make room; bounce those too, not just the entrant.
        const passHasEntrant = windowLayouts.some(({ window }) => WindowState.get(window, 'pendingFirstPlacement')) ||
            miniLayouts.some(({ window }) => WindowState.get(window, 'pendingFirstPlacement'));
        const previousMembershipChangeBounce = this._membershipChangeBounce;
        if (passHasEntrant) this._membershipChangeBounce = true;

        try {
            this._animateReTilingPass(windowLayouts, draggedWindow, miniLayouts);
        } finally {
            this._membershipChangeBounce = previousMembershipChangeBounce;
        }
    }

    _animateReTilingPass(windowLayouts, draggedWindow, miniLayouts) {
        for (const { window, rect } of windowLayouts) {
            // Cleared by animateWindow once this placement actually finishes (not
            // here), since a single window-open burst can recurse through several
            // tileWorkspaceWindows passes, and each one needs to still see this
            // as a first placement, not just whichever pass happens to run first.
            const isFirstPlacement = WindowState.get(window, 'pendingFirstPlacement');

            const currentRect = window.get_frame_rect();

            const needsMove = Math.abs(currentRect.x - rect.x) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.y - rect.y) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.width - rect.width) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.height - rect.height) > constants.ANIMATION_DIFF_THRESHOLD;

            // A first placement still needs to run through animateWindow even when
            // the raw spawn position happens to already match the target, since it
            // owns clearing the opacity=0 onWindowAdded left it at and the slide-in offset.
            if (!needsMove && !isFirstPlacement) {
                window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
                continue;
            }

            // Include pending miniature siblings too: they're real neighbors for
            // direction purposes even though they're excluded from windowLayouts
            // (createMiniature owns their own animation, not this loop).
            const slideInOffset = isFirstPlacement
                ? this._computeSlideInOffset(window, rect, windowLayouts.concat(miniLayouts))
                : null;

            this.animateWindow(window, rect, { draggedWindow, firstPlacement: isFirstPlacement, slideInOffset });
        }
    }

    // Derives the slide-in push direction from the real final layout instead of
    // guessing from wherever Mutter happened to drop the window before tiling.
    // That raw position is arbitrary and can coincidentally land dead-center on
    // the existing window(s), silently producing a zero offset (no animation at all).
    //
    // TODO: always picks some direction once there's at least one sibling, even
    // when the window ends up boxed in by neighbors on every side with no clear
    // side to slide from. By the time this runs, windowHandler.js's _hasSiblings
    // has already decided to suppress Mutter's native animation (skipNextEffect),
    // so there's no going back to it here even if we detected the enclosure.
    _computeSlideInOffset(window, targetRect, windowLayouts) {
        const OFFSET = constants.SLIDE_IN_OFFSET_PX;
        const siblings = windowLayouts.filter(l => l.window.get_id() !== window.get_id());

        if (siblings.length === 0) {
            // Nothing to push against, so fall back to a workspace-switch cue, if any.
            const ws = window.get_workspace();
            const prevWSIndex = WindowState.get(window, 'previousWorkspace');
            if (ws && prevWSIndex !== undefined && prevWSIndex !== ws.index())
                return { x: (prevWSIndex < ws.index() ? -1 : 1) * OFFSET * 3, y: 0 };
            return null;
        }

        let centerX = 0, centerY = 0;
        for (const { rect } of siblings) {
            centerX += rect.x + rect.width / 2;
            centerY += rect.y + rect.height / 2;
        }
        centerX /= siblings.length;
        centerY /= siblings.length;

        const winCenterX = targetRect.x + targetRect.width / 2;
        const winCenterY = targetRect.y + targetRect.height / 2;
        const deltaX = winCenterX - centerX;
        const deltaY = winCenterY - centerY;

        return Math.abs(deltaX) >= Math.abs(deltaY)
            ? { x: deltaX < 0 ? -OFFSET : OFFSET, y: 0 }
            : { x: 0, y: deltaY < 0 ? -OFFSET : OFFSET };
    }

    // Where an in-flight ease is driving the window, so size-changed can tell the
    // ease's own move_resize_frame apart from a client committing a different size.
    getAnimatingTarget(windowId) {
        return this._animatingTargets.get(windowId) || null;
    }

    removeAnimatingWindow(windowId) {
        this._animatingTargets.delete(windowId);
        if (this._animatingWindows.delete(windowId)) {
            this._checkAllAnimationsComplete();
        }
    }

    // A role transition (dominant/miniature/fullscreen handoff) supersedes ordinary Mosaic
    // relayout/entrance animation ownership. Merely dropping bookkeeping is not enough: a
    // running Clutter ease would keep mutating translation/scale after the role solver has
    // committed a new presentation. Claim the actor synchronously so the role transaction
    // starts from the MetaWindow's live frame with no stale ordinary transform layered on it.
    claimWindowForRoleTransition(window) {
        if (!window) return;
        const id = window.get_id();

        // Remove the pending record before cancelling actor transitions: remove_all_transitions
        // fires old onStopped(false) callbacks synchronously, and those callbacks must not be
        // able to resurrect a deferred entrance that this role transaction just superseded.
        this._clearDeferredEntrance(id);

        const actor = window.get_compositor_private();
        if (actor && !actor.is_destroyed()) {
            actor.remove_all_transitions();
            // Miniature presentation is the role state, not an ordinary tiling transform.
            // Cancelling a stale Mosaic ease may settle it to the current miniature target,
            // but must never expand the actor back to 1:1 before the role transaction has a
            // chance to animate it through MiniatureManager's normal pipeline.
            if (!WindowState.get(window, WindowState.IS_MINIATURE)) {
                actor.set_pivot_point(0, 0);
                actor.set_scale(1, 1);
                actor.set_translation(0, 0, 0);
            }
            actor.opacity = 255;
        }

        WindowState.remove(window, 'pendingFirstPlacement');
        WindowState.set(window, 'isMosaicResizing', false);
        this._animatingTargets.delete(id);
        if (this._animatingWindows.delete(id))
            this._checkAllAnimationsComplete();
    }

    // Drops any entrance ease still pending map before the window was excluded
    // from tiling, so it can't fire later and clobber the snap-to-visible reset.
    cancelPendingEntrance(window) {
        const id = window.get_id();
        this._clearDeferredEntrance(id);
        this.removeAnimatingWindow(id);
    }

    // No ease here means no onStopped to clear the flag, so give Mutter a
    // moment to actually fire size-changed before we drop it.
    _clearMosaicResizingSoon(window) {
        this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
            WindowState.set(window, 'isMosaicResizing', false);
            return GLib.SOURCE_REMOVE;
        }, 'animations_clearMosaicResizing');
    }

    cleanup() {
        for (const pending of this._pendingEntranceEases.values())
            this._disconnectDeferredEntranceRetry(pending);
        this._pendingEntranceEases.clear();
        this._animatingWindows.clear();
        this._animatingTargets.clear();
        this._checkAllAnimationsComplete();
        this._isDragging = false;
    }

    destroy() {
        this.cleanup();
    }
});
