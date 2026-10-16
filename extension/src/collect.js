// Runs inside the inspected tab via chrome.scripting.executeScript.
// Must stay self-contained: no imports, no outer-scope references.
export async function collectPage() {
  const STATIC_RE = /\.(css|m?js|png|jpe?g|webp|avif|gif|svg|woff2?|ico)(\?|$)/i;
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
    rocketLoader: all.some((u) => u.includes('rocket-loader.min.js')) ||
      !!document.querySelector('script[type$="-text/javascript"]'),
    emailDecode: all.some((u) => u.includes('/email-decode.min.js')),
    rum: all.some((u) => u.includes('static.cloudflareinsights.com/beacon') || u.includes('/cdn-cgi/rum')),
    challenge: all.some((u) => u.includes('/cdn-cgi/challenge-platform/')),
  };

  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  out.metaCsp = meta ? meta.getAttribute('content') || '' : '';

  async function headersOf(url) {
    try {
      const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow' });
      const h = {};
      r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
      if (r.body) r.body.cancel().catch(() => {});
      return { url: r.url, status: r.status, headers: h };
    } catch (e) {
      return { url, error: String(e && e.message || e) };
    }
  }

  const asset = all.find((u) => {
    try {
      const p = new URL(u);
      return p.origin === location.origin && !p.pathname.startsWith('/cdn-cgi/') && STATIC_RE.test(p.pathname);
    } catch { return false; }
  });

  const [page, assetRes] = await Promise.all([
    headersOf(location.href),
    asset ? headersOf(asset) : Promise.resolve(null),
  ]);
  out.page = page;
  out.asset = assetRes;
  return out;
}
