import { Ubus } from "../lib/ubus.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["routerUrl", "user", "pass", "applyCmd"];
const DEFAULTS = { routerUrl: "http://192.168.1.1/", applyCmd: "" };
const msg = $("msg");

function setMsg(text, cls) { msg.textContent = text; msg.className = cls || ""; }

const CFG_SCHEMA = 3;

async function load() {
  const stored = await chrome.storage.local.get([...FIELDS, "cfgSchema"]);
  // See popup.js loadConfig(): schema < 3 resets applyCmd to "auto" — the old
  // persisted "restart" both double-restarted forkop and always tripped ubus
  // TIMEOUT. `domainOption` (single-list picker) is gone as of 1.2.0.
  if (!(stored.cfgSchema >= CFG_SCHEMA)) {
    await chrome.storage.local.remove(["applyCmd", "domainOption"]);
    await chrome.storage.local.set({ cfgSchema: CFG_SCHEMA });
    delete stored.applyCmd;
  }
  for (const f of FIELDS) $(f).value = stored[f] ?? DEFAULTS[f] ?? "";
}

async function save() {
  const out = {};
  for (const f of FIELDS) out[f] = $(f).value.trim() || DEFAULTS[f] || "";
  await chrome.storage.local.set(out);
  setMsg("Сохранено.", "ok");
}

async function test() {
  setMsg("Проверяю…", "");
  try {
    const url = $("routerUrl").value.trim() || DEFAULTS.routerUrl;
    const u = new Ubus(url);
    await u.login($("user").value.trim(), $("pass").value);
    const values = await u.uciGetAll("forkop");
    const secs = Object.values(values)
      .filter((s) => s && s[".type"] === "section" && s[".name"] !== "settings")
      .map((s) => (s.label ? `${s[".name"]} (${s.label})` : s[".name"]));
    if (!secs.length) setMsg("Связь есть, но секций в forkop не найдено.", "ok");
    else setMsg("Связь есть. Секции: " + secs.join(", "), "ok");
  } catch (e) {
    setMsg((e && e.message) || String(e), "err");
  }
}

$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
load();
