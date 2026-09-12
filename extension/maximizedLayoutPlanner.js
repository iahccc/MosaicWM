// SPDX-License-Identifier: GPL-2.0-or-later
import {miniatureSizeForSource, solveMaximizedRail} from './mosaicLayoutSolver.js';

// Input order is native MRU. Native mode and miniature presentation are independent.
// Planning never changes windows, focus, or the last committed layout.
export function planMaximizedLayout({items, focusId, restoreId = null, workArea,
    spacing, standardSize = 256, targetSize = standardSize, previousSide = null,
    outerGap = spacing, passive = false}) {
    const candidates = items.filter(item => item.maximized);
    candidates.sort((a, b) => Number(b.id === focusId) - Number(a.id === focusId));
    const options = {workArea, spacing, outerGap, standardSize, targetSize, previousSide};
    for (const candidate of candidates) {
        const result = tryCandidate(candidate, items, focusId, restoreId, passive, options);
        if (result) return result;
    }
    return null;
}

function tryCandidate(candidate, items, focusId, restoreId, passive, options) {
    const normals = new Set(items.filter(item => !item.maximized &&
        (!item.miniature || item.id === restoreId || item.id === focusId)).map(item => item.id));
    const maximizedMinimum = focusedPriorityMinimum(candidate, items, focusId, options);
    while (true) {
        const result = solveCandidate(candidate, items, normals, options, maximizedMinimum);
        if (result) return result;
        // Only deliberate focus on a maximized window may sacrifice normal peers.
        if (passive || focusId !== candidate.id) return null;
        const victim = [...items].reverse().find(item => normals.has(item.id));
        if (!victim) return null;
        normals.delete(victim.id);
    }
}

function focusedPriorityMinimum(candidate, items, focusId, options) {
    if (candidate.id !== focusId) return candidate.minimum;
    // Role feasibility is always defined by the standard rail. Compact 128px presentation
    // may enlarge the visible maximized rect, but it must never become a stricter minimum
    // than the canonical 256px plan could satisfy on the next solve.
    const canonicalOptions = {...options, targetSize: options.standardSize};
    const priority = solveCandidate(candidate, items, new Set(), canonicalOptions, candidate.minimum);
    if (!priority) return candidate.minimum;
    return {
        width: Math.max(candidate.minimum.width, priority.rect.width),
        height: Math.max(candidate.minimum.height, priority.rect.height),
    };
}

function solveCandidate(candidate, items, normals, options, maximizedMinimum = candidate.minimum) {
    const siblings = items.filter(item => item !== candidate);
    const sizeFor = (item, target) => normals.has(item.id)
        ? item.normalSize : miniatureSizeForSource(item.sourceSize, target);
    const canonicalItems = siblings.map(item => ({id: item.id, ...sizeFor(item, options.standardSize)}));
    const actualItems = siblings.map(item => ({id: item.id, ...sizeFor(item, options.targetSize)}));
    const solution = solveMaximizedRail({...options, canonicalItems, actualItems,
        maximizedMinimum});
    if (!solution) return null;
    return {windowId: candidate.id, rect: solution.maximizedRect,
        side: solution.side, placements: siblings.map(item => ({
            id: item.id, kind: normals.has(item.id) ? 'normal' : 'mini',
            rect: solution.slots.get(item.id), sourceSize: item.sourceSize,
        }))};
}
