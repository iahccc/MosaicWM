// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Workspace tile-lock ledger.
//
// A tile pass takes a reference-counted workspace lock and hands it back once move_resize's
// signals have settled. Two things used to go wrong with that, and both are ledger problems
// rather than call-site problems:
//
//   1. The unlock was registered only at the very end of the pass, so anything that threw
//      earlier left the lock at depth 1 forever. resizeHandler reads that as "transaction
//      busy" and silently stops reconciling the workspace.
//   2. "Release everything" reclaimed locks that other, still-settling passes owned, cutting
//      their protection short.
//
// So: the ledger entry is created when the lock is *taken*, not when the unlock is scheduled.
// Every entry owns exactly one depth and can be released exactly once, whoever gets there
// first -- the pass's own release, the deferred unlock, the fallback timer, or the exception
// net. An entry also arms a fallback timer, so a lock held by a caller that never reaches any
// release path at all still comes back.
export class TileLockLedger {
    constructor(registry = null, onChange = null) {
        this._registry = registry;
        this._onChange = onChange;
        this._depths = new WeakMap();
        this._entries = new Set();
    }

    setTimeoutRegistry(registry) {
        this._registry = registry;
    }

    // Acquires the lock and registers its ledger entry before returning, so the entry exists
    // from the instant the lock does. Returns the token, or null when there is no workspace.
    acquire(workspace, fallbackDelayMs = 0, fallbackName = 'tileLockFallback') {
        if (!workspace) return null;

        const depth = (this._depths.get(workspace) ?? 0) + 1;
        this._depths.set(workspace, depth);

        const token = {workspace, released: false, registryId: null, fallbackId: null};
        this._entries.add(token);
        if (fallbackDelayMs > 0 && this._registry) {
            token.fallbackId = this._registry.add(fallbackDelayMs, () => {
                token.fallbackId = null;
                this._release(token, 'fallback');
                return false;
            }, fallbackName);
        }

        this._changed(`LOCKED depth=${depth}`, workspace);
        return token;
    }

    // Hands the lock back once. A token whose unlock was already deferred keeps that delay:
    // the delay exists to cover move_resize's asynchronous settle, and a pass reaching its own
    // finally says nothing about whether those frames have stabilized yet.
    release(token) {
        if (token?.registryId) return false;
        return this._release(token, 'release');
    }

    // Raw decrement for a caller that holds a workspace but no token. It cannot retire a ledger
    // entry, because it cannot know which one owns the depth it is giving back; prefer release().
    releaseWorkspace(workspace) {
        if (!workspace) return;
        const depth = (this._depths.get(workspace) ?? 0) - 1;
        if (depth <= 0) {
            this._depths.delete(workspace);
            this._changed('UNLOCKED (raw)', workspace);
        } else {
            this._depths.set(workspace, depth);
            this._changed(`unlock depth=${depth} still locked (raw)`, workspace);
        }
    }

    // Converts a token into a delayed unlock. The entry already exists, so this only decides
    // *when* the lock comes back, never *whether*.
    defer(token, delayMs, name) {
        if (!token || token.released) return;
        if (!this._registry) {
            this._release(token, `${name}:no-registry`);
            return;
        }

        if (token.registryId) this._registry.remove(token.registryId);
        token.registryId = this._registry.add(delayMs, () => {
            token.registryId = null;
            this._release(token, name);
            return false;
        }, name);
    }

    // Exception net. With a token, reclaims only that pass's lock; without one, every entry,
    // for callers that cannot say which pass died.
    releaseAll(token = null) {
        const targets = token ? [token] : [...this._entries];
        for (const entry of targets) this._release(entry, 'exception-net');
    }

    isLocked(workspace) {
        if (!workspace) return false;
        return (this._depths.get(workspace) ?? 0) > 0;
    }

    depthOf(workspace) {
        return this._depths.get(workspace) ?? 0;
    }

    get pendingCount() {
        return this._entries.size;
    }

    // Drops every entry without decrementing: teardown discards the whole depth map, so the
    // counter has nothing left to give back.
    clear() {
        for (const entry of this._entries) {
            if (entry.registryId) this._registry?.remove(entry.registryId);
            if (entry.fallbackId) this._registry?.remove(entry.fallbackId);
            entry.released = true;
            entry.registryId = null;
            entry.fallbackId = null;
        }
        this._entries.clear();
        this._depths = new WeakMap();
    }

    _release(token, via) {
        if (!token || token.released) return false;
        token.released = true;
        this._entries.delete(token);
        if (token.registryId) {
            this._registry?.remove(token.registryId);
            token.registryId = null;
        }
        if (token.fallbackId) {
            this._registry?.remove(token.fallbackId);
            token.fallbackId = null;
        }

        const depth = (this._depths.get(token.workspace) ?? 0) - 1;
        if (depth <= 0) {
            this._depths.delete(token.workspace);
            this._changed(`UNLOCKED (${via})`, token.workspace);
        } else {
            this._depths.set(token.workspace, depth);
            this._changed(`unlock depth=${depth} still locked (${via})`, token.workspace);
        }
        return true;
    }

    _changed(message, workspace) {
        if (this._onChange) this._onChange(workspace, message);
    }
}
