#!/usr/bin/env node
import assert from 'node:assert/strict';
import {allocate} from '../extension/sizeAllocator.js';
import {MINIATURE_TARGET_SIZE_PX} from '../extension/constants.js';
const floor = MINIATURE_TARGET_SIZE_PX;
const participant = (id, extra = {}) => ({id, mode: 'window', fixed: false,
    capAtThreshold: false, mruRank: id, current: {width: 900, height: 600},
    preferred: {width: 900, height: 600}, min: {width: 450, height: 300},
    threshold: {width: 600, height: 400}, aspectRef: {width: 900, height: 600},
    floor: {width: floor, height: Math.round(floor * 2 / 3)}, ...extra});
const sizesFit = limit => sizes => sizes.reduce((sum, s) => sum + s.width, 0) <= limit;
const peers = [participant(1, {mode: 'thumbnail'}), participant(2, {mode: 'thumbnail'})];
const tight = allocate({participants: peers, fits: sizesFit(2 * floor)});
assert(tight.fits);
assert([...tight.entries.values()].every(e => e.mode === 'thumbnail' && e.size.width === floor));
const medium = allocate({participants: peers, fits: sizesFit(700)});
assert(medium.fits);
assert([...medium.entries.values()].some(e => e.size.width > floor), 'ordinary thumbnails stay dynamic');
const nativeMini = participant(0, {mode: 'thumbnail', allowRestore: false});
const ample = allocate({participants: [nativeMini], fits: () => true});
assert.equal(ample.entries.get(0).mode, 'thumbnail', 'native maximize cannot auto-restore through normal allocation');
const normal = participant(1, {capAtThreshold: true});
const selected = allocate({participants: [nativeMini, normal], fits: sizesFit(730)});
assert(selected.fits);
assert.equal(selected.entries.get(1).mode, 'window');
assert.equal(selected.entries.get(0).mode, 'thumbnail');
console.log('[SIZE ALLOCATOR TEST] PASS: shared 128px floor, dynamic sizing and native role protection');
