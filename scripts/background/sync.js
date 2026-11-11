/**
 * @fileoverview Sync consumer — drains the durable syncQueue into the
 * signed-in user's Firestore workspace (workspaces/{uid}), converting the
 * producer's shapes to the cloud schema (proscan-web docs/architecture/
 * data-model.md §4) so every write passes firestore.rules.
 *
 * The producer (scraper.js/storage.js/delta.js) stamps each product with
 * priceCents + a delta block + runId/pageIndex and pushes it to
 * chrome.storage.local 'syncQueue'. It does NOT carry several fields the cloud
 * schema requires — this module derives them at write time:
 *   - canonical sourceId  (s_{sellerId} | k_{slug})  from scrapeRunMeta
 *   - canonical runId      ({sourceId}_{startEpochMs})
 *   - dayKey               (UTC date of run start; rules REQUIRE it as string)
 *   - mk                   ('US' — only marketplace today)
 *   - delta.pPct           (percent change; producer only has absolute cents)
 *   - ISO strings -> Firestore Timestamp
 *   - isPrime boolean -> pr 0/1
 * Money stays integer cents. Unknown numerics are OMITTED (never written as
 * null) so they never violate the rules' `is int` checks. Dashboard-owned
 * fields (lead/verdict/tags/spread) are never touched — set(merge) preserves
 * them.
 *
 * Bundled into the service worker by esbuild.
 * @module Sync
 */

import {
  writeBatch,
  doc,
  serverTimestamp,
  Timestamp,
  arrayUnion,
} from 'firebase/firestore';
import { db } from './firebase-init.js';

const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const tsOf = (iso) => Timestamp.fromDate(new Date(iso));
const round1 = (n) => Math.round(n * 10) / 10;
const intOrUndef = (n) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined;

function deriveSourceId(meta) {
  if (meta && meta.sellerId) return `s_${meta.sellerId}`;
  if (meta && meta.keyword) return `k_${slugify(meta.keyword)}`;
  return 'k_unknown';
}

/** Compact observation point {p,r,v,pr} — schema's history/latest shape.
 *  Omits unknown numerics so the rules' `is int` checks never see a null. */
function pointFrom(q) {
  const pt = {
    p: intOrUndef(q.priceCents),
    r: typeof q.rating === 'number' && q.rating > 0 ? round1(q.rating) : undefined,
    v: typeof q.reviewCount === 'number' && q.reviewCount > 0 ? Math.round(q.reviewCount) : undefined,
    pr: q.isPrime ? 1 : 0,
  };
  Object.keys(pt).forEach((k) => pt[k] === undefined && delete pt[k]);
  return pt;
}

/** Convert the producer delta {dPriceCents,dRating,dReviews} → schema
 *  {p,pPct,r,v}. Returns undefined for first-sight / empty deltas. */
function deltaBlock(q) {
  const d = q.delta;
  if (!d || d.isNew) return undefined;
  const out = {};
  if (typeof d.dPriceCents === 'number') {
    out.p = Math.round(d.dPriceCents);
    const prev = typeof q.priceCents === 'number' ? q.priceCents - d.dPriceCents : null;
    if (prev && prev !== 0) out.pPct = round1((d.dPriceCents / prev) * 100);
  }
  if (typeof d.dRating === 'number') out.r = round1(d.dRating);
  if (typeof d.dReviews === 'number') out.v = Math.round(d.dReviews);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Drain the queue into workspaces/{uid}. Idempotent: every write is
 * set(merge) of absolute values + one arrayUnion, so a retried export
 * rewrites byte-identical docs.
 *
 * @param {string} uid  signed-in user's uid (== workspace id)
 * @param {{syncQueue?: object[], scrapeRunMeta?: object, scrapeRunPages?: object[]}} bundle
 * @returns {Promise<{written: number, runId: string|null, products: number}>}
 */
export async function syncToCloud(uid, bundle) {
  const queue = (bundle && bundle.syncQueue) || [];
  if (!queue.length) return { written: 0, runId: null, products: 0 };

  const meta = (bundle && bundle.scrapeRunMeta) || {};
  const sourceId = deriveSourceId(meta);
  const startMs = meta.startedAt ? Date.parse(meta.startedAt) : Date.now();
  const runId = `${sourceId}_${startMs}`;
  const dayKey = new Date(startMs).toISOString().slice(0, 10);
  const mk = 'US';

  // ── products + history, chunked under the 500-writes/batch limit ──
  const CHUNK = 200; // 2 writes per product → 400 writes/batch
  let products = 0;
  for (let i = 0; i < queue.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const q of queue.slice(i, i + CHUNK)) {
      if (!q || !q.asin) continue;
      const at = q.scrapedAt ? tsOf(q.scrapedAt) : serverTimestamp();

      const payload = {
        asin: q.asin, // rules: doc id must equal this
        mk,
        url: `https://www.amazon.com/dp/${q.asin}`,
        latest: { ...pointFrom(q), at, runId, dayKey }, // rules require latest.dayKey:string
        sourceIds: arrayUnion(sourceId),
      };
      if (typeof q.name === 'string' && q.name) payload.name = q.name;
      const d = deltaBlock(q);
      if (d) payload.delta = d;
      if (q.delta && q.delta.isNew) {
        // immutable first-sight stamps — only on first sight, else merge would clobber
        payload.firstSeenAt = at;
        payload.firstRunId = runId;
      }
      batch.set(doc(db, 'workspaces', uid, 'products', q.asin), payload, { merge: true });

      // date-keyed history point (deep-merges into the d-map)
      batch.set(
        doc(db, 'workspaces', uid, 'products', q.asin, 'history', 'daily'),
        { asin: q.asin, d: { [dayKey]: pointFrom(q) } },
        { merge: true },
      );
      products++;
    }
    await batch.commit();
  }

  // ── run header + source spine (once per drain) ──
  const head = writeBatch(db);
  head.set(
    doc(db, 'workspaces', uid, 'runs', runId),
    {
      runId,
      sourceId, // rules require string
      source: {
        type: meta.type || 'keyword',
        sellerId: meta.sellerId ?? null,
        keyword: meta.keyword ?? null,
        url: meta.url ?? null,
      },
      mk,
      dayKey, // rules require string
      startedAt: meta.startedAt ? tsOf(meta.startedAt) : serverTimestamp(),
      finishedAt: serverTimestamp(),
      status: 'complete', // rules enum
      pagesDone: bundle.scrapeRunPages ? bundle.scrapeRunPages.length : null,
      pagesPlanned: bundle.scrapeRunPages ? bundle.scrapeRunPages.length : null,
      counters: {
        // Each queued product is one ASIN; its placements list every card it had
        placements: queue.reduce((n, q) => n + (Array.isArray(q.placements) ? q.placements.length : 1), 0),
        uniqueAsins: new Set(queue.map((q) => q.asin)).size,
        sponsored: queue.reduce(
          (n, q) => n + (Array.isArray(q.placements) ? q.placements.filter((pl) => pl.sponsored).length : q.sponsored ? 1 : 0),
          0,
        ),
        priceParseFailures: queue.filter((q) => q.priceCents == null).length,
        newSeen: queue.filter((q) => q.delta && q.delta.isNew).length,
      },
    },
    { merge: true },
  );
  head.set(
    doc(db, 'workspaces', uid, 'sources', sourceId),
    {
      sourceId,
      type: meta.type === 'storefront' ? 'storefront' : 'keyword', // rules enum
      sellerId: meta.sellerId ?? null,
      keyword: meta.keyword ?? null,
      url: meta.url ?? null,
      lastRunId: runId,
      lastScrapedAt: meta.startedAt ? tsOf(meta.startedAt) : serverTimestamp(),
      // cadenceDays intentionally omitted — rules default it; never stomp a
      // dashboard-set cadence on re-scan.
    },
    { merge: true },
  );
  await head.commit();

  return { written: products * 2 + 2, runId, products };
}
