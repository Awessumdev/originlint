import { API_ORIGIN } from './cfapi.js';
import { score, REQUESTS_PER_SECOND } from './zonescan.js';
import { loadToken, loadReport, runAndStore, setDaily, ScanBusyError, ALARM } from './zonestore.js';

const t = (key, subs) => chrome.i18n.getMessage(key, subs && subs.map(String)) || key;
const $ = (id) => document.getElementById(id);
const ORDER = { fail: 0, warn: 1, info: 2, skip: 3, pass: 4 };

let report = null;
let muted = [];
let scanning = false;
let retryTimer = 0;

// Stored results carry only id/status/detail; titles and fixes come from the message catalog.
const hydrate = (r) => ({
  ...r,
  title: t(`check_${r.id}`),
  fix: r.status === 'pass' || r.status === 'skip' ? '' : t(`fix_${r.id}`),
});

document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
$('version').textContent = `OriginLint v${chrome.runtime.getManifest().version}`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // zone names and API messages are untrusted: never innerHTML
  return n;
}

function notice(text, kind = '', action) {
  const box = $('notice');
  box.hidden = !text;
  box.className = 'z-notice ' + kind;
  box.replaceChildren(el('span', null, text || ''));
  if (action) {
    const b = el('button', 'small', action.label);
    b.type = 'button';
    b.addEventListener('click', action.run);
    box.append(b);
  }
}

const when = (ms) => new Date(ms).toLocaleString(chrome.i18n.getUILanguage());

async function loadMuted() {
  try {
    const { muted: m } = await chrome.storage.sync.get('muted');
    return Array.isArray(m) ? m : [];
  } catch { return []; }
}

async function toggleMute(id) {
  muted = muted.includes(id) ? muted.filter((m) => m !== id) : [...muted, id];
  try { await chrome.storage.sync.set({ muted }); } catch {}
  render();
}

function itemNode(r) {
  const isMuted = muted.includes(r.id);
  const li = el('div', `item st-${r.status}`);
  li.append(el('span', 'dot', t('st_' + r.status)), el('span', 'title', r.title));
  if (r.status !== 'pass' && r.status !== 'skip') {
    const b = el('button', 'small mute', t(isMuted ? 'unmute' : 'mute'));
    b.type = 'button';
    b.addEventListener('click', () => toggleMute(r.id));
    li.append(b);
  }
  li.append(el('span', 'detail', r.detail));
  if (r.fix && !isMuted) {
    const d = el('details', 'fix');
    d.append(el('summary', null, t('howToFix')), el('p', null, r.fix));
    li.append(d);
  }
  return li;
}

const liveIds = (ids) => ids.filter((id) => !muted.includes(id));

function zoneNode(entry) {
  const results = entry.results.map(hydrate);
  const live = results.filter((r) => !muted.includes(r.id));
  const count = (s) => live.filter((r) => r.status === s).length;
  const worse = liveIds(entry.diff.worse);
  const better = liveIds(entry.diff.better);
  const fails = count('fail');
  const warns = count('warn');

  const card = el('details', 'zone' + (fails ? ' has-fail' : warns ? ' has-warn' : ''));
  card.open = worse.length > 0;
  const head = el('summary');
  const chips = el('div', 'z-chips');
  if (worse.length) chips.append(el('span', 'z-chip new', t('zones_newProblems', [worse.length])));
  if (better.length) chips.append(el('span', 'z-chip fixed', t('zones_fixed', [better.length])));
  if (entry.stale) chips.append(el('span', 'z-chip info', t('zones_stale')));
  // "Error: 1" rather than "1 errors": chrome.i18n has no plural forms.
  if (fails) chips.append(el('span', 'z-chip fail', `${t('st_fail')}: ${fails}`));
  if (warns) chips.append(el('span', 'z-chip warn', `${t('st_warn')}: ${warns}`));
  if (count('info')) chips.append(el('span', 'z-chip info', `${t('st_info')}: ${count('info')}`));
  if (!fails && !warns && !count('info')) chips.append(el('span', 'z-chip ok', t('zones_clean')));
  head.append(el('span', 'z-name', entry.zone.name), chips);

  const body = el('div', 'z-body');
  const open = results.filter((r) => r.status !== 'pass')
    .sort((a, b) => (muted.includes(a.id) - muted.includes(b.id)) || ORDER[a.status] - ORDER[b.status]);
  body.append(...open.map(itemNode));
  const passed = results.filter((r) => r.status === 'pass');
  if (passed.length) {
    const d = el('details', 'passed');
    d.append(el('summary', null, t('groupPassed', [passed.length])), ...passed.map(itemNode));
    body.append(d);
  }
  card.append(head, body);
  return card;
}

function tile(cls, n, label) {
  const box = el('div', 'sum ' + cls);
  box.append(el('b', null, String(n)), el('span', null, label));
  return box;
}

function render() {
  if (!report) {
    $('summary').hidden = true;
    $('filters').hidden = true;
    $('list').replaceChildren(el('p', 'z-empty', t('zones_empty')));
    return;
  }
  $('lastScan').textContent = t('zones_lastScan', [when(report.scannedAt)]) +
    (report.prevScannedAt ? ' · ' + t('zones_comparedTo', [when(report.prevScannedAt)]) : '');

  const entries = report.entries;
  const withFail = entries.filter((e) => e.results.some((r) => r.status === 'fail' && !muted.includes(r.id))).length;
  const withWarn = entries.filter((e) => e.results.some((r) => r.status === 'warn' && !muted.includes(r.id))).length;
  const changed = entries.filter((e) => liveIds(e.diff.worse).length).length;
  $('summary').hidden = false;
  $('summary').replaceChildren(
    tile('pass', entries.length, t('zones_tileZones')),
    tile('fail', withFail, t('zones_tileFail')),
    tile('warn', withWarn, t('zones_tileWarn')),
    tile('info', changed, t('zones_tileChanged')),
  );
  $('filters').hidden = false;

  const only = $('onlyProblems').checked;
  const shown = entries
    .filter((e) => !only || score(e.results, muted) >= 10 || liveIds(e.diff.worse).length)
    .sort((a, b) => liveIds(b.diff.worse).length - liveIds(a.diff.worse).length || score(b.results, muted) - score(a.results, muted));
  $('list').replaceChildren(...(shown.length ? shown.map(zoneNode) : [el('p', 'z-empty', t('zones_allClean'))]));

  if (report.remaining && report.remaining.length) showRemaining();
}

// After a 429 Cloudflare blocks the token for a while: the "scan the rest" button waits it out.
function showRemaining() {
  clearTimeout(retryTimer);
  if (scanning) return;
  const left = Math.ceil(((report.retryAt || 0) - Date.now()) / 1000);
  const n = report.remaining.length;
  if (left > 0) {
    notice(t('zones_rateLimitedWait', [n, Math.ceil(left / 60)]), 'warn');
    retryTimer = setTimeout(showRemaining, Math.min(left, 30) * 1000);
  } else {
    notice(t('zones_rateLimited', [n]), 'warn', { label: t('zones_scanRest'), run: () => scan(report.remaining) });
  }
}

async function scan(onlyZones) {
  if (scanning) return;
  // While Cloudflare's block lasts every request would fail; say how long instead.
  if (report && report.retryAt > Date.now()) return showRemaining();
  clearTimeout(retryTimer);
  const token = await loadToken();
  if (!token) return noToken();
  if (!(await chrome.permissions.contains({ origins: [API_ORIGIN] }).catch(() => false))) {
    return notice(t('apiNoPermission'), 'error');
  }
  scanning = true;
  $('scan').disabled = true;
  notice(t('zones_scanning'));
  $('progress').hidden = false;
  $('bar').style.width = '0';
  try {
    report = await runAndStore(token, t, {
      zones: onlyZones,
      onProgress: (done, total) => {
        $('bar').style.width = `${Math.round((done / total) * 100)}%`;
        // ~17 paced requests per zone at REQUESTS_PER_SECOND, 3 zones overlapping.
        const minutes = Math.ceil(((total - done) * 17) / REQUESTS_PER_SECOND / 60);
        notice(t('zones_progress', [done, total, minutes]));
      },
    });
    notice('');
    render();
  } catch (e) {
    notice(e instanceof ScanBusyError ? t('zones_busy') : t('zones_failed', [e.message || e]), e instanceof ScanBusyError ? 'warn' : 'error');
  } finally {
    scanning = false;
    $('scan').disabled = false;
    $('progress').hidden = true;
  }
}

function noToken() {
  $('scan').disabled = true;
  $('daily').disabled = true;
  notice(t('zones_noToken'), 'warn', { label: t('zones_openOptions'), run: () => chrome.runtime.openOptionsPage() });
}

// Daily scan: an alarm the service worker answers; notifications are asked for in this click.
$('daily').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (!on) {
    await setDaily(false);
    try { await chrome.permissions.remove({ permissions: ['notifications'] }); } catch {}
    return notice(t('zones_dailyOff'));
  }
  const granted = await chrome.permissions.request({ permissions: ['notifications'] }).catch(() => false);
  if (!granted) {
    e.target.checked = false;
    return notice(t('zones_notifyDenied'), 'warn');
  }
  await setDaily(true);
  notice(t('zones_dailyOn'));
});

$('scan').addEventListener('click', () => scan());
$('onlyProblems').addEventListener('change', render);

(async () => {
  muted = await loadMuted();
  const { dailyScan } = await chrome.storage.local.get('dailyScan').catch(() => ({}));
  $('daily').checked = !!dailyScan || !!(await chrome.alarms.get(ALARM));
  report = await loadReport();
  render();
  if (!(await loadToken())) noToken();
})();
