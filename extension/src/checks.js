// Pure rule engine: (page data, dns data, extra probes, t) -> results.
// Status: pass | warn | fail | info | skip | action
const HALF_YEAR = 15552000;
const CF_CAS = ['letsencrypt.org', 'pki.goog', 'ssl.com', 'sectigo.com', 'comodoca.com', 'digicert.com'];
const CACHED = ['HIT', 'MISS', 'EXPIRED', 'REVALIDATED', 'UPDATING', 'STALE'];

export const GROUPS = ['cloudflare', 'https', 'headers', 'dns'];

export function evaluate({ page, dns, dnsError, redirect, variant, variantHost }, t) {
  const h = page.page && page.page.headers ? page.page.headers : {};
  const proxied = (h.server || '').toLowerCase() === 'cloudflare' || !!h['cf-ray'];
  const out = [];
  const add = (id, group, status, detail, fixKey = `fix_${id}`) =>
    out.push({ id, group, status, title: t(`check_${id}`), detail, fix: status === 'pass' || status === 'skip' ? '' : t(fixKey) });
  const cf = (id, fn) => (proxied ? fn() : add(id, 'cloudflare', 'skip', t('skippedNotCf')));

  // --- Cloudflare
  add('proxied', 'cloudflare', proxied ? 'pass' : 'fail',
    proxied ? t('proxied_pass', [h['cf-ray'] || 'cloudflare']) : t('proxied_fail'));

  cf('http3', () => {
    const alt = (h['alt-svc'] || '').includes('h3');
    if (page.navProtocol === 'h3') add('http3', 'cloudflare', 'pass', t('http3_pass'));
    else if (alt) add('http3', 'cloudflare', 'pass', t('http3_advertised', [page.navProtocol || '?']));
    else add('http3', 'cloudflare', 'warn', t('http3_fail'));
  });

  cf('compression', () => {
    const enc = (h['content-encoding'] || '').toLowerCase();
    if (enc === 'br' || enc === 'zstd') add('compression', 'cloudflare', 'pass', t('compression_pass', [enc]));
    else if (enc === 'gzip') add('compression', 'cloudflare', 'info', t('compression_gzip'));
    else add('compression', 'cloudflare', 'warn', t('compression_fail'));
  });

  cf('cache', () => {
    const assets = page.assets || [];
    if (!assets.length) return add('cache', 'cloudflare', 'skip', t('cache_none'));
    const label = (a) => {
      const path = new URL(a.url).pathname;
      const st = (a.headers['cf-cache-status'] || '').toUpperCase();
      return `${path.length > 40 ? '…' + path.slice(-39) : path} → ${st || t('none')}`;
    };
    const uncached = assets.filter((a) => !CACHED.includes((a.headers['cf-cache-status'] || '').toUpperCase()));
    if (!uncached.length) add('cache', 'cloudflare', 'pass', t('cache_pass', [assets.map(label).join(' · ')]));
    else add('cache', 'cloudflare', 'warn', t('cache_fail', [uncached.map(label).join(' · ')]));
  });

  cf('ipv6', () => {
    if (!dns) return add('ipv6', 'cloudflare', 'skip', t('dnsFailed', [dnsError || '?']));
    if (dns.aaaa.length) add('ipv6', 'cloudflare', 'pass', t('ipv6_pass'));
    else add('ipv6', 'cloudflare', 'warn', t('ipv6_fail', [page.host]));
  });

  const sig = page.signals || {};
  cf('rocketLoader', () => add('rocketLoader', 'cloudflare', sig.rocketLoader ? 'warn' : 'pass',
    t(sig.rocketLoader ? 'rocketLoader_fail' : 'rocketLoader_pass')));
  cf('emailObf', () => add('emailObf', 'cloudflare', sig.emailDecode ? 'info' : 'pass',
    t(sig.emailDecode ? 'emailObf_info' : 'emailObf_pass')));
  cf('rum', () => add('rum', 'cloudflare', sig.rum ? 'info' : 'pass', t(sig.rum ? 'rum_info' : 'rum_pass')));
  cf('challenge', () => add('challenge', 'cloudflare', sig.challenge ? 'info' : 'pass',
    t(sig.challenge ? 'challenge_info' : 'challenge_pass')));

  // --- HTTPS
  const https = page.protocol === 'https:';
  add('https', 'https', https ? 'pass' : 'fail', t(https ? 'https_pass' : 'https_fail'));

  if (!redirect) add('httpRedirect', 'https', 'action', t('deep_action'));
  else if (redirect.error) add('httpRedirect', 'https', 'skip', t('httpRedirect_error', [redirect.error]));
  else if (redirect.finalUrl.startsWith('https://')) add('httpRedirect', 'https', 'pass', t('httpRedirect_pass'));
  else add('httpRedirect', 'https', 'fail', t('httpRedirect_fail', [redirect.finalUrl]));

  // www <-> apex: one of them should redirect to the other, or search engines see two sites.
  if (variantHost) {
    if (!variant) add('hostVariant', 'https', 'action', t('deep_action'));
    else if (variant.noDns) add('hostVariant', 'https', 'pass', t('hostVariant_unused', [variantHost]));
    else if (variant.error) add('hostVariant', 'https', 'skip', t('hostVariant_error', [variantHost, variant.error]));
    else {
      const finalHost = new URL(variant.finalUrl).hostname;
      let canonHost = '';
      try { canonHost = page.canonical ? new URL(page.canonical).hostname : ''; } catch {}
      if (finalHost === page.host) add('hostVariant', 'https', 'pass', t('hostVariant_pass', [variantHost, page.host]));
      else if (finalHost === variantHost && canonHost === page.host)
        add('hostVariant', 'https', 'info', t('hostVariant_canonical', [variantHost, page.host]));
      else if (finalHost === variantHost) add('hostVariant', 'https', 'warn', t('hostVariant_fail', [variantHost]));
      else add('hostVariant', 'https', 'info', t('hostVariant_other', [variantHost, finalHost]));
    }
  }

  if (https) {
    const mixed = page.mixed || [];
    add('mixed', 'https', mixed.length ? 'warn' : 'pass',
      mixed.length ? t('mixed_fail', [mixed.length, mixed[0]]) : t('mixed_pass'));
  }

  const hsts = h['strict-transport-security'];
  if (!https) add('hsts', 'https', 'skip', t('https_fail'));
  else if (!hsts) add('hsts', 'https', 'warn', t('hsts_fail'));
  else {
    const age = +((hsts.match(/max-age\s*=\s*"?(\d+)/i) || [])[1] || 0);
    const days = Math.round(age / 86400);
    const flags = ['includeSubDomains', 'preload'].filter((f) => new RegExp(f, 'i').test(hsts));
    if (age >= HALF_YEAR) add('hsts', 'https', 'pass', t('hsts_pass', [days, flags.length ? ' · ' + flags.join(', ') : '']));
    else add('hsts', 'https', 'warn', t('hsts_weak', [days]));
  }

  // --- Security headers
  const csp = h['content-security-policy'] || page.metaCsp || '';
  if (csp) add('csp', 'headers', 'pass', t('csp_pass'));
  else if (h['content-security-policy-report-only']) add('csp', 'headers', 'info', t('csp_reportOnly'));
  else add('csp', 'headers', 'warn', t('csp_fail'));

  const nosniff = /nosniff/i.test(h['x-content-type-options'] || '');
  add('nosniff', 'headers', nosniff ? 'pass' : 'warn', t(nosniff ? 'nosniff_pass' : 'nosniff_fail'));

  // frame-ancestors is ignored in <meta> CSP, so only the header counts.
  const fa = ((h['content-security-policy'] || '').match(/frame-ancestors\s+([^;]*)/i) || [])[1];
  const xfo = (h['x-frame-options'] || '').trim();
  const faOpen = fa != null && fa.split(/\s+/).some((v) => v === '*' || v === 'https:' || v === 'http:');
  if (fa != null && !faOpen) add('frame', 'headers', 'pass', 'CSP frame-ancestors');
  else if (/^(deny|sameorigin)$/i.test(xfo) && fa == null) add('frame', 'headers', 'pass', `X-Frame-Options: ${xfo}`);
  else if (faOpen || xfo) add('frame', 'headers', 'warn', t('frame_weak', [faOpen ? `frame-ancestors ${fa.trim()}` : `X-Frame-Options: ${xfo}`]));
  else add('frame', 'headers', 'warn', t('frame_fail'));

  const rp = h['referrer-policy'];
  add('referrer', 'headers', rp ? 'pass' : 'info', rp || t('referrer_fail'));

  add('permissions', 'headers', h['permissions-policy'] ? 'pass' : 'info',
    t(h['permissions-policy'] ? 'permissions_pass' : 'permissions_fail'));

  const leaks = [];
  if (h['x-powered-by']) leaks.push(`X-Powered-By: ${h['x-powered-by']}`);
  if (h.server && /\d/.test(h.server)) leaks.push(`Server: ${h.server}`);
  if (h['x-aspnet-version']) leaks.push(`X-AspNet-Version: ${h['x-aspnet-version']}`);
  add('leak', 'headers', leaks.length ? 'warn' : 'pass', leaks.length ? t('leak_fail', [leaks.join(', ')]) : t('leak_pass'));

  // --- DNS & email
  if (!dns) {
    add('dnssec', 'dns', 'skip', t('dnsFailed', [dnsError || '?']));
    return out;
  }
  const z = dns.zone;
  add('dnssec', 'dns', dns.ds.length ? 'pass' : 'warn', t(dns.ds.length ? 'dnssec_pass' : 'dnssec_fail', [z]));

  const issueRecs = dns.caa.filter((c) => c.tag === 'issue' || c.tag === 'issuewild');
  const issuers = [...new Set(issueRecs.map((c) => c.value.split(';')[0].trim().toLowerCase()).filter(Boolean))];
  if (!dns.caa.length) add('caa', 'dns', 'info', t('caa_none'));
  else if (proxied && issueRecs.length && !issuers.some((i) => CF_CAS.includes(i)))
    add('caa', 'dns', 'warn', t('caa_bad', [issuers.join(', ') || ';']));
  else add('caa', 'dns', 'pass', t('caa_pass', [issuers.join(', ') || '—']));

  const spf = dns.txt.filter((s) => /^v=spf1(\s|$)/i.test(s));
  if (!spf.length) add('spf', 'dns', 'warn', t('spf_fail', [z]));
  else if (spf.length > 1) add('spf', 'dns', 'fail', t('spf_multiple', [spf.length]));
  else {
    const m = spf[0].match(/(?:^|\s)([+?~-]?all)(?=\s|$)/i);
    const all = m ? m[1].toLowerCase() : '';
    if (!all && !/(?:^|\s)redirect=/i.test(spf[0])) add('spf', 'dns', 'warn', t('spf_noAll'));
    else if (all === '+all' || all === '?all' || all === 'all') add('spf', 'dns', 'warn', t('spf_weak', [all]));
    else add('spf', 'dns', 'pass', spf[0]);
  }

  if (!dns.dmarc.length) add('dmarc', 'dns', 'warn', t('dmarc_fail', [z]));
  else {
    const p = ((dns.dmarc[0].match(/;\s*p\s*=\s*(\w+)/i) || [])[1] || 'none').toLowerCase();
    if (p === 'none') add('dmarc', 'dns', 'info', t('dmarc_none'));
    else add('dmarc', 'dns', 'pass', t('dmarc_pass', [p]));
  }
  return out;
}

export function toMarkdown(host, zone, results, t) {
  const icon = { pass: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️', skip: '⏭️', action: '🔎' };
  const lines = [`# EdgeCheck · ${host}`, zone ? `${t('zoneLabel', [zone])}` : '', ''];
  for (const g of GROUPS) {
    const rs = results.filter((r) => r.group === g);
    if (!rs.length) continue;
    lines.push(`## ${t('grp_' + g)}`);
    for (const r of rs) {
      lines.push(`- ${icon[r.status]} **${r.title}**: ${r.detail}${r.fix ? `\n  - ${t('howToFix')}: ${r.fix}` : ''}`);
    }
    lines.push('');
  }
  lines.push(`_${t('limits')}_`);
  return lines.join('\n');
}
