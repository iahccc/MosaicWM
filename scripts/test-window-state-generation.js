#!/usr/bin/env node

import assert from 'node:assert/strict';

import * as WindowState from '../extension/windowState.js';

const window = {};
const first = {width: 640, height: 480};
const second = {width: 800, height: 600};

WindowState.set(window, 'targetRestoredSize', first);
assert.equal(WindowState.removeIfCurrent(window, 'targetRestoredSize', second), false,
    'A cleanup token must not remove a different generation');
assert.equal(WindowState.get(window, 'targetRestoredSize'), first,
    'Rejected cleanup must preserve the current generation');

WindowState.set(window, 'targetRestoredSize', second);
assert.equal(WindowState.removeIfCurrent(window, 'targetRestoredSize', first), false,
    'An older cleanup must not erase a newer restore bridge');
assert.equal(WindowState.get(window, 'targetRestoredSize'), second,
    'The newer restore bridge must remain owned by its producer');

assert.equal(WindowState.removeIfCurrent(window, 'targetRestoredSize', second), true,
    'The owning cleanup token must remove its own generation');
assert.equal(WindowState.get(window, 'targetRestoredSize'), undefined,
    'Owned cleanup must clear the bridge');

console.log('[WINDOW STATE TEST] PASS: delayed cleanup is generation-safe');
