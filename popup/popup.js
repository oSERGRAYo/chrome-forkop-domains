// Popup: manual domain management + per-tab domain collector for a forkop section.
//
// Two matchers per section are managed together:
//   • "exact"  → forkop `domain`         — matches the host verbatim, nothing else
//   • "suffix" → forkop `domain_suffix`  — matches the apex AND every subdomain
// A host can be exactly one of them here. `domain_suffix` already covers the
// bare apex, so a host that the router keeps in *both* lists is folded to
// "suffix" on read and rewritten to `domain_suffix` only on the next apply.
import { Ubus, UbusError } from "../lib/ubus.js";
import { normalizeHost, groupByRegistrable } from "../lib/domains.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  sectionSel: $("sectionSel"),
  domList: $("domList"),
  addForm: $("addForm"),
  addInput: $("addInput"),
  addMode: $("addMode"),
  pendingBar: $("pendingBar"),
  pendingText: $("pendingText"),
  applyBtn: $("applyBtn"),
  revertBtn: $("revertBtn"),
  reloadCap: $("reloadCap"),
  refreshCap: $("refreshCap"),
  collectSectionSel: $("collectSectionSel"),
  addSelected: $("addSelected"),
  capAll: $("capAll"),
  capCount: $("capCount"),
  capList: $("capList"),
  openOptions: $("openOptions"),
};

// UCI option name per matcher.
const OPT = { exact: "domain", suffix: "domain_suffix" };
const MODE_LABEL = { exact: "точный", suffix: "поддомены" };

const CFG_KEYS = ["routerUrl", "user", "pass", "applyCmd"];
const DEFAULT_CFG = { applyCmd: "" };
let cfg = { ...DEFAULT_CFG };
let ubus = null;
let sections = [];          // [{name, label, text}]
let section = null;         // current section name
let committed = new Map();  // host -> "exact" | "suffix", as stored on the router
let pending = new Map();    // host -> "exact" | "suffix", after local edits
let groups = [];            // collector groups [{reg, hosts}]
let busy = false;           // an apply is in flight — every mutating control is locked
let ready = false;          // connected AND at least one section exists
let selectToken = 0;        // guards against a stale selectSection response landing late

// A single switch for everything that can mutate `pending` or `section`.
// apply() takes a snapshot up front, so anything the user changes mid-flight
// would silently diverge from what actually reached the router.
function setBusy(v) {
  busy = v;
  const lock = v || !ready;
  els.applyBtn.disabled = els.revertBtn.disabled = v;
  els.sectionSel.disabled = els.collectSectionSel.disabled = lock;
  els.addInput.disabled = els.addSelected.disabled = lock;
  for (const b of els.addForm.querySelectorAll("button, select")) b.disabled = lock;
  for (const b of els.domList.querySelectorAll("button")) b.disabled = v;
}

// ---------- status ----------
function setStatus(msg, cls) {
  els.status.textContent = "";
  els.status.className = cls || "";
  els.status.hidden = false;
  els.status.append(document.createTextNode(msg));
}
function statusWithOptionsLink(msg) {
  setStatus(msg + " ", "err");
  const a = document.createElement("a");
  a.href = "#";
  a.textContent = "Открыть настройки";
  a.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  els.status.append(a);
}
function clearStatus() { els.status.hidden = true; els.status.textContent = ""; els.status.className = ""; }
function fail(e) {
  console.error(e);
  setStatus(e && e.message ? e.message : String(e), "err");
}

// ---------- config ----------
const CFG_SCHEMA = 3;

async function loadConfig() {
  const stored = await chrome.storage.local.get([...CFG_KEYS, "cfgSchema", "domainOption"]);
  // schema < 3: force `applyCmd` back to "auto".
  //   • v1.0.0 always persisted applyCmd:"restart" (no "auto" choice existed),
  //     and apply() then fired `/etc/init.d/forkop restart` on top of forkop's
  //     own config.change restart → two teardowns → half-flushed nftables.
  //   • that explicit restart also always trips ubus TIMEOUT (the init script
  //     outlives rpcd's ~30s call window), surfacing as an error in the popup.
  // Commit-only is proven to apply both `domain` and `domain_suffix` in <15s,
  // so "auto" is the right default. Someone on a trigger-less forkop build
  // re-picks reload/restart in options (apply() now tolerates the TIMEOUT).
  if (!(stored.cfgSchema >= CFG_SCHEMA)) {
    await chrome.storage.local.remove(["applyCmd", "domainOption"]);
    await chrome.storage.local.set({ cfgSchema: CFG_SCHEMA });
    delete stored.applyCmd;
    delete stored.domainOption;
  }
  cfg = { ...DEFAULT_CFG, ...stored };
  return cfg.routerUrl && cfg.user && cfg.pass;
}

// Remember which section the user was last looking at, so reopening the popup
// doesn't silently drop them onto sections[0] (which reads as "my list vanished").
async function loadLastSection() {
  try { return (await chrome.storage.local.get("lastSection")).lastSection || null; }
  catch { return null; }
}
function saveLastSection(name) {
  chrome.storage.local.set({ lastSection: name }).catch(() => {});
}

// One transparent retry — a single dropped request on open shouldn't blank the UI.
async function withRetry(fn, tries = 2) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

// ---------- router ----------
async function connect() {
  ubus = new Ubus(cfg.routerUrl);
  await ubus.login(cfg.user, cfg.pass);
  const values = await ubus.uciGetAll("forkop");
  sections = Object.values(values)
    .filter((s) => s && s[".type"] === "section" && s[".name"] !== "settings")
    .map((s) => {
      const name = s[".name"];
      const label = s.label || "";
      return { name, label, text: label ? `${name} (${label})` : name };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!sections.length) {
    // Nothing to edit: leave the form inert rather than letting "Применить"
    // fire `uci set` with section === null.
    setStatus("В forkop нет секций — расширению нечего редактировать.", "err");
    ready = false;
    setBusy(false);
    return;
  }
  ready = true;

  for (const sel of [els.sectionSel, els.collectSectionSel]) {
    sel.textContent = "";
    for (const s of sections) {
      const o = document.createElement("option");
      o.value = s.name;
      o.textContent = s.text;
      sel.append(o);
    }
  }

  const last = await loadLastSection();
  const start = sections.some((s) => s.name === last) ? last : sections[0].name;
  els.collectSectionSel.value = start;
  await selectSection(start);
}

function normalizeList(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v.slice() : [String(v)];
}

async function selectSection(name) {
  clearStatus();
  // Every read carries a token; a slow response for an abandoned section must
  // not overwrite the list the user has since switched to.
  const token = ++selectToken;
  let ex, sf;
  try {
    [ex, sf] = await Promise.all([
      ubus.uciGet("forkop", name, OPT.exact),
      ubus.uciGet("forkop", name, OPT.suffix),
    ]);
  } catch (e) {
    // Don't wipe the list we're already showing on a transient read failure —
    // surface the error and keep the <select> on the section that's live.
    if (token !== selectToken) return;
    fail(e);
    if (section) els.sectionSel.value = section;
    return;
  }
  if (token !== selectToken) return;
  section = name;
  els.sectionSel.value = name;
  saveLastSection(name);
  committed = new Map();
  for (const h of normalizeList(sf).filter(Boolean)) committed.set(h, "suffix");
  for (const h of normalizeList(ex).filter(Boolean)) {
    // A host in `domain` only → exact. A host in both lists → `domain_suffix`
    // already covers it, so keep it as "suffix" (this quietly de-dups on apply).
    if (!committed.has(h)) committed.set(h, "exact");
  }
  pending = new Map(committed);
  renderDomains();
}

// ---------- domains tab ----------
// added   — in pending, not committed
// removed — in committed, not pending
// changed — in both, but the matcher was flipped
function diff() {
  const added = [], removed = [], changed = [];
  for (const [h, m] of pending) {
    if (!committed.has(h)) added.push(h);
    else if (committed.get(h) !== m) changed.push(h);
  }
  for (const h of committed.keys()) if (!pending.has(h)) removed.push(h);
  return { added, removed, changed };
}

function renderDomains() {
  const hosts = [...new Set([...committed.keys(), ...pending.keys()])].sort();
  els.domList.textContent = "";

  if (!hosts.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Список пуст";
    els.domList.append(li);
  }

  for (const h of hosts) {
    const inC = committed.has(h), inP = pending.has(h);
    const mode = inP ? pending.get(h) : committed.get(h);

    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "grow";
    name.textContent = h;
    li.append(name);

    // matcher badge — click to flip exact <-> suffix (only while the host is in pending)
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "mode mode-" + mode;
    badge.textContent = MODE_LABEL[mode];
    if (inP && !busy) {
      badge.title = "переключить точный / с поддоменами";
      badge.addEventListener("click", () => {
        pending.set(h, pending.get(h) === "suffix" ? "exact" : "suffix");
        renderDomains();
      });
    } else {
      badge.disabled = true;
    }
    li.append(badge);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.disabled = busy;
    if (inP && !inC) {
      li.className = "added";
      btn.textContent = "убрать";
      btn.addEventListener("click", () => { pending.delete(h); renderDomains(); });
    } else if (inC && !inP) {
      li.className = "removed";
      btn.textContent = "вернуть";
      btn.addEventListener("click", () => { pending.set(h, committed.get(h)); renderDomains(); });
    } else {
      if (inC && committed.get(h) !== pending.get(h)) li.className = "changed";
      btn.textContent = "×";
      btn.title = "удалить";
      btn.addEventListener("click", () => { pending.delete(h); renderDomains(); });
    }
    li.append(btn);
    els.domList.append(li);
  }

  const { added, removed, changed } = diff();
  if (added.length || removed.length || changed.length) {
    const parts = [`+${added.length}`, `−${removed.length}`];
    if (changed.length) parts.push(`↹${changed.length}`);
    els.pendingText.textContent = parts.join(" / ");
    els.pendingBar.hidden = false;
  } else {
    els.pendingBar.hidden = true;
  }
}

// Add hosts from free text under the given matcher. Re-adding an existing host
// just moves it to `mode` (handy: paste a list, flip the ones you want exact).
function addFromText(text, mode = "suffix") {
  const parts = String(text).split(/[\s,]+/).filter(Boolean);
  let n = 0;
  const bad = [];
  for (const p of parts) {
    const h = normalizeHost(p);
    // Say what was thrown away — silently dropping input reads as "«+» сломан".
    if (!h) { bad.push(p); continue; }
    if (pending.get(h) !== mode) { pending.set(h, mode); n++; }
  }
  renderDomains();
  return { added: n, rejected: bad };
}

async function apply() {
  if (busy || !ready || !section) return;
  // Snapshot both the target section and the edit set. Everything below is
  // async, and `section`/`pending` are module state: without the snapshot a
  // mid-flight section switch could write the two options into DIFFERENT
  // sections, and `committed = pending` at the end would swallow edits made
  // during the request as if they had been saved.
  const sec = section;
  const snap = new Map(pending);
  setBusy(true);
  renderDomains();
  try {
    setStatus("Применяю…", "");
    const lists = { exact: [], suffix: [] };
    for (const [h, m] of snap) lists[m].push(h);
    lists.exact.sort();
    lists.suffix.sort();

    for (const mode of ["exact", "suffix"]) {
      const list = [...new Set(lists[mode])];
      if (list.length) await ubus.uciSet("forkop", sec, { [OPT[mode]]: list });
      else await ubus.uciDelete("forkop", sec, OPT[mode]);
    }

    // `uci commit` emits a `config.change` service event; forkop reacts to it
    // with a single restart via its own procd trigger — exactly like LuCI's
    // "Save & Apply", and it recompiles both `domain` and `domain_suffix` into
    // the sing-box route rules. Firing an extra `/etc/init.d/forkop restart`
    // here would run a second teardown in parallel and can leave the nftables
    // ruleset half-flushed. So by default we only commit. `applyCmd` stays as
    // an opt-in escape hatch for forkop builds without the trigger.
    await ubus.uciCommit("forkop");
    if (cfg.applyCmd) {
      try {
        const r = await ubus.exec("/etc/init.d/forkop", [cfg.applyCmd]);
        if (r && typeof r.code === "number" && r.code !== 0) {
          throw new Error(`forkop ${cfg.applyCmd} → код ${r.code}${r.stderr ? ": " + r.stderr.trim() : ""}`);
        }
      } catch (e) {
        // `/etc/init.d/forkop restart` recompiles lists + reloads sing-box and
        // nftables — that routinely outlives rpcd's ~30s call window, so ubus
        // reports TIMEOUT (code 7) even though the restart goes on to finish.
        // Only a real failure (bad command, PERMISSION_DENIED, …) is re-raised.
        if (!(e instanceof UbusError && e.code === 7)) throw e;
      }
    }
    // Only the snapshot is known to be on the router. Anything the user typed
    // while the request was in flight stays in `pending` as an unsaved diff.
    if (section === sec) committed = snap;
    setStatus(
      `Применено: ${lists.exact.length} точн. + ${lists.suffix.length} с поддоменами в «${sec}». ` +
      `forkop перезапускается — подожди ~10–15 с.`,
      "ok",
    );
  } catch (e) {
    if (e instanceof UbusError && e.code === 7) {
      // Client-side timeout: the write may well have landed. Say so instead of
      // implying it failed, and let the user re-open the popup to check.
      setStatus(
        `Роутер не ответил вовремя. Изменения могли примениться — закрой и открой попап, чтобы увидеть текущий список секции «${sec}».`,
        "err",
      );
    } else {
      fail(e);
    }
  } finally {
    setBusy(false);
    renderDomains();
  }
}

// ---------- collect tab ----------
async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

function renderGroups() {
  els.capList.textContent = "";
  els.capCount.textContent = groups.length ? `${groups.length} групп(ы)` : "";
  if (!groups.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Пусто — перезагрузи страницу и собери";
    els.capList.append(li);
    return;
  }
  for (const g of groups) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = g.reg;
    label.append(cb, document.createTextNode(" " + g.reg));
    label.title = g.hosts.join("\n");
    li.append(label);
    if (g.hosts.length > 1) {
      const c = document.createElement("span");
      c.className = "muted";
      c.textContent = g.hosts.length;
      li.append(c);
    }
    els.capList.append(li);
  }
  els.capAll.checked = false;
}

async function refreshCapture() {
  try {
    const tabId = await activeTabId();
    if (!tabId) return setStatus("Нет активной вкладки.", "err");
    const res = await chrome.runtime.sendMessage({ type: "getCapture", tabId });
    // The worker records raw `URL.hostname` values, so bare IP literals and
    // other non-domains arrive here. Without this filter registrable() would
    // split "104.21.5.9" into a "5.9" group and one click would push that
    // straight into the section's domain_suffix list.
    const hosts = ((res && res.hosts) || []).map(normalizeHost).filter(Boolean);
    groups = groupByRegistrable(hosts);
    renderGroups();
    clearStatus();
  } catch (e) { fail(e); }
}

async function reloadAndCapture() {
  try {
    const tabId = await activeTabId();
    if (!tabId) return setStatus("Нет активной вкладки.", "err");
    els.reloadCap.disabled = true;
    await chrome.runtime.sendMessage({ type: "clearCapture", tabId });
    await chrome.tabs.reload(tabId);
    setStatus("Собираю…", "");
    await new Promise((r) => setTimeout(r, 3500));
    await refreshCapture();
  } catch (e) {
    fail(e);
  } finally {
    els.reloadCap.disabled = false;
  }
}

async function addSelected() {
  if (busy || !ready) return;
  const picked = [...els.capList.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
  if (!picked.length) return setStatus("Ничего не отмечено.", "err");
  const target = els.collectSectionSel.value;
  try {
    // Switching sections here throws away unsaved edits in the current one —
    // make the user resolve them first instead of losing them silently.
    if (target !== section) {
      const { added, removed, changed } = diff();
      if (added.length || removed.length || changed.length) {
        els.collectSectionSel.value = section;
        setStatus(`В секции «${section}» есть несохранённые правки. Примени или сбрось их, потом добавляй в другую секцию.`, "err");
        return;
      }
      await selectSection(target);
      if (target !== section) return; // selectSection failed — don't edit the wrong list
    }
    // Collected picks are registrable domains → route the whole site (subdomains
    // included). Flip individual entries to "точный" on the Домены tab if needed.
    const { added } = addFromText(picked.join(" "), "suffix");
    if (!added) { setStatus("Все выбранные домены уже в секции.", "ok"); return; }
    await apply();
    switchTab("domains");
  } catch (e) { fail(e); }
}

// ---------- tabs ----------
function switchTab(name) {
  for (const b of document.querySelectorAll("#tabs button")) {
    b.classList.toggle("active", b.dataset.tab === name);
  }
  $("tab-domains").hidden = name !== "domains";
  $("tab-collect").hidden = name !== "collect";
}

// ---------- wire ----------
function wire() {
  for (const b of document.querySelectorAll("#tabs button")) {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  }
  els.openOptions.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  els.sectionSel.addEventListener("change", () => {
    if (busy) { els.sectionSel.value = section; return; }
    // Switching wipes `pending`; refuse while there is something to lose.
    const { added, removed, changed } = diff();
    if (added.length || removed.length || changed.length) {
      els.sectionSel.value = section;
      setStatus("Сначала «Применить» или «Сбросить» — иначе правки этой секции пропадут.", "err");
      return;
    }
    selectSection(els.sectionSel.value).catch(fail);
  });
  els.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy || !ready) return;
    const { added, rejected } = addFromText(els.addInput.value, els.addMode.value);
    els.addInput.value = "";
    if (rejected.length) setStatus(`Не похоже на домены, пропущено: ${rejected.slice(0, 5).join(", ")}${rejected.length > 5 ? "…" : ""}`, "err");
    else if (added) clearStatus();
  });
  els.applyBtn.addEventListener("click", () => apply());
  els.revertBtn.addEventListener("click", () => {
    if (busy) return;
    pending = new Map(committed);
    renderDomains();
    clearStatus();
  });
  els.refreshCap.addEventListener("click", () => refreshCapture());
  els.reloadCap.addEventListener("click", () => reloadAndCapture());
  els.addSelected.addEventListener("click", () => addSelected());
  els.capAll.addEventListener("change", () => {
    for (const c of els.capList.querySelectorAll("input[type=checkbox]")) c.checked = els.capAll.checked;
  });
}

// ---------- init ----------
(async () => {
  wire();
  renderGroups();
  renderDomains();     // "Список пуст" beats an empty panel while we connect
  setBusy(false);      // controls stay locked until `ready` flips
  try {
    const ok = await loadConfig();
    if (!ok) { statusWithOptionsLink("Не заданы адрес роутера / логин / пароль."); return; }
    // Connecting can take seconds (login + two reads, plus retries). Without a
    // status line the popup just sits there looking broken.
    setStatus("Подключаюсь к роутеру…", "");
    await withRetry(connect);
    setBusy(false);
  } catch (e) {
    fail(e);
  }
})();
