import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, toMarkdown } from '../extension/src/checks.js';
import { joinTxt, parseCaa, findZone, hostVariant, isDnsName } from '../extension/src/dns.js';

const msgs = JSON.parse(readFileSync(new URL('../extension/_locales/en/messages.json', import.meta.url)));
const t = (k, subs = []) => {
  assert.ok(msgs[k], `missing message: ${k}`);
  return msgs[k].message.replace(/\$(\d)/g, (_, i) => subs[i - 1] ?? '');
};
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));

const goodPage = {
  host: 'www.example.com', protocol: 'https:', navProtocol: 'h3', metaCsp: '',
  signals: { rocketLoader: false, emailDecode: false, rum: false, challenge: false },
  page: { status: 200, headers: {
    server: 'cloudflare', 'cf-ray': '8abc-IST', 'alt-svc': 'h3=":443"', 'content-encoding': 'br',
    'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
    'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin', 'permissions-policy': 'camera=()',
  } },
  canonical: 'https://www.example.com/', mixed: [],
  assets: [
    { url: 'https://www.example.com/_next/static/app.js', headers: { 'cf-cache-status': 'HIT' } },
    { url: 'https://www.example.com/logo.png', headers: { 'cf-cache-status': 'MISS' } },
  ],
};
const goodDns = {
  zone: 'example.com', aaaa: ['2606:4700::1'], ds: ['2371 13 2 ABC'],
  caa: [{ flags: 0, tag: 'issue', value: 'letsencrypt.org' }],
  txt: ['v=spf1 -all'], dmarc: ['v=DMARC1; p=reject'],
};

test('a well-configured site passes everything except the http probe', () => {
  const r = byId(evaluate({ page: goodPage, dns: goodDns }, t));
  for (const [id, x] of Object.entries(r)) {
    if (id === 'httpRedirect') assert.equal(x.status, 'action');
    else assert.equal(x.status, 'pass', `${id}: ${x.detail}`);
  }
  assert.match(r.hsts.detail, /365 days · includeSubDomains, preload/);
});

test('not proxied: Cloudflare checks are skipped, generic ones still run', () => {
  const page = { ...goodPage, page: { headers: { server: 'nginx/1.25.3', 'x-powered-by': 'Express' } } };
  const r = byId(evaluate({ page, dns: goodDns }, t));
  assert.equal(r.proxied.status, 'fail');
  for (const id of ['http3', 'compression', 'cache', 'ipv6', 'rocketLoader', 'rum']) assert.equal(r[id].status, 'skip');
  assert.equal(r.hsts.status, 'warn');
  assert.equal(r.leak.status, 'warn');
  assert.match(r.leak.detail, /nginx\/1\.25\.3.*|Express/);
  assert.equal(r.frame.status, 'warn');
});

test('forgotten Cloudflare settings are flagged', () => {
  const page = {
    ...goodPage, navProtocol: 'h2',
    signals: { rocketLoader: true, emailDecode: true, rum: true, challenge: true },
    page: { headers: { ...goodPage.page.headers, 'alt-svc': '', 'content-encoding': 'gzip', 'strict-transport-security': 'max-age=86400' } },
    assets: [
      { url: 'https://www.example.com/a.css', headers: { 'cf-cache-status': 'DYNAMIC' } },
      { url: 'https://www.example.com/b.js', headers: { 'cf-cache-status': 'HIT' } },
    ],
    mixed: ['http://cdn.example.net/x.js'],
  };
  const dns = { ...goodDns, aaaa: [], ds: [], txt: ['v=spf1 include:x ?all'], dmarc: ['v=DMARC1; p=none'] };
  const r = byId(evaluate({ page, dns, redirect: { finalUrl: 'http://www.example.com/' } }, t));
  const expect = {
    http3: 'warn', compression: 'info', cache: 'warn', ipv6: 'warn', rocketLoader: 'warn', emailObf: 'info',
    rum: 'info', challenge: 'info', httpRedirect: 'fail', hsts: 'warn', dnssec: 'warn', spf: 'warn', dmarc: 'info',
    mixed: 'warn',
  };
  for (const [id, st] of Object.entries(expect)) assert.equal(r[id].status, st, id);
  assert.ok(r.cache.fix && r.httpRedirect.fix);
  assert.match(r.cache.detail, /a\.css → DYNAMIC/);
  assert.doesNotMatch(r.cache.detail, /b\.js/);
});

test('www / apex variant', () => {
  const run = (variant, canonical = goodPage.canonical) =>
    byId(evaluate({ page: { ...goodPage, canonical }, dns: goodDns, variantHost: 'example.com', variant }, t)).hostVariant;
  assert.equal(run(null).status, 'action');
  assert.equal(run({ noDns: true }).status, 'pass');
  assert.equal(run({ finalUrl: 'https://www.example.com/' }).status, 'pass');
  assert.equal(run({ finalUrl: 'https://example.com/' }).status, 'info'); // duplicate, canonical points here
  assert.equal(run({ finalUrl: 'https://example.com/' }, '').status, 'warn');
  assert.equal(run({ finalUrl: 'https://shop.other.com/' }).status, 'info');
  assert.equal(run({ error: 'timeout' }).status, 'skip');
  // Other subdomains have no www/apex counterpart: the check isn't shown.
  assert.equal(byId(evaluate({ page: goodPage, dns: goodDns, variantHost: '' }, t)).hostVariant, undefined);
});

test('DNS edge cases', () => {
  const r = byId(evaluate({ page: goodPage, dns: { ...goodDns, txt: ['v=spf1 -all', 'v=spf1 ~all'], dmarc: [],
    caa: [{ flags: 0, tag: 'issue', value: 'amazon.com' }] } }, t));
  assert.equal(r.spf.status, 'fail');
  assert.equal(r.dmarc.status, 'warn');
  assert.equal(r.caa.status, 'warn');
  const noDns = byId(evaluate({ page: goodPage, dns: null, dnsError: 'timeout' }, t));
  assert.equal(noDns.dnssec.status, 'skip');
  assert.equal(noDns.ipv6.status, 'skip');
});

test('report-only CSP and meta CSP', () => {
  const h = { ...goodPage.page.headers };
  delete h['content-security-policy'];
  h['content-security-policy-report-only'] = "default-src 'self'";
  const r = byId(evaluate({ page: { ...goodPage, page: { headers: h } }, dns: goodDns }, t));
  assert.equal(r.csp.status, 'info');
  assert.equal(r.frame.status, 'warn'); // no XFO, no header CSP
  const m = byId(evaluate({ page: { ...goodPage, metaCsp: "default-src 'self'", page: { headers: h } }, dns: goodDns }, t));
  assert.equal(m.csp.status, 'pass');
});

test('markdown report contains every check', () => {
  const rs = evaluate({ page: goodPage, dns: goodDns }, t);
  const md = toMarkdown('www.example.com', 'example.com', rs, t);
  for (const r of rs) assert.ok(md.includes(r.title), r.title);
});

test('TXT and CAA parsing', () => {
  assert.equal(joinTxt('"v=spf1 include:_spf.google.com " "-all"'), 'v=spf1 include:_spf.google.com -all');
  assert.deepEqual(parseCaa('0 issue "pki.goog"'), { flags: 0, tag: 'issue', value: 'pki.goog' });
  // 0 flags, tag "issue" (5), value "pki.goog"
  const hex = '\\# 15 00 05 69 73 73 75 65 70 6b 69 2e 67 6f 6f 67';
  assert.deepEqual(parseCaa(hex), { flags: 0, tag: 'issue', value: 'pki.goog' });
});

test('findZone walks past CNAMEs to the owning zone', async () => {
  const resp = {
    'shop.brand.co.uk': { Answer: [{ name: 'shop.brand.co.uk', type: 5, data: 'x.shopify.com.' }],
      Authority: [{ name: 'shopify.com', type: 6 }] },
    'brand.co.uk': { Answer: [{ name: 'brand.co.uk.', type: 6 }] },
  };
  const fake = async (url) => {
    const name = new URL(url).searchParams.get('name');
    return { ok: true, json: async () => resp[name] || {} };
  };
  assert.equal(await findZone('shop.brand.co.uk', fake), 'brand.co.uk');
});

test('hostVariant pairs www and apex only', () => {
  assert.equal(hostVariant('example.com', 'example.com'), 'www.example.com');
  assert.equal(hostVariant('www.example.com', 'example.com'), 'example.com');
  assert.equal(hostVariant('api.example.com', 'example.com'), '');
});

test('every locale has the same keys', () => {
  const tr = JSON.parse(readFileSync(new URL('../extension/_locales/tr/messages.json', import.meta.url)));
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(msgs).sort());
});

// --- Regressions from the v0.2 review
const withDns = (patch) => byId(evaluate({ page: goodPage, dns: { ...goodDns, ...patch } }, t));
const withHeaders = (patch) => byId(evaluate({ page: { ...goodPage, page: { headers: { ...goodPage.page.headers, ...patch } } }, dns: goodDns }, t));

test('SPF: "all" inside a domain name is not the all mechanism', () => {
  assert.equal(withDns({ txt: ['v=spf1 include:spf.firewall.net -all'] }).spf.status, 'pass');
  assert.equal(withDns({ txt: ['v=spf1 include:spf.small.net ~all'] }).spf.status, 'pass');
  assert.equal(withDns({ txt: ['v=spf1 include:x.net ?all'] }).spf.status, 'warn');
  assert.equal(withDns({ txt: ['v=spf1 include:x.net'] }).spf.status, 'warn'); // no all at all
  assert.equal(withDns({ txt: ['v=spf1 redirect=_spf.x.net'] }).spf.status, 'pass');
});

test('CAA forbid-all on a proxied zone warns', () => {
  assert.equal(withDns({ caa: [{ flags: 0, tag: 'issue', value: ';' }] }).caa.status, 'warn');
  assert.equal(withDns({ caa: [{ flags: 0, tag: 'iodef', value: 'mailto:a@b.c' }] }).caa.status, 'pass');
});

test('frame protection rejects wildcards and invalid XFO', () => {
  assert.equal(withHeaders({ 'content-security-policy': "default-src 'self'; frame-ancestors *" }).frame.status, 'warn');
  assert.equal(withHeaders({ 'content-security-policy': "default-src 'self'", 'x-frame-options': 'ALLOWALL' }).frame.status, 'warn');
  assert.equal(withHeaders({ 'content-security-policy': "default-src 'self'", 'x-frame-options': 'SAMEORIGIN' }).frame.status, 'pass');
});

test('an invalid canonical URL does not throw', () => {
  const r = byId(evaluate({ page: { ...goodPage, canonical: 'http://[bad' }, dns: goodDns,
    variantHost: 'example.com', variant: { finalUrl: 'https://example.com/' } }, t));
  assert.equal(r.hostVariant.status, 'warn');
});

test('findZone ignores the SOA of a CNAME target', async () => {
  const resp = {
    'www.example.org': { Answer: [{ name: 'www.example.org', type: 5, data: 'example.com.' }, { name: 'example.com', type: 6 }] },
    'example.org': { Answer: [{ name: 'example.org.', type: 6 }] },
  };
  const fake = async (url) => ({ ok: true, json: async () => resp[new URL(url).searchParams.get('name')] || {} });
  assert.equal(await findZone('www.example.org', fake), 'example.org');
});

test('IP literals and single-label hosts skip DNS', () => {
  for (const h of ['192.168.1.10', 'localhost', '[::1]', '2001:db8::1']) assert.equal(isDnsName(h), false, h);
  assert.equal(isDnsName('example.com'), true);
});
