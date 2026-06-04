#!/usr/bin/env node
import assert from 'node:assert/strict';
import {assignWindowHints, HINT_KEYS} from '../extension/navigationHints.js';

const item = (id, x, y, width = 100, height = 100) => ({id, rect: {x, y, width, height}});
const anchor = item(0, 400, 400);
const cross = [anchor, item(1, 100, 400), item(2, 700, 400), item(3, 400, 100), item(4, 400, 700)];
const ids = hints => [...hints].map(([key, candidate]) => [key, candidate.id]);
const hints = assignWindowHints(cross, 0);
assert.equal(hints.get('h').id, 1);
assert.equal(hints.get('l').id, 2);
assert.equal(hints.get('k').id, 3);
assert.equal(hints.get('j').id, 4);
assert.equal(hints.get('u').id, 0);
assert.deepEqual(ids(assignWindowHints([...cross].reverse(), 0)), ids(hints), 'Mapping must not depend on MRU/input order');
const occupiedDirections = assignWindowHints(cross, 0, HINT_KEYS.replace(/[hj]/g, ''));
assert(![...occupiedDirections.keys()].some(key => /[hj]/.test(key)),
    'System shortcuts must take priority over directional letters too');
assert.equal(occupiedDirections.get('l').id, 2);
assert.equal(occupiedDirections.get('k').id, 3);
assert([...occupiedDirections.values()].some(candidate => candidate.id === 1) &&
    [...occupiedDirections.values()].some(candidate => candidate.id === 4),
    'Windows with occupied direction letters must remain reachable using free letters');
const allDirectionsReserved = assignWindowHints(cross, 0, HINT_KEYS.replace(/[hjkl]/g, ''));
assert.equal(allDirectionsReserved.size, cross.length,
    'Every window must remain reachable even when all four direction letters are occupied');
assert([...allDirectionsReserved.keys()].every(key => !/[hjkl]/.test(key)),
    'No directional letter may override an existing shortcut');

// Coincident frames have no directional neighbor, exposing the fallback order alone.
const stacked = Array.from({length: 8}, (_, id) => item(id, 400, 400));
const rightHand = ['u', 'i', 'o', 'n', 'm', 'p', 'y'];
assert.deepEqual([...assignWindowHints(stacked.slice(0, 7), 0).keys()], rightHand,
    'Right-hand letters must be used before any left-hand letter');
assert.deepEqual([...assignWindowHints(stacked, 0).keys()], [...rightHand, 'a'],
    'Left-hand fallback must follow all seven right-hand letters');
const available = 'ionpyasdfgqwertzxcvb';
const reserved = assignWindowHints(stacked, 0, available);
assert(![...reserved.keys()].some(key => /[um]/.test(key)),
    'Letters reserved by existing shortcuts must not appear in hints');
assert.equal(reserved.get('i').id, 0, 'The first available right-hand letter must take priority');
const binaryHints = assignWindowHints(stacked, 0, 'ui');
assert.equal(binaryHints.size, stacked.length, 'A reduced alphabet must still reach every window');
assert([...binaryHints.keys()].every(key => /^[ui]{3}$/.test(key)),
    'A reduced alphabet must use unambiguous sequences');

const diagonal = assignWindowHints([anchor, item(1, 300, 50)], 0);
assert.equal(diagonal.get('k').id, 1, 'A mostly vertical diagonal belongs to K before H');
assert(!diagonal.has('h'), 'A window must not receive two directional hints');
const rightOnly = assignWindowHints([anchor, item(1, 700, 400)], 0);
assert(!rightOnly.has('h') && !rightOnly.has('k') && !rightOnly.has('j'), 'Missing directions stay reserved');
const near = item(5, 550, 410), far = item(6, 900, 400);
assert.equal(assignWindowHints([anchor, near, far], 0).get('l').id, 5,
    'Alignment conflict resolution must preserve the existing nearest-neighbor ranking');
const otherMonitor = item(7, -1200, 400);
assert.equal(assignWindowHints([anchor, otherMonitor], 0).get('h').id, 7, 'Monitor coordinates may be negative');

for (const count of [0, 1, 7, 8, 22, 23, 26, 60, 500]) {
    const items = Array.from({length: count}, (_, id) => item(id, id % 25 * 120, Math.floor(id / 25) * 120));
    const before = JSON.stringify(items);
    const result = assignWindowHints(items, 0);
    assert.equal(result.size, count, 'Every window must be reachable');
    assert.equal(new Set([...result.values()].map(candidate => candidate.id)).size, count);
    const keys = [...result.keys()];
    for (const key of keys) {
        assert.match(key, /^[a-z]+$/);
        assert(!keys.some(other => key !== other && other.startsWith(key)), 'Hint sequences must be prefix-free');
    }
    assert.equal(JSON.stringify(items), before, 'Assignment must not mutate the layout');
    assert.deepEqual(ids(assignWindowHints([...items].reverse(), 0)), ids(result));
}
console.log('[NAVIGATION HINT TEST] PASS: H/L/K/J priority, right-hand fallback, diagonal conflicts, nearest neighbors, stable mapping, monitor coordinates and prefix-free overflow');
