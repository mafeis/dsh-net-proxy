// tests/log-routes.test.mjs — 请求日志路由：GET 读取 / POST 清空 / 跨站与 Host 防护
import test from "node:test";
import assert from "node:assert/strict";
import { createTrafficLog } from "../lib/traffic-log.js";
import { logHandler } from "../lib/routes.js";

function mockRes() {
  return {
    code: 0,
    body: "",
    writeHead(c) { this.code = c; },
    end(b) { this.body = String(b == null ? "" : b); },
  };
}

function seed(log) {
  const e = log.begin({ kind: "fetch", method: "GET", url: "https://example.com/a" });
  e.setResponse(200); e.addUp(12); e.addDown(340); e.finalize();
  const e2 = log.begin({ kind: "fetch", method: "POST", url: "https://example.com/b" });
  e2.finalize(new Error("boom"));
}

test("log-routes: GET 返回 summary/relay/entries", () => {
  const log = createTrafficLog({});
  seed(log);
  const res = mockRes();
  logHandler({ method: "GET", headers: { host: "127.0.0.1:43120" }, url: "/_dsh/net-proxy/log?limit=50" }, res, log, () => ({ listening: true, port: 9999 }), ["127.0.0.1"]);
  assert.equal(res.code, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.ok, true);
  assert.equal(j.summary.total, 2);
  assert.equal(j.summary.errors, 1);
  assert.equal(j.summary.upBytes, 12);
  assert.equal(j.relay.port, 9999);
  assert.equal(j.entries.length, 2);
  assert.equal(j.entries[0].url, "https://example.com/b"); // 新的在前
});

test("log-routes: POST clearLog 需要自定义头并清空", () => {
  const log = createTrafficLog({});
  seed(log);
  // 缺头 → 403
  const r1 = mockRes();
  logHandler({ method: "POST", headers: { host: "127.0.0.1" } }, r1, log, () => null, ["127.0.0.1"]);
  assert.equal(r1.code, 403);
  // 跨源 Origin → 403
  const r2 = mockRes();
  logHandler({ method: "POST", headers: { host: "127.0.0.1", origin: "https://evil.com", "x-dsh-net-proxy": "1" } }, r2, log, () => null, ["127.0.0.1"]);
  assert.equal(r2.code, 403);
  // 正常清空
  const r3 = mockRes();
  logHandler({
    method: "POST",
    headers: { host: "127.0.0.1", "x-dsh-net-proxy": "1" },
    on(ev, fn) { if (ev === "data") fn(JSON.stringify({ action: "clearLog" })); if (ev === "end") fn(); },
  }, r3, log, () => null, ["127.0.0.1"]);
  assert.equal(r3.code, 200);
  assert.equal(JSON.parse(r3.body).ok, true);
  assert.equal(log.summary().total, 0);
});

test("log-routes: 非 localhost Host 拒绝；未知 action 400；其他方法 405", () => {
  const log = createTrafficLog({});
  const r1 = mockRes();
  logHandler({ method: "GET", headers: { host: "evil.com" }, url: "/" }, r1, log, () => null, ["127.0.0.1"]);
  assert.equal(r1.code, 403);
  const r2 = mockRes();
  logHandler({
    method: "POST",
    headers: { host: "127.0.0.1", "x-dsh-net-proxy": "1" },
    on(ev, fn) { if (ev === "data") fn(JSON.stringify({ action: "nope" })); if (ev === "end") fn(); },
  }, r2, log, () => null, ["127.0.0.1"]);
  assert.equal(r2.code, 400);
  const r3 = mockRes();
  logHandler({ method: "DELETE", headers: { host: "127.0.0.1" }, url: "/" }, r3, log, () => null, ["127.0.0.1"]);
  assert.equal(r3.code, 405);
});
