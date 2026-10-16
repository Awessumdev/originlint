# Chrome Web Store listing — EdgeCheck 0.2.0

## Name (from _locales)
- en: EdgeCheck — setup checker for Cloudflare® sites
- tr: EdgeCheck — Cloudflare® siteleri için ayar denetçisi

## Summary (from _locales, ≤132 chars)
- en: Spot forgotten Cloudflare, HTTPS, security header and DNS settings on any site, from the outside.
- tr: Herhangi bir sitede unutulmuş Cloudflare, HTTPS, güvenlik başlığı ve DNS ayarlarını dışarıdan tespit eder.

## Description — en
EdgeCheck finds the Cloudflare and web security settings you meant to turn on, and the ones you forgot to turn off.

Open any website, click the EdgeCheck icon, and get a report in a few seconds:

• Cloudflare: proxy status, HTTP/3, compression, edge caching of static files, IPv6, Rocket Loader, Email Address Obfuscation, Web Analytics beacon, JavaScript detections
• HTTPS: HTTP→HTTPS redirect, www vs. root domain redirect, HSTS, mixed content
• Security headers: Content-Security-Policy, X-Content-Type-Options, clickjacking protection, Referrer-Policy, Permissions-Policy, server version leaks
• DNS & email: DNSSEC, CAA, SPF, DMARC

Every finding tells you where to fix it in the Cloudflare dashboard. If a check doesn't fit your setup, ignore it and it stays out of your way. Copy the whole report as Markdown for a ticket or a client.

No account, no API token. EdgeCheck only looks at what a site shows publicly, so it works on any site, including ones you don't own. Settings that aren't visible from outside (SSL mode, minimum TLS version, WAF rules) aren't reported.

Privacy: EdgeCheck reads only the tab you click it on. The domain name is sent to Cloudflare's public DNS resolver (cloudflare-dns.com) for DNS lookups. There are no analytics and no developer servers.

Cloudflare is a trademark of Cloudflare, Inc. EdgeCheck is an independent tool, not affiliated with or endorsed by Cloudflare.

## Description — tr
EdgeCheck, açmayı planladığınız ama unuttuğunuz Cloudflare ve web güvenliği ayarlarını, kapatmayı unuttuklarınızla birlikte bulur.

Herhangi bir siteyi açın, EdgeCheck simgesine tıklayın, birkaç saniyede raporunuz hazır:

• Cloudflare: proxy durumu, HTTP/3, sıkıştırma, statik dosyaların edge önbelleği, IPv6, Rocket Loader, e-posta adresi gizleme, Web Analytics beacon, JavaScript tespitleri
• HTTPS: HTTP→HTTPS yönlendirme, www ve kök alan adı yönlendirmesi, HSTS, karışık içerik
• Güvenlik başlıkları: Content-Security-Policy, X-Content-Type-Options, clickjacking koruması, Referrer-Policy, Permissions-Policy, sunucu sürümü sızıntısı
• DNS ve e-posta: DNSSEC, CAA, SPF, DMARC

Her bulgu, Cloudflare panelinde nereden düzelteceğinizi gösterir. Kurulumunuza uymayan bir kontrolü yoksayabilirsiniz. Raporun tamamını Markdown olarak kopyalayıp bir iş kaydına ya da müşterinize iletebilirsiniz.

Hesap ya da API token gerekmez. EdgeCheck yalnızca sitenin herkese açık gösterdiklerine bakar; bu yüzden sahibi olmadığınız sitelerde de çalışır. Dışarıdan görünmeyen ayarlar (SSL modu, minimum TLS sürümü, WAF kuralları) raporlanmaz.

Gizlilik: EdgeCheck yalnızca tıkladığınız sekmeyi okur. Alan adı, DNS sorguları için Cloudflare'in herkese açık DNS çözümleyicisine (cloudflare-dns.com) gönderilir. Analitik yok, geliştiriciye ait sunucu yok.

Cloudflare, Cloudflare, Inc.'in ticari markasıdır. EdgeCheck bağımsız bir araçtır; Cloudflare ile bağlantılı değildir ve onun tarafından desteklenmez.

## Category
Developer Tools

## Privacy practices tab

**Single purpose**
Checks the website in the current tab, when the user clicks the toolbar button, for externally visible misconfigurations in its Cloudflare proxy, HTTPS, security headers and DNS setup, and shows a report with fix hints.

**activeTab**
Gives temporary access to the current tab only after the user clicks the toolbar button, so the extension can analyze that one site.

**scripting**
After the user clicks, injects a script bundled with the extension into the active tab. It re-requests the page and up to three of its static files to read response headers, and reads which scripts the page loaded. It changes nothing on the page. No remote code is executed.

**storage**
Stores the list of checks the user chose to ignore, so they stay hidden next time. It is kept in chrome.storage.sync (the user's own Chrome sync); nothing goes to a developer server.

**Optional host permissions (http://\*/\*, https://\*/\*)**
Never granted at install. Requested for one site at a time, only when the user clicks "Run deep checks", and limited to that site's http:// and https:// addresses and its www/root counterpart. Used to verify the HTTP→HTTPS redirect and the www↔root redirect.

**Remote code**
No, I am not using remote code.

**Data usage**
- Tick: Web browsing activity. Reason: the hostname of the site the user scans is sent to Cloudflare's public DNS-over-HTTPS resolver (cloudflare-dns.com) to look up DNS records. This is required for the extension's DNS checks.
- Do not tick anything else.
- Certify all three statements: data is not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL**
Host store/privacy.html at a public URL and paste it here.

## Images
- Icon 128×128: extension/icons/icon-128.png
- Screenshots 1280×800: store/screenshot-en-1.png, store/screenshot-en-2.png (tr versions for the Turkish listing)
- Small promo tile 440×280: store/promo-small.png
