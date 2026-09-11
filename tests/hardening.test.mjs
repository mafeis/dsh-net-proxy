// tests/hardening.test.mjs — v0.2.7 加固项回归：
//   1. 设置路由 Host/自定义头/Origin 校验（CSRF + DNS rebinding 防护）
//   2. probe 密码打码哨兵还原；toCfg 脏值拒绝
//   3. noProxy 前导点条目
//   4. CONNECT/SOCKS5 握手超时与可中止
//   5. body 中途 abort / cancel；Content-Length 截断报错
//   6. Request 对象入参继承 headers/body/signal
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsHandler } from "../lib/routes.js";
import { toCfg } from "../lib/config.js";
import { proxiedFetch, isNoProxy } from "../lib/proxy-fetch.js";
import { sendViaSocket } from "../lib/proxy/http11.js";

// ───────────────────────── routes 安全校验 ─────────────────────────

function fakeRes() {
  const r = { status: null, headers: null, data: "" };
  r.writeHead = (c, o) => { r.status = c; r.headers = o; };
  r.end = (s) => { r.data = s; };
  return r;
}
function fakeReq(method, body, headers) {
  const r = { method, _body: body, headers: headers || {} };
  r.on = (ev, cb) => { if (ev === "data" && r._body != null) cb(r._body); if (ev === "end") cb(); };
  return r;
}
const flush = () => new Promise((r) => setImmediate(r));
const OK_HEADERS = { host: "127.0.0.1:43120", "x-dsh-net-proxy": "1" };
const withTmpFile = async (fn, initial) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nphard-"));
  const file = path.join(dir, "net-proxy.json");
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  try { await fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test("routes: POST 缺自定义头 → 403（跨站简单请求无法携带）", async () => {
  await withTmpFile(async (file) => {
    const res = fakeRes();
    settingsHandler(fakeReq("POST", JSON.stringify({ enabled: true }), { host: "127.0.0.1:43120" }), res, file);
    await flush();
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(file), false); // 未写入
  });
});

test("routes: Host 不在白名单 → 403（防 DNS rebinding），GET/POST 皆拒", async () => {
  await withTmpFile(async (file) => {
    const g = fakeRes();
    settingsHandler(fakeReq("GET", null, { host: "evil.example:43120" }), g, file);
    assert.equal(g.status, 403);
    const p = fakeRes();
    settingsHandler(fakeReq("POST", "{}", { host: "evil.example:43120", "x-dsh-net-proxy": "1" }), p, file);
    await flush();
    assert.equal(p.status, 403);
    // [::1] 带括号 + 端口应命中默认白名单
    const ok = fakeRes();
    settingsHandler(fakeReq("GET", null, { host: "[::1]:43120" }), ok, file);
    assert.equal(ok.status, 200);
  });
});

test("routes: opts.allowedHosts 可放行局域网地址；无 Host 头放行（非浏览器直连）", async () => {
  await withTmpFile(async (file) => {
    const res = fakeRes();
    settingsHandler(fakeReq("GET", null, { host: "192.168.1.10:43120" }), res, file, undefined, undefined, { allowedHosts: ["192.168.1.10"] });
    assert.equal(res.status, 200);
    const bare = fakeRes();
    settingsHandler(fakeReq("GET"), bare, file);
    assert.equal(bare.status, 200);
  });
});

test("routes: Origin 与 Host 不同源 → 403；同源放行", async () => {
  await withTmpFile(async (file) => {
    const bad = fakeRes();
    settingsHandler(fakeReq("POST", "{}", { ...OK_HEADERS, origin: "http://evil.example:43120" }), bad, file);
    await flush();
    assert.equal(bad.status, 403);
    const good = fakeRes();
    settingsHandler(fakeReq("POST", "{}", { ...OK_HEADERS, origin: "http://127.0.0.1:43120" }), good, file);
    await flush();
    assert.equal(good.status, 200);
  });
});

test("routes: probe 的密码打码哨兵还原为已存真实密码", async () => {
  await withTmpFile(async (file) => {
    fs.writeFileSync(file, JSON.stringify({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890, username: "u", password: "S3cret!" }));
    let got = null;
    const res = fakeRes();
    settingsHandler(fakeReq("POST", JSON.stringify({ action: "probe", proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "u", password: "***" } }), OK_HEADERS),
      res, file, undefined, (p) => { got = p; return Promise.resolve({ ok: true }); });
    await flush();
    assert.equal(res.status, 200);
    assert.equal(got.password, "S3cret!");
  });
});

test("routes: POST 非法 port/protocol → 400 不落盘", async () => {
  await withTmpFile(async (file) => {
    for (const bad of [{ port: 0 }, { port: 70000 }, { port: "abc" }, { protocol: "ftp" }]) {
      const res = fakeRes();
      settingsHandler(fakeReq("POST", JSON.stringify(bad), OK_HEADERS), res, file);
      await flush();
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });
});

// ───────────────────────── noProxy / config ─────────────────────────

test("noProxy: 前导点条目匹配本域 + 子域", () => {
  assert.equal(isNoProxy("https://x.foo.com/", [".foo.com"]), true);
  assert.equal(isNoProxy("https://foo.com/", [".foo.com"]), true);
  assert.equal(isNoProxy("https://notfoo.com/", [".foo.com"]), false);
  assert.equal(isNoProxy("https://a.b.corp.internal/", [".corp.internal"]), true);
});

test("config: toCfg 拒绝非法 port/protocol", () => {
  assert.throws(() => toCfg({ port: 0 }));
  assert.throws(() => toCfg({ port: 70000 }));
  assert.throws(() => toCfg({ port: "abc" }));
  assert.throws(() => toCfg({ protocol: "ftp" }));
  const ok = toCfg({ port: "8118", protocol: "SOCKS5" });
  assert.equal(ok.port, 8118);
  assert.equal(ok.protocol, "socks5");
});

// ───────────────────────── 握手超时/中止 ─────────────────────────

const P_CONNECT = 19010, P_SOCKS = 19011;

test("握手加固：CONNECT 半开代理 → ETIMEOUT；abort → AbortError", async (t) => {
  // 接受 TCP 但永不回 CONNECT 响应。注：本环境回环上 client.destroy() 的 RST
  // 可能迟迟不送达服务端，清理时需主动销毁服务端连接，否则测试进程不退出。
  const conns = new Set();
  const blackhole = net.createServer((s) => { conns.add(s); s.on("close", () => conns.delete(s)); });
  await new Promise((r) => blackhole.listen(P_CONNECT, "127.0.0.1", r));
  t.after(() => { blackhole.close(); for (const s of conns) { try { s.destroy(); } catch {} } });
  const cfg = { protocol: "http", host: "127.0.0.1", port: P_CONNECT, timeout: 400, noProxy: [] };

  await t.test("CONNECT 握手超时 → ETIMEOUT（不再无限挂起）", async () => {
    const t0 = Date.now();
    await assert.rejects(
      proxiedFetch("https://example.com/x", { method: "GET" }, cfg, fetch),
      (e) => e.code === "ETIMEOUT"
    );
    assert.ok(Date.now() - t0 < 3000, `应在超时上限内失败，实际 ${Date.now() - t0}ms`);
  });

  await t.test("CONNECT 握手期间 abort → AbortError", async () => {
    const ac = new AbortController();
    const p = proxiedFetch("https://example.com/x", { method: "GET", signal: ac.signal }, { ...cfg, timeout: 30000 }, fetch);
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(p, (e) => e.name === "AbortError");
  });
});

test("握手加固：SOCKS5 半开代理 → ETIMEOUT", async (t) => {
  const conns = new Set();
  const blackhole = net.createServer((s) => { conns.add(s); s.on("close", () => conns.delete(s)); });
  await new Promise((r) => blackhole.listen(P_SOCKS, "127.0.0.1", r));
  t.after(() => { blackhole.close(); for (const s of conns) { try { s.destroy(); } catch {} } });
  const cfg = { protocol: "socks5", host: "127.0.0.1", port: P_SOCKS, timeout: 400, noProxy: [] };
  const t0 = Date.now();
  await assert.rejects(
    proxiedFetch("https://example.com/x", { method: "GET" }, cfg, fetch),
    (e) => e.code === "ETIMEOUT"
  );
  assert.ok(Date.now() - t0 < 3000);
});

// ───────────────────────── body 生命周期 ─────────────────────────

const T1 = 19020, P1 = 19021, T2 = 19022, P2 = 19023, T3 = 19024, P3 = 19025;

test("body 加固：头到达后 abort → text() 以 AbortError 拒绝", async (t) => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.write("abc"); // 之后不再发数据
  });
  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url);
    const p = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: req.headers, agent: false });
    p.on("response", (r) => { res.writeHead(r.statusCode || 200, r.headers); r.pipe(res); });
    p.on("error", () => { try { res.destroy(); } catch {} });
    req.pipe(p);
  });
  await new Promise((r) => target.listen(T1, "127.0.0.1", r));
  await new Promise((r) => proxy.listen(P1, "127.0.0.1", r));
  t.after(() => { target.closeAllConnections(); proxy.closeAllConnections(); target.close(); proxy.close(); });
  const cfg = { protocol: "http", host: "127.0.0.1", port: P1, noProxy: [] };
  const ac = new AbortController();
  const resp = await proxiedFetch(`http://127.0.0.1:${T1}/stream`, { method: "GET", signal: ac.signal }, cfg, fetch);
  assert.equal(resp.status, 200);
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(resp.text(), (e) => e.name === "AbortError");
});

test("body 加固：resp.body.cancel() → 到代理的 socket 立即关闭（不泄漏连接）", async (t) => {
  let closed = 0, opened = 0;
  const target = http.createServer((req, res) => {
    res.writeHead(200);
    res.write("start\n");
    const iv = setInterval(() => res.write(": keep-alive\n\n"), 50);
    res.on("close", () => clearInterval(iv));
  });
  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url);
    const p = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: req.headers, agent: false });
    p.on("response", (r) => { res.writeHead(r.statusCode || 200, r.headers); r.pipe(res); });
    p.on("error", () => { try { res.destroy(); } catch {} });
    req.pipe(p);
  });
  proxy.on("connection", (s) => { opened++; s.on("close", () => { closed++; }); });
  await new Promise((r) => target.listen(T2, "127.0.0.1", r));
  await new Promise((r) => proxy.listen(P2, "127.0.0.1", r));
  t.after(() => { target.closeAllConnections(); proxy.closeAllConnections(); target.close(); proxy.close(); });
  const cfg = { protocol: "http", host: "127.0.0.1", port: P2, noProxy: [] };
  const resp = await proxiedFetch(`http://127.0.0.1:${T2}/sse`, { method: "GET" }, cfg, fetch);
  assert.equal(resp.status, 200);
  await resp.body.cancel();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(closed, opened, "取消 body 后到代理的连接应被销毁");
});

test("body 加固：Content-Length 截断 → ERESP_END 而非静默短读", async (t) => {
  // 直接对 sendViaSocket 单跳验证（经代理转发的 mock 会把「上游截断」变成
  // aborted/RST，观察不到干净的 FIN 路径；单跳才能确定性地触发 ERESP_END 分支）
  const srv = net.createServer((s) => {
    s.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"); // 只给 3 字节就 FIN
  });
  await new Promise((r) => srv.listen(T3, "127.0.0.1", r));
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const sock = net.connect({ host: "127.0.0.1", port: T3 });
  await new Promise((r) => sock.once("connect", r));
  const resp = await sendViaSocket(
    sock, `http://127.0.0.1:${T3}/trunc`,
    "GET /trunc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    null, {}
  );
  assert.equal(resp.status, 200);
  await assert.rejects(resp.text(), (e) => e.code === "ERESP_END");
});

// ───────────────────────── Request 对象入参 ─────────────────────────

test("proxiedFetch(Request) 继承 headers/body/signal（对齐 fetch 契约）", async () => {
  let seen = null;
  const spy = (input, init) => { seen = { input, init }; return Promise.resolve(new Response("ok")); };
  const ac = new AbortController();
  const reqObj = new Request("http://x.test/echo", {
    method: "POST",
    headers: { "content-type": "application/json", "x-a": "1" },
    body: JSON.stringify({ k: 1 }),
    signal: ac.signal,
  });
  await proxiedFetch(reqObj, undefined, { noProxy: ["x.test"] }, spy);
  assert.ok(seen, "originalFetch 应被调用");
  assert.equal(seen.init.method, "POST");
  assert.equal(typeof seen.init.headers.get, "function");
  assert.equal(seen.init.headers.get("x-a"), "1");
  assert.equal(seen.init.headers.get("content-type"), "application/json");
  assert.ok(Buffer.isBuffer(seen.init.body));
  assert.equal(seen.init.body.toString(), JSON.stringify({ k: 1 }));
  // undici 会把传入的 signal 包装成新实例（状态联动、引用不同），故按行为断言
  assert.ok(seen.init.signal instanceof AbortSignal, "signal 应被继承");
  ac.abort();
  assert.equal(seen.init.signal.aborted, true, "abort 应联动到继承的 signal");
});
