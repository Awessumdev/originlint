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

const dir = mkdtempSync(join(tmpdir(), 'edgecheck-e2e-'));
cpSync(new URL('../extension', import.meta.url).pathname, dir, { recursive: true });
const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf));
writeFileSync(join(dir, 'src/test-shim.js'), `
  const target = new URLSearchParams(location.search).get('target');
  const realQuery = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async () => (await realQuery({})).filter((t) => t.url === target).slice(0, 1);
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
  extId = await p.evaluate(async () => (await chrome.management.getAll()).find((e) => e.name.startsWith('EdgeCheck'))?.id);
  await p.close();
}

let failures = 0;
for (const site of sites) {
  const tab = await browser.newPage();
  await tab.goto(site, { waitUntil: 'networkidle2', timeout: 45000 });
  const target = tab.url();
  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 600 });
  const errors = [];
  popup.on('pageerror', (e) => errors.push(e.message));
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await popup.goto(`chrome-extension://${extId}/src/popup.html?target=${encodeURIComponent(target)}`);
  await popup.waitForSelector('.group, .status.error', { timeout: 30000 });
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
  if (errors.length) { console.log('popup errors:', errors); failures++; }
  if (shotDir) {
    const h = await popup.evaluate(() => document.documentElement.scrollHeight);
    await popup.setViewport({ width: 400, height: Math.min(h, 1400) });
    await popup.screenshot({ path: join(shotDir, new URL(target).hostname + `-${lang}.png`), fullPage: true });
  }
  await popup.close();
  await tab.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
