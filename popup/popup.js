// Popup: manual domain management + per-tab domain collector for a forkop section.
import { Ubus } from "../lib/ubus.js";
import { normalizeHost, groupByRegistrable } from "../lib/domains.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  sectionSel: $("sectionSel"),
  domList: $("domList"),
  addForm: $("addForm"),
  addInput: $("addInput"),
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

const CFG_KEYS = ["routerUrl", "user", "pass", "applyCmd", "domainOption"];
const DEFAULT_CFG = { applyCmd: "", domainOption: "domain" };
let cfg = { ...DEFAULT_CFG };
let ubus = null;
let sections = [];          // [{name, label, text}]
let section = null;         // current section name
let committed = [];         // domains stored on the router
let pending = [];           // domains after local edits
let groups = [];            // collector groups [{reg, hosts}]

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
async function loadConfig() {
  const stored = await chrome.storage.local.get(CFG_KEYS);
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

  if (!sections.length) { setStatus("В forkop нет секций.", "err"); return; }

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
  let v;
  try {
    v = await ubus.uciGet("forkop", name, cfg.domainOption);
  } catch (e) {
    // Don't wipe the list we're already showing on a transient read failure —
    // surface the error and keep the <select> on the section that's live.
    fail(e);
    if (section) els.sectionSel.value = section;
    return;
  }
  section = name;
  els.sectionSel.value = name;
  saveLastSection(name);
  committed = normalizeList(v).filter(Boolean);
  pending = committed.slice();
  renderDomains();
}

// ---------- domains tab ----------
function diff() {
  const cSet = new Set(committed), pSet = new Set(pending);
  const added = pending.filter((d) => !cSet.has(d));
  const removed = committed.filter((d) => !pSet.has(d));
  return { added, removed };
}

function renderDomains() {
  const cSet = new Set(committed), pSet = new Set(pending);
  const all = [...new Set([...committed, ...pending])].sort();
  els.domList.textContent = "";

  if (!all.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Список пуст";
    els.domList.append(li);
  }

  for (const d of all) {
    const inC = cSet.has(d), inP = pSet.has(d);
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "grow";
    span.textContent = d;
    li.append(span);
    const btn = document.createElement("button");
    btn.type = "button";
    if (inP && !inC) {
      li.className = "added";
      btn.textContent = "убрать";
      btn.addEventListener("click", () => { pending = pending.filter((x) => x !== d); renderDomains(); });
    } else if (inC && !inP) {
      li.className = "removed";
      btn.textContent = "вернуть";
      btn.addEventListener("click", () => { pending.push(d); renderDomains(); });
    } else {
      btn.textContent = "×";
      btn.title = "удалить";
      btn.addEventListener("click", () => { pending = pending.filter((x) => x !== d); renderDomains(); });
    }
    li.append(btn);
    els.domList.append(li);
  }

  const { added, removed } = diff();
  if (added.length || removed.length) {
    els.pendingText.textContent = `+${added.length} / −${removed.length}`;
    els.pendingBar.hidden = false;
  } else {
    els.pendingBar.hidden = true;
  }
}

function addFromText(text) {
  const parts = String(text).split(/[\s,]+/).filter(Boolean);
  let n = 0;
  for (const p of parts) {
    const h = normalizeHost(p);
    if (h && !pending.includes(h)) { pending.push(h); n++; }
  }
  renderDomains();
  return n;
}

async function apply() {
  els.applyBtn.disabled = els.revertBtn.disabled = true;
  try {
    const list = [...new Set(pending)];
    setStatus("Применяю…", "");
    if (list.length) await ubus.uciSet("forkop", section, { [cfg.domainOption]: list });
    else await ubus.uciDelete("forkop", section, cfg.domainOption);

    // `uci commit` emits a `config.change` service event; forkop reacts to it
    // with a single restart via its own procd trigger — exactly like LuCI's
    // "Save & Apply". Firing an extra `/etc/init.d/forkop restart` here would
    // run a second teardown in parallel with that one and can leave the
    // nftables ruleset half-flushed. So by default we only commit. `applyCmd`
    // stays as an opt-in escape hatch for forkop builds without the trigger.
    await ubus.uciCommit("forkop");
    if (cfg.applyCmd) {
      const r = await ubus.exec("/etc/init.d/forkop", [cfg.applyCmd]);
      if (r && typeof r.code === "number" && r.code !== 0) {
        throw new Error(`forkop ${cfg.applyCmd} → код ${r.code}${r.stderr ? ": " + r.stderr.trim() : ""}`);
      }
    }
    committed = list.slice();
    pending = list.slice();
    renderDomains();
    setStatus(`Применено: ${list.length} домен(ов) в «${section}». forkop перезапускается — подожди ~5–10 с.`, "ok");
  } catch (e) {
    fail(e);
  } finally {
    els.applyBtn.disabled = els.revertBtn.disabled = false;
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
    groups = groupByRegistrable((res && res.hosts) || []);
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
  const picked = [...els.capList.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
  if (!picked.length) return setStatus("Ничего не отмечено.", "err");
  const target = els.collectSectionSel.value;
  try {
    if (target !== section) await selectSection(target);
    if (target !== section) return; // selectSection failed — don't edit the wrong list
    const n = addFromText(picked.join(" "));
    if (!n) { setStatus("Все выбранные домены уже в секции.", "ok"); return; }
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
  els.sectionSel.addEventListener("change", () => selectSection(els.sectionSel.value).catch(fail));
  els.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    addFromText(els.addInput.value);
    els.addInput.value = "";
  });
  els.applyBtn.addEventListener("click", () => apply());
  els.revertBtn.addEventListener("click", () => { pending = committed.slice(); renderDomains(); clearStatus(); });
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
  try {
    const ok = await loadConfig();
    if (!ok) { statusWithOptionsLink("Не заданы адрес роутера / логин / пароль."); return; }
    await withRetry(connect);
  } catch (e) {
    fail(e);
  }
})();
