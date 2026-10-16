import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanZones, snapshot, diffZone, score, paced } from '../extension/src/zonescan.js';
import { listZones } from '../extension/src/cfapi.js';

const msgs = JSON.parse(readFileSync(new URL('../extension/_locales/en/messages.json', import.meta.url)));
const t = (k, subs = []) => {
  assert.ok(msgs[k], `missing message: ${k}`);
  return msgs[k].message.replace(/\$(\d)/g, (_, i) => subs[i - 1] ?? '');
};

const SETTINGS = {
  ssl: 'strict', ssl_automatic_mode: 'custom', min_tls_version: '1.2', tls_1_3: 'on', always_use_https: 'on',
  automatic_https_rewrites: 'on', development_mode: 'off', security_level: 'medium', browser_check: 'on',
  email_obfuscation: 'off', rocket_loader: 'off',
};

// A fake api.cloudflare.com with per-zone overrides; tracks how many zone scans run at once.
function fakeAccount(zones, { overrides = {}, rateLimitAfter = Infinity } = {}) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url) => {
    calls++;
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    const reply = (status, body, headers = {}) => ({
      ok: status < 400, status, json: async () => body, headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    });
    if (calls > rateLimitAfter) return reply(429, { success: false, errors: [{ code: 10000, message: 'Rate limited' }] }, { 'retry-after': '120' });
    if (path.startsWith('/zones?per_page=50&page=')) {
      const page = Number(new URL('http://x' + path).searchParams.get('page'));
      return reply(200, { success: true, result: zones.slice((page - 1) * 50, page * 50).map((name, i) => ({ id: `id-${name}`, name, status: 'active' })),
        result_info: { total_pages: Math.ceil(zones.length / 50) } });
    }
    const m = path.match(/^\/zones\/id-([^/]+)\/(.*)$/);
    if (!m) return reply(404, { success: false, errors: [{ code: 7003, message: 'nope' }] });
    const [, zone, rest] = m;
    if (rest.startsWith('settings/')) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      const id = rest.slice('settings/'.length);
      return reply(200, { success: true, result: { id, value: (overrides[zone] || {})[id] ?? SETTINGS[id] } });
    }
    if (rest === 'dnssec') return reply(200, { success: true, result: { status: (overrides[zone] || {}).dnssec || 'active' } });
    if (rest.startsWith('dns_records')) return reply(200, { success: true, result: [], result_info: { total_pages: 1 } });
    if (rest.startsWith('ssl/certificate_packs')) return reply(200, { success: true, result: [{ type: 'universal', status: 'active', certificates: [] }] });
    return reply(404, { success: false, errors: [{ code: 7003, message: 'nope' }] });
  };
  return { fetchImpl, stats: () => ({ calls, maxInFlight }) };
}

test('listZones follows pagination', async () => {
  const names = Array.from({ length: 120 }, (_, i) => `site${i}.com`);
  const { fetchImpl } = fakeAccount(names);
  assert.equal((await listZones('tok', fetchImpl)).length, 120);
});

test('scanZones scans every zone, worst first, with limited concurrency', async () => {
  const { fetchImpl, stats } = fakeAccount(['a.com', 'b.com', 'c.com', 'd.com', 'e.com'], {
    overrides: { 'c.com': { ssl: 'flexible' }, 'd.com': { development_mode: 'on' } },
  });
  const { entries, stopped, total } = await scanZones('tok', t, { fetchImpl, rps: 0 });
  assert.equal(stopped, null);
  assert.equal(total, 5);
  assert.deepEqual(entries.slice(0, 2).map((e) => e.zone.name), ['c.com', 'd.com']); // fail before warn
  // 3 zones at a time, 11 settings each in parallel.
  assert.ok(stats().maxInFlight <= 3 * 11, `in flight: ${stats().maxInFlight}`);
});

test('a rate limit stops the scan and lists what was left', async () => {
  const names = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'];
  const { fetchImpl } = fakeAccount(names, { rateLimitAfter: 30 });
  const { entries, stopped } = await scanZones('tok', t, { fetchImpl, rps: 0 });
  assert.ok(stopped, 'should stop');
  assert.equal(stopped.error.retryAfter, 120);
  assert.equal(entries.length + stopped.remaining.length, names.length);
  // Rate-limited zones are never reported as "missing permission" skips.
  for (const e of entries) assert.ok(!e.results.some((r) => /Rate limited/.test(r.detail)), e.zone.name);
});

test('Always Use HTTPS off is a note, not a warning, on the zones page', async () => {
  const { fetchImpl } = fakeAccount(['a.com'], { overrides: { 'a.com': { always_use_https: 'off' } } });
  const { entries } = await scanZones('tok', t, { fetchImpl, rps: 0 });
  assert.equal(entries[0].results.find((r) => r.id === 'api_alwaysHttps').status, 'info');
});

test('snapshot + diff find new problems and fixes', () => {
  const z = { id: 'z1', name: 'a.com' };
  const before = snapshot([{ zone: z, results: [{ id: 'api_ssl', status: 'pass' }, { id: 'api_devMode', status: 'warn' }] }], null, 1000);
  const now = [{ id: 'api_ssl', status: 'fail' }, { id: 'api_devMode', status: 'pass' }];
  const d = diffZone(before, 'z1', now);
  assert.deepEqual(d.worse, ['api_ssl']);
  assert.deepEqual(d.better, ['api_devMode']);
  assert.equal(diffZone(before, 'z2', now).isNew, true);   // zone added since last scan
  assert.equal(diffZone(null, 'z1', now).isNew, false);    // first scan ever: nothing to compare
  assert.equal(diffZone(null, 'z1', now).worse.length, 0);
});

test('score ignores muted checks', () => {
  const rs = [{ id: 'api_alwaysHttps', status: 'warn' }, { id: 'api_grey', status: 'info' }];
  assert.equal(score(rs), 11);
  assert.equal(score(rs, ['api_alwaysHttps']), 1);
});

// --- Regressions from the all-zones review
test('a day of errors does not turn known problems into "new" ones', () => {
  const z = { id: 'z1', name: 'a.com' };
  const day1 = snapshot([{ zone: z, results: [{ id: 'api_ssl', status: 'fail' }, { id: 'api_dnssec', status: 'warn' }] }], null, 1);
  // Day 2: API trouble, everything skipped.
  const day2 = snapshot([{ zone: z, results: [{ id: 'api_ssl', status: 'skip' }, { id: 'api_dnssec', status: 'skip' }] }], day1, 2);
  assert.equal(day2.zones.z1.statuses.api_ssl, 'fail'); // baseline carried forward
  // Day 3: back to normal, same problems as day 1.
  const d = diffZone(day2, 'z1', [{ id: 'api_ssl', status: 'fail' }, { id: 'api_dnssec', status: 'warn' }]);
  assert.deepEqual(d.worse, []);
  // A check that didn't exist before (extension update) is not "new" either.
  assert.deepEqual(diffZone(day1, 'z1', [{ id: 'api_newCheck', status: 'warn' }]).worse, []);
});

test('paced() spaces request starts', async () => {
  // What matters is the rate over a window (timer jitter can shift single gaps by a few ms).
  const starts = [];
  const f = paced(async () => { starts.push(performance.now()); return {}; }, 20); // 20/s -> 50 ms apart
  await Promise.all(Array.from({ length: 11 }, () => f('u')));
  const span = starts[starts.length - 1] - starts[0];
  assert.ok(span >= 10 * 50 * 0.95, `11 requests took ${Math.round(span)} ms, expected ~500`);
});

test('stored results are compact (no titles or fixes)', async () => {
  const { fetchImpl } = fakeAccount(['a.com']);
  const { entries } = await scanZones('tok', t, { fetchImpl, rps: 0 });
  assert.deepEqual(Object.keys(entries[0].results[0]).sort(), ['detail', 'id', 'status']);
});

test('warn -> fail is a new problem; fail -> warn is not', () => {
  const z = { id: 'z1', name: 'a.com' };
  const base = snapshot([{ zone: z, results: [{ id: 'api_ssl', status: 'warn' }, { id: 'api_dnssec', status: 'fail' }] }], null, 1);
  const d = diffZone(base, 'z1', [{ id: 'api_ssl', status: 'fail' }, { id: 'api_dnssec', status: 'warn' }]);
  assert.deepEqual(d.worse, ['api_ssl']);
});

test('a zone-level error keeps every other check in the baseline', () => {
  const z = { id: 'z1', name: 'a.com' };
  const day1 = snapshot([{ zone: z, results: [{ id: 'api_ssl', status: 'pass' }, { id: 'api_tls13', status: 'pass' }] }], null, 1);
  const day2 = snapshot([{ zone: z, results: [{ id: 'apiAccess', status: 'warn' }] }], day1, 2);
  assert.equal(day2.zones.z1.statuses.api_ssl, 'pass');
  assert.deepEqual(diffZone(day2, 'z1', [{ id: 'api_ssl', status: 'fail' }]).worse, ['api_ssl']);
});
