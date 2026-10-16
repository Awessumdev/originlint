// Public DNS lookups over Cloudflare DoH (JSON API, CORS-enabled).
const DOH = 'https://cloudflare-dns.com/dns-query';
const T = { A: 1, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28, DS: 43, CAA: 257 };

async function query(name, type, fetchImpl = fetch) {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  const r = await fetchImpl(url, { headers: { accept: 'application/dns-json' } });
  if (!r.ok) throw new Error(`DoH ${r.status}`);
  return r.json();
}

const answers = (res, type) => (res.Answer || []).filter((a) => a.type === T[type]);
const trimDot = (s) => s.replace(/\.$/, '').toLowerCase();

// TXT data comes back as one or more quoted chunks: "v=spf1 " "include:..."
export function joinTxt(data) {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('') : data;
}

// CAA may arrive as presentation format (0 issue "pki.goog") or RFC 3597 hex (\# 19 00 05 ...).
export function parseCaa(data) {
  const hex = data.match(/^\\#\s+\d+\s+([0-9a-f\s]+)$/i);
  if (hex) {
    const b = hex[1].replace(/\s+/g, '').match(/../g).map((x) => parseInt(x, 16));
    const tagLen = b[1];
    const tag = String.fromCharCode(...b.slice(2, 2 + tagLen));
    const value = String.fromCharCode(...b.slice(2 + tagLen));
    return { flags: b[0], tag: tag.toLowerCase(), value };
  }
  const m = data.match(/^(\d+)\s+(\S+)\s+"?(.*?)"?$/);
  return m ? { flags: +m[1], tag: m[2].toLowerCase(), value: m[3] } : null;
}

// Walk up from the host until we find the zone that owns it (SOA owner).
export async function findZone(host, fetchImpl) {
  let candidate = host.toLowerCase();
  while (candidate.split('.').length >= 2) {
    const res = await query(candidate, 'SOA', fetchImpl);
    const own = answers(res, 'SOA')[0];
    if (own) return trimDot(own.name);
    const viaCname = answers(res, 'CNAME').length > 0;
    const auth = (res.Authority || []).find((a) => a.type === T.SOA);
    if (auth && !viaCname) {
      const zone = trimDot(auth.name);
      if (candidate === zone || candidate.endsWith('.' + zone)) return zone;
    }
    candidate = candidate.slice(candidate.indexOf('.') + 1);
  }
  return host.toLowerCase();
}

// CAs climb from the host toward the root and use the first non-empty set (RFC 8659).
async function effectiveCaa(host, zone, fetchImpl) {
  let name = host.toLowerCase();
  for (;;) {
    const set = answers(await query(name, 'CAA', fetchImpl), 'CAA').map((a) => parseCaa(a.data)).filter(Boolean);
    if (set.length || name === zone || !name.includes('.')) return set;
    name = name.slice(name.indexOf('.') + 1);
  }
}

export async function collectDns(host, fetchImpl) {
  const zone = await findZone(host, fetchImpl);
  const [aaaa, ds, caa, txt, dmarc] = await Promise.all([
    query(host, 'AAAA', fetchImpl),
    query(zone, 'DS', fetchImpl),
    effectiveCaa(host, zone, fetchImpl),
    query(zone, 'TXT', fetchImpl),
    query(`_dmarc.${zone}`, 'TXT', fetchImpl),
  ]);
  return {
    zone,
    aaaa: answers(aaaa, 'AAAA').map((a) => a.data),
    ds: answers(ds, 'DS').map((a) => a.data),
    caa,
    txt: answers(txt, 'TXT').map((a) => joinTxt(a.data)),
    dmarc: answers(dmarc, 'TXT').map((a) => joinTxt(a.data)).filter((s) => /^v=DMARC1/i.test(s)),
  };
}
