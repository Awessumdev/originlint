// Composes Chrome Web Store images from popup captures in store/raw (made by test/e2e.js with
// EC_SHOTS=store/raw on https://example.com/, per EC_LANG: plain, EC_OPENFIX=1 (-fix) and
// EC_FAKEAPI=1 EC_OPENFIX=1 renamed to -api). Originally:
// `EC_SHOTS=store/raw node test/e2e.js https://example.com/`, once per EC_LANG).
//   store/screenshot-{en,tr}-{1,2}.png  1280×800
//   store/promo-small.png                440×280
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { CHROME } from './chrome.js';

const root = new URL('../', import.meta.url).pathname;
const b64 = (p) => readFileSync(root + p).toString('base64');
const icon = `data:image/png;base64,${b64('extension/icons/icon-128.png')}`;

const COPY = {
  en: [
    ['Find the Cloudflare settings you forgot',
      'One click checks HTTPS, security headers, caching and DNS on any site. From the outside, no account or API token needed.'],
    ['Every finding comes with a fix',
      'Each issue points to the place in the Cloudflare dashboard where you change it. Ignore the ones that don’t fit your setup.'],
    ['See what’s hidden from outside',
      'Add a read-only API token to check SSL mode, minimum TLS, a forgotten Development Mode, DNSSEC status and more. The token goes only to Cloudflare’s API.'],
  ],
  tr: [
    ['Unuttuğunuz Cloudflare ayarlarını bulun',
      'Tek tıkla her sitede HTTPS, güvenlik başlıkları, önbellek ve DNS kontrolü. Dışarıdan; hesap ya da API token gerekmez.'],
    ['Her bulgunun bir çözümü var',
      'Her sorun, Cloudflare panelinde nereden düzelteceğinizi gösterir. Kurulumunuza uymayanları yoksayın.'],
    ['Dışarıdan görünmeyeni de görün',
      'Salt okunur bir API token ekleyin; SSL modu, minimum TLS, açık unutulmuş Development Mode, DNSSEC durumu ve fazlası kontrol edilsin. Token yalnızca Cloudflare API’sine gider.'],
  ],
};

const FONT = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap">';
const BASE = `
  *{box-sizing:border-box} html,body{margin:0}
  body{font-family:"IBM Plex Sans",system-ui,sans-serif;color:#10201f;
    background:radial-gradient(120% 90% at 0% 0%,#e6f4f2 0%,#f5f8f8 55%,#eef2f2 100%)}`;

function screenshotHtml(lang, idx, shot) {
  const [h, p] = COPY[lang][idx];
  // 1: top of the popup · 2: HTTPS group with fix hints open · 3: API mode group
  const offset = [0, 282, 205][idx];
  return `${FONT}<style>${BASE}
    .wrap{width:1280px;height:800px;display:grid;grid-template-columns:1fr 470px;gap:56px;align-items:center;padding:0 88px}
    .brand{display:flex;gap:12px;align-items:center;font-weight:700;font-size:22px;color:#0f766e}
    .brand img{width:40px;height:40px}
    h1{font-size:50px;line-height:1.08;letter-spacing:-.01em;margin:28px 0 20px;text-wrap:balance}
    p{font-size:21px;line-height:1.5;color:#40524f;margin:0;max-width:520px}
    .frame{width:420px;height:700px;border-radius:14px;overflow:hidden;background:#fff;
      box-shadow:0 30px 60px -20px rgba(15,60,56,.35),0 0 0 1px rgba(15,60,56,.08);position:relative}
    .frame img{width:400px;margin:10px;display:block;transform:translateY(-${offset}px)}
    .frame:after{content:"";position:absolute;inset:auto 0 0;height:90px;background:linear-gradient(transparent,#fff)}
  </style>
  <div class="wrap"><div><div class="brand"><img src="${icon}" alt="">OriginLint</div><h1>${h}</h1><p>${p}</p></div>
  <div class="frame"><img src="data:image/png;base64,${shot}" alt=""></div></div>`;
}

const promoHtml = `${FONT}<style>${BASE}
  .t{width:440px;height:280px;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:0 36px;
     background:linear-gradient(135deg,#0f766e,#115e59);color:#fff}
  .r{display:flex;gap:14px;align-items:center}
  .r img{width:64px;height:64px;filter:drop-shadow(0 4px 10px rgba(0,0,0,.25))}
  b{font-size:34px;letter-spacing:-.01em} span{font-size:17px;line-height:1.4;color:#d5f1ec}
</style><div class="t"><div class="r"><img src="${icon}" alt=""><b>OriginLint</b></div>
<span>Setup checker for Cloudflare® sites. Find forgotten HTTPS, header and DNS settings in one click.</span></div>`;

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
async function render(html, w, h, out) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: root + out, clip: { x: 0, y: 0, width: w, height: h } });
  console.log(out);
}
for (const lang of ['en', 'tr']) {
  const shots = ['', '-fix', '-api'].map((suffix) => b64(`store/raw/example.com-${lang}${suffix}.png`));
  for (const idx of [0, 1, 2]) await render(screenshotHtml(lang, idx, shots[idx]), 1280, 800, `store/screenshot-${lang}-${idx + 1}.png`);
}
await render(promoHtml, 440, 280, 'store/promo-small.png');
await browser.close();
