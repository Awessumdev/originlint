// Renders tools/assets/icon.svg to the PNG sizes Chrome needs.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { CHROME } from './chrome.js';

const svg = readFileSync(new URL('./assets/icon.svg', import.meta.url), 'utf8');
const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: new URL(`../extension/icons/icon-${size}.png`, import.meta.url).pathname, omitBackground: true });
}
await browser.close();
console.log('icons written');
