#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
    RailSide,
    miniatureSizeForSource,
    solveMaximizedRail,
} from '../extension/mosaicLayoutSolver.js';

const SPACING = 8;
const STANDARD_SIZE = 256;
const COMPACT_SIZE = 128;

function area(rect) {
    return rect.width * rect.height;
}

function overlaps(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
}

function within(rect, bounds) {
    return rect.x >= bounds.x && rect.y >= bounds.y &&
        rect.x + rect.width <= bounds.x + bounds.width &&
        rect.y + rect.height <= bounds.y + bounds.height;
}

function hasOuterGap(rect, bounds, gap) {
    return rect.x >= bounds.x + gap && rect.y >= bounds.y + gap &&
        rect.x + rect.width <= bounds.x + bounds.width - gap &&
        rect.y + rect.height <= bounds.y + bounds.height - gap;
}

function assertValidSlots(solution, bounds, contentRect = solution.maximizedRect) {
    const slots = [...solution.slots.values()];
    for (const slot of slots) {
        assert(within(slot, bounds), `slot ${JSON.stringify(slot)} must stay inside work area`);
        assert(!overlaps(slot, contentRect), `slot ${JSON.stringify(slot)} must not overlap content area`);
    }
    for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++)
            assert(!overlaps(slots[i], slots[j]), `miniature slots ${i} and ${j} must not overlap`);
    }
}

function testMiniatureSizing() {
    const source = {width: 1000, height: 500};
    assert.deepEqual(miniatureSizeForSource(source, STANDARD_SIZE), {width: 256, height: 128});
    assert.deepEqual(miniatureSizeForSource(source, COMPACT_SIZE), {width: 128, height: 64});
}

function testMaximizedRailStabilizesEqualAreaTie() {
    const workArea = {x: 0, y: 0, width: 500, height: 500};
    const items = [{id: 1, width: 100, height: 100}];
    const options = {
        workArea,
        canonicalItems: items,
        actualItems: items,
        spacing: SPACING,
        maximizedMinimum: {width: 100, height: 100},
    };

    const natural = solveMaximizedRail(options);
    assert(natural);
    assert.equal(natural.side, RailSide.BOTTOM,
        'a full tie must follow the maximized side order');
    assertValidSlots(natural, workArea);

    const stabilized = solveMaximizedRail({...options, previousSide: RailSide.RIGHT});
    assert(stabilized);
    assert.equal(stabilized.side, RailSide.RIGHT,
        'the previous rail side must stabilize an equal-area solution');
    assertValidSlots(stabilized, workArea);
}

function testFocusedMaximizedExpandsMainArea() {
    const workArea = {x: 0, y: 0, width: 1280, height: 720};
    const sourceSizes = [
        {width: 800, height: 450},
        {width: 960, height: 540},
        {width: 640, height: 480},
    ];
    const normalItems = sourceSizes.map((source, index) => ({
        id: index + 1,
        ...miniatureSizeForSource(source, STANDARD_SIZE),
    }));
    const compactItems = sourceSizes.map((source, index) => ({
        id: index + 1,
        ...miniatureSizeForSource(source, COMPACT_SIZE),
    }));
    const minimum = {width: 320, height: 240};

    const normal = solveMaximizedRail({
        workArea,
        canonicalItems: normalItems,
        actualItems: normalItems,
        spacing: SPACING,
        maximizedMinimum: minimum,
    });
    const compact = solveMaximizedRail({
        workArea,
        canonicalItems: normalItems,
        actualItems: compactItems,
        spacing: SPACING,
        maximizedMinimum: minimum,
        previousSide: normal?.side,
    });

    assert(normal && compact);
    assert(area(compact.maximizedRect) > area(normal.maximizedRect),
        'focused-maximized compact miniatures must enlarge the maximized area');
    assertValidSlots(normal, workArea, normal.maximizedRect);
    assertValidSlots(compact, workArea, compact.maximizedRect);
    assert(hasOuterGap(normal.maximizedRect, workArea, SPACING),
        'maximized rect must keep the standard outer gap');
    assert(hasOuterGap(compact.maximizedRect, workArea, SPACING),
        'focused maximized rect must keep the standard outer gap');
    for (const slot of compact.slots.values())
        assert(hasOuterGap(slot, workArea, SPACING), 'maximized miniatures must keep the standard outer gap');
}

function testActualPresentationCannotExceedCanonicalBudget() {
    const workArea = {x: 0, y: 0, width: 800, height: 600};
    const canonicalItems = [{id: 1, width: 200, height: 100}];
    const actualItems = [{id: 1, width: 300, height: 200}];
    const solution = solveMaximizedRail({
        workArea,
        canonicalItems,
        actualItems,
        spacing: SPACING,
        maximizedMinimum: {width: 300, height: 300},
    });
    assert.equal(solution, null,
        'actual rail items must never require more thickness than the canonical budget');
}

function testMaximizedOnlyKeepsOuterGap() {
    const workArea = {x: 0, y: 0, width: 1280, height: 720};
    const solution = solveMaximizedRail({
        workArea,
        canonicalItems: [],
        actualItems: [],
        spacing: SPACING,
        maximizedMinimum: {width: 320, height: 240},
    });
    assert(solution);
    assert.deepEqual(solution.maximizedRect,
        {x: SPACING, y: SPACING, width: 1280 - SPACING * 2, height: 720 - SPACING * 2},
        'a maximized-only layout must use the same outer gap as inter-window spacing');
}

function testMaximizedRejectsImpossibleMinimum() {
    const workArea = {x: 0, y: 0, width: 800, height: 600};
    const mini = [{id: 1, width: 256, height: 180}];
    const solution = solveMaximizedRail({
        workArea,
        canonicalItems: mini,
        actualItems: mini,
        spacing: SPACING,
        maximizedMinimum: {width: 790, height: 590},
    });
    assert.equal(solution, null);
}

function main() {
    testMiniatureSizing();
    testMaximizedRailStabilizesEqualAreaTie();
    testFocusedMaximizedExpandsMainArea();
    testActualPresentationCannotExceedCanonicalBudget();
    testMaximizedOnlyKeepsOuterGap();
    testMaximizedRejectsImpossibleMinimum();
    console.log('[LAYOUT SOLVER TEST] PASS: miniature sizing, stable ties, compact maximized profile, canonical budget, bounds and overlap invariants');
}

main();
