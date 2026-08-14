import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { proxiedFetch, isNoProxy } from "../lib/proxy-fetch.js";

test("isNoProxy: host 精确/后缀/CIDR/端口/<local>", () => {
  assert.equal(isNoProxy("http://example.com/x", ["example.com"]), true);
  assert.equal(isNoProxy("http://a.example.com/x", ["example.com"]), true);
  assert.equal(isNoProxy("http://other.org/x", ["example.com"]), false);
  assert.equal(isNoProxy("http://10.1.2.3/x", ["10.0.0.0/8"]), true);
  assert.equal(isNoProxy("http://192.168.1.5/x", ["10.0.0.0/8"]), false);
  assert.equal(isNoProxy("http://example.com:8080/x", ["example.com:443"]), false);
  assert.equal(isNoProxy("http://example.com:443/x", ["example.com:443"]), true);
  assert.equal(isNoProxy("http://localhost/x", ["<local>"]), true);
  assert.equal(isNoProxy("http://example.com/x", ["*"]), true);
});

test("http 代理：Proxy-Authorization / accept-encoding 尊重 / 解压去 content-length", async (t) => {
  const TARGET = 18995, PROXY = 18996;
  let sawProxyAuth = false;
  const target = http.createServer((req, res) => {
    if (req.url === "/echo") return res.end(JSON.stringify({ host: req.headers.host, ae: req.headers["accept-encoding"] }));
    if (req.url === "/gzip") {
      const gz = zlib.gzipSync(Buffer.from("HELLO"));
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Length": gz.length });
      return res.end(gz);
    }
    res.writeHead(404); res.end();
  });
  const proxy = http.createServer((req, res) => {
    sawProxyAuth = (req.headers["proxy-authorization"] || "").startsWith("Basic ");
    const u = new URL(req.url);
    const p = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers, agent: false });
    p.on("response", (r) => { res.writeHead(r.statusCode || 200, r.headers); r.pipe(res); });
    p.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  const listen = (s, p) => new Promise((r) => s.listen(p, r));
  await listen(target, TARGET); await listen(proxy, PROXY);
  t.after(() => { target.closeAllConnections(); proxy.closeAllConnections(); target.close(); proxy.close(); });
  const cfg = { protocol: "http", host: "127.0.0.1", port: PROXY, username: "u", password: "p", noProxy: [] };

  await t.test("A3 http 分支发送 Proxy-Authorization", async () => {
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/echo", { method: "GET" }, cfg, fetch);
    assert.equal(r.status, 200);
    assert.equal(sawProxyAuth, true);
  });
  await t.test("A4 尊重 caller 显式 accept-encoding", async () => {
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/echo", { method: "GET", headers: { "accept-encoding": "gzip" } }, cfg, fetch);
    const body = JSON.parse(await r.text());
    assert.equal(body.ae, "gzip");
  });
  await t.test("A2 解压后移除 content-length 但保留 content-encoding", async () => {
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/gzip", { method: "GET" }, cfg, fetch);
    assert.equal(await r.text(), "HELLO");
    assert.equal(r.headers.get("content-length"), null);
    assert.equal(r.headers.get("content-encoding"), "gzip");
  });
});

test("B2 AbortSignal 可取消挂起请求", async (t) => {
  const TARGET = 18997, PROXY = 18998;
  const target = http.createServer(() => { /* 永不响应 */ });
  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url);
    const p = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, headers: req.headers, agent: false });
    p.on("error", () => {});
    req.pipe(p);
  });
  const listen = (s, p) => new Promise((r) => s.listen(p, r));
  await listen(target, TARGET); await listen(proxy, PROXY);
  t.after(() => { target.closeAllConnections(); proxy.closeAllConnections(); target.close(); proxy.close(); });
  const cfg = { protocol: "http", host: "127.0.0.1", port: PROXY, noProxy: [] };
  const ac = new AbortController();
  const p = proxiedFetch("http://127.0.0.1:" + TARGET + "/x", { method: "GET", signal: ac.signal }, cfg, fetch);
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(p, (e) => { assert.equal(e.name, "AbortError"); return true; });
});
