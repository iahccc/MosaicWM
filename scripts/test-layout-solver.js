#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
    MiniatureLayoutProfile,
    RailSide,
    miniatureSizeForSource,
    miniatureTargetSize,
    solveDominantRail,
    solveMiniatureRail,
} from '../extension/mosaicLayoutSolver.js';

const SPACING = 8;

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

function assertValidSlots(solution, bounds, contentRect = solution.contentRect ?? solution.dominantRect) {
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

function testProfiles() {
    assert.equal(miniatureTargetSize(MiniatureLayoutProfile.NORMAL, 256), 256);
    assert.equal(miniatureTargetSize(MiniatureLayoutProfile.DOMINANT_FOCUSED, 256), 128);

    const source = {width: 1000, height: 500};
    assert.deepEqual(miniatureSizeForSource(source, 256), {width: 256, height: 128});
    assert.deepEqual(miniatureSizeForSource(source, 128), {width: 128, height: 64});
}

function testRailChoosesLargestContentArea() {
    const workArea = {x: 0, y: 0, width: 1000, height: 600};
    const miniatureItems = [
        {id: 1, width: 200, height: 100},
        {id: 2, width: 200, height: 100},
        {id: 3, width: 200, height: 100},
    ];
    const solution = solveMiniatureRail({
        workArea,
        miniatureItems,
        spacing: SPACING,
    });

    assert(solution);
    assert.equal(solution.side, RailSide.BOTTOM,
        'horizontal rail should win when it leaves the largest content area');
    assertValidSlots(solution, workArea);
    for (const slot of solution.slots.values())
        assert(hasOuterGap(slot, workArea, SPACING), 'miniature slots must keep the same gap from the work-area edge');
}

function testPreviousSideOnlyBreaksTies() {
    const workArea = {x: 0, y: 0, width: 500, height: 500};
    const miniatureItems = [{id: 1, width: 100, height: 100}];
    const solution = solveMiniatureRail({
        workArea,
        miniatureItems,
        spacing: SPACING,
        previousSide: RailSide.LEFT,
    });

    assert(solution);
    assert.equal(solution.side, RailSide.LEFT,
        'previous rail side should stabilize an equal-area solution');
    assertValidSlots(solution, workArea);
}

function testContentEvaluatorCanRejectARail() {
    const workArea = {x: 0, y: 0, width: 900, height: 600};
    const miniatureItems = [{id: 1, width: 200, height: 100}];
    const solution = solveMiniatureRail({
        workArea,
        miniatureItems,
        spacing: SPACING,
        contentEvaluator: (_rect, side) => ({valid: side !== RailSide.BOTTOM}),
    });

    assert(solution);
    assert.notEqual(solution.side, RailSide.BOTTOM);
    assertValidSlots(solution, workArea);
}

function testNormalContentAndRailCenterAsCluster() {
    const workArea = {x: 0, y: 0, width: 1280, height: 763};
    const miniatureItems = [{id: 1, width: 256, height: 192}];
    const normalBounds = {x: 108, y: 116, width: 800, height: 600};
    const solution = solveMiniatureRail({
        workArea,
        miniatureItems,
        spacing: SPACING,
        contentEvaluator: (contentRect, side) => ({
            valid: side === RailSide.RIGHT,
            bounds: normalBounds,
            score: area(contentRect),
        }),
    });

    assert(solution);
    assert.equal(solution.side, RailSide.RIGHT);
    const shiftedNormal = {
        ...normalBounds,
        x: normalBounds.x + solution.contentOffset.x,
        y: normalBounds.y + solution.contentOffset.y,
    };
    const rail = solution.slots.get(1);
    assert.equal(rail.x - (shiftedNormal.x + shiftedNormal.width), SPACING,
        'miniature rail must stay directly adjacent to normal content');
    const clusterCenter = solution.clusterBounds.x + solution.clusterBounds.width / 2;
    const workAreaCenter = workArea.x + workArea.width / 2;
    assert.equal(clusterCenter, workAreaCenter,
        'normal content and miniature rail must be centered as one visual cluster');
    assert(!overlaps(shiftedNormal, rail),
        'centered content/rail cluster must remain non-overlapping');
    assert.equal(solution.contentOffset.y, 0,
        'centering a vertical rail cluster must preserve normal layout along the rail axis');
}

function testImpossibleMiniatureRailRejectsInsteadOfIgnoringMinis() {
    const workArea = {x: 0, y: 0, width: 300, height: 200};
    const miniatureItems = [
        {id: 1, width: 400, height: 250},
        {id: 2, width: 400, height: 250},
    ];
    assert.equal(solveMiniatureRail({
        workArea,
        miniatureItems,
        spacing: SPACING,
    }), null, 'an impossible miniature rail must reject instead of returning the full work area');
}

function testFocusedDominantExpandsMainArea() {
    const workArea = {x: 0, y: 0, width: 1280, height: 720};
    const sourceSizes = [
        {width: 800, height: 450},
        {width: 960, height: 540},
        {width: 640, height: 480},
    ];
    const normalTarget = miniatureTargetSize(MiniatureLayoutProfile.NORMAL, 256);
    const compactTarget = miniatureTargetSize(MiniatureLayoutProfile.DOMINANT_FOCUSED, 256);
    const normalItems = sourceSizes.map((source, index) => ({
        id: index + 1,
        ...miniatureSizeForSource(source, normalTarget),
    }));
    const compactItems = sourceSizes.map((source, index) => ({
        id: index + 1,
        ...miniatureSizeForSource(source, compactTarget),
    }));
    const minimum = {width: 320, height: 240};

    const normal = solveDominantRail({
        workArea,
        canonicalItems: normalItems,
        actualItems: normalItems,
        spacing: SPACING,
        dominantMinimum: minimum,
    });
    const compact = solveDominantRail({
        workArea,
        canonicalItems: normalItems,
        actualItems: compactItems,
        spacing: SPACING,
        dominantMinimum: minimum,
        previousSide: normal?.side,
    });

    assert(normal && compact);
    assert(area(compact.dominantRect) > area(normal.dominantRect),
        'focused-dominant compact miniatures must enlarge the dominant area');
    assertValidSlots(normal, workArea, normal.dominantRect);
    assertValidSlots(compact, workArea, compact.dominantRect);
    assert(hasOuterGap(normal.dominantRect, workArea, SPACING),
        'dominant rect must keep the standard outer gap');
    assert(hasOuterGap(compact.dominantRect, workArea, SPACING),
        'focused dominant rect must keep the standard outer gap');
    for (const slot of compact.slots.values())
        assert(hasOuterGap(slot, workArea, SPACING), 'dominant miniatures must keep the standard outer gap');
}

function testDominantOnlyKeepsOuterGap() {
    const workArea = {x: 0, y: 0, width: 1280, height: 720};
    const solution = solveDominantRail({
        workArea,
        canonicalItems: [],
        actualItems: [],
        spacing: SPACING,
        dominantMinimum: {width: 320, height: 240},
    });
    assert(solution);
    assert.deepEqual(solution.dominantRect,
        {x: SPACING, y: SPACING, width: 1280 - SPACING * 2, height: 720 - SPACING * 2},
        'a dominant-only layout must use the same outer gap as inter-window spacing');
}

function testDominantRejectsImpossibleMinimum() {
    const workArea = {x: 0, y: 0, width: 800, height: 600};
    const mini = [{id: 1, width: 256, height: 180}];
    const solution = solveDominantRail({
        workArea,
        canonicalItems: mini,
        actualItems: mini,
        spacing: SPACING,
        dominantMinimum: {width: 790, height: 590},
    });
    assert.equal(solution, null);
}

function main() {
    testProfiles();
    testRailChoosesLargestContentArea();
    testPreviousSideOnlyBreaksTies();
    testContentEvaluatorCanRejectARail();
    testNormalContentAndRailCenterAsCluster();
    testImpossibleMiniatureRailRejectsInsteadOfIgnoringMinis();
    testFocusedDominantExpandsMainArea();
    testDominantOnlyKeepsOuterGap();
    testDominantRejectsImpossibleMinimum();
    console.log('[LAYOUT SOLVER TEST] PASS: unified centered rail cluster, stable ties, compact dominant profile, bounds and overlap invariants');
}

main();
