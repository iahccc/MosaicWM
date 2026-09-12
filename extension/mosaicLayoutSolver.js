// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

export const MiniatureLayoutProfile = Object.freeze({
    NORMAL: 'normal',
    DOMINANT_FOCUSED: 'dominant-focused',
});

export const RailSide = Object.freeze({
    TOP: 'top',
    RIGHT: 'right',
    BOTTOM: 'bottom',
    LEFT: 'left',
});

const SIDE_ORDER = [RailSide.BOTTOM, RailSide.RIGHT, RailSide.LEFT, RailSide.TOP];
const SIDE_CONFIG = Object.freeze({
    [RailSide.TOP]: { horizontal: true, atStart: true },
    [RailSide.RIGHT]: { horizontal: false, atStart: false },
    [RailSide.BOTTOM]: { horizontal: true, atStart: false },
    [RailSide.LEFT]: { horizontal: false, atStart: true },
});
const EPSILON = 0.001;

export function miniatureTargetSize(profile, defaultSize) {
    const divisor = profile === MiniatureLayoutProfile.DOMINANT_FOCUSED ? 2 : 1;
    return Math.max(1, Math.round(defaultSize / divisor));
}

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
 *   miniatureItems: Array<{id: number|string, width: number, height: number}>,
 *   spacing: number,
 *   outerGap?: number,
 *   previousSide?: string|null,
 *   contentEvaluator?: ((contentRect: {x: number, y: number, width: number, height: number}, side: string|null) => ({valid: boolean, payload?: *, score?: number, bounds?: {x:number,y:number,width:number,height:number}}|boolean))|null,
 * }} options
 */
export function solveMiniatureRail({
    workArea,
    miniatureItems,
    spacing,
    outerGap = spacing,
    previousSide = null,
    requiredSide = null,
    contentEvaluator = null,
}) {
    if (!isUsableRect(workArea)) return null;
    const layoutArea = insetRect(workArea, outerGap);
    if (!isUsableRect(layoutArea)) return null;
    const sides = requiredSide ? [requiredSide] : SIDE_ORDER;
    const candidates = miniatureItems?.length
        ? sides.map(side => buildMiniatureCandidate(
            side, miniatureItems, layoutArea, spacing, contentEvaluator)).filter(Boolean)
        : [buildEmptyMiniatureCandidate(layoutArea, contentEvaluator)].filter(Boolean);
    return chooseBestCandidate(candidates, previousSide);
}

/**
 * @param {{
 *   workArea: {x: number, y: number, width: number, height: number},
 *   canonicalItems: Array<{id: number|string, width: number, height: number}>,
 *   actualItems: Array<{id: number|string, width: number, height: number}>,
 *   spacing: number,
 *   outerGap?: number,
 *   dominantMinimum: {width: number, height: number},
 *   previousSide?: string|null,
 * }} options
 */
export function solveDominantRail({
    workArea,
    canonicalItems,
    actualItems,
    spacing,
    outerGap = spacing,
    dominantMinimum,
    previousSide = null,
    requiredSide = null,
}) {
    if (!isUsableRect(workArea)) return null;
    const layoutArea = insetRect(workArea, outerGap);
    if (!isUsableRect(layoutArea)) return null;
    if (!canonicalItems?.length)
        return buildDominantOnlyCandidate(layoutArea, dominantMinimum);

    const sides = requiredSide ? [requiredSide] : SIDE_ORDER;
    const candidates = sides.map(side => buildDominantCandidate(
        side, canonicalItems, actualItems, layoutArea, spacing, dominantMinimum)).filter(Boolean);
    return chooseBestCandidate(candidates, previousSide);
}

function buildEmptyMiniatureCandidate(workArea, evaluator) {
    const evaluation = evaluateContent(evaluator, workArea, null);
    if (!evaluation.valid) return null;
    return {
        side: null,
        railThickness: 0,
        slots: new Map(),
        contentRect: cloneRect(workArea),
        payload: evaluation.payload,
        score: evaluation.score ?? rectArea(workArea),
    };
}

function buildMiniatureCandidate(side, items, workArea, spacing, evaluator) {
    const packed = packRail(items, workArea, side, spacing);
    if (!packed) return null;
    const contentRect = subtractRail(workArea, side, packed.thickness, spacing);
    if (!isUsableRect(contentRect)) return null;

    const evaluation = evaluateContent(evaluator, contentRect, side);
    if (!evaluation.valid) return null;
    const cluster = centerContentRailCluster(
        workArea, side, evaluation.bounds, packed.slots, spacing);
    return {
        side,
        railThickness: packed.thickness,
        slots: cluster.slots,
        contentRect,
        payload: evaluation.payload,
        contentOffset: cluster.contentOffset,
        clusterBounds: cluster.bounds,
        score: evaluation.score ?? rectArea(contentRect),
    };
}

function buildDominantOnlyCandidate(workArea, minimum) {
    if (!rectMeetsMinimum(workArea, minimum)) return null;
    return {
        side: null,
        railThickness: 0,
        slots: new Map(),
        dominantRect: cloneRect(workArea),
        score: rectArea(workArea),
    };
}

function buildDominantCandidate(side, canonicalItems, actualItems, workArea, spacing, minimum) {
    const canonical = packRail(canonicalItems, workArea, side, spacing);
    if (!canonical) return null;

    const actual = packRail(actualItems, workArea, side, spacing, canonical.thickness);
    if (!actual) return null;
    // Canonical geometry decides whether the current roles are allowed to coexist. Presentation
    // may consume less rail space (focused-dominant miniatures are half-size), but it may never
    // require more than that canonical budget. Using the actual thickness below lets compact
    // presentation enlarge dominantRect without making focus alter role feasibility.
    const dominantRect = subtractRail(workArea, side, actual.thickness, spacing);
    if (!rectMeetsMinimum(dominantRect, minimum)) return null;
    return {
        side,
        railThickness: actual.thickness,
        slots: actual.slots,
        dominantRect,
        score: rectArea(dominantRect),
    };
}

function evaluateContent(evaluator, contentRect, side) {
    if (!evaluator)
        return { valid: true, payload: null, score: rectArea(contentRect) };
    const result = evaluator(contentRect, side);
    if (typeof result === 'boolean')
        return { valid: result, payload: null, score: rectArea(contentRect) };
    return {
        valid: !!result?.valid,
        payload: result?.payload ?? null,
        score: result?.score,
        bounds: result?.bounds ?? null,
    };
}

function centerContentRailCluster(workArea, side, contentBounds, slots, spacing) {
    if (!contentBounds || !side || !slots?.size)
        return {slots, contentOffset: {x: 0, y: 0}, bounds: contentBounds ?? null};

    const railBounds = boundsOfRects(slots.values());
    if (!railBounds)
        return {slots, contentOffset: {x: 0, y: 0}, bounds: contentBounds};

    const offsets = clusterOffsets(workArea, side, contentBounds, railBounds, spacing);
    return {
        slots: translateSlots(slots, offsets.rail),
        contentOffset: offsets.content,
        bounds: translatedClusterBounds(contentBounds, railBounds, offsets),
    };
}

function clusterOffsets(workArea, side, content, rail, spacing) {
    if (side === RailSide.LEFT || side === RailSide.RIGHT)
        return horizontalClusterOffsets(workArea, side, content, rail, spacing);
    return verticalClusterOffsets(workArea, side, content, rail, spacing);
}

function horizontalClusterOffsets(workArea, side, content, rail, spacing) {
    const clusterWidth = content.width + spacing + rail.width;
    const start = workArea.x + (workArea.width - clusterWidth) / 2;
    const railFirst = side === RailSide.LEFT;
    const desiredContentX = railFirst ? start + rail.width + spacing : start;
    const desiredRailX = railFirst ? start : start + content.width + spacing;
    return {
        content: {x: desiredContentX - content.x, y: 0},
        rail: {x: desiredRailX - rail.x, y: 0},
    };
}

function verticalClusterOffsets(workArea, side, content, rail, spacing) {
    const clusterHeight = content.height + spacing + rail.height;
    const start = workArea.y + (workArea.height - clusterHeight) / 2;
    const railFirst = side === RailSide.TOP;
    const desiredContentY = railFirst ? start + rail.height + spacing : start;
    const desiredRailY = railFirst ? start : start + content.height + spacing;
    return {
        content: {x: 0, y: desiredContentY - content.y},
        rail: {x: 0, y: desiredRailY - rail.y},
    };
}

function translateSlots(slots, offset) {
    const translated = new Map();
    for (const [id, rect] of slots)
        translated.set(id, translateRect(rect, offset));
    return translated;
}

function translatedClusterBounds(content, rail, offsets) {
    return unionRects(
        translateRect(content, offsets.content),
        translateRect(rail, offsets.rail));
}

function boundsOfRects(rects) {
    let bounds = null;
    for (const rect of rects)
        bounds = bounds ? unionRects(bounds, rect) : cloneRect(rect);
    return bounds;
}

function unionRects(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return {x: left, y: top, width: right - left, height: bottom - top};
}

function translateRect(rect, offset) {
    return {
        x: rect.x + (offset?.x ?? 0),
        y: rect.y + (offset?.y ?? 0),
        width: rect.width,
        height: rect.height,
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

function chooseBestCandidate(candidates, previousSide) {
    let best = null;
    for (const candidate of candidates) {
        if (isBetterCandidate(candidate, best, previousSide)) best = candidate;
    }
    return best;
}

function isBetterCandidate(candidate, best, previousSide) {
    if (!best) return true;
    if (candidate.score > best.score + EPSILON) return true;
    if (candidate.score < best.score - EPSILON) return false;

    const candidateStable = candidate.side === previousSide;
    const bestStable = best.side === previousSide;
    if (candidateStable !== bestStable) return candidateStable;
    return SIDE_ORDER.indexOf(candidate.side) < SIDE_ORDER.indexOf(best.side);
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
