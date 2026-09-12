// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

export const RailSide = Object.freeze({
    TOP: 'top',
    RIGHT: 'right',
    BOTTOM: 'bottom',
    LEFT: 'left',
});

const MAXIMIZED_SIDE_ORDER = [RailSide.BOTTOM, RailSide.LEFT, RailSide.RIGHT, RailSide.TOP];
const SIDE_CONFIG = Object.freeze({
    [RailSide.TOP]: { horizontal: true, atStart: true },
    [RailSide.RIGHT]: { horizontal: false, atStart: false },
    [RailSide.BOTTOM]: { horizontal: true, atStart: false },
    [RailSide.LEFT]: { horizontal: false, atStart: true },
});
const EPSILON = 0.001;

export function miniatureSizeForSource(sourceSize, targetLongEdge) {
    const width = Math.max(1, sourceSize?.width ?? 1);
    const height = Math.max(1, sourceSize?.height ?? 1);
    const scale = Math.min(1, Math.max(1, targetLongEdge) / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

/**
 * @param {{
 *   workArea: {x: number, y: number, width: number, height: number},
 *   canonicalItems: Array<{id: number|string, width: number, height: number}>,
 *   actualItems: Array<{id: number|string, width: number, height: number}>,
 *   spacing: number,
 *   outerGap?: number,
 *   maximizedMinimum: {width: number, height: number},
 *   previousSide?: string|null,
 * }} options
 */
export function solveMaximizedRail({
    workArea,
    canonicalItems,
    actualItems,
    spacing,
    outerGap = spacing,
    maximizedMinimum,
    previousSide = null,
}) {
    if (!isUsableRect(workArea)) return null;
    const layoutArea = insetRect(workArea, outerGap);
    if (!isUsableRect(layoutArea)) return null;
    if (!canonicalItems?.length)
        return buildMaximizedOnlyCandidate(layoutArea, maximizedMinimum);

    const candidates = MAXIMIZED_SIDE_ORDER.map(side => buildMaximizedCandidate(
        side, canonicalItems, actualItems, layoutArea, spacing, maximizedMinimum)).filter(Boolean);
    return chooseBestCandidate(candidates, previousSide, MAXIMIZED_SIDE_ORDER);
}

function buildMaximizedOnlyCandidate(workArea, minimum) {
    if (!rectMeetsMinimum(workArea, minimum)) return null;
    return {
        side: null,
        railThickness: 0,
        slots: new Map(),
        maximizedRect: cloneRect(workArea),
        score: rectArea(workArea),
    };
}

function buildMaximizedCandidate(side, canonicalItems, actualItems, workArea, spacing, minimum) {
    const canonical = packRail(canonicalItems, workArea, side, spacing);
    if (!canonical || !rectMeetsMinimum(
        subtractRail(workArea, side, canonical.thickness, spacing), minimum)) return null;

    const actual = packRail(actualItems, workArea, side, spacing, canonical.thickness);
    if (!actual) return null;
    // Canonical geometry decides whether the current roles are allowed to coexist. Presentation
    // may consume less rail space (focused-maximized miniatures are half-size), but it may never
    // require more than that canonical budget. Using the actual thickness below lets compact
    // presentation enlarge maximizedRect without making focus alter role feasibility.
    const maximizedRect = subtractRail(workArea, side, actual.thickness, spacing);
    if (!rectMeetsMinimum(maximizedRect, minimum)) return null;
    return {
        side,
        railThickness: actual.thickness,
        slots: actual.slots,
        maximizedRect,
        score: rectArea(maximizedRect),
    };
}

function packRail(items, workArea, side, spacing, maxThickness = null) {
    const config = SIDE_CONFIG[side];
    if (!config) return null;
    const span = config.horizontal ? workArea.width : workArea.height;
    const layers = buildLayers(items, span, spacing, config.horizontal);
    if (!layers) return null;

    const thickness = totalLayerThickness(layers, spacing);
    const available = config.horizontal ? workArea.height : workArea.width;
    if (!thicknessFits(thickness, available, maxThickness)) return null;

    const railThickness = maxThickness ?? thickness;
    return {
        thickness,
        slots: placeLayers(layers, workArea, side, railThickness, spacing),
    };
}

function buildLayers(items, span, spacing, horizontal) {
    const layers = [];
    let layer = newLayer();
    for (const item of items) {
        const dimensions = itemDimensions(item, horizontal);
        if (!dimensionsFit(dimensions, span)) return null;
        if (needsNewLayer(layer, dimensions.along, span, spacing)) {
            layers.push(layer);
            layer = newLayer();
        }
        appendToLayer(layer, item, dimensions, spacing);
    }
    if (layer.items.length > 0) layers.push(layer);
    return layers;
}

function itemDimensions(item, horizontal) {
    return horizontal
        ? { along: item.width, across: item.height }
        : { along: item.height, across: item.width };
}

function dimensionsFit(dimensions, span) {
    return dimensions.along > 0 && dimensions.across > 0 && dimensions.along <= span + EPSILON;
}

function needsNewLayer(layer, along, span, spacing) {
    if (layer.items.length === 0) return false;
    return layer.extent + spacing + along > span + EPSILON;
}

function appendToLayer(layer, item, dimensions, spacing) {
    const gap = layer.items.length > 0 ? spacing : 0;
    layer.items.push(item);
    layer.extent += gap + dimensions.along;
    layer.thickness = Math.max(layer.thickness, dimensions.across);
}

function newLayer() {
    return { items: [], extent: 0, thickness: 0 };
}

function totalLayerThickness(layers, spacing) {
    return layers.reduce((sum, layer, index) =>
        sum + layer.thickness + (index > 0 ? spacing : 0), 0);
}

function thicknessFits(thickness, available, maximum) {
    if (thickness > available + EPSILON) return false;
    return maximum === null || thickness <= maximum + EPSILON;
}

function placeLayers(layers, workArea, side, railThickness, spacing) {
    const config = SIDE_CONFIG[side];
    return config.horizontal
        ? placeHorizontalLayers(layers, workArea, config.atStart, railThickness, spacing)
        : placeVerticalLayers(layers, workArea, config.atStart, railThickness, spacing);
}

function placeHorizontalLayers(layers, workArea, atStart, railThickness, spacing) {
    const slots = new Map();
    let inward = 0;
    for (const layer of layers) {
        const layerY = atStart
            ? workArea.y + inward
            : workArea.y + workArea.height - inward - layer.thickness;
        let x = workArea.x + Math.max(0, (workArea.width - layer.extent) / 2);
        for (const item of layer.items) {
            const y = atStart ? layerY : layerY + layer.thickness - item.height;
            slots.set(item.id, { x, y, width: item.width, height: item.height });
            x += item.width + spacing;
        }
        inward += layer.thickness + spacing;
    }
    return clampSlotsToRail(slots, workArea, true, atStart, railThickness);
}

function placeVerticalLayers(layers, workArea, atStart, railThickness, spacing) {
    const slots = new Map();
    let inward = 0;
    for (const layer of layers) {
        const layerX = atStart
            ? workArea.x + inward
            : workArea.x + workArea.width - inward - layer.thickness;
        let y = workArea.y + Math.max(0, (workArea.height - layer.extent) / 2);
        for (const item of layer.items) {
            const x = atStart ? layerX : layerX + layer.thickness - item.width;
            slots.set(item.id, { x, y, width: item.width, height: item.height });
            y += item.height + spacing;
        }
        inward += layer.thickness + spacing;
    }
    return clampSlotsToRail(slots, workArea, false, atStart, railThickness);
}

function clampSlotsToRail(slots, workArea, horizontal, atStart, thickness) {
    const rail = railRect(workArea, horizontal, atStart, thickness);
    for (const slot of slots.values()) {
        slot.x = Math.min(Math.max(slot.x, rail.x), rail.x + rail.width - slot.width);
        slot.y = Math.min(Math.max(slot.y, rail.y), rail.y + rail.height - slot.height);
    }
    return slots;
}

function railRect(workArea, horizontal, atStart, thickness) {
    if (horizontal) {
        const y = atStart ? workArea.y : workArea.y + workArea.height - thickness;
        return { x: workArea.x, y, width: workArea.width, height: thickness };
    }
    const x = atStart ? workArea.x : workArea.x + workArea.width - thickness;
    return { x, y: workArea.y, width: thickness, height: workArea.height };
}

function subtractRail(workArea, side, thickness, spacing) {
    const config = SIDE_CONFIG[side];
    const reserved = thickness + spacing;
    if (config.horizontal)
        return subtractHorizontalRail(workArea, config.atStart, reserved);
    return subtractVerticalRail(workArea, config.atStart, reserved);
}

function subtractHorizontalRail(workArea, atStart, reserved) {
    return {
        x: workArea.x,
        y: atStart ? workArea.y + reserved : workArea.y,
        width: workArea.width,
        height: workArea.height - reserved,
    };
}

function subtractVerticalRail(workArea, atStart, reserved) {
    return {
        x: atStart ? workArea.x + reserved : workArea.x,
        y: workArea.y,
        width: workArea.width - reserved,
        height: workArea.height,
    };
}

function chooseBestCandidate(candidates, previousSide, sideOrder) {
    let best = null;
    for (const candidate of candidates) {
        if (isBetterCandidate(candidate, best, previousSide, sideOrder)) best = candidate;
    }
    return best;
}

function isBetterCandidate(candidate, best, previousSide, sideOrder) {
    if (!best) return true;
    if (candidate.score > best.score + EPSILON) return true;
    if (candidate.score < best.score - EPSILON) return false;

    const candidateStable = candidate.side === previousSide;
    const bestStable = best.side === previousSide;
    if (candidateStable !== bestStable) return candidateStable;
    return sideOrder.indexOf(candidate.side) < sideOrder.indexOf(best.side);
}

function rectMeetsMinimum(rect, minimum) {
    if (!isUsableRect(rect)) return false;
    if (!minimum) return true;
    return rect.width + EPSILON >= minimum.width && rect.height + EPSILON >= minimum.height;
}

function isUsableRect(rect) {
    return !!rect && rect.width > 0 && rect.height > 0;
}

function rectArea(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function cloneRect(rect) {
    return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    };
}

function insetRect(rect, gap) {
    const inset = Math.max(0, gap ?? 0);
    return {
        x: rect.x + inset,
        y: rect.y + inset,
        width: rect.width - inset * 2,
        height: rect.height - inset * 2,
    };
}
