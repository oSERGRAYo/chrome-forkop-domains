// Minimal ubus (OpenWrt) JSON-RPC over HTTP client.
// Endpoint: http(s)://<router>/ubus  (needs uhttpd-mod-ubus + rpcd)

const NULL_SESSION = "00000000000000000000000000000000";

const UBUS_STATUS = {
  0: "OK", 1: "INVALID_COMMAND", 2: "INVALID_ARGUMENT", 3: "METHOD_NOT_FOUND",
  4: "NOT_FOUND", 5: "NO_DATA", 6: "PERMISSION_DENIED", 7: "TIMEOUT",
  8: "NOT_SUPPORTED", 9: "UNKNOWN", 10: "CONNECTION_FAILED",
};

// uhttpd-mod-ubus reports access/session problems at the JSON-RPC layer rather
// than as a ubus status inside `result`, so these have to be mapped back or the
// auto-relogin below never fires. (uhttpd/ubus.c: ERROR_ACCESS / ERROR_SESSION.)
const RPC_TO_UBUS = { "-32002": 6, "-32003": 7 };

// Reads are quick; `uci commit` and `/etc/init.d/forkop <cmd>` recompile lists
// and rebuild nftables, so they need a far longer leash.
export const TIMEOUT_FAST = 10000;
export const TIMEOUT_SLOW = 40000;

export class UbusError extends Error {
  constructor(code, method) {
    super(`ubus ${method}: ${UBUS_STATUS[code] || "code " + code}`);
    this.name = "UbusError";
    this.code = code;
    this.method = method;
  }
  get isAuth() { return this.code === 6; }
}

// Accepts "192.168.1.1", "192.168.1.1:8080", "http://host/" and normalises to a
// scheme-qualified origin. Without this a bare host becomes a *relative* URL
// inside chrome-extension://, and the failure surfaces as a bogus CORS error.
export function normalizeBase(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) throw new Error("Не задан адрес роутера.");
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new Error(`Адрес роутера должен начинаться с http:// или https:// (получено «${s}»).`);
    s = "http://" + s;
  }
  let u;
  try { u = new URL(s); } catch { throw new Error(`Некорректный адрес роутера: «${raw}».`); }
  if (!u.hostname) throw new Error(`Некорректный адрес роутера: «${raw}».`);
  return u.origin;
}

export class Ubus {
  constructor(base) {
    this.base = normalizeBase(base);
    this.session = NULL_SESSION;
    this._id = 1;
    this.creds = null;      // {user, pass} for auto-relogin
    this._relogin = null;   // in-flight relogin, shared by concurrent calls
  }

  async _rpc(object, method, args, timeoutMs = TIMEOUT_FAST) {
    const url = this.base + "/ubus";
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A 30x would silently turn this POST into a GET and come back as a
        // baffling "HTTP 400"; fail loudly and say what to fix instead.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          jsonrpc: "2.0", id: this._id++, method: "call",
          params: [this.session, object, method, args || {}],
        }),
      });
    } catch (e) {
      if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new UbusError(7, `${object}.${method}`);
      }
      if (e && e.message && /redirect/i.test(e.message)) {
        throw new Error(`${url} отвечает редиректом. Укажи в настройках точный адрес со схемой (например https://…), по которому роутер отдаёт /ubus напрямую.`);
      }
      throw new Error(`Сеть/CORS: не достучались до ${url} (${e && e.message}). Проверь адрес роутера и доступность.`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} от ${url}${res.status === 404 ? " — похоже, не установлен uhttpd-mod-ubus" : ""}`);

    let j;
    try { j = await res.json(); }
    catch { throw new Error(`${url} вернул не JSON — по этому адресу отвечает не ubus.`); }

    if (j.error) {
      const mapped = RPC_TO_UBUS[String(j.error.code)];
      if (mapped !== undefined) throw new UbusError(mapped, `${object}.${method}`);
      throw new Error(`ubus rpc error: ${JSON.stringify(j.error)}`);
    }
    const result = j.result;
    if (Array.isArray(result)) {
      const [code, data] = result;
      if (code !== 0) throw new UbusError(code, `${object}.${method}`);
      return data === undefined ? {} : data;
    }
    return result; // login on some builds returns object directly
  }

  // Auto-relogin once on PERMISSION_DENIED (expired session). Concurrent calls
  // share a single in-flight relogin, so a parallel pair of reads can't race
  // two logins against each other and leave one holding a dead session.
  async call(object, method, args, timeoutMs) {
    try {
      return await this._rpc(object, method, args, timeoutMs);
    } catch (e) {
      if (!(e instanceof UbusError && e.isAuth && this.creds && object !== "session")) throw e;
      try {
        this._relogin = this._relogin || this.login(this.creds.user, this.creds.pass);
        await this._relogin;
      } finally {
        this._relogin = null;
      }
      try {
        return await this._rpc(object, method, args, timeoutMs);
      } catch (e2) {
        // Denied again right after a fresh login means the rpcd ACL, not the session.
        if (e2 instanceof UbusError && e2.isAuth) {
          throw new Error(`Доступ запрещён для ${object}.${method}. Проверь ACL: /usr/share/rpcd/acl.d/forkop-domain-mgr.json на роутере и «/etc/init.d/rpcd restart».`);
        }
        throw e2;
      }
    }
  }

  async login(user, pass, timeout = 600) {
    this.session = NULL_SESSION;
    let data;
    try {
      data = await this._rpc("session", "login", { username: user, password: pass, timeout });
    } catch (e) {
      if (e instanceof UbusError && e.code === 6) throw new Error("Login: неверный логин или пароль rpcd-пользователя.");
      throw e;
    }
    if (!data || !data.ubus_rpc_session) throw new Error("Login: не вернулся ubus_rpc_session (неверные логин/пароль?)");
    this.session = data.ubus_rpc_session;
    this.creds = { user, pass };
    return data;
  }

  // ---- uci ----
  async uciGetAll(config) { return (await this.call("uci", "get", { config })).values || {}; }
  async uciGet(config, section, option) {
    try {
      const r = await this.call("uci", "get", { config, section, option });
      return r.value;
    } catch (e) {
      // A missing option is an empty list, not an error. Depending on the
      // OpenWrt build `uci get` for an absent option returns NOT_FOUND (4) or
      // an empty object — normalise both to "undefined".
      if (e instanceof UbusError && e.code === 4) return undefined;
      throw e;
    }
  }
  async uciSet(config, section, values) { return this.call("uci", "set", { config, section, values }); }
  // Delete a whole option (uci set rejects an empty list, so an empty domain
  // list is expressed by removing the option entirely). NOT_FOUND is fine.
  async uciDelete(config, section, option) {
    try {
      return await this.call("uci", "delete", { config, section, option });
    } catch (e) {
      if (e instanceof UbusError && e.code === 4) return {};
      throw e;
    }
  }
  async uciCommit(config) { return this.call("uci", "commit", { config }, TIMEOUT_SLOW); }

  // ---- file (rpcd-mod-file) ----
  async exec(command, params = []) { return this.call("file", "exec", { command, params }, TIMEOUT_SLOW); }
}
