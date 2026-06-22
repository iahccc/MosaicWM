// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
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
        this._pendingEntranceEases = new Map(); // Window ID -> ease params, for entrances deferred until the actor is mapped
        this._justEndedDrag = false;
        this._resizingWindowId = null;
        this._timeoutRegistry = null;
        this._isOverviewActive = false;
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
                stale = !actor || actor.is_destroyed() || !actor.get_transition('translation_x');
            } catch (e) {
                // Actor's underlying GObject was fully disposed (e.g. window destroyed
                // mid-animation) rather than merely Clutter-destroyed - any method call
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
        // If ending drag, set flag for smooth drop animation
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
            return false;
        }

        if (draggedWindow && window.get_id() === draggedWindow.get_id()) {
            return false;
        }

        return true;
    }

    animateWindow(window, targetRect, options = {}) {
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

        if (!this.shouldAnimateWindow(window, draggedWindow)) {
            // The overview being visible is a "not yet", not a "never" - this window
            // gets retiled again once it hides (onOverviewHidden's re-enqueue), and that
            // pass deserves a real shot at animating (bounce for a sibling push, slide-in
            // for an entrance). move_resize_frame is a no-op while the overview is still
            // genuinely open anyway (Mutter discards it), so skip it entirely instead of
            // "snapping" to a position that never actually took effect while permanently
            // losing the chance to animate once the next pass sees needsMove as already false.
            if (Main.overview.visible) {
                if (onComplete) onComplete();
                return;
            }

            WindowState.set(window, 'isMosaicResizing', true);
            window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            this._clearMosaicResizingSoon(window);
            if (firstPlacement) {
                WindowState.remove(window, 'pendingFirstPlacement');
                const actor = window.get_compositor_private();
                if (actor) actor.opacity = 255;
            }
            if (onComplete) onComplete();
            return;
        }

        const windowActor = window.get_compositor_private();
        if (!windowActor) {
            Logger.log(`No actor for window ${window.get_id()}, skipping animation`);
            WindowState.set(window, 'isMosaicResizing', true);
            window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            this._clearMosaicResizingSoon(window);
            if (firstPlacement) WindowState.remove(window, 'pendingFirstPlacement');
            if (onComplete) onComplete();
            return;
        }

        // Redundant retile to the same destination already in flight (e.g. the
        // window-open queue re-evaluates the same window ~100ms later) — restarting
        // the ease here would cut the original transition off before its EASE_OUT_BACK
        // overshoot plays, replacing a full bounce with an imperceptible one. Let the
        // existing ease run to completion instead.
        const lastTarget = this._animatingTargets.get(window.get_id());
        if (this._animatingWindows.has(window.get_id()) && lastTarget &&
            lastTarget.x === targetRect.x && lastTarget.y === targetRect.y &&
            lastTarget.width === targetRect.width && lastTarget.height === targetRect.height) {
            if (onComplete) onComplete();
            return;
        }

        // Must read translation/scale BEFORE remove_all_transitions() - they reset after.
        const currentFrame = window.get_frame_rect();
        const currentTx = windowActor.translation_x;
        const currentTy = windowActor.translation_y;
        const currentScaleX = windowActor.scale_x;
        const currentScaleY = windowActor.scale_y;

        // A miniature restore animates scale on this same actor and owns recovery
        // if we cut it off below (see continueScaleUp in miniature.js) - piling our
        // own scale ease on top would fight it for the same property.
        const skipScale = WindowState.get(window, MINIATURE_ANIM_KIND) != null;

        // remove_all_transitions fires old onStopped(isFinished=false);
        // the guard at the ease callback returns early without double cleanup.
        windowActor.remove_all_transitions();

        this._animatingWindows.set(window.get_id(), windowActor);
        this._animatingTargets.set(window.get_id(), targetRect);

        const effectiveDuration = Math.ceil(duration * getSlowDownFactor());

        let animationMode;
        if (mode !== null) {
            animationMode = mode;
        } else if (subtle || this._justEndedDrag) {
            animationMode = ANIMATION_MODE_SUBTLE;
        } else {
            animationMode = ANIMATION_MODE;
        }

        // idle  (currentTx=0): initialTx = frameX - targetX
        // moving (currentTx!=0): initialTx = (frameX + currentTx) - targetX  (no jump)
        // First placement has no prior visual position worth preserving - start
        // from the slide-in offset instead of the "no jump" continuity math.
        const initialTx = slideInOffset ? slideInOffset.x : currentFrame.x + currentTx - targetRect.x;
        const initialTy = slideInOffset ? slideInOffset.y : currentFrame.y + currentTy - targetRect.y;

        // Same "no jump" logic, applied to visual size: preserves the actor's
        // current on-screen size if a previous resize ease is still in flight.
        const initialScaleX = targetRect.width > 0 ? (currentFrame.width * currentScaleX) / targetRect.width : 1;
        const initialScaleY = targetRect.height > 0 ? (currentFrame.height * currentScaleY) / targetRect.height : 1;

        WindowState.set(window, 'isMosaicResizing', true);
        window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        windowActor.set_translation(initialTx, initialTy, 0);
        if (!skipScale) {
            windowActor.set_pivot_point(0, 0);
            windowActor.set_scale(initialScaleX, initialScaleY);
        }

        const easeParams = { effectiveDuration, animationMode, skipScale, firstPlacement, onComplete };

        // Clutter silently skips implicit transitions on actors that aren't mapped yet
        // (should_skip_implicit_transition in clutter-actor.c), snapping straight to the
        // final value instead of animating - and a first placement can run this early,
        // since this pipeline reliably outpaces the actor's own mapping. Defer the actual
        // ease until onWindowCreated (windowHandler.js) confirms the actor is mapped,
        // instead of calling ease() now and getting silently skipped.
        if (firstPlacement && !windowActor.mapped) {
            this._pendingEntranceEases.set(window.get_id(), { windowActor, ...easeParams });
            return;
        }

        this._runEntranceEase(window, windowActor, easeParams);
    }

    // Runs the actual translation/scale ease. Called either immediately from
    // animateWindow (actor already mapped) or later via runDeferredEntrance,
    // once windowHandler.js confirms the actor is mapped.
    _runEntranceEase(window, windowActor, { effectiveDuration, animationMode, skipScale, firstPlacement, onComplete }) {
        // Position keeps its own bounce; scale and opacity run as separate eases so
        // they can use a different curve - EASE_OUT_BACK overshoots past its target
        // and clamps there, so bundled into the same ease as translation it finishes
        // (and visually settles) well before the bouncy slide-in does. A resize that
        // overshoots reads as a glitch, and a fade that overshoots reads as already-
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
        // knew where to slide in from - needed even with no offset (e.g. the very
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
    // mapped - safe to ease now that Clutter will no longer skip the transition outright.
    runDeferredEntrance(window) {
        const pending = this._pendingEntranceEases.get(window.get_id());
        if (!pending) return;
        this._pendingEntranceEases.delete(window.get_id());
        const { windowActor, ...easeParams } = pending;
        if (!windowActor || windowActor.is_destroyed()) return;
        this._runEntranceEase(window, windowActor, easeParams);
    }

    // onWindowAdded and onWindowCreated race independently (no guaranteed order), and
    // both can claim a window's entrance. If onWindowCreated already started or queued
    // the real ease, onWindowAdded must not reset opacity back to 0 behind its back -
    // that's a direct, non-eased property write, which stomps the fade mid-flight and
    // reads as a visible blink once the ease's own next frame overwrites it again.
    hasActiveOrPendingEntrance(window) {
        const id = window.get_id();
        return this._pendingEntranceEases.has(id) || this._animatingWindows.has(id);
    }

    animateReTiling(windowLayouts, draggedWindow = null) {
        for (const { window, rect } of windowLayouts) {
            // Cleared by animateWindow once this placement actually finishes (not
            // here) - a single window-open burst can recurse through several
            // tileWorkspaceWindows passes, and each one needs to still see this
            // as a first placement, not just whichever pass happens to run first.
            const isFirstPlacement = WindowState.get(window, 'pendingFirstPlacement');

            const currentRect = window.get_frame_rect();

            const needsMove = Math.abs(currentRect.x - rect.x) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.y - rect.y) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.width - rect.width) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.height - rect.height) > constants.ANIMATION_DIFF_THRESHOLD;

            // A first placement still needs to run through animateWindow even when
            // the raw spawn position happens to already match the target - it owns
            // clearing the opacity=0 onWindowAdded left it at and the slide-in offset.
            if (!needsMove && !isFirstPlacement) {
                window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
                continue;
            }

            const slideInOffset = isFirstPlacement
                ? this._computeSlideInOffset(window, rect, windowLayouts)
                : null;

            this.animateWindow(window, rect, { draggedWindow, firstPlacement: isFirstPlacement, slideInOffset });
        }
    }

    // Derives the slide-in push direction from the real final layout instead of
    // guessing from wherever Mutter happened to drop the window before tiling -
    // that raw position is arbitrary and can coincidentally land dead-center on
    // the existing window(s), silently producing a zero offset (no animation at all).
    _computeSlideInOffset(window, targetRect, windowLayouts) {
        const OFFSET = constants.SLIDE_IN_OFFSET_PX;
        const siblings = windowLayouts.filter(l => l.window.get_id() !== window.get_id());

        if (siblings.length === 0) {
            // Nothing to push against - fall back to a workspace-switch cue, if any.
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

    removeAnimatingWindow(windowId) {
        this._animatingTargets.delete(windowId);
        if (this._animatingWindows.delete(windowId)) {
            this._checkAllAnimationsComplete();
        }
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
        this._animatingWindows.clear();
        this._animatingTargets.clear();
        this._checkAllAnimationsComplete();
        this._isDragging = false;
    }

    destroy() {
        this.cleanup();
    }
});
