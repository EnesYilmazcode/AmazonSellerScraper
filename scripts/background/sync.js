/**
 * @fileoverview Cloud sync: drains the IndexedDB outbox into the signed-in
 * user's workspace, one entry at a time.
 *
 * Each entry (one page of a run, or the end of a run) is planned by
 * sync-plan.js, committed, and only then deleted. Entries queued while a
 * flush runs are picked up before it returns. An entry belongs to the
 * account that was signed in when it was queued and is never written into
 * another account's workspace.
 *
 * Every write is idempotent, so an entry that fails halfway is simply
 * written again on the next flush.
 *
 * Authored as ESM and bundled into the service worker by esbuild. The
 * contract test runs this same file in Node against the emulators.
 *
 * @module Sync
 */

import {
  doc,
  getDoc,
  writeBatch,
  Timestamp,
  arrayUnion,
  FieldPath,
} from 'firebase/firestore';
import { planEntry, firstSeenCandidates } from './sync-plan.js';

const FIRESTORE = { doc, getDoc, writeBatch, Timestamp, arrayUnion, FieldPath };

/** Firestore allows 500 writes per batch; stay under it. */
export const BATCH_LIMIT = 450;

/**
 * Errors that mean the account's session is gone, not the network. A
 * permission-denied is the rules refusing a document, not a lost session.
 */
const AUTH_CODES = ['unauthenticated', 'auth/user-token-expired', 'auth/user-disabled', 'auth/invalid-user-token'];

export function isAuthError(err) {
  return !!err && AUTH_CODES.includes(err.code);
}

/**
 * @param {Object} deps
 * @param {Object} deps.db - the Firestore instance
 * @param {function(): Promise<Object>} deps.openStore - resolves to the db.js api
 * @param {Object} [deps.fs] - firebase/firestore functions, for tests
 * @param {function(Object): Promise<void>} [deps.onBatch] - called before each commit, for tests
 */
export function createSync({ db, openStore, fs = FIRESTORE, batchLimit = BATCH_LIMIT, onBatch = null, log = console }) {
  let running = null;
  let again = false;

  const ref = (path) => fs.doc(db, ...path);
  const time = (ms) => fs.Timestamp.fromMillis(ms);
  const union = (vals) => fs.arrayUnion(...vals);
  const field = (f) => (Array.isArray(f) ? new fs.FieldPath(...f) : f);

  /** Entries queued for `uid`, oldest first. */
  async function mine(store, uid) {
    const all = await store.getAll('outbox');
    return all
      .filter((e) => e.uid === uid && (e.kind === 'page' || e.kind === 'run'))
      .sort((a, b) => a.seq - b.seq);
  }

  /** Product documents among `asins` that do not exist yet. */
  async function missingOf(uid, asins) {
    const missing = new Set();
    for (let i = 0; i < asins.length; i += 25) {
      const part = asins.slice(i, i + 25);
      const snaps = await Promise.all(part.map((a) => fs.getDoc(ref(['workspaces', uid, 'products', a]))));
      snaps.forEach((snap, j) => { if (!snap.exists()) missing.add(part[j]); });
    }
    return missing;
  }

  /** Writes one entry. Returns how many writes it took, or null if it had nothing to write. */
  async function commitEntry(store, entry) {
    const run = await store.get('runs', entry.runId);
    if (!run) return null;
    const [products, pages] = await Promise.all([store.runProducts(entry.runId), store.runPages(entry.runId)]);
    const missing = await missingOf(entry.uid, firstSeenCandidates(entry, products));
    let writes;
    try {
      writes = planEntry({ entry, run, products, pages, missing, time, union });
    } catch (err) {
      // Planning is pure, so a retry would fail the same way and hold up the queue.
      log.warn('[ProScan] Dropped an outbox entry that cannot be written:', err.message);
      return null;
    }

    for (let i = 0; i < writes.length; i += batchLimit) {
      const batch = fs.writeBatch(db);
      for (const w of writes.slice(i, i + batchLimit)) {
        if (w.fields) batch.set(ref(w.path), w.data, { mergeFields: w.fields.map(field) });
        else batch.set(ref(w.path), w.data);
      }
      if (onBatch) await onBatch({ entry, writes: Math.min(batchLimit, writes.length - i) });
      await batch.commit();
    }
    return { writes: writes.length, products: products.filter((p) => (p.placements || []).some((pl) => pl.page === entry.pageIndex)).length };
  }

  async function drain(uid) {
    const store = await openStore();
    const totals = { entries: 0, pages: 0, runs: 0, products: 0, writes: 0 };
    const runs = new Set();
    // New entries can arrive while we write; keep going until none are left.
    for (let round = 0; round < 1000; round++) {
      const entries = await mine(store, uid);
      if (entries.length === 0) break;
      for (const entry of entries) {
        const done = await commitEntry(store, entry);
        await store.write([{ store: 'outbox', delete: entry.seq }]);
        totals.entries++;
        if (!done) continue;
        runs.add(entry.runId);
        totals.writes += done.writes;
        if (entry.kind === 'page') {
          totals.pages++;
          totals.products += done.products;
        }
      }
    }
    totals.runs = runs.size;
    return totals;
  }

  /**
   * Writes everything queued for `uid`. One flush at a time; a call during
   * a flush makes it look again once more before it resolves.
   *
   * @param {string} uid
   * @returns {Promise<{entries:number, pages:number, runs:number, products:number, writes:number}>}
   */
  function flush(uid) {
    if (!uid) return Promise.resolve({ entries: 0, pages: 0, runs: 0, products: 0, writes: 0 });
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      const totals = { entries: 0, pages: 0, runs: 0, products: 0, writes: 0 };
      do {
        again = false;
        const t = await drain(uid);
        for (const k of Object.keys(totals)) totals[k] += t[k];
      } while (again);
      return totals;
    })().catch((err) => {
      log.warn('[ProScan] Sync stopped:', err && (err.code || err.message));
      throw err;
    }).finally(() => { running = null; });
    return running;
  }

  /** How many entries are waiting for `uid`. */
  async function pending(uid) {
    if (!uid) return 0;
    return (await mine(await openStore(), uid)).length;
  }

  return { flush, pending };
}
