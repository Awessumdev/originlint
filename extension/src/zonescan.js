// Bulk scan of every zone a token can read, plus the snapshot/diff used for change tracking.
// Shared by the zones page and the background service worker.
import { listZones, collectZone, ApiError } from './cfapi.js';
import { evaluateAccount } from './apichecks.js';

export const PROBLEM = ['fail', 'warn'];
const CONCURRENCY = 3;
// Cloudflare allows 1200 requests per 5 minutes (4/s) per user, shared with the user's other tools.
// 3/s finishes any account without hitting the limit and leaves a quarter of it free.
export const REQUESTS_PER_SECOND = 3;

// Wraps fetch so requests start at most `rps` per second, in order.
export function paced(fetchImpl = fetch, rps = REQUESTS_PER_SECOND) {
  let nextAt = 0;
  return async (url, opts) => {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + 1000 / rps;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return fetchImpl(url, opts);
  };
}

// Only what's needed to redraw a result: title and fix come back from the message catalog.
const compact = (results) => results.map((r) => ({ id: r.id, status: r.status, detail: r.detail }));

// Returns { entries: [{ zone, results }], stopped: null | { error, remaining: [zone] }, total }.
// opts.rps: 0 turns pacing off (tests).
export async function scanZones(token, t, { fetchImpl, onProgress, zones, rps = REQUESTS_PER_SECOND } = {}) {
  const f = rps ? paced(fetchImpl || fetch, rps) : fetchImpl;
  const list = zones || await listZones(token, f);
  const entries = [];
  let stopped = null;
  let next = 0;
  let done = 0;

  async function worker() {
    while (!stopped && next < list.length) {
      const zone = list[next++];
      try {
        const acct = await collectZone(token, zone, f);
        entries.push({ zone, results: compact(evaluateAccount({ zoneName: zone.name, ...acct }, [], t, { bulk: true })) });
      } catch (e) {
        if (e instanceof ApiError && e.rateLimited) {
          stopped = stopped || { error: e, remaining: [] };
          stopped.remaining.push(zone);
          continue;
        }
        entries.push({ zone, results: compact(evaluateAccount({ zoneName: zone.name, error: e }, [], t, { bulk: true })) });
      }
      done++;
      if (onProgress) onProgress(done, list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  if (stopped) stopped.remaining.push(...list.slice(next));
  entries.sort((a, b) => score(b.results) - score(a.results) || a.zone.name.localeCompare(b.zone.name));
  return { entries, stopped, total: list.length };
}

export function score(results, muted = []) {
  const live = results.filter((r) => !muted.includes(r.id));
  const n = (s) => live.filter((r) => r.status === s).length;
  return n('fail') * 100 + n('warn') * 10 + n('info');
}

// What gets stored between scans: per zone, the status of every check. A check that couldn't be
// read this time (skip) keeps its previous status, so one bad day doesn't reset the baseline.
export function snapshot(entries, prev, now = Date.now()) {
  return {
    scannedAt: now,
    zones: Object.fromEntries(entries.map((e) => {
      const before = (prev && prev.zones && prev.zones[e.zone.id]) || { statuses: {} };
      const statuses = { ...before.statuses }; // a zone-level error must not wipe the other checks' baseline
      for (const r of e.results) {
        statuses[r.id] = r.status === 'skip' && before.statuses[r.id] ? before.statuses[r.id] : r.status;
      }
      return [e.zone.id, { name: e.zone.name, statuses }];
    })),
  };
}

const RANK = { pass: 0, info: 0, warn: 1, fail: 2 };

// Compares one zone's results with the previous snapshot; returns check ids.
// "Worse" means a problem now that is more severe than the known status before (pass -> warn,
// warn -> fail). A check that was unreadable or didn't exist last time is never counted as new.
export function diffZone(prev, zoneId, results) {
  const before = prev && prev.zones && prev.zones[zoneId];
  if (!before) return { isNew: !!prev, worse: [], better: [] };
  const was = (id) => before.statuses[id];
  return {
    isNew: false,
    worse: results.filter((r) => PROBLEM.includes(r.status) && was(r.id) in RANK && RANK[r.status] > RANK[was(r.id)]).map((r) => r.id),
    better: results.filter((r) => r.status === 'pass' && PROBLEM.includes(was(r.id))).map((r) => r.id),
  };
}
