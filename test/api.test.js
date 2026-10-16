import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateAccount, PART_PERMISSION } from '../extension/src/apichecks.js';
import { collectAccount, verifyToken, ApiError } from '../extension/src/cfapi.js';

const msgs = JSON.parse(readFileSync(new URL('../extension/_locales/en/messages.json', import.meta.url)));
const t = (k, subs = []) => {
  assert.ok(msgs[k], `missing message: ${k}`);
  return msgs[k].message.replace(/\$(\d)/g, (_, i) => subs[i - 1] ?? '');
};
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));
const ok = (value) => ({ value });
const settings = (over = {}) => ok(Object.fromEntries(Object.entries({
  ssl: 'strict', min_tls_version: '1.2', tls_1_3: 'on', always_use_https: 'on', automatic_https_rewrites: 'on',
  development_mode: 'off', security_level: 'medium', browser_check: 'on', rocket_loader: 'off', email_obfuscation: 'off',
  ...over,
}).map(([id, value]) => [id, { id, value }])));
const inFuture = (days) => new Date(Date.now() + days * 86400000).toISOString();
const good = {
  zoneName: 'example.com', zone: { id: 'z1', name: 'example.com' },
  settings: settings(),
  dnssec: ok({ status: 'active' }),
  records: ok({ partial: false, records: [{ type: 'A', name: 'example.com', proxiable: true, proxied: true },
    { type: 'MX', name: 'example.com', proxiable: false, proxied: false }] }),
  certs: ok([{ type: 'universal', status: 'active', certificates: [{ expires_on: inFuture(60) }] }]),
};

test('a well-configured account passes every API check', () => {
  const r = evaluateAccount(good, [], t);
  assert.equal(r.length, 13);
  for (const x of r) assert.equal(x.status, 'pass', `${x.id}: ${x.detail}`);
  assert.ok(r.every((x) => x.group === 'account' && x.fix === ''));
});

test('forgotten account settings are flagged', () => {
  const acct = {
    ...good,
    settings: settings({ ssl: 'flexible', min_tls_version: '1.0', tls_1_3: 'off', always_use_https: 'off',
      development_mode: 'on', security_level: 'under_attack', rocket_loader: 'on', email_obfuscation: 'on' }),
    dnssec: ok({ status: 'pending' }),
    records: ok({ partial: false, records: [{ type: 'A', name: 'staging.example.com', proxiable: true, proxied: false }] }),
    certs: ok([{ type: 'universal', status: 'pending_validation', certificates: [] }]),
  };
  acct.settings.value.development_mode.time_remaining = 5400;
  const r = byId(evaluateAccount(acct, [], t));
  const expect = { api_ssl: 'fail', api_minTls: 'warn', api_tls13: 'warn', api_alwaysHttps: 'warn', api_devMode: 'warn',
    api_securityLevel: 'warn', api_rocketLoader: 'warn', api_emailObf: 'info', api_dnssec: 'warn', api_grey: 'info', api_certs: 'warn' };
  for (const [id, st] of Object.entries(expect)) assert.equal(r[id].status, st, id);
  assert.match(r.api_devMode.detail, /90/);
  assert.match(r.api_grey.detail, /staging\.example\.com/);
  assert.ok(r.api_ssl.fix.includes('Full (strict)'));
});

test('Always Use HTTPS off is fine when the origin redirects', () => {
  const acct = { ...good, settings: settings({ always_use_https: 'off' }) };
  assert.equal(byId(evaluateAccount(acct, [{ id: 'httpRedirect', status: 'pass' }], t)).api_alwaysHttps.status, 'pass');
  assert.equal(byId(evaluateAccount(acct, [{ id: 'httpRedirect', status: 'action' }], t)).api_alwaysHttps.status, 'warn');
});

test('a part the token cannot read becomes a missing-permission skip', () => {
  const forbidden = new ApiError(403, [{ code: 9109, message: 'Unauthorized to access requested resource' }]);
  const acct = { ...good, certs: { error: forbidden }, dnssec: { error: new ApiError(500, [{ code: 1, message: 'boom' }]) } };
  const r = byId(evaluateAccount(acct, [], t));
  assert.equal(r.api_certs.status, 'skip');
  assert.ok(r.api_certs.detail.includes(PART_PERMISSION.certs));
  assert.equal(r.api_dnssec.status, 'skip');
  assert.match(r.api_dnssec.detail, /boom/);
  assert.equal(r.api_ssl.status, 'pass');
});

test('zone not in account, and API errors', () => {
  assert.equal(evaluateAccount({ zoneName: 'other.com', zone: null }, [], t)[0].status, 'info');
  const e401 = evaluateAccount({ zoneName: 'x.com', error: new ApiError(401, [{ code: 1000, message: 'Invalid API Token' }]) }, [], t)[0];
  assert.equal(e401.status, 'warn');          // visible, not folded away as "skipped"
  assert.match(e401.detail, /Invalid API Token/);
  const e403 = evaluateAccount({ zoneName: 'x.com', error: new ApiError(403, [{ code: 10000, message: 'Forbidden' }]) }, [], t)[0];
  assert.ok(e403.detail.includes('Zone - Zone - Read'));
});

test('expiring certificate warns', () => {
  const acct = { ...good, certs: ok([{ type: 'universal', status: 'active', certificates: [{ expires_on: inFuture(5) }] }]) };
  assert.equal(byId(evaluateAccount(acct, [], t)).api_certs.status, 'warn');
});

// --- cfapi.js against a fake api.cloudflare.com
function fakeApi(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    const [status, body] = hit ? hit[1] : [404, { success: false, errors: [{ code: 7003, message: 'not found' }] }];
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('collectAccount reads every part and isolates a forbidden one', async () => {
  const { fetchImpl, calls } = fakeApi({
    '/zones?name=example.com': [200, { success: true, result: [{ id: 'z1', name: 'example.com', status: 'active', plan: { name: 'Free' } }] }],
    '/zones/z1/settings/ssl_automatic_mode': [200, { success: true, result: { id: 'ssl_automatic_mode', value: 'auto' } }],
    '/zones/z1/settings/ssl': [200, { success: true, result: { id: 'ssl', value: 'strict' } }],
    '/zones/z1/settings/min_tls_version': [403, { success: false, errors: [{ code: 10000, message: 'Forbidden' }] }],
    '/zones/z1/dnssec': [200, { success: true, result: { status: 'active' } }],
    '/zones/z1/dns_records': [200, { success: true, result: [{ type: 'A', name: 'example.com' }], result_info: { total_pages: 1 } }],
    '/zones/z1/ssl/certificate_packs': [403, { success: false, errors: [{ code: 9109, message: 'Unauthorized' }] }],
  });
  const acct = await collectAccount('tok_secret', 'example.com', fetchImpl);
  assert.equal(acct.zone.id, 'z1');
  assert.equal(acct.settings.value.ssl.value, 'strict');
  assert.equal(acct.settings.value.ssl_automatic_mode.value, 'auto');
  assert.equal(acct.settings.value.min_tls_version.error.forbidden, true); // kept as an error; the rest still load
  // Never the deprecated all-settings call.
  assert.ok(!calls.some((c) => c.url.endsWith('/zones/z1/settings')));
  assert.equal(acct.records.value.records.length, 3); // one per type from the fake route
  assert.equal(acct.records.value.partial, false);
  assert.equal(acct.certs.error.forbidden, true);
  // The token only ever goes to api.cloudflare.com, as a bearer header.
  assert.ok(calls.every((c) => c.url.startsWith('https://api.cloudflare.com/') && c.auth === 'Bearer tok_secret'));
  assert.ok(calls.every((c) => !c.url.includes('tok_secret')));
});

test('verifyToken surfaces API errors', async () => {
  const { fetchImpl } = fakeApi({ '/user/tokens/verify': [401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }] });
  await assert.rejects(verifyToken('bad', fetchImpl), /Invalid API Token/);
});

test('verifyToken falls back to listing zones for account-owned tokens', async () => {
  const { fetchImpl } = fakeApi({
    '/user/tokens/verify': [401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }],
    '/zones?per_page=5': [200, { success: true, result: [] }],
  });
  assert.equal((await verifyToken('acct_token', fetchImpl)).status, 'active');
});

test('settings with every call forbidden become a missing-permission skip', async () => {
  const { fetchImpl } = fakeApi({
    '/zones?name=example.com': [200, { success: true, result: [{ id: 'z1', name: 'example.com' }] }],
    '/zones/z1/settings/': [403, { success: false, errors: [{ code: 10000, message: 'Forbidden' }] }],
  });
  const acct = await collectAccount('tok', 'example.com', fetchImpl);
  const r = byId(evaluateAccount({ zoneName: 'example.com', ...acct }, [], t));
  assert.equal(r.api_ssl.status, 'skip');
  assert.ok(r.api_ssl.detail.includes('Zone - Zone Settings - Read'));
});

test('SSL set by automatic mode is labelled', () => {
  const acct = { ...good, settings: settings({ ssl_automatic_mode: 'auto' }) };
  assert.match(byId(evaluateAccount(acct, [], t)).api_ssl.detail, /automatically/);
});

test('API results replace outside duplicates only when the API could read them', async () => {
  const { mergeResults } = await import('../extension/src/apichecks.js');
  const outside = [{ id: 'dnssec', status: 'warn' }, { id: 'rocketLoader', status: 'pass' }, { id: 'hsts', status: 'pass' }];
  const merged = mergeResults(outside, [{ id: 'api_dnssec', status: 'warn' }, { id: 'api_rocketLoader', status: 'skip' }]);
  const ids = merged.map((r) => r.id);
  assert.ok(!ids.includes('dnssec'));       // replaced by api_dnssec
  assert.ok(ids.includes('rocketLoader'));  // API couldn't read it: keep the outside check
  assert.ok(ids.includes('hsts'));
});

// --- Regressions from the API-mode review
test('DNSSEC error and pending-disabled are not downgraded to notes', () => {
  assert.equal(byId(evaluateAccount({ ...good, dnssec: ok({ status: 'error' }) }, [], t)).api_dnssec.status, 'fail');
  assert.equal(byId(evaluateAccount({ ...good, dnssec: ok({ status: 'pending-disabled' }) }, [], t)).api_dnssec.status, 'warn');
});

test('an indefinite API answer never hides an outside finding', async () => {
  const { mergeResults } = await import('../extension/src/apichecks.js');
  const outside = [{ id: 'dnssec', status: 'fail' }];
  const ids = mergeResults(outside, [{ id: 'api_dnssec', status: 'info' }]).map((r) => r.id);
  assert.ok(ids.includes('dnssec'));
});

test('page-level Rocket Loader evidence survives a zone setting of off', async () => {
  const { mergeResults } = await import('../extension/src/apichecks.js');
  const kept = mergeResults([{ id: 'rocketLoader', status: 'warn' }], [{ id: 'api_rocketLoader', status: 'pass' }]).map((r) => r.id);
  assert.ok(kept.includes('rocketLoader'));
  const replaced = mergeResults([{ id: 'rocketLoader', status: 'pass' }], [{ id: 'api_rocketLoader', status: 'warn' }]).map((r) => r.id);
  assert.ok(!replaced.includes('rocketLoader'));
});

test('retired certificate packs are ignored', () => {
  const acct = { ...good, certs: ok([
    { type: 'advanced', status: 'deleted', certificates: [{ expires_on: inFuture(-100) }] },
    { type: 'universal', status: 'active', certificates: [{ expires_on: inFuture(60) }] },
  ]) };
  const r = byId(evaluateAccount(acct, [], t)).api_certs;
  assert.equal(r.status, 'pass');
  assert.match(r.detail, /59|60/);
});

test('a setting that failed on its own gets its own skip line', () => {
  const s = settings();
  s.value.min_tls_version = { error: new ApiError(429, [{ code: 10000, message: 'Rate limited' }]) };
  const r = byId(evaluateAccount({ ...good, settings: s }, [], t));
  assert.equal(r.api_minTls.status, 'skip');
  assert.equal(r.api_ssl.status, 'pass');
});

test('findZone walks the host labels and prefers an active zone', async () => {
  const { findZone } = await import('../extension/src/cfapi.js');
  const { fetchImpl, calls } = fakeApi({
    '/zones?name=www.shop.example.com': [200, { success: true, result: [] }],
    '/zones?name=shop.example.com': [200, { success: true, result: [
      { id: 'other', name: 'shop.example.com', status: 'pending' }, { id: 'mine', name: 'shop.example.com', status: 'active' }] }],
  });
  assert.equal((await findZone('tok', 'www.shop.example.com', fetchImpl)).id, 'mine');
  assert.equal(calls.length, 2);
});

test('only DNS-only records are requested', async () => {
  const { fetchImpl, calls } = fakeApi({
    '/zones?name=example.com': [200, { success: true, result: [{ id: 'z1', name: 'example.com', status: 'active' }] }],
    '/zones/z1/dns_records': [200, { success: true, result: [], result_info: { total_pages: 1 } }],
  });
  await collectAccount('tok', 'example.com', fetchImpl);
  for (const type of ['A', 'AAAA', 'CNAME']) assert.ok(calls.some((c) => c.url.includes(`/dns_records?type=${type}&proxied=false`)), type);
  assert.ok(!calls.some((c) => c.url.includes('type=MX')));
});

test('a partial record list never reports "all proxied"', () => {
  const r = byId(evaluateAccount({ ...good, records: ok({ partial: true, records: [] }) }, [], t)).api_grey;
  assert.equal(r.status, 'info');
});
