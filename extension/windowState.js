// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Centralized window state management using WeakMap

// This avoids polluting native objects with custom properties
const windowStates = new WeakMap();

export function get(window, property) {
    const state = windowStates.get(window);
    return state ? state[property] : undefined;
}

export function set(window, property, value) {
    let state = windowStates.get(window);
    if (!state) {
        state = {};
        windowStates.set(window, state);
    }
    state[property] = value;
}

export function has(window, property) {
    const state = windowStates.get(window);
    return state ? property in state : false;
}

export function remove(window, property) {
    const state = windowStates.get(window);
    if (state) {
        delete state[property];
    }
}

// Delayed cleanup must only clear the state generation it originally created.
// Several geometry bridges intentionally share the same property name, so a timeout from
// an older transition must not erase a newer transition's value just because both happen
// to use `targetRestoredSize`. Object identity is the ownership token here: every producer
// installs a fresh value object and keeps that exact reference for its eventual cleanup.
export function removeIfCurrent(window, property, expectedValue) {
    const state = windowStates.get(window);
    if (!state || state[property] !== expectedValue) return false;
    delete state[property];
    return true;
}

export function getState(window) {
    return windowStates.get(window);
}

export function clear(window) {
    windowStates.delete(window);
}

export const IS_MINIATURE = 'isMiniature';
export const MINIATURE_SCALE = 'miniatureScale';
export const PRE_MINIATURE_SIZE = 'preMiniatureSize';
export const MINIATURE_TARGET_POS = 'miniatureTargetPos';
export const MINIATURE_EXT_LEFT = 'miniatureExtLeft';
export const MINIATURE_EXT_TOP = 'miniatureExtTop';
export const MINIATURE_SCREENSHOT_PAUSE = 'miniatureScreenshotPause';
export const MINIATURE_FULLSCREEN_PAUSE = 'miniatureFullscreenPause';
export const ANIMATING_MINIATURE = 'animatingMiniature';
export const MINIATURE_OVERLAY = 'miniatureOverlay';
export const MINIATURE_ANIM_KIND = 'miniatureAnimKind';
// Set between the layout shrinking a descriptor and createMiniature claiming the window. Anything
// that positions windows has to leave these alone: their descriptor already carries the mini's size,
// so a move_resize_frame would shrink the real frame and the scale would compound on top of it.
export const PENDING_MINIATURE = 'pendingMiniature';
export const MOSAIC_FULLSCREEN = 'mosaicFullscreen';
export const MOSAIC_FULLSCREEN_KIND = 'mosaicFullscreenKind';

export const APPLYING_LAYOUT = 'applyingLayout';
