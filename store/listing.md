# Chrome Web Store listing — OriginLint 0.4.0

## Name (from _locales)
- en: OriginLint — setup checker for Cloudflare® sites
- tr: OriginLint — Cloudflare® siteleri için ayar denetçisi

## Summary (from _locales, ≤132 chars)
- en: Spot forgotten Cloudflare, HTTPS, security header and DNS settings on any site, from the outside.
- tr: Herhangi bir sitede unutulmuş Cloudflare, HTTPS, güvenlik başlığı ve DNS ayarlarını dışarıdan tespit eder.

## Description — en
OriginLint finds the Cloudflare and web security settings you meant to turn on, and the ones you forgot to turn off.

Open any website, click the OriginLint icon, and get a report in a few seconds:

• Cloudflare: proxy status, HTTP/3, compression, edge caching of static files, IPv6, Rocket Loader, Email Address Obfuscation, Web Analytics beacon, JavaScript detections
• HTTPS: HTTP→HTTPS redirect, www vs. root domain redirect, HSTS, mixed content
• Security headers: Content-Security-Policy, X-Content-Type-Options, clickjacking protection, Referrer-Policy, Permissions-Policy, server version leaks
• DNS & email: DNSSEC, CAA, SPF, DMARC

Optional API mode: paste a read-only Cloudflare API token and OriginLint also checks what can't be seen from outside: SSL/TLS encryption mode, minimum TLS version, TLS 1.3, Always Use HTTPS, a forgotten Development Mode or "I'm Under Attack" mode, DNSSEC waiting for the registrar, DNS-only records and edge certificate status. The token stays in your browser and goes only to api.cloudflare.com.

Every finding tells you where to fix it in the Cloudflare dashboard. If a check doesn't fit your setup, ignore it and it stays out of your way. Copy the whole report as Markdown for a ticket or a client.

Without a token, OriginLint only looks at what a site shows publicly, so it works on any site, including ones you don't own.

Privacy: OriginLint reads only the tab you click it on. The domain name is sent to Cloudflare's public DNS resolver (cloudflare-dns.com) for DNS lookups. In API mode, your token is stored only in this browser and sent only to api.cloudflare.com. There are no analytics and no developer servers.

Cloudflare is a trademark of Cloudflare, Inc. OriginLint is an independent tool, not affiliated with or endorsed by Cloudflare.

## Description — tr
OriginLint, açmayı planladığınız ama unuttuğunuz Cloudflare ve web güvenliği ayarlarını, kapatmayı unuttuklarınızla birlikte bulur.

Herhangi bir siteyi açın, OriginLint simgesine tıklayın, birkaç saniyede raporunuz hazır:

• Cloudflare: proxy durumu, HTTP/3, sıkıştırma, statik dosyaların edge önbelleği, IPv6, Rocket Loader, e-posta adresi gizleme, Web Analytics beacon, JavaScript tespitleri
• HTTPS: HTTP→HTTPS yönlendirme, www ve kök alan adı yönlendirmesi, HSTS, karışık içerik
• Güvenlik başlıkları: Content-Security-Policy, X-Content-Type-Options, clickjacking koruması, Referrer-Policy, Permissions-Policy, sunucu sürümü sızıntısı
• DNS ve e-posta: DNSSEC, CAA, SPF, DMARC

İsteğe bağlı API modu: salt okunur bir Cloudflare API token yapıştırın; OriginLint dışarıdan görünmeyenleri de kontrol etsin: SSL/TLS şifreleme modu, minimum TLS sürümü, TLS 1.3, Always Use HTTPS, açık unutulmuş Development Mode ya da "I'm Under Attack" modu, kayıt firmasında bekleyen DNSSEC, DNS-only kayıtlar ve edge sertifika durumu. Token tarayıcınızda kalır ve yalnızca api.cloudflare.com'a gider.

Her bulgu, Cloudflare panelinde nereden düzelteceğinizi gösterir. Kurulumunuza uymayan bir kontrolü yoksayabilirsiniz. Raporun tamamını Markdown olarak kopyalayıp bir iş kaydına ya da müşterinize iletebilirsiniz.

Token olmadan OriginLint yalnızca sitenin herkese açık gösterdiklerine bakar; bu yüzden sahibi olmadığınız sitelerde de çalışır.

Gizlilik: OriginLint yalnızca tıkladığınız sekmeyi okur. Alan adı, DNS sorguları için Cloudflare'in herkese açık DNS çözümleyicisine (cloudflare-dns.com) gönderilir. API modunda token'ınız yalnızca bu tarayıcıda saklanır ve yalnızca api.cloudflare.com'a gönderilir. Analitik yok, geliştiriciye ait sunucu yok.

Cloudflare, Cloudflare, Inc.'in ticari markasıdır. OriginLint bağımsız bir araçtır; Cloudflare ile bağlantılı değildir ve onun tarafından desteklenmez.

## Category
Developer Tools

## Privacy practices tab

**Single purpose**
Checks the website in the current tab, when the user clicks the toolbar button, for misconfigurations in its Cloudflare proxy, HTTPS, security headers and DNS setup, and shows a report with fix hints. It looks at what the site exposes publicly and, optionally, at the user's own Cloudflare zone settings through a read-only API token the user provides.

**activeTab**
Gives temporary access to the current tab only after the user clicks the toolbar button, so the extension can analyze that one site.

**scripting**
After the user clicks, injects a script bundled with the extension into the active tab. It re-requests the page and up to three of its static files to read response headers, and reads which scripts the page loaded. It changes nothing on the page. No remote code is executed.

**storage**
Stores the list of checks the user chose to ignore (chrome.storage.sync, the user's own Chrome sync) and, only if the user enables API mode, their Cloudflare API token (chrome.storage.local, never synced). Nothing goes to a developer server.

**Optional host permissions (http://\*/\*, https://\*/\*)**
Never granted at install. Requested in two cases, each from an explicit user click: (1) "Run deep checks", for one site at a time, limited to that site's http:// and https:// addresses and its www/root counterpart, to verify the HTTP→HTTPS and www↔root redirects; (2) saving a Cloudflare API token in the options page, for https://api.cloudflare.com/* only, to make read-only API requests. Removing the token revokes (2).

**Remote code**
No, I am not using remote code.

**Data usage**
- Tick: Web browsing activity. Reason: the hostname of the site the user scans is sent to Cloudflare's public DNS-over-HTTPS resolver (cloudflare-dns.com) to look up DNS records. This is required for the extension's DNS checks.
- Tick: Authentication information. Reason: in the optional API mode the user's Cloudflare API token is stored locally and sent only to api.cloudflare.com to authenticate read-only requests.
- Do not tick anything else.
- Certify all three statements: data is not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL**
Host store/privacy.html at a public URL and paste it here.

## Images
- Icon 128×128: extension/icons/icon-128.png
- Screenshots 1280×800: store/screenshot-en-1.png, store/screenshot-en-2.png (tr versions for the Turkish listing)
- Small promo tile 440×280: store/promo-small.png
