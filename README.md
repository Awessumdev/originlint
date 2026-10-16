# OriginLint — Cloudflare setup checker

Chrome (MV3) extension that spots forgotten Cloudflare, HTTPS, security-header and DNS settings
on any site **from the outside** — no Cloudflare account or API token needed.

## How it works
Click the toolbar icon on a site:
1. `collect.js` is injected into the tab (`activeTab` + `scripting`): re-fetches the page and one
   same-origin static file to read response headers, and reads resource timing for injected
   Cloudflare scripts (Rocket Loader, email-decode, Web Analytics beacon, challenge-platform).
2. `dns.js` queries Cloudflare DoH (`cloudflare-dns.com`, CORS-enabled): zone, AAAA, DS, CAA, SPF, DMARC.
3. `checks.js` (pure, unit-tested) turns that into pass / warn / fail / info results with fix hints.
4. "Run deep checks" asks, per site, for the host's http/https origins and its www/apex counterpart,
   then verifies the HTTP→HTTPS and www↔apex redirects. Once granted, they run on every scan of that site.

Install-time permissions: `activeTab`, `scripting`, `storage` — no host access warning.
Optional host permissions are requested only from a click (deep checks, saving an API token).
Ignored checks are stored in `chrome.storage.sync`.

**Not visible from outside:** SSL mode, minimum TLS version, Development Mode, DNSSEC status and
similar zone settings. Those come from the optional API mode below.

## API mode (optional)
The options page (`src/options.html`) takes a read-only Cloudflare API token
(Zone - Zone / Zone Settings / DNS / SSL and Certificates - Read). On save it asks for
`https://api.cloudflare.com/*` inside the click, verifies the token, and stores it in
`chrome.storage.local` (never synced). The popup then reads the scanned zone with GETs only
(`src/cfapi.js`) and adds a "Cloudflare account (API)" group (`src/apichecks.js`).
- Settings are read one by one (`/zones/{id}/settings/{id}`); the all-settings call is deprecated
  and shuts down 2027-03-31.
- A part the token can't read (403 / code 10000) becomes a "missing permission" line for its checks.
- An API check that could be read replaces its outside twin (Rocket Loader, email obfuscation, DNSSEC).
- `EC_FAKEAPI=1 npm run e2e -- <url>` runs the popup against a fake api.cloudflare.com fixture.

## Development
```bash
npm run locales   # tools/gen_locales.py -> _locales/{en,tr}
npm run icons     # tools/assets/icon.svg -> icons/*.png
npm test          # rule engine unit tests
npm run e2e -- https://example.com/   # real Chrome + real popup against live sites
npm run zip       # originlint.zip for the Chrome Web Store
npm run store     # store/ screenshots + promo tile (needs store/raw captures, see tools/store-assets.js)
```
`EC_NARROW=1 npm run e2e -- <url>` grants only the scanned https origin (like activeTab), so deep checks stay pending.
Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.

## Chrome Web Store
Everything for the submission is in `store/`: `listing.md` (descriptions EN/TR, single purpose,
permission justifications, data-usage answers), `privacy.html` (must be hosted at a public URL),
screenshots and the promo tile.

### Notes
- Privacy policy must disclose: the hostname being scanned is sent to Cloudflare's public DNS
  resolver (cloudflare-dns.com) for DNS lookups. Nothing else leaves the browser; no analytics.
- Name uses "Cloudflare" descriptively; the extension is not affiliated with Cloudflare, Inc.
  (say so in the store description). No Cloudflare logo or orange in the branding.
