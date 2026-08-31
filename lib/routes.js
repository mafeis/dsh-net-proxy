// lib/routes.js  同源设置路由的 HTTP handler（纯函数，便于单元测试）
// GET 读 / POST 写同一份 net-proxy.json；POST { action:"probe" } 触发连通探测。
// 安全：GET 回传时密码打码为 "***"；POST 收到 "***" 视为「未改动」保留原值，
// 避免任何同源页面都能通过 GET 读到明文代理凭据。
import { loadConfig, writeConfig, toCfg } from "./config.js";

const MASK = "***";
const MAX_POST_BODY = 64 * 1024; // POST 体积上限，防止无界累积

/** 同源设置路由（GET 读 / POST 写 net-proxy.json）。 */
export function settingsHandler(req, res, file, reloadFn, probeFn) {
  const send = function (code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const masked = function (cfg) {
    return { ...cfg, password: cfg.password ? MASK : "" };
  };
  if (req.method === "GET") {
    send(200, { ok: true, value: masked(loadConfig(file)) });
    return;
  }
  if (req.method === "POST") {
    let body = "";
    let overflow = false;
    req.on("data", function (c) {
      body += c;
      if (body.length > MAX_POST_BODY) {
        overflow = true;
        body = "";
        try { req.destroy(); } catch {}
      }
    });
    req.on("end", function () {
      if (overflow) return send(413, { ok: false, error: "payload too large" });
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch (e) { return send(400, { ok: false, error: "invalid json" }); }
      // 连通/延迟探测（不改配置）：body = { action: "probe", proxy: {...}, target? }
      if (payload && payload.action === "probe") {
        if (!probeFn) return send(200, { ok: false, error: "probe unavailable" });
        const errText = function (e) { return String((e && e.message) || e); };
        return Promise.resolve(probeFn(payload.proxy || {}, payload.target)).then(
          function (r) { send(200, r); },
          function (e) { send(200, { ok: false, error: errText(e) }); }
        );
      }
      try {
        if (payload && payload.password === MASK) {
          payload = { ...payload, password: loadConfig(file).password }; // 打码值  保留原密码
        }
        const next = toCfg(payload || {});
        writeConfig(next, file);
        if (reloadFn) reloadFn();
        send(200, { ok: true, value: masked(loadConfig(file)) });
      } catch (e) {
        send(400, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return;
  }
  send(405, { ok: false, error: "method not allowed" });
}


