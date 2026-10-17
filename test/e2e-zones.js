// Zones page + daily scan against a fake api.cloudflare.com, in Chrome for Testing.
// The test copy gets api.cloudflare.com and notifications up front (normally asked for in a click),
// and a shim that answers the API from window.__fake (the page) or a fixture (the service worker).
import puppeteer from 'puppeteer-core';
import { cpSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from '../tools/chrome.js';

const lang = process.env.EC_LANG || 'en';
const shotDir = process.env.EC_SHOTS || '';
const dir = mkdtempSync(join(tmpdir(), 'originlint-zones-'));
cpSync(new URL('../extension', import.meta.url).pathname, dir, { recursive: true });
const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['https://api.cloudflare.com/*'];
mf.permissions = [...mf.permissions, 'notifications'];
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf));

const FAKE = `
const BASE = { ssl: 'strict', ssl_automatic_mode: 'custom', min_tls_version: '1.2', tls_1_3: 'on', always_use_https: 'on',
  automatic_https_rewrites: 'on', development_mode: 'off', security_level: 'medium', browser_check: 'on',
  email_obfuscation: 'off', rocket_loader: 'off' };
const fakeState = (globalThis.__fake = globalThis.__fake || {
  zones: { z1: 'alpha.example', z2: 'bravo.example', z3: 'charlie.example', z4: 'delta.example' },
  overrides: { z2: { ssl: 'flexible' }, z3: { development_mode: 'on' } },
});
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://api.cloudflare.com/client/v4')) return realFetch(url, opts);
  const path = u.slice('https://api.cloudflare.com/client/v4'.length);
  const json = (result, extra = {}) => new Response(JSON.stringify({ success: true, errors: [], result, ...extra }), { status: 200 });
  if (path.startsWith('/zones?per_page=50')) {
    return json(Object.entries(fakeState.zones).map(([id, name]) => ({ id, name, status: 'active' })), { result_info: { total_pages: 1 } });
  }
  const parts = path.split('/'); // ['', 'zones', id, ...rest]
  const id = parts[2];
  const rest = parts.slice(3).join('/');
  const over = fakeState.overrides[id] || {};
  if (rest.startsWith('settings/')) {
    const key = rest.slice('settings/'.length);
    return json({ id: key, value: key in over ? over[key] : BASE[key], time_remaining: key === 'development_mode' ? 3600 : undefined });
  }
  if (rest === 'dnssec') return json({ status: over.dnssec || 'active' });
  if (rest.startsWith('dns_records')) return json([], { result_info: { total_pages: 1 } });
  if (rest.startsWith('ssl/certificate_packs')) return json([{ type: 'universal', status: 'active', certificates: [] }]);
  return new Response('{}', { status: 404 });
};
`;
writeFileSync(join(dir, 'src/test-fake.js'), FAKE);
writeFileSync(join(dir, 'src/zones.html'), readFileSync(join(dir, 'src/zones.html'), 'utf8')
  .replace('<script type="module"', '<script src="test-fake.js"></script><script type="module"'));
// The service worker is a module: prepend the fake, seed a token, and fire the daily alarm soon.
writeFileSync(join(dir, 'src/background.js'), `import './test-fake.js';\n` + readFileSync(join(dir, 'src/background.js'), 'utf8'));

const browser = await puppeteer.launch({
  executablePath: CHROME, pipe: true, enableExtensions: [dir],
  args: ['--no-sandbox', `--lang=${lang}`], env: { ...process.env, LANGUAGE: lang },
});
const swTarget = await browser.waitForTarget((tg) => tg.type() === 'service_worker' && tg.url().endsWith('/src/background.js'), { timeout: 10000 });
const extId = new URL(swTarget.url()).host;
const sw = await swTarget.worker();
// Puppeteer can attach before Chrome has bound the extension APIs in the worker.
for (let i = 0; i < 50 && !(await sw.evaluate(() => !!(globalThis.chrome && chrome.storage && chrome.alarms))); i++) {
  await new Promise((r) => setTimeout(r, 100));
}
const swErrors = [];
sw.on('console', (m) => m.type() === 'error' && swErrors.push(m.text()));
await sw.evaluate(() => chrome.storage.local.set({ cfToken: 'test_token_000000000000000000000000000000' }));

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: shotDir ? 2 : 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`chrome-extension://${extId}/src/zones.html`);
await page.waitForSelector('#scan:not([disabled])');

// Scan 1
await page.click('#scan');
await page.waitForSelector('.zone', { timeout: 90000 });
const first = await page.evaluate(() => ({
  zones: [...document.querySelectorAll('.zone .z-name')].map((n) => n.textContent),
  tiles: [...document.querySelectorAll('#summary .sum')].map((s) => s.innerText.replace('\n', ' ')),
  chips: [...document.querySelectorAll('.zone')].map((z) => z.querySelector('.z-name').textContent + ': ' + [...z.querySelectorAll('.z-chip')].map((c) => c.textContent).join(', ')),
}));
console.log('scan 1:', first);
check(first.zones[0] === 'bravo.example', 'worst zone (Flexible SSL) listed first');
check(first.zones.length === 2, 'only zones with problems shown by default');
check(!first.chips.join().match(/new|yeni/), 'first scan shows no "new" badges');

await page.click('#onlyProblems');
check(await page.$$eval('.zone', (z) => z.length) === 4, 'all 4 zones shown when the filter is off');
await page.click('#onlyProblems');

// Something breaks on a clean zone, then scan 2
await page.evaluate(() => { window.__fake.overrides.z4 = { min_tls_version: '1.0' }; });
await page.click('#scan');
await page.waitForFunction(() => document.querySelector('.z-chip.new'), { timeout: 90000 });
const second = await page.evaluate(() => [...document.querySelectorAll('.zone')].map((z) =>
  z.querySelector('.z-name').textContent + ': ' + [...z.querySelectorAll('.z-chip')].map((c) => c.textContent).join(', ') + (z.open ? ' [open]' : '')));
console.log('scan 2:', second);
check(second[0].startsWith('delta.example') && second[0].includes('[open]'), 'zone with a new problem is first and expanded');
check(/Last scan|Son tarama/.test(await page.$eval('#lastScan', (e) => e.textContent)), 'last scan time shown');
if (shotDir) await page.screenshot({ path: join(shotDir, `zones-${lang}.png`), fullPage: true });

// Muting a check updates the counts
const before = await page.$eval('.zone:first-child .z-chips', (c) => c.textContent);
const mutedId = await page.$eval('.zone:first-child .z-body .item', (i) => i.querySelector('.title').textContent);
await page.$eval('.zone:first-child .z-body .mute', (b) => b.click()); // DOM click: the sticky header can cover the button
await page.waitForFunction(() => chrome.storage.sync.get('muted').then((m) => (m.muted || []).length > 0));
console.log('muted:', mutedId, await page.evaluate(() => chrome.storage.sync.get('muted').then((m) => m.muted)));
const after = await page.$eval('.zone:first-of-type .z-chips', (c) => c.textContent).catch(() => '(zone filtered out)');
check(before !== after, `muting changes the zone's chips (${before} -> ${after})`);
await page.evaluate(() => chrome.storage.sync.set({ muted: [] }));

// Daily scan: the service worker answers the alarm and notifies about new problems.
await sw.evaluate(() => {
  globalThis.__fake.overrides.z1 = { tls_1_3: 'off' }; // alpha breaks before the daily run
  return chrome.alarms.create('originlint-daily-scan', { when: Date.now() + 500 });
});
const notified = await (async () => {
  for (let i = 0; i < 360; i++) {
    const n = await sw.evaluate(() => chrome.notifications.getAll());
    if (n['originlint-daily-scan']) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
})();
check(notified, 'daily alarm scanned and raised a notification');
const stored = await sw.evaluate(async () => (await chrome.storage.local.get('zonesReport')).zonesReport.entries
  .filter((e) => e.diff.worse.length).map((e) => e.zone.name));
check(stored.includes('alpha.example'), `daily scan stored the new problem (${stored.join(', ')})`);

// Reopening the page starts empty; opening it from the notification shows the daily report.
await page.goto(`chrome-extension://${extId}/src/zones.html?daily`);
await page.waitForSelector('#scan:not([disabled])');
check(!!(await page.$('.zone .z-chip.new')), 'notification view shows the daily report');
await page.goto(`chrome-extension://${extId}/src/zones.html`);
await page.waitForSelector('#scan:not([disabled])');
check(!(await page.$('.zone')) && await page.$('.z-empty'), 'reopened page starts with no report');
check(!(await sw.evaluate(async () => (await chrome.storage.local.get('zonesReport')).zonesReport)), 'stored report cleared on open');
check(!!(await sw.evaluate(async () => (await chrome.storage.local.get('zonesSnapshot')).zonesSnapshot)), 'baseline for "new" badges kept');

check(!errors.length, `no page errors ${errors.join(' | ')}`);
check(!swErrors.length, `no service worker errors ${swErrors.join(' | ')}`);
await browser.close();
process.exit(failures ? 1 : 0);
