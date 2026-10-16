import { collectPage } from './collect.js';
import { collectDns, hasAddress, hostVariant, isDnsName } from './dns.js';
import { evaluate, toMarkdown, GROUPS } from './checks.js';

const t = (key, subs) => chrome.i18n.getMessage(key, subs && subs.map(String)) || key;
const $ = (id) => document.getElementById(id);
const COUNTED = ['fail', 'warn', 'info', 'pass'];
const ORDER = { fail: 0, warn: 1, action: 2, info: 3 };
const TIMEOUT_MS = 10000;

// Bumped by every scan; async work from an older scan drops its result.
let generation = 0;
let deepRunning = false;

let state = {
  tab: null, page: null, dns: null, dnsError: '', redirect: null,
  variant: null, variantHost: '', results: [], muted: [], deepNote: '',
};

document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
$('version').textContent = `EdgeCheck v${chrome.runtime.getManifest().version}`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // header values are untrusted: never innerHTML
  return n;
}

function setStatus(text, isError = false) {
  $('results').replaceChildren(el('p', 'status' + (isError ? ' error' : ''), text));
}

async function loadMuted() {
  try {
    const { muted } = await chrome.storage.sync.get('muted');
    return Array.isArray(muted) ? muted : [];
  } catch { return []; }
}

async function toggleMute(id) {
  const muted = state.muted.includes(id) ? state.muted.filter((m) => m !== id) : [...state.muted, id];
  state.muted = muted;
  try { await chrome.storage.sync.set({ muted }); } catch {}
  recompute();
}

// Origins the deep checks fetch: the http:// version, the https site itself (redirect targets)
// and the www/apex counterpart.
const deepOrigins = (host, alt) =>
  [`http://${host}/*`, `https://${host}/*`, ...(alt ? [`http://${alt}/*`, `https://${alt}/*`] : [])];

async function follow(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
    r.body && r.body.cancel().catch(() => {});
    return { finalUrl: r.url };
  } catch (e) {
    // Following failed (the target isn't readable); a manual probe still shows whether it redirects.
    try {
      const m = await fetch(url, { redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (m.type === 'opaqueredirect') return { redirectedUnknown: true };
    } catch {}
    return { error: String(e.message || e) };
  }
}

const UNREADABLE = 'redirect target not readable';

async function probeHttp(host) {
  const r = await follow(`http://${host}/`);
  // A redirect we can't follow might still land on http://, so don't call it a pass.
  return r.redirectedUnknown ? { error: UNREADABLE } : r;
}

async function probeVariant(alt) {
  if (!alt) return null;
  try {
    if (!(await hasAddress(alt))) return { noDns: true };
  } catch (e) {
    return { error: String(e.message || e) };
  }
  const r = await follow(`https://${alt}/`);
  return r.redirectedUnknown ? { error: UNREADABLE } : r;
}

async function runDeepChecks() {
  if (deepRunning) return;
  const { host } = state.page;
  const alt = state.variantHost;
  const gen = generation;
  // Must be the first call in the click handler so Chrome sees the user gesture.
  const request = chrome.permissions.request({ origins: deepOrigins(host, alt) });
  deepRunning = true;
  setBusy(true);
  try {
    const granted = await request.catch(() => false);
    if (gen !== generation) return;
    if (!granted) {
      state.deepNote = t('deepDenied');
      return render();
    }
    state.deepNote = '';
    const [redirect, variant] = await Promise.all([probeHttp(host), probeVariant(alt)]);
    if (gen !== generation) return;
    state.redirect = redirect;
    state.variant = variant;
    recompute();
  } finally {
    deepRunning = false;
    if (gen === generation) setBusy(false);
  }
}

function setBusy(busy) {
  $('rescan').disabled = busy;
  document.querySelectorAll('.run').forEach((b) => { b.disabled = busy; });
}

function recompute() {
  try {
    state.results = evaluate(state, t);
    render();
  } catch (e) {
    setStatus(t('scanFailed', [e.message || e]), true);
    $('rescan').disabled = false;
    return;
  }
  const live = state.results.filter((r) => !state.muted.includes(r.id));
  const n = live.filter((r) => r.status === 'fail' || r.status === 'warn').length;
  const hasFail = live.some((r) => r.status === 'fail');
  chrome.action.setBadgeText({ tabId: state.tab.id, text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId: state.tab.id, color: hasFail ? '#b91c1c' : '#b45309' });
}

// Deep checks get a permanent spot under the summary: a button until they've run, a status after.
function renderDeep() {
  const box = $('deep');
  const ran = !!(state.redirect || state.variant);
  if (ran) {
    box.replaceChildren(el('span', 'deep-on', t('deepOn')));
    return;
  }
  const b = el('button', 'primary run', t('deepButton'));
  b.type = 'button';
  b.disabled = deepRunning;
  b.addEventListener('click', runDeepChecks);
  box.replaceChildren(b, el('span', 'deep-note', state.deepNote || t('deepHint')));
}

function itemNode(r, muted) {
  const li = el('div', `item st-${r.status}`);
  li.append(el('span', 'dot', t('st_' + r.status)), el('span', 'title', r.title));
  if (r.status !== 'pass' && r.status !== 'skip') {
    const b = el('button', 'small mute', t(muted ? 'unmute' : 'mute'));
    b.type = 'button';
    b.addEventListener('click', () => toggleMute(r.id));
    li.append(b);
  }
  li.append(el('span', 'detail', r.detail));
  if (r.fix && !muted && r.status !== 'action') {
    const d = el('details', 'fix');
    d.append(el('summary', null, t('howToFix')), el('p', null, r.fix));
    li.append(d);
  }
  return li;
}

function render() {
  const { page, dns, results, muted } = state;
  $('site').hidden = false;
  $('host').textContent = page.host;
  const proxied = results.find((r) => r.id === 'proxied')?.status === 'pass';
  $('cfchip').textContent = t(proxied ? 'onCf' : 'notCf');
  $('cfchip').className = 'chip ' + (proxied ? 'on' : 'off');
  $('zone').textContent = dns && dns.zone !== page.host ? t('zoneLabel', [dns.zone]) : '';

  const active = results.filter((r) => !muted.includes(r.id));
  $('summary').replaceChildren(...COUNTED.map((s) => {
    const box = el('div', 'sum ' + s);
    box.append(el('b', null, String(active.filter((r) => r.status === s).length)),
      el('span', null, t('sum' + s[0].toUpperCase() + s.slice(1))));
    return box;
  }));

  renderDeep();

  const groups = GROUPS.map((g) => {
    const rs = active.filter((r) => r.group === g);
    if (!rs.length) return null;
    const open = rs.filter((r) => r.status in ORDER).sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    const passed = rs.filter((r) => r.status === 'pass');
    const skipped = rs.filter((r) => r.status === 'skip');
    const sec = el('section', 'group');
    sec.append(el('h2', null, t('grp_' + g)));
    for (const r of open) sec.append(itemNode(r, false));
    if (passed.length || skipped.length) {
      const d = el('details', 'passed');
      const label = [passed.length && t('groupPassed', [passed.length]), skipped.length && t('groupSkipped', [skipped.length])]
        .filter(Boolean).join(' · ');
      d.append(el('summary', null, label), ...passed.concat(skipped).map((r) => itemNode(r, false)));
      sec.append(d);
    }
    return sec;
  }).filter(Boolean);
  $('results').replaceChildren(...groups);

  const ignored = results.filter((r) => muted.includes(r.id));
  $('ignoredBox').hidden = !ignored.length;
  $('ignoredTitle').textContent = t('ignored', [ignored.length]);
  $('ignoredList').replaceChildren(...ignored.map((r) => itemNode(r, true)));

  $('copy').disabled = false;
  $('rescan').disabled = deepRunning;
}

async function scan() {
  $('rescan').disabled = true;
  $('copy').disabled = true;
  setStatus(t('scanning'));

  const gen = ++generation;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  if (!tab || !/^https?:/.test(tab.url || '')) {
    // No url means the activeTab grant ended (the tab moved to another site since the click).
    setStatus(t(tab && !tab.url ? 'clickAgain' : 'notWeb'));
    $('rescan').disabled = false;
    return;
  }
  const host = new URL(tab.url).hostname;

  const pagePromise = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPage })
    .then((r) => r[0].result);
  const dnsPromise = isDnsName(host)
    ? collectDns(host).then((d) => ({ d }), (e) => ({ e: String(e.message || e) }))
    : Promise.resolve({ e: t('dnsNotDomain') });

  let page;
  try {
    page = await pagePromise;
    if (!page) throw new Error('no result');
    if (page.page.error) throw new Error(page.page.error);
  } catch (e) {
    if (gen !== generation) return;
    setStatus(t('scanFailed', [e.message || e]), true);
    $('rescan').disabled = false;
    return;
  }
  const dnsRes = await dnsPromise;
  const variantHost = dnsRes.d ? hostVariant(host, dnsRes.d.zone) : '';

  // Deep checks run on their own once the user has granted this site's permissions.
  let redirect = null;
  let variant = null;
  const granted = await chrome.permissions.contains({ origins: deepOrigins(host, variantHost) }).catch(() => false);
  if (granted) [redirect, variant] = await Promise.all([probeHttp(host), probeVariant(variantHost)]);
  const muted = await loadMuted();
  if (gen !== generation) return;

  state = {
    ...state, page, dns: dnsRes.d || null, dnsError: dnsRes.e || '',
    redirect, variant, variantHost, muted, deepNote: '',
  };
  recompute();
}

$('rescan').addEventListener('click', scan);
$('copy').addEventListener('click', async () => {
  const active = state.results.filter((r) => !state.muted.includes(r.id));
  try {
    await navigator.clipboard.writeText(toMarkdown(state.page.host, state.dns?.zone, active, t));
    $('copy').textContent = t('copied');
    setTimeout(() => { $('copy').textContent = t('copyReport'); }, 1500);
  } catch {}
});

scan();
