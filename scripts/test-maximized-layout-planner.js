#!/usr/bin/env node
import assert from 'node:assert/strict';
import {planMaximizedLayout} from '../extension/maximizedLayoutPlanner.js';
import {solveMaximizedRail} from '../extension/mosaicLayoutSolver.js';

const area = {x: 40, y: 30, width: 1200, height: 800};
const item = (id, options = {}) => ({id, maximized: false, miniature: false,
    minimum: {width: 240, height: 180}, normalSize: {width: 450, height: 300},
    sourceSize: {width: 900, height: 600}, ...options});
const max = item(1, {maximized: true});
function plan(items, focusId = 1, options = {}) {
    return planMaximizedLayout({items, focusId, workArea: area, spacing: 16,
        targetSize: 128, ...options});
}
function validate(result, bounds = area) {
    assert(result);
    const rects = [result.rect, ...result.placements.map(p => p.rect)];
    for (const r of rects) {
        assert(r.x >= bounds.x && r.y >= bounds.y);
        assert(r.x + r.width <= bounds.x + bounds.width + 0.01);
        assert(r.y + r.height <= bounds.y + bounds.height + 0.01);
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        assert(a.x + a.width <= b.x || b.x + b.width <= a.x ||
            a.y + a.height <= b.y || b.y + b.height <= a.y, 'windows must not overlap');
    }
}
assert.deepEqual(plan([max], 1, {outerGap: 0}).rect, area);
const peer = item(2);
const before = JSON.stringify([max, peer]);
const coexist = plan([max, peer], 2, {targetSize: 256});
validate(coexist);
assert.equal(coexist.placements[0].kind, 'normal');
assert.equal(JSON.stringify([max, peer]), before, 'planning is pure');
const large = item(3, {normalSize: {width: 1150, height: 730}});
assert.equal(plan([large, max], 3), null, 'normal focus cannot be sacrificed');
const sacrificed = plan([max, large]);
validate(sacrificed);
assert.equal(sacrificed.placements[0].kind, 'mini');
assert.equal(plan([max, large], 1, {passive: true}), null, 'passive restore cannot shrink peers');
const modest = item(6, {normalSize: {width: 400, height: 260}});
const focusedPriority = plan([max, modest], 1, {targetSize: 128});
validate(focusedPriority);
assert.equal(focusedPriority.placements[0].kind, 'mini',
    'focused maximize keeps the all-mini priority region instead of shrinking to preserve a normal peer');
const secondMax = item(4, {maximized: true});
assert.equal(plan([secondMax, max], 1).windowId, 1, 'actual focus wins over MRU');
assert.equal(plan([secondMax, max], null).windowId, 4, 'native MRU is the fallback');
assert.equal(plan([secondMax, max], 1).placements[0].kind, 'mini');
const mini = item(5, {miniature: true});
assert.equal(plan([max, mini]).placements[0].kind, 'mini');
assert.equal(plan([max, mini], 5, {restoreId: 5}).placements[0].kind, 'normal');

// Restoring a normal miniature may reuse the currently displayed maximized region, but it
// must not make that region smaller. The caller folds the committed region into the
// maximized minimum before planning; if every coexistence option would squeeze one axis,
// the maximized window must become a miniature instead of accepting the restore here.
const displayed = plan([max, mini], 1, {targetSize: 256});
const preservedMax = item(1, {maximized: true,
    minimum: {width: displayed.rect.width, height: displayed.rect.height}});
assert.equal(plan([preservedMax, mini], 5, {restoreId: 5, targetSize: 256}), null,
    'normal restore must not squeeze an already constrained maximized region');

for (const targetSize of [128, 256]) {
    const result = plan([max, mini], 1, {targetSize});
    validate(result);
    assert.equal(Math.max(result.placements[0].rect.width, result.placements[0].rect.height), targetSize);
}
// This exact input used to pass at 128px and fail when focus expanded the rail.
const constrained = {workArea: {x: 0, y: 0, width: 1200, height: 800},
    canonicalItems: [{id: 2, width: 256, height: 192}], spacing: 16, outerGap: 16,
    maximizedMinimum: {width: 1100, height: 600}, requiredSide: 'bottom'};
for (const actualItems of [[{id: 2, width: 128, height: 96}], constrained.canonicalItems])
    assert.equal(solveMaximizedRail({...constrained, actualItems}), null);
// Area already excludes an edge tile; all slots must stay inside it.
const remainder = {x: 640, y: 30, width: 600, height: 800};
validate(plan([max, mini], 1, {workArea: remainder}), remainder);
// Focus profiles must agree on feasibility, including multi-layer rails.
for (let count = 1; count < 15; count++) {
    const items = [max, ...Array.from({length: count}, (_, i) => item(i + 10, {miniature: true}))];
    const compact = plan(items, 1, {targetSize: 128});
    const normal = plan(items, 1, {targetSize: 256});
    assert.equal(!!compact, !!normal);
    if (compact) { validate(compact); validate(normal); }
}
console.log('[MAXIMIZED PLANNER TEST] PASS: native MRU, focus, coexistence, restoration, bounds and profile-independent feasibility');
