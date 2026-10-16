// Read-only Cloudflare API client for "API mode". Every call is a GET; the token never
// leaves this module except in the Authorization header to api.cloudflare.com.
export const API = 'https://api.cloudflare.com/client/v4';
export const API_ORIGIN = 'https://api.cloudflare.com/*';
const TIMEOUT_MS = 10000;

export class ApiError extends Error {
  constructor(status, errors) {
    const first = (errors && errors[0]) || {};
    super(first.message || `HTTP ${status}`);
    this.status = status;
    this.code = first.code || 0;
  }
  // 403 / code 10000 mean "this token can't read that": shown as a missing permission, not a failure.
  get forbidden() {
    return this.status === 403 || this.code === 10000;
  }
}

async function get(token, path, fetchImpl = fetch) {
  const r = await fetchImpl(API + path, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok || !body || body.success === false) throw new ApiError(r.status, body && body.errors);
  return body;
}

// /user/tokens/verify only knows user-owned tokens. An account-owned token fails there, so a
// token that can list zones counts as working.
export async function verifyToken(token, fetchImpl) {
  try {
    const body = await get(token, '/user/tokens/verify', fetchImpl);
    return body.result; // { id, status: 'active' | 'disabled' | 'expired', ... }
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    try {
      await get(token, '/zones?per_page=5', fetchImpl);
      return { status: 'active' };
    } catch {
      throw e;
    }
  }
}

// Read one-by-one: GET /zones/{id}/settings (all at once) is deprecated and shuts down 2027-03-31.
export const SETTING_IDS = ['ssl', 'ssl_automatic_mode', 'min_tls_version', 'tls_1_3', 'always_use_https',
  'automatic_https_rewrites', 'development_mode', 'security_level', 'browser_check', 'email_obfuscation', 'rocket_loader'];

async function zoneSettings(token, zoneId, fetchImpl) {
  const results = await Promise.allSettled(SETTING_IDS.map((id) =>
    get(token, `/zones/${zoneId}/settings/${id}`, fetchImpl).then((b) => b.result)));
  // Nothing readable at all: report why (usually a missing Zone Settings permission).
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
  const map = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) map[SETTING_IDS[i]] = r.value;
    else if (r.status === 'rejected') map[SETTING_IDS[i]] = { error: r.reason };
  });
  return map;
}

// Walks the host's labels (www.shop.example.com -> shop.example.com -> example.com) and returns the
// first zone this token can see, so a subdomain delegated as its own zone is found too. The same name
// can be pending in other accounts, so an active zone wins.
export async function findZone(token, host, fetchImpl) {
  const labels = host.toLowerCase().split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    const body = await get(token, `/zones?name=${encodeURIComponent(name)}`, fetchImpl);
    const list = body.result || [];
    const z = list.find((x) => x.status === 'active') || list[0];
    if (z) return { id: z.id, name: z.name, status: z.status };
  }
  return null;
}

// Only DNS-only web records matter. Asking per type keeps MX/TXT records from using up the page budget.
const GREY_TYPES = ['A', 'AAAA', 'CNAME'];
const MAX_PAGES = 3;

async function greyRecords(token, zoneId, fetchImpl) {
  const perType = await Promise.all(GREY_TYPES.map(async (type) => {
    const records = [];
    let partial = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await get(token, `/zones/${zoneId}/dns_records?type=${type}&proxied=false&per_page=100&page=${page}`, fetchImpl);
      records.push(...(body.result || []));
      const pages = (body.result_info || {}).total_pages || 1;
      if (page >= pages) break;
      if (page === MAX_PAGES) partial = true;
    }
    return { records, partial };
  }));
  return { records: perType.flatMap((p) => p.records), partial: perType.some((p) => p.partial) };
}

// Each part settles on its own so one missing permission only blanks that part.
export async function collectAccount(token, host, fetchImpl) {
  const zone = await findZone(token, host, fetchImpl);
  if (!zone) return { zone: null };
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
  const [settings, dnssec, records, certs] = await Promise.all([
    settle(zoneSettings(token, zone.id, fetchImpl)),
    settle(get(token, `/zones/${zone.id}/dnssec`, fetchImpl).then((b) => b.result)),
    settle(greyRecords(token, zone.id, fetchImpl)),
    settle(get(token, `/zones/${zone.id}/ssl/certificate_packs?status=all&per_page=50`, fetchImpl).then((b) => b.result || [])),
  ]);
  return { zone, settings, dnssec, records, certs };
}
