import { collectPage } from './collect.js';
import { collectDns } from './dns.js';
import { evaluate, toMarkdown, GROUPS } from './checks.js';

const t = (key, subs) => chrome.i18n.getMessage(key, subs && subs.map(String)) || key;
const $ = (id) => document.getElementById(id);
const COUNTED = ['fail', 'warn', 'info', 'pass'];

let state = { tab: null, page: null, dns: null, dnsError: '', redirect: null, results: [], muted: [] };

document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // header values are untrusted: never innerHTML
  return n;
}

function setStatus(text, isError = false) {
  const main = $('results');
  main.replaceChildren(el('p', 'status' + (isError ? ' error' : ''), text));
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
  render();
}

const httpOrigin = (host) => `http://${host}/*`;

async function probeHttp(host) {
  const url = `http://${host}/`;
  try {
    const r = await fetch(url, { redirect: 'follow', cache: 'no-store', credentials: 'omit' });
    r.body && r.body.cancel().catch(() => {});
    return { finalUrl: r.url };
  } catch (e) {
    // Following failed (e.g. the https target isn't readable); a manual probe still shows whether it redirects.
    try {
      const m = await fetch(url, { redirect: 'manual', cache: 'no-store', credentials: 'omit' });
      if (m.type === 'opaqueredirect') return { finalUrl: 'https://' };
    } catch {}
    return { error: String(e.message || e) };
  }
}

async function runRedirectCheck() {
  const host = state.page.host;
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [httpOrigin(host)] }); } catch {}
  if (!granted) return;
  state.redirect = await probeHttp(host);
  recompute();
}

function recompute() {
  state.results = evaluate(state, t);
  render();
  const n = state.results.filter((r) => !state.muted.includes(r.id) && (r.status === 'fail' || r.status === 'warn')).length;
  const hasFail = state.results.some((r) => !state.muted.includes(r.id) && r.status === 'fail');
  chrome.action.setBadgeText({ tabId: state.tab.id, text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId: state.tab.id, color: hasFail ? '#b91c1c' : '#b45309' });
}

function itemNode(r, muted) {
  const li = el('div', `item st-${r.status}`);
  li.append(el('span', 'dot', t('st_' + r.status)), el('span', 'title', r.title));
  if (r.status !== 'pass' && r.status !== 'skip') {
    const b = el('button', 'ghost small mute', t(muted ? 'unmute' : 'mute'));
    b.type = 'button';
    b.addEventListener('click', () => toggleMute(r.id));
    li.append(b);
  }
  li.append(el('span', 'detail', r.detail));
  if (r.id === 'httpRedirect' && r.status === 'action' && !muted) {
    const b = el('button', 'small primary run', t('check'));
    b.type = 'button';
    b.addEventListener('click', runRedirectCheck);
    li.append(b);
  }
  if (r.fix && !muted) {
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
    box.append(el('b', null, String(active.filter((r) => r.status === s).length)), el('span', null, t('sum' + s[0].toUpperCase() + s.slice(1))));
    return box;
  }));

  const order = { fail: 0, warn: 1, action: 2, info: 3, pass: 4, skip: 5 };
  const groups = GROUPS.map((g) => {
    const rs = active.filter((r) => r.group === g).sort((a, b) => order[a.status] - order[b.status]);
    if (!rs.length) return null;
    const sec = el('section', 'group');
    sec.append(el('h2', null, t('grp_' + g)), ...rs.map((r) => itemNode(r, false)));
    return sec;
  }).filter(Boolean);
  $('results').replaceChildren(...groups);

  const ignored = results.filter((r) => muted.includes(r.id));
  $('ignoredBox').hidden = !ignored.length;
  $('ignoredTitle').textContent = t('ignored', [ignored.length]);
  $('ignoredList').replaceChildren(...ignored.map((r) => itemNode(r, true)));

  $('copy').disabled = false;
  $('rescan').disabled = false;
}

async function scan() {
  $('rescan').disabled = true;
  $('copy').disabled = true;
  setStatus(t('scanning'));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  if (!tab || !/^https?:/.test(tab.url || '')) {
    setStatus(t('notWeb'));
    return;
  }
  const host = new URL(tab.url).hostname;

  const pagePromise = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPage })
    .then((r) => r[0].result);
  const dnsPromise = collectDns(host).then((d) => ({ d }), (e) => ({ e: String(e.message || e) }));
  const redirectPromise = chrome.permissions.contains({ origins: [httpOrigin(host)] })
    .then((ok) => (ok ? probeHttp(host) : null));

  let page;
  try {
    page = await pagePromise;
    if (!page) throw new Error('no result');
  } catch (e) {
    setStatus(t('scanFailed', [e.message || e]), true);
    $('rescan').disabled = false;
    return;
  }
  const [dnsRes, redirect, muted] = await Promise.all([dnsPromise, redirectPromise, loadMuted()]);
  state = { ...state, page, dns: dnsRes.d || null, dnsError: dnsRes.e || '', redirect, muted };
  recompute();
}

$('rescan').addEventListener('click', scan);
$('copy').addEventListener('click', async () => {
  const active = state.results.filter((r) => !state.muted.includes(r.id));
  await navigator.clipboard.writeText(toMarkdown(state.page.host, state.dns?.zone, active, t));
  $('copy').textContent = t('copied');
  setTimeout(() => { $('copy').textContent = t('copyReport'); }, 1500);
});

scan();
