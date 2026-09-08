import { Ubus } from "../lib/ubus.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["routerUrl", "user", "pass", "applyCmd", "domainOption"];
const DEFAULTS = { routerUrl: "http://192.168.1.1/", applyCmd: "", domainOption: "domain" };
const msg = $("msg");

function setMsg(text, cls) { msg.textContent = text; msg.className = cls || ""; }

async function load() {
  const stored = await chrome.storage.local.get([...FIELDS, "cfgSchema"]);
  // See popup.js loadConfig(): v1.0.0 persisted applyCmd:"restart", which now
  // causes a double forkop restart. Clear it once so the form shows "авто".
  if (!stored.cfgSchema) {
    if (stored.applyCmd) { delete stored.applyCmd; await chrome.storage.local.remove("applyCmd"); }
    await chrome.storage.local.set({ cfgSchema: 2 });
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
