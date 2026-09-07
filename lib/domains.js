// Domain helpers: normalization and registrable-domain grouping (compact PSL).

// Compact multi-label public suffix set. NOT the full PSL — good enough for
// grouping the collector view.
const TWO_LEVEL = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp", "go.jp", "ac.jp",
  "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.hk", "com.sg",
  "co.kr", "co.in", "co.il", "co.za",
  "com.ua", "net.ua", "org.ua", "in.ua",
  "msk.ru", "spb.ru",
]);

export function isIp(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(":") && /^[0-9a-f:]+$/i.test(h));
}

// returns clean hostname or null if not a usable domain
export function normalizeHost(raw) {
  if (!raw) return null;
  let h = String(raw).trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "").split("/")[0].split("?")[0];
  h = h.replace(/:\d+$/, "").replace(/\.$/, "");
  if (h.startsWith("*.")) h = h.slice(2);
  if (h.startsWith(".")) h = h.slice(1);
  if (!h || isIp(h) || !h.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) {
    try { h = new URL("http://" + h).hostname; } catch { return null; }
  }
  return h;
}

export function registrable(host) {
  const p = host.split(".");
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join(".");
  if (TWO_LEVEL.has(last2)) return p.slice(-3).join(".");
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
