import { Ubus, normalizeBase } from "../lib/ubus.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["routerUrl", "user", "pass", "applyCmd"];
const DEFAULTS = { routerUrl: "http://192.168.1.1/", applyCmd: "" };
// Trimming a password would make one with a leading/trailing space
// unenterable — and `test()` used to trim differently from `save()`, so
// "Проверить связь" said OK while the popup got Permission denied.
const NO_TRIM = new Set(["pass"]);
const CFG_SCHEMA = 3;
const msg = $("msg");

function setMsg(text, cls) { msg.textContent = text; msg.className = cls || ""; }
function field(f) { return NO_TRIM.has(f) ? $(f).value : $(f).value.trim(); }

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
  for (const f of FIELDS) out[f] = field(f) || DEFAULTS[f] || "";
  // Reject a bad address here rather than letting a schemeless host resolve
  // relative to chrome-extension:// and fail later as a bogus CORS error.
  try {
    out.routerUrl = normalizeBase(out.routerUrl) + "/";
  } catch (e) {
    setMsg((e && e.message) || String(e), "err");
    return;
  }
  if (!out.user || !out.pass) {
    setMsg("Нужны логин и пароль rpcd-пользователя.", "err");
    return;
  }
  await chrome.storage.local.set(out);
  $("routerUrl").value = out.routerUrl;
  setMsg("Сохранено.", "ok");
}

async function test() {
  setMsg("Проверяю…", "");
  try {
    // Exactly the values save() would persist — otherwise the check can pass
    // with credentials the popup will never see.
    const u = new Ubus(field("routerUrl") || DEFAULTS.routerUrl);
    await u.login(field("user"), field("pass"));
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

// Wire only after the stored values are in the form: clicking "Сохранить"
// during an un-awaited load() used to persist empty fields over the real ones.
(async () => {
  const buttons = [$("save"), $("test")];
  for (const b of buttons) b.disabled = true;
  try {
    await load();
  } catch (e) {
    setMsg((e && e.message) || String(e), "err");
  }
  $("save").addEventListener("click", () => save().catch((e) => setMsg(String(e), "err")));
  $("test").addEventListener("click", () => test());
  for (const b of buttons) b.disabled = false;
})();
