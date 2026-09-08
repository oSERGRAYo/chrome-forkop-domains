// Domain helpers: normalization and registrable-domain grouping (compact PSL).

// Compact multi-label public suffix set. NOT the full PSL — good enough for
// grouping the collector view. Anything not listed still falls back to the
// TWO_LEVEL_HEURISTIC below, so a missing entry narrows a group rather than
// widening it to a whole national zone.
const TWO_LEVEL = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "go.jp", "ac.jp",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "com.ar", "com.tr", "gov.tr", "edu.tr",
  "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "com.sg", "com.tw", "com.vn",
  "co.kr", "or.kr", "co.in", "co.il", "co.za", "co.th", "co.id",
  "com.my", "com.ph", "com.pk", "com.ng", "com.eg", "com.sa",
  "com.co", "com.pe", "com.ec", "com.uy", "com.ve",
  "com.pl", "net.pl", "org.pl",
  "com.ua", "net.ua", "org.ua", "in.ua",
  "com.ru", "net.ru", "org.ru", "pp.ru", "msk.ru", "spb.ru",
]);

// Second-level suffixes that behave like a public suffix but are operated by a
// single provider ("private" PSL section). Grouping by the bare apex here would
// hand forkop a rule covering every customer of that host — one `domain_suffix`
// entry for `github.io` proxies all of GitHub Pages.
const PRIVATE_SUFFIX = new Set([
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "r2.dev",
  "vercel.app", "netlify.app", "netlify.com", "herokuapp.com",
  "appspot.com", "web.app", "firebaseapp.com", "blogspot.com",
  "cloudfront.net", "akamaized.net", "azureedge.net", "fastly.net",
  "amazonaws.com", "s3.amazonaws.com", "compute.amazonaws.com",
]);

// A dotted pair like "co.id" / "com.pl" is a public suffix in most ccTLDs even
// when it is not spelled out above. Matching it keeps the group one label
// narrower (safer) instead of collapsing to the national zone.
const TWO_LEVEL_HEURISTIC = /^(com|net|org|edu|gov|co|ac|mil|int|nom|gob)\.[a-z]{2}$/;

// Bare-IP literals must never reach forkop: `domain`/`domain_suffix` are
// hostname matchers, and `registrable("104.21.5.9")` would otherwise yield "5.9".
export function isIp(h) {
  if (!h) return false;
  const s = String(h).replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split(".").every((o) => Number(o) <= 255);
  return s.includes(":") && /^[0-9a-f:.]+$/i.test(s);
}

// Every label must be 1-63 chars of letters/digits/hyphen, not starting or
// ending with a hyphen; the TLD must be alphabetic (or a punycode `xn--` label).
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

// returns clean hostname or null if not a usable domain
export function normalizeHost(raw) {
  if (!raw) return null;
  let h = String(raw).trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");   // scheme
  h = h.split(/[/?#]/)[0];                        // path / query / fragment
  h = h.replace(/^[^@/]*@/, "");                  // userinfo
  if (h.startsWith("[")) {                        // bracketed IPv6 literal
    return null;
  }
  h = h.replace(/:\d+$/, "").replace(/\.$/, "");  // port, root dot
  if (h.startsWith("*.")) h = h.slice(2);
  if (h.startsWith(".")) h = h.slice(1);
  if (!h || isIp(h) || !h.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) {
    // IDN → punycode via the URL parser, then re-validate.
    try { h = new URL("http://" + h).hostname; } catch { return null; }
    if (h.startsWith("[") || !/^[a-z0-9.-]+$/.test(h)) return null;
  }
  if (h.length > 253) return null;
  const parts = h.split(".");
  if (parts.length < 2 || !parts.every((p) => LABEL.test(p))) return null;
  if (!TLD.test(parts[parts.length - 1])) return null;   // rejects "5.9", "host.123"
  return h;
}

export function registrable(host) {
  if (isIp(host)) return host;           // never split an IP literal on dots
  const p = host.split(".");
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join(".");
  const last3 = p.slice(-3).join(".");
  // Longest private suffix first: "s3.amazonaws.com" must beat "amazonaws.com".
  if (p.length > 3 && PRIVATE_SUFFIX.has(last3)) return p.slice(-4).join(".");
  if (PRIVATE_SUFFIX.has(last2)) return p.slice(-3).join(".");
  if (TWO_LEVEL.has(last2) || TWO_LEVEL_HEURISTIC.test(last2)) return last3;
  return last2;
}

// Group hosts by registrable domain for a compact collector view.
export function groupByRegistrable(hosts) {
  const m = new Map();
  for (const h of hosts) {
    const r = registrable(h);
    if (!m.has(r)) m.set(r, new Set());
    m.get(r).add(h);
  }
  return [...m.entries()]
    .map(([reg, set]) => ({ reg, hosts: [...set].sort() }))
    .sort((a, b) => a.reg.localeCompare(b.reg));
}
