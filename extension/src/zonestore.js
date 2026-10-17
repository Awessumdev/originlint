// Runs a bulk scan and keeps two things in chrome.storage.local:
//   zonesReport   - the last scan as shown on the zones page (results + changes)
//   zonesSnapshot - per-zone statuses of the last scan, the baseline for the next diff
import { scanZones, snapshot, diffZone } from './zonescan.js';

export const ALARM = 'originlint-daily-scan';
const LOCK = 'zonesScanLock';
const LOCK_TTL = 2 * 60 * 1000;       // the running scan refreshes it; a closed tab's lock expires fast
const HEARTBEAT = 30 * 1000;
const DEFAULT_RETRY_S = 300;         // Cloudflare blocks for 5 minutes after a 429

export async function loadToken() {
  try {
    const { cfToken } = await chrome.storage.local.get('cfToken');
    return cfToken || '';
  } catch { return ''; }
}

export async function loadReport() {
  try {
    const { zonesReport } = await chrome.storage.local.get('zonesReport');
    return zonesReport || null;
  } catch { return null; }
}

// The zones page starts empty each time it's opened. The snapshot stays, so the next scan still
// shows what changed.
export async function clearReport() {
  try { await chrome.storage.local.remove('zonesReport'); } catch {}
}

export class ScanBusyError extends Error {}

// One scan at a time across the zones page, other tabs and the daily alarm. storage has no
// compare-and-set, so: claim, then read back after a moment to see who won. The holder refreshes
// the timestamp while it runs, so a scan cut off by a closed tab frees the lock within LOCK_TTL.
async function withLock(fn) {
  const read = async () => (await chrome.storage.local.get(LOCK))[LOCK];
  const held = await read();
  if (held && Date.now() - held.at < LOCK_TTL) throw new ScanBusyError('scan already running');
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [LOCK]: { owner, at: Date.now() } });
  await new Promise((r) => setTimeout(r, 150));
  if ((await read())?.owner !== owner) throw new ScanBusyError('scan already running');
  const beat = setInterval(() => {
    read().then((l) => l && l.owner === owner && chrome.storage.local.set({ [LOCK]: { owner, at: Date.now() } }));
  }, HEARTBEAT);
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    if ((await read())?.owner === owner) await chrome.storage.local.remove(LOCK);
  }
}

// opts.zones: rescan only these (e.g. the ones a rate limit left out), merged into the last report.
export function runAndStore(token, t, { onProgress, zones } = {}) {
  return withLock(async () => {
    const { zonesSnapshot: prev = null } = await chrome.storage.local.get('zonesSnapshot');
    const old = (await loadReport()) || { entries: [] };
    const scan = await scanZones(token, t, { onProgress, zones });
    const now = Date.now();

    const fresh = scan.entries.map((e) => ({ ...e, diff: diffZone(prev, e.zone.id, e.results) }));
    const freshIds = new Set(fresh.map((e) => e.zone.id));
    const remaining = scan.stopped ? scan.stopped.remaining : [];
    const remainingIds = new Set(remaining.map((z) => z.id));
    // Keep earlier results for zones this scan didn't reach (marked stale), and, on a partial
    // rescan, for every zone it wasn't asked to scan. On a full scan, zones that are gone drop out.
    const kept = old.entries
      .filter((e) => !freshIds.has(e.zone.id) && (zones || remainingIds.has(e.zone.id)))
      .map((e) => remainingIds.has(e.zone.id)
        ? { ...e, stale: true, diff: { isNew: false, worse: [], better: [] } }
        : e);

    const report = {
      scannedAt: now,
      prevScannedAt: zones ? old.prevScannedAt : (prev ? prev.scannedAt : null),
      entries: [...fresh, ...kept],
      remaining,
      retryAt: scan.stopped ? now + (scan.stopped.error.retryAfter || DEFAULT_RETRY_S) * 1000 : 0,
    };

    // Only zones scanned now move the baseline; the rest keep what they had.
    const nextSnap = snapshot(fresh, prev, now);
    if (prev) for (const [id, z] of Object.entries(prev.zones)) if (!freshIds.has(id) && (zones || remainingIds.has(id))) nextSnap.zones[id] = z;
    await chrome.storage.local.set({ zonesReport: report, zonesSnapshot: nextSnap });
    return report;
  });
}

export function newProblems(report, muted = []) {
  return report.entries.filter((e) => e.diff.worse.some((id) => !muted.includes(id)));
}

// --- Daily scan setting: kept in storage so the alarm can be recreated after updates/restarts.
export async function setDaily(on) {
  await chrome.storage.local.set({ dailyScan: !!on });
  if (on) await chrome.alarms.create(ALARM, { delayInMinutes: 1440, periodInMinutes: 1440 });
  else await chrome.alarms.clear(ALARM);
}

export async function ensureDailyAlarm() {
  const { dailyScan } = await chrome.storage.local.get('dailyScan');
  if (dailyScan && !(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { delayInMinutes: 60, periodInMinutes: 1440 });
  }
}

// Everything API mode left behind: token, reports, daily scan, notifications permission.
export async function forgetAccount() {
  await setDaily(false);
  await chrome.storage.local.remove(['cfToken', 'zonesReport', 'zonesSnapshot', LOCK, 'dailyScan']);
  try { await chrome.permissions.remove({ permissions: ['notifications'] }); } catch {}
}
