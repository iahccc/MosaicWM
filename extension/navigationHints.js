// Copyright 2026 Mosaic WM contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Pure spatial hint assignment with H/J/K/L direction priority.

export function centerOf(rect) {
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

export function getDirectionalMetrics(direction, fromRect, toRect) {
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

export function compareDirectionalMetrics(a, b) {
    if (a.metrics.overlap !== b.metrics.overlap)
        return a.metrics.overlap ? -1 : 1;
    if (a.metrics.primaryGap !== b.metrics.primaryGap)
        return a.metrics.primaryGap - b.metrics.primaryGap;
    if (a.metrics.secondaryDelta !== b.metrics.secondaryDelta)
        return a.metrics.secondaryDelta - b.metrics.secondaryDelta;
    if (a.metrics.centerDistance !== b.metrics.centerDistance)
        return a.metrics.centerDistance - b.metrics.centerDistance;
    return a.candidate.id - b.candidate.id;
}

export const DIRECTION_HINTS = Object.freeze({left: 'h', right: 'l', up: 'k', down: 'j'});
// Keep the right hand available for selection while the left holds Super.
export const FALLBACK_KEYS = 'uionmpyasdfgqwertzxcvb';
export const HINT_KEYS = Object.values(DIRECTION_HINTS).join('') + FALLBACK_KEYS;

function alignment(direction, from, to) {
    const a = centerOf(from), b = centerOf(to);
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    return direction === 'left' || direction === 'right' ? dy / dx : dx / dy;
}

function assignDirections(items, anchor, hints, used, availableKeys) {
    const directions = Object.entries(DIRECTION_HINTS).filter(([, key]) => availableKeys.includes(key))
        .map(([direction, key]) => ({
            direction, key,
            ranked: items.filter(item => item.id !== anchor.id)
                .map(candidate => ({candidate, metrics: getDirectionalMetrics(direction, anchor.rect, candidate.rect)}))
                .filter(item => item.metrics).sort(compareDirectionalMetrics),
        }));
    // Every direction first proposes its usual nearest neighbor. If two directions want
    // the same diagonal window, the better-aligned direction gets it and the other retries.
    while (directions.length) {
        const proposals = directions.map(entry => ({...entry,
            match: entry.ranked.find(item => !used.has(item.candidate.id))}))
            .filter(entry => entry.match);
        proposals.sort((a, b) =>
            alignment(a.direction, anchor.rect, a.match.candidate.rect) -
            alignment(b.direction, anchor.rect, b.match.candidate.rect) ||
            compareDirectionalMetrics(a.match, b.match));
        const chosen = proposals[0];
        if (!chosen) break;
        hints.set(chosen.key, chosen.match.candidate);
        used.add(chosen.match.candidate.id);
        directions.splice(directions.findIndex(entry => entry.key === chosen.key), 1);
    }
}

function fallbackHint(index, width, keys) {
    let key = '';
    for (let digit = 0; digit < width; digit++) {
        key = keys[index % keys.length] + key;
        index = Math.floor(index / keys.length);
    }
    return key;
}

export function assignWindowHints(items, anchorId, availableKeys = HINT_KEYS) {
    const fallbackKeys = [...FALLBACK_KEYS].filter(key => availableKeys.includes(key)).join('');
    if (fallbackKeys.length < 2) throw new RangeError('At least two fallback hint letters are required');
    const hints = new Map();
    const used = new Set();
    const anchor = items.find(item => item.id === anchorId);
    if (anchor) assignDirections(items, anchor, hints, used, availableKeys);
    const remaining = items.filter(item => !used.has(item.id)).sort((a, b) =>
        Number(a.id !== anchorId) - Number(b.id !== anchorId) ||
        a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id - b.id);
    // Reserve H/J/K/L even when a direction has no neighbor. Fixed-width fallback
    // codes are prefix-free, so large workspaces never make a one-letter choice ambiguous.
    let width = 1;
    while (fallbackKeys.length ** width < remaining.length) width++;
    remaining.forEach((item, index) => hints.set(fallbackHint(index, width, fallbackKeys), item));
    return hints;
}
