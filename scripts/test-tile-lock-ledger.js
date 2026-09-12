#!/usr/bin/env node
// Ledger-level regression for the tile-lock exception net. Pure bookkeeping: no Clutter, no
// Mutter, no gnome-shell, so it runs under plain gjs (or node) in any environment.
//
//   gjs -m scripts/test-tile-lock-ledger.js
//
// The integration-level behaviour (real windows, real passes) lives in the headless
// regressions driven by scripts/test-headless.sh.
import {TileLockLedger} from '../extension/tileLockLedger.js';

function assert(condition, message) {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

const workspace = {index: () => 3};

// A stand-in for TimeoutRegistry: records the callback so a test can fire a timer by hand.
function makeRegistry() {
    const timers = new Map();
    let nextId = 1;
    return {
        timers,
        add(delay, callback, name) {
            const id = nextId++;
            timers.set(id, {delay, callback, name});
            return id;
        },
        remove(id) {
            timers.delete(id);
        },
        fire(name) {
            const match = [...timers.entries()].find(([, t]) => t.name === name);
            assert(match, `no pending timer named ${name}`);
            timers.delete(match[0]);
            match[1].callback();
        },
    };
}

function makeLedger() {
    const registry = makeRegistry();
    return {ledger: new TileLockLedger(registry), registry};
}

// 1. Registration happens at acquire time, not at the deferred unlock: a pass that dies in
//    between still has something to reclaim.
{
    const {ledger, registry} = makeLedger();
    const token = ledger.acquire(workspace, 400);
    assert(ledger.depthOf(workspace) === 1, 'acquire takes the lock');
    assert(ledger.pendingCount === 1, 'entry is registered immediately');
    assert(token.fallbackId, 'fallback is armed');

    ledger.release(token); // the pass's finally, on a throw before any schedule
    assert(ledger.depthOf(workspace) === 0, 'a throw before the deferred unlock still frees the lock');
    assert(ledger.pendingCount === 0, 'ledger is drained');
    assert(registry.timers.size === 0, 'no timer survives the release');
    assert(ledger.isLocked(workspace) === false, 'resizeHandler no longer reads it as busy');
}

// 2. One pass's failure must not reclaim another pass's settle delay.
{
    const {ledger, registry} = makeLedger();
    const settling = ledger.acquire(workspace, 400);
    ledger.defer(settling, 350, 'unlockWorkspace');
    const failing = ledger.acquire(workspace, 400);
    assert(ledger.depthOf(workspace) === 2, 'both passes hold the lock');

    ledger.releaseAll(failing);
    assert(ledger.depthOf(workspace) === 1, 'only the failing pass is reclaimed');
    assert(settling.released === false, 'the settling pass keeps its delay');
    assert(ledger.isLocked(workspace) === true, 'settle protection is intact');

    registry.fire('unlockWorkspace');
    assert(ledger.depthOf(workspace) === 0, 'the deferred unlock still fires');
    assert(ledger.pendingCount === 0, 'no entry leaks');
}

// 3. The pass's finally must not collapse a deferred delay, and a repeated release is a no-op.
{
    const {ledger, registry} = makeLedger();
    const token = ledger.acquire(workspace, 400);
    ledger.defer(token, 350, 'unlockWorkspace');
    assert(registry.timers.size === 2, 'fallback + deferred unlock');

    ledger.release(token);
    assert(token.released === false, 'a deferred token is left to its timer');
    assert(ledger.depthOf(workspace) === 1, 'the delay is preserved, not collapsed');
    assert(registry.timers.size === 2, 'finally did not touch the deferred timer');

    registry.fire('unlockWorkspace');
    assert(ledger.depthOf(workspace) === 0, 'timer retires the entry');
    ledger.release(token);
    assert(ledger.depthOf(workspace) === 0, 'a later release cannot double-decrement');
}

// 4. The fallback rescues a lock that no release path ever reaches.
{
    const {ledger, registry} = makeLedger();
    const token = ledger.acquire(workspace, 400);
    registry.fire('tileLockFallback');
    assert(ledger.depthOf(workspace) === 0, 'fallback frees the stranded lock');
    assert(token.released === true, 'entry is retired');
    assert(ledger.pendingCount === 0, 'unreachable entry is dropped');
}

// 5. Nested acquire/release pairs balance, as the per-monitor recursion requires.
{
    const {ledger} = makeLedger();
    const outer = ledger.acquire(workspace, 400);
    for (let m = 0; m < 4; m++) {
        const inner = ledger.acquire(workspace, 400);
        ledger.defer(inner, 350, 'unlockWorkspace');
        ledger.release(inner);
    }
    assert(ledger.depthOf(workspace) === 5, 'outer + four per-monitor locks');
    ledger.releaseAll();
    assert(ledger.depthOf(workspace) === 0, 'global net reclaims every entry');
    assert(outer.released === true, 'outer entry retired');
    assert(ledger.pendingCount === 0, 'no entry left behind');
}

// 6. Teardown drops the ledger without decrementing a map it is discarding.
{
    const {ledger, registry} = makeLedger();
    const token = ledger.acquire(workspace, 400);
    ledger.defer(token, 350, 'unlockWorkspace');
    ledger.clear();
    assert(ledger.pendingCount === 0, 'ledger cleared');
    assert(registry.timers.size === 0, 'pending timers removed');
    assert(ledger.depthOf(workspace) === 0, 'depth map is reset with it');
}

// 7. A null workspace (Mutter before placement) is a no-op, never a throw.
{
    const {ledger} = makeLedger();
    assert(ledger.acquire(null, 400) === null, 'no token without a workspace');
    ledger.release(null);
    ledger.defer(null, 350, 'unlockWorkspace');
    ledger.releaseWorkspace(null);
    assert(ledger.isLocked(null) === false, 'null workspace never reads as locked');
}

// 8. Scoped reclaim: an error path must name the failing pass, because the ledger also holds
//    in-flight passes' entries. Blanket release would end another pass's settle delay, and that
//    pass's own finally would then decrement a depth that is already gone.
{
    const {ledger} = makeLedger();
    const settling = ledger.acquire(workspace, 400);
    ledger.defer(settling, 350, 'unlockWorkspace');
    const inFlight = ledger.acquire(workspace, 400);
    ledger.defer(inFlight, 350, 'unlockWorkspace');

    ledger.release(settling);
    assert(settling.released === false, 'scoped release refuses a deferred token');
    assert(ledger.depthOf(workspace) === 2, 'nothing released while both delays are pending');

    ledger.releaseAll(inFlight);
    assert(ledger.depthOf(workspace) === 1, 'scoped reclaim takes only its own lock');
    assert(settling.released === false, 'the other pass keeps its delay');

    // The settling pass still hands its own lock back when its timer fires.
    const {ledger: solo, registry: soloRegistry} = makeLedger();
    const only = solo.acquire(workspace, 400);
    solo.defer(only, 350, 'unlockWorkspace');
    soloRegistry.fire('unlockWorkspace');
    assert(solo.depthOf(workspace) === 0, 'the deferred unlock retires the entry');
    assert(solo.pendingCount === 0, 'and leaves nothing behind');
}

console.log('LOCK LEDGER TEST PASS: acquire-time registration, per-pass reclaim, deferred delay preserved, fallback, nesting, scoped reclaim, null scope, teardown');
