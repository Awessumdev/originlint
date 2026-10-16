// Runs inside the inspected tab via chrome.scripting.executeScript.
// Must stay self-contained: no imports, no outer-scope references.
export async function collectPage() {
  const STATIC_RE = /\.(css|m?js|png|jpe?g|webp|avif|gif|svg|woff2?|ico)(\?|$)/i;
  const MAX_ASSETS = 3;
  const out = {
    url: location.href,
    protocol: location.protocol,
    host: location.hostname,
  };

  const nav = performance.getEntriesByType('navigation')[0];
  out.navProtocol = nav ? nav.nextHopProtocol || '' : '';

  const urls = new Set(performance.getEntriesByType('resource').map((e) => e.name));
  document.querySelectorAll('script[src]').forEach((s) => urls.add(s.src));
  document.querySelectorAll('link[rel~="stylesheet"][href]').forEach((l) => urls.add(l.href));
  const all = [...urls];

  out.signals = {
    // Rocket Loader rewrites <script type> to "<hex id>-text/javascript" and loads rocket-loader.min.js.
    rocketLoader: all.some((u) => u.includes('/rocket-loader.min.js')) ||
      [...document.querySelectorAll('script[type]')].some((s) => /^[0-9a-f]{16,}-text\/javascript$/i.test(s.type)),
    emailDecode: all.some((u) => u.includes('/email-decode.min.js')),
    rum: all.some((u) => u.includes('static.cloudflareinsights.com/beacon') || u.includes('/cdn-cgi/rum')),
    challenge: all.some((u) => u.includes('/cdn-cgi/challenge-platform/')),
  };

  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  out.metaCsp = meta ? meta.getAttribute('content') || '' : '';
  const canonical = document.querySelector('link[rel="canonical"][href]');
  out.canonical = canonical ? canonical.href : '';

  // Mixed content: http:// subresources on an https page (blocked or auto-upgraded by the browser).
  if (location.protocol === 'https:') {
    const insecure = new Set(all.filter((u) => u.startsWith('http:')));
    document.querySelectorAll('[src^="http:" i], link[rel~="stylesheet"][href^="http:" i]')
      .forEach((n) => insecure.add(n.getAttribute('src') || n.getAttribute('href')));
    out.mixed = [...insecure].slice(0, 5);
  } else {
    out.mixed = [];
  }

  async function headersOf(url) {
    try {
      const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow', signal: AbortSignal.timeout(10000) });
      const h = {};
      r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
      if (r.body) r.body.cancel().catch(() => {});
      return { url: r.url, status: r.status, headers: h };
    } catch (e) {
      return { url, error: String(e && e.message || e) };
    }
  }

  // Pick up to MAX_ASSETS same-origin static files, preferring different file types.
  const seenExt = new Set();
  const assets = [];
  for (const u of all) {
    let p;
    try { p = new URL(u); } catch { continue; }
    if (p.origin !== location.origin || p.pathname.startsWith('/cdn-cgi/')) continue;
    const m = p.pathname.match(STATIC_RE);
    if (!m) continue;
    const ext = m[1].toLowerCase();
    if (seenExt.has(ext)) continue;
    seenExt.add(ext);
    assets.push(u);
    if (assets.length === MAX_ASSETS) break;
  }

  const [page, ...assetRes] = await Promise.all([headersOf(location.href), ...assets.map(headersOf)]);
  out.page = page;
  out.assets = assetRes.filter((a) => !a.error);
  return out;
}
