// MV3 service worker: collect every request host per tab. Resets on top-frame
// navigation so "reload & capture" yields exactly the domains used to load the page.
//
// The worker is evicted after ~30s idle, which wipes `sets`. chrome.storage.session
// is therefore the source of truth: writes MERGE into it and reads UNION with it,
// so a mid-capture eviction can't truncate the list. Only the two explicit reset
// points (top-frame navigation, clearCapture) overwrite.

const sets = new Map();        // tabId -> Set<host>   (in-memory cache, may be cold)
const flushTimers = new Map(); // tabId -> timeout id
const flushChain = new Map();  // tabId -> promise, serialises read-modify-write

const key = (tabId) => "cap_" + tabId;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
function add(tabId, host) {
  if (tabId < 0 || !host) return;
  let s = sets.get(tabId);
  if (!s) { s = new Set(); sets.set(tabId, s); }
  s.add(host);
  scheduleFlush(tabId);
}
function scheduleFlush(tabId) {
  if (flushTimers.has(tabId)) return;
  flushTimers.set(tabId, setTimeout(() => { flushTimers.delete(tabId); flush(tabId); }, 400));
}

// Serialised per tab: two flushes in flight would otherwise read the same
// stored array and the later write would drop the earlier one's hosts.
function flush(tabId, replace = false) {
  const run = async () => {
    const k = key(tabId);
    const mem = [...(sets.get(tabId) || [])];
    try {
      let merged = mem;
      if (!replace) {
        const stored = (await chrome.storage.session.get(k))[k] || [];
        merged = [...new Set([...stored, ...mem])];
      }
      await chrome.storage.session.set({ [k]: merged });
      sets.set(tabId, new Set(merged));
    } catch {}
  };
  const next = (flushChain.get(tabId) || Promise.resolve()).then(run, run);
  flushChain.set(tabId, next);
  return next;
}

async function readCapture(tabId) {
  const k = key(tabId);
  let stored = [];
  try { stored = (await chrome.storage.session.get(k))[k] || []; } catch {}
  return [...new Set([...stored, ...(sets.get(tabId) || [])])];
}

function reset(tabId) {
  const t = flushTimers.get(tabId);
  if (t !== undefined) { clearTimeout(t); flushTimers.delete(tabId); }
  sets.set(tabId, new Set());
  return flush(tabId, true);
}

chrome.webRequest.onCompleted.addListener(d => add(d.tabId, hostOf(d.url)), { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(d => add(d.tabId, hostOf(d.url)), { urls: ["<all_urls>"] });

chrome.webNavigation.onBeforeNavigate.addListener(d => {
  if (d.frameId === 0) reset(d.tabId);
});
chrome.tabs.onRemoved.addListener(tabId => {
  // Drop the pending timer too, or its flush would resurrect the key we just removed.
  const t = flushTimers.get(tabId);
  if (t !== undefined) { clearTimeout(t); flushTimers.delete(tabId); }
  sets.delete(tabId);
  flushChain.delete(tabId);
  chrome.storage.session.remove(key(tabId)).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "getCapture") {
    readCapture(msg.tabId).then(hosts => reply({ hosts }), () => reply({ hosts: [] }));
    return true; // async reply
  }
  if (msg && msg.type === "clearCapture") {
    reset(msg.tabId).then(() => reply({ ok: true }), () => reply({ ok: true }));
    return true;
  }
  return false;
});
