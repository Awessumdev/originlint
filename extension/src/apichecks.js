// Pure rules for API mode: (account data from cfapi.collectAccount, outside results, t) -> results.
// Results use the same shape and statuses as checks.js, in group 'account'.

// Which token permission each API part needs, as the dashboard's token editor names it.
export const PART_PERMISSION = {
  settings: 'Zone - Zone Settings - Read',
  dnssec: 'Zone - DNS - Read',
  records: 'Zone - DNS - Read',
  certs: 'Zone - SSL and Certificates - Read',
};
export const TOKEN_PERMISSIONS = ['Zone - Zone - Read', ...new Set(Object.values(PART_PERMISSION))];

// Outside checks that an API check can answer more precisely. The outside one is dropped only when
// the API gave a definite answer (pass/warn/fail), and, for page-level observations (a
// Configuration Rule can turn Rocket Loader on for one host while the zone setting is off), only
// when the outside check saw nothing either.
export const SUPERSEDES = {
  api_dnssec: { id: 'dnssec', always: true },
  api_rocketLoader: { id: 'rocketLoader', always: false },
  api_emailObf: { id: 'emailObf', always: false },
};
const DEFINITE = ['pass', 'warn', 'fail'];

export function mergeResults(outside, account) {
  const byId = Object.fromEntries(outside.map((r) => [r.id, r]));
  const replaced = new Set();
  for (const r of account) {
    const rule = SUPERSEDES[r.id];
    if (!rule || !DEFINITE.includes(r.status) || !byId[rule.id]) continue;
    const seen = byId[rule.id].status;
    if (rule.always || seen === 'pass' || seen === 'skip') replaced.add(rule.id);
  }
  return [...outside.filter((r) => !replaced.has(r.id)), ...account];
}

// Setting id -> the check that reports it, for settings that couldn't be read one by one.
const SETTING_CHECK = {
  ssl: 'api_ssl', min_tls_version: 'api_minTls', tls_1_3: 'api_tls13', always_use_https: 'api_alwaysHttps',
  automatic_https_rewrites: 'api_httpsRewrites', development_mode: 'api_devMode', security_level: 'api_securityLevel',
  browser_check: 'api_browserCheck', rocket_loader: 'api_rocketLoader', email_obfuscation: 'api_emailObf',
};
// Certificate packs that are on their way out don't count against the zone.
const RETIRED_PACKS = ['deleted', 'expired', 'pending_deletion', 'deactivating', 'inactive'];

export function evaluateAccount(acct, outside, t) {
  const out = [];
  const add = (id, status, detail) => out.push({
    id, group: 'account', status, title: t(`check_${id}`), detail,
    fix: status === 'pass' || status === 'skip' ? '' : t(`fix_${id}`),
  });

  if (acct.error) {
    const e = acct.error;
    const detail = e.forbidden ? t('api_noPerm', [TOKEN_PERMISSIONS[0]]) : t('api_error', [e.message || String(e)]);
    add('apiAccess', 'warn', detail);
    return out;
  }
  if (!acct.zone) {
    add('apiAccess', 'info', t('api_noZone', [acct.zoneName]));
    return out;
  }

  // A part the token couldn't read becomes one "missing permission" line per check that needs it.
  const part = (name, ids, fn) => {
    const p = acct[name];
    if (p && p.value !== undefined) return fn(p.value);
    const err = p && p.error;
    const detail = err && err.forbidden ? t('api_noPerm', [PART_PERMISSION[name]]) : t('api_error', [err ? err.message : '?']);
    ids.forEach((id) => add(id, 'skip', detail));
  };
  const outsideStatus = (id) => (outside.find((r) => r.id === id) || {}).status;

  part('settings', Object.values(SETTING_CHECK), (s) => {
    const v = (id) => (s[id] && !s[id].error ? s[id].value : undefined);
    for (const [id, check] of Object.entries(SETTING_CHECK)) {
      const err = s[id] && s[id].error;
      if (err) add(check, 'skip', err.forbidden ? t('api_noPerm', [PART_PERMISSION.settings]) : t('api_error', [err.message || String(err)]));
    }

    const ssl = v('ssl');
    const auto = v('ssl_automatic_mode') === 'auto' ? t('api_ssl_auto') : '';
    if (ssl === 'strict' || ssl === 'full_strict') add('api_ssl', 'pass', 'Full (strict)' + auto);
    else if (ssl === 'full') add('api_ssl', 'warn', t('api_ssl_full') + auto);
    else if (ssl === 'flexible') add('api_ssl', 'fail', t('api_ssl_flexible') + auto);
    else if (ssl === 'off') add('api_ssl', 'fail', t('api_ssl_off'));
    else if (ssl) add('api_ssl', 'info', t('api_unknown', [ssl]));

    const tls = v('min_tls_version');
    if (tls === '1.2' || tls === '1.3') add('api_minTls', 'pass', `TLS ${tls}`);
    else if (tls) add('api_minTls', 'warn', t('api_minTls_weak', [tls]));

    const t13 = v('tls_1_3');
    if (t13) add('api_tls13', t13 === 'off' ? 'warn' : 'pass', t13 === 'off' ? t('api_off') : t('api_on'));

    // Off is fine when the origin already redirects http -> https (e.g. Caddy).
    const always = v('always_use_https');
    if (always === 'on') add('api_alwaysHttps', 'pass', t('api_on'));
    else if (always === 'off' && outsideStatus('httpRedirect') === 'pass') add('api_alwaysHttps', 'pass', t('api_alwaysHttps_origin'));
    else if (always === 'off') add('api_alwaysHttps', 'warn', t('api_alwaysHttps_off'));

    const rewrites = v('automatic_https_rewrites');
    if (rewrites) add('api_httpsRewrites', rewrites === 'on' ? 'pass' : 'info', rewrites === 'on' ? t('api_on') : t('api_httpsRewrites_off'));

    const dev = v('development_mode');
    if (dev === 'on') {
      const left = s.development_mode.time_remaining;
      add('api_devMode', 'warn', t('api_devMode_on', [left ? Math.ceil(left / 60) : '?']));
    } else if (dev) add('api_devMode', 'pass', t('api_off'));

    const level = v('security_level');
    if (level === 'under_attack') add('api_securityLevel', 'warn', t('api_underAttack'));
    else if (level === 'essentially_off' || level === 'off') add('api_securityLevel', 'info', t('api_securityLevel_low', [level]));
    else if (level) add('api_securityLevel', 'pass', level);

    const bic = v('browser_check');
    if (bic) add('api_browserCheck', bic === 'on' ? 'pass' : 'info', bic === 'on' ? t('api_on') : t('api_browserCheck_off'));

    const rl = v('rocket_loader');
    if (rl) add('api_rocketLoader', rl === 'on' ? 'warn' : 'pass', rl === 'on' ? t('rocketLoader_fail') : t('api_off'));

    const eo = v('email_obfuscation');
    if (eo) add('api_emailObf', eo === 'on' ? 'info' : 'pass', eo === 'on' ? t('api_emailObf_on') : t('api_off'));
  });

  part('dnssec', ['api_dnssec'], (d) => {
    const st = (d && d.status) || '';
    if (st === 'active') add('api_dnssec', 'pass', t('api_dnssec_active'));
    else if (st === 'pending') add('api_dnssec', 'warn', t('api_dnssec_pending'));
    else if (st === 'disabled') add('api_dnssec', 'warn', t('api_dnssec_disabled'));
    else if (st === 'pending-disabled') add('api_dnssec', 'warn', t('api_dnssec_pendingDisabled'));
    else if (st === 'error') add('api_dnssec', 'fail', t('api_dnssec_error'));
    else add('api_dnssec', 'info', t('api_unknown', [st || '?']));
  });

  part('records', ['api_grey'], ({ records, partial }) => {
    const grey = records.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && r.proxiable && !r.proxied);
    const names = [...new Set(grey.map((r) => r.name))];
    // Too many records to read in full: never claim "all proxied" from a partial list.
    if (!names.length && partial) add('api_grey', 'info', t('api_grey_partial'));
    else if (!names.length) add('api_grey', 'pass', t('api_grey_none'));
    else add('api_grey', 'info', t('api_grey_some', [names.length, names.slice(0, 5).join(', ') + (names.length > 5 ? ' …' : '')]));
  });

  part('certs', ['api_certs'], (packs) => {
    const live = packs.filter((p) => !RETIRED_PACKS.includes(p.status));
    if (!live.length) return add('api_certs', 'warn', t('api_certs_none'));
    const bad = live.filter((p) => p.status !== 'active');
    const expiries = live.filter((p) => p.status === 'active')
      .flatMap((p) => (p.certificates || []).map((c) => c.expires_on)).filter(Boolean)
      .map((d) => new Date(d)).filter((d) => !isNaN(d));
    const soonest = expiries.length ? new Date(Math.min(...expiries)) : null;
    const days = soonest ? Math.floor((soonest - Date.now()) / 86400000) : null;
    if (bad.length) add('api_certs', 'warn', t('api_certs_bad', [bad.map((p) => `${p.type || 'pack'}: ${p.status}`).join(', ')]));
    else if (days !== null && days < 14) add('api_certs', 'warn', t('api_certs_expiring', [days]));
    else add('api_certs', 'pass', days !== null ? t('api_certs_ok', [days]) : t('api_certs_ok_nodate'));
  });

  return out;
}
