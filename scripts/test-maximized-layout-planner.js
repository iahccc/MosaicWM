#!/usr/bin/env node
import assert from 'node:assert/strict';
import {planMaximizedLayout} from '../extension/maximizedLayoutPlanner.js';
import {MINIATURE_TARGET_SIZE_PX, FIT_SCALE_SEARCH_TOLERANCE_PX} from '../extension/constants.js';

const gap = 8;
const area = {x: 40, y: 30, width: 1200, height: 800};
const item = (id, maximized = false) => ({id, maximized,
    minimum: {width: 240, height: 180}, sourceSize: {width: 900, height: 600},
    miniatureSize: {width: MINIATURE_TARGET_SIZE_PX, height: 85}});
// An injected rectangular-grid packer gives the planner an independent fit oracle.
function pack(items, bounds, dryRun) {
    const cols = Math.floor((bounds.width + gap) / (128 + gap));
    const rows = Math.floor((bounds.height + gap) / (85 + gap));
    const fits = cols > 0 && rows > 0 && cols * rows >= items.length;
    const slots = new Map();
    if (fits && !dryRun) items.forEach((it, i) => slots.set(it.id, {
        x: bounds.x + i % cols * (128 + gap), y: bounds.y + Math.floor(i / cols) * (85 + gap),
        width: it.width, height: it.height}));
    return {fits, slots};
}
const max = item(1, true);
const plan = (items, focusId = 1, options = {}) => planMaximizedLayout({items, focusId,
    workArea: area, spacing: gap, pack, ...options});
function validate(result) {
    assert(result);
    const rects = [result.rect, ...result.placements.map(p => p.rect)];
    for (const r of rects) {
        assert(r.x >= area.x && r.y >= area.y);
        assert(r.x + r.width <= area.x + area.width);
        assert(r.y + r.height <= area.y + area.height);
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        assert(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x ||
            a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y,
        'placements must have spacing and must not overlap');
    }
}
assert.equal(MINIATURE_TARGET_SIZE_PX, 128);
assert.deepEqual(plan([max], 1, {outerGap: 0}).rect, area);
const secondMax = item(2, true);
assert.equal(plan([secondMax, max]).windowId, 1, 'actual focus wins over MRU');
assert.equal(plan([secondMax, max], null).windowId, 2, 'MRU is the fallback');
assert.equal(plan([max, item(2)], 2), null, 'ordinary focus yields to the ordinary allocator');
assert.equal(plan([{...max, minimum: {width: 2000, height: 180}}]), null);
assert.equal(plan([max, item(2)], 1, {workArea: {...area, width: 250, height: 190}}), null,
    'failure to fit must be handed to overflow handling');
for (const count of [1, 2, 5, 12, 25]) {
    const peers = Array.from({length: count}, (_, i) => item(i + 2));
    const input = [max, ...peers];
    const snapshot = JSON.stringify(input);
    const result = plan(input);
    validate(result);
    assert.equal(JSON.stringify(input), snapshot, 'planning must be pure');
    assert(result.rect.width >= max.minimum.width && result.rect.height >= max.minimum.height);
    assert(result.placements.every(p => p.kind === 'mini' && p.rect.width === 128));
    // Exhaustive integer-thickness search bounds the area's error by the normal search tolerance.
    const width = area.width - 2 * gap, height = area.height - 2 * gap;
    let optimum = 0;
    for (let thickness = 1; thickness < Math.max(width, height); thickness++) {
        if (width - thickness - gap >= max.minimum.width &&
            pack(peers, {width: thickness, height}, true).fits)
            optimum = Math.max(optimum, (width - thickness - gap) * height);
        if (height - thickness - gap >= max.minimum.height &&
            pack(peers, {width, height: thickness}, true).fits)
            optimum = Math.max(optimum, width * (height - thickness - gap));
    }
    assert(optimum - result.rect.width * result.rect.height <=
        (FIT_SCALE_SEARCH_TOLERANCE_PX + 1) * Math.max(width, height));
    const repeated = plan(input, 1, {previousSide: result.side});
    assert.equal(repeated.side, result.side, 'equal-area choices preserve their side');
}
console.log('[MAXIMIZED PLANNER TEST] PASS: focus, bounds, minimums, 128px peers and maximum feasible area');
