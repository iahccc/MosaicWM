// SPDX-License-Identifier: GPL-2.0-or-later
// Pure Node regression for MosaicModel scope ownership.

import {MosaicModel} from '../extension/mosaicModel.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const workspaceA = {index: () => 0};
const workspaceB = {index: () => 1};
let workspace = workspaceA;
let monitor = 0;

const window = {
    get_id: () => 1,
    get_workspace: () => workspace,
    get_monitor: () => monitor,
    get_frame_rect: () => ({x: 0, y: 0, width: 1, height: 1}),
};

MosaicModel.commitNormalSlot(window,
    {x: 10, y: 20, width: 300, height: 200}, workspaceA, 0);
assert(MosaicModel.normalSlotFor(window)?.x === 10,
    'Committed slot must be readable inside its workspace/monitor scope');

workspace = workspaceB;
assert(MosaicModel.normalSlotFor(window) === null,
    'A normal slot must not leak across workspace moves');
assert(MosaicModel.presentationSlotFor(window) === null,
    'A presentation slot must not leak across workspace moves');

MosaicModel.commitNormalSlot(window,
    {x: 30, y: 40, width: 300, height: 200}, workspaceB, 0);
assert(MosaicModel.normalSlotFor(window)?.x === 30,
    'The destination workspace must own its newly committed slot');

monitor = 1;
assert(MosaicModel.normalSlotFor(window) === null,
    'A normal slot must not leak across monitor moves');
assert(MosaicModel.presentationSlotFor(window) === null,
    'A presentation slot must not leak across monitor moves');

console.log('[MOSAIC MODEL TEST] PASS: layout slots are workspace/monitor-local');
