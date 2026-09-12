// SPDX-License-Identifier: GPL-2.0-or-later
import * as constants from './constants.js';
import {searchSmallestFit} from './sizeAllocator.js';

// The current mosaic packer owns peer placement. Search the four possible main rectangles
// at its usual pixel tolerance, reserving only the thinnest strip that actually fits.
const SIDES = ['bottom', 'left', 'right', 'top'];
const horizontalSide = side => side === 'top' || side === 'bottom';

function stripRect(area, side, thickness) {
    if (horizontalSide(side)) return {x: area.x,
        y: side === 'top' ? area.y : area.y + area.height - thickness,
        width: area.width, height: thickness};
    return {x: side === 'left' ? area.x : area.x + area.width - thickness,
        y: area.y, width: thickness, height: area.height};
}

function mainRect(area, side, thickness, spacing) {
    if (horizontalSide(side)) return {
        x: area.x, y: side === 'top' ? area.y + thickness + spacing : area.y,
        width: area.width, height: area.height - thickness - spacing};
    return {x: side === 'left' ? area.x + thickness + spacing : area.x, y: area.y,
        width: area.width - thickness - spacing, height: area.height};
}

function candidateFor(area, selected, sizes, side, spacing, pack) {
    const axis = horizontalSide(side) ? 'height' : 'width';
    const available = area[axis] - selected.minimum[axis] - spacing;
    if (available <= 0) return null;
    const strip = t => stripRect(area, side, Math.ceil(t * available));
    const scale = searchSmallestFit(t => pack(sizes, strip(t), true).fits,
        constants.FIT_SCALE_SEARCH_TOLERANCE_PX / available, null);
    if (scale === null) return null;
    return {side, strip: strip(scale),
        rect: mainRect(area, side, Math.ceil(scale * available), spacing)};
}

function chooseCandidate(candidates, peers, sizes, pack, previousSide, windowId) {
    candidates.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height ||
        Number(b.side === previousSide) - Number(a.side === previousSide) ||
        SIDES.indexOf(a.side) - SIDES.indexOf(b.side));
    for (const candidate of candidates) {
        const result = pack(sizes, candidate.strip, false);
        if (!result.fits) continue;
        return {windowId, rect: candidate.rect, side: candidate.side,
            placements: peers.map(item => ({id: item.id, kind: 'mini',
                rect: result.slots.get(item.id), sourceSize: item.sourceSize}))};
    }
    return null;
}

function selectMain(items, focusId) {
    const focused = items.find(item => item.maximized && item.id === focusId);
    return focused ?? ((focusId === null || focusId === undefined)
        ? items.find(item => item.maximized) : null);
}

export function planMaximizedLayout({items, focusId, workArea, spacing,
    outerGap = spacing, previousSide = null, pack}) {
    const selected = selectMain(items, focusId);
    if (!selected || !workArea || typeof pack !== 'function') return null;
    const area = {x: workArea.x + outerGap, y: workArea.y + outerGap,
        width: workArea.width - 2 * outerGap, height: workArea.height - 2 * outerGap};
    if (area.width < selected.minimum.width || area.height < selected.minimum.height) return null;
    const peers = items.filter(item => item !== selected);
    if (!peers.length) return {windowId: selected.id, rect: area, side: null, placements: []};
    const sizes = peers.map(item => ({id: item.id, ...item.miniatureSize}));
    const candidates = SIDES.map(side => candidateFor(area, selected, sizes, side, spacing, pack))
        .filter(Boolean);
    return chooseCandidate(candidates, peers, sizes, pack, previousSide, selected.id);
}
