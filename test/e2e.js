// Loads a test copy of the extension into Chrome for Testing and runs the real popup
// against live sites. The copy gets <all_urls> and a shim that points tabs.query at the
// target tab, standing in for the toolbar click that grants activeTab.
import puppeteer from 'puppeteer-core';
import { cpSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from '../tools/chrome.js';

const sites = process.argv.slice(2).length ? process.argv.slice(2)
  : ['https://transferfirsati.com/', 'https://awesum.dev/', 'https://github.com/'];
const lang = process.env.EC_LANG || 'en';
const shotDir = process.env.EC_SHOTS || '';

const dir = mkdtempSync(join(tmpdir(), 'originlint-e2e-'));
cpSync(new URL('../extension', import.meta.url).pathname, dir, { recursive: true });
const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
// EC_NARROW=1: grant only the scanned https origins, like activeTab does, so deep checks stay pending.
mf.host_permissions = process.env.EC_NARROW ? sites.map((u) => `${new URL(u).origin}/*`) : ['<all_urls>'];
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf));
// EC_FAKEAPI=1: seed a token and answer api.cloudflare.com from a fixture with some forgotten settings.
const fakeApi = process.env.EC_FAKEAPI ? `
  chrome.storage.local.set({ cfToken: 'test_token_000000000000000000000000000000' });
  const S = { ssl: 'full', ssl_automatic_mode: 'custom', min_tls_version: '1.2', tls_1_3: 'on', always_use_https: 'off',
    automatic_https_rewrites: 'on', development_mode: 'on', security_level: 'medium', browser_check: 'on',
    email_obfuscation: 'off', rocket_loader: 'off' };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith('https://api.cloudflare.com/client/v4')) return realFetch(url, opts);
    const path = u.slice('https://api.cloudflare.com/client/v4'.length);
    const json = (result, extra = {}) => new Response(JSON.stringify({ success: true, errors: [], result, ...extra }), { status: 200 });
    if (path.startsWith('/zones?name=')) return json([{ id: 'z1', name: decodeURIComponent(path.split('=')[1]) }]);
    if (path.startsWith('/zones/z1/settings/')) {
      const id = path.slice('/zones/z1/settings/'.length);
      return json({ id, value: S[id], time_remaining: id === 'development_mode' ? 5400 : undefined });
    }
    if (path === '/zones/z1/dnssec') return json({ status: 'pending' });
    if (path.startsWith('/zones/z1/dns_records?type=A&')) return json([{ type: 'A', name: 'staging.example.com', proxiable: true, proxied: false }], { result_info: { total_pages: 1 } });
    if (path.startsWith('/zones/z1/dns_records')) return json([], { result_info: { total_pages: 1 } });
    if (path.startsWith('/zones/z1/ssl/certificate_packs')) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Forbidden' }] }), { status: 403 });
    return new Response('{}', { status: 404 });
  };
` : '';
writeFileSync(join(dir, 'src/test-shim.js'), `
  const target = new URLSearchParams(location.search).get('target');
  const realQuery = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async () => (await realQuery({})).filter((t) => t.url === target).slice(0, 1);
  ${fakeApi}
`);
const html = readFileSync(join(dir, 'src/popup.html'), 'utf8')
  .replace('<script type="module"', '<script src="test-shim.js"></script><script type="module"');
writeFileSync(join(dir, 'src/popup.html'), html);

const browser = await puppeteer.launch({
  executablePath: CHROME, pipe: true, enableExtensions: [dir],
  args: ['--no-sandbox', `--lang=${lang}`], env: { ...process.env, LANGUAGE: lang },
});
const sw = await browser.waitForTarget((tg) => tg.url().startsWith('chrome-extension://') || tg.type() === 'service_worker', { timeout: 5000 }).catch(() => null);
let extId = sw ? new URL(sw.url()).host : null;
if (!extId) {
  // No service worker in this extension: read the id from chrome://extensions internals.
  const p = await browser.newPage();
  await p.goto('chrome://extensions');
  extId = await p.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name.startsWith('OriginLint'))?.id);
  await p.close();
}

let failures = 0;
for (const site of sites) {
  const tab = await browser.newPage();
  await tab.goto(site, { waitUntil: 'networkidle2', timeout: 45000 });
  const target = tab.url();
  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 600, deviceScaleFactor: shotDir ? 2 : 1 });
  const errors = [];
  popup.on('pageerror', (e) => errors.push(e.message));
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await popup.goto(`chrome-extension://${extId}/src/popup.html?target=${encodeURIComponent(target)}`);
  await popup.waitForSelector('.group, .status.error', { timeout: 30000 }).catch(async (e) => {
    console.log('popup stuck:', await popup.$eval('#results', (r) => r.innerText).catch(() => '?'), errors);
    throw e;
  });
  if (process.env.EC_OPTIONS) {
    const opt = await browser.newPage();
    await opt.setViewport({ width: 720, height: 900, deviceScaleFactor: 1 });
    await opt.goto(`chrome-extension://${extId}/src/options.html`);
    await opt.waitForSelector('#perms li');
    if (shotDir) await opt.screenshot({ path: join(shotDir, `options-${lang}.png`), fullPage: true });
    console.log('options perms:', await opt.$$eval('#perms li', (l) => l.map((x) => x.textContent)));
    await opt.close();
  }
  const out = await popup.evaluate(() => ({
    host: document.getElementById('host').textContent,
    chip: document.getElementById('cfchip').textContent,
    zone: document.getElementById('zone').textContent,
    summary: [...document.querySelectorAll('.sum')].map((s) => s.innerText.replace('\n', ' ')).join(' · '),
    error: document.querySelector('.status.error')?.textContent,
    items: [...document.querySelectorAll('#results .item')].map((i) =>
      `${i.querySelector('.dot').textContent.padEnd(12)} ${i.querySelector('.title').textContent}: ${i.querySelector('.detail').textContent}`),
  }));
  console.log(`\n=== ${target}  [${out.chip}] ${out.zone}\n${out.summary}`);
  if (out.error) { console.log('ERROR', out.error); failures++; }
  out.items.forEach((l) => console.log('  ' + l));
  console.log('  deep-check buttons:', await popup.$$eval('.run', (b) => b.map((x) => x.textContent)));
  if (errors.length) { console.log('popup errors:', errors); failures++; }
  if (shotDir) {
    // EC_OPENFIX=1: expand the fix hints of warnings (store screenshot "every finding comes with a fix").
    if (process.env.EC_OPENFIX) await popup.evaluate(() => document.querySelectorAll('#results .st-warn .fix').forEach((d) => { d.open = true; }));
    const h = await popup.evaluate(() => document.documentElement.scrollHeight);
    await popup.setViewport({ width: 400, height: Math.min(h, 1400), deviceScaleFactor: 2 });
    await popup.screenshot({ path: join(shotDir, new URL(target).hostname + `-${lang}${process.env.EC_OPENFIX ? '-fix' : ''}.png`), fullPage: true });
  }
  await popup.close();
  await tab.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
