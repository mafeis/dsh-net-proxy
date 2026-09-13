// tests/traffic-tap.test.mjs — 插桩 e2e：真实 CONNECT 隧道 + TLS 上验证 fetch 包装层日志
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import url from "node:url";
import { proxiedFetch } from "../lib/proxy-fetch.js";
import { createTrafficLog } from "../lib/traffic-log.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const TLS_KEY = fs.readFileSync(path.join(here, "fixtures", "test-key.pem"));
const TLS_CERT = fs.readFileSync(path.join(here, "fixtures", "test-cert.pem"));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const TARGET = 19093, PROXY = 19094;

test("fetch 包装层日志：CONNECT+TLS 请求记录元数据/字节/预览", async (t) => {
  const target = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("LOG-TAP-OK-BODY");
  });
  const proxy = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  const upstreams = new Set();
  proxy.on("connect", (req, clientSock, head) => {
    const u = new URL("http://" + req.url);
    const upstream = net.connect(Number(u.port), "127.0.0.1", () => {
      upstreams.add(upstream);
      upstream.on("close", () => upstreams.delete(upstream));
      clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      clientSock.pipe(upstream);
      upstream.pipe(clientSock);
    });
    upstream.on("error", () => { try { clientSock.destroy(); } catch {} });
    clientSock.on("error", () => { try { upstream.destroy(); } catch {} });
  });
  const listen = (srv, port) => new Promise((r) => srv.listen(port, "127.0.0.1", r));
  await listen(target, TARGET);
  await listen(proxy, PROXY);
  t.after(() => {
    for (const u of upstreams) { try { u.destroy(); } catch {} }
    target.closeAllConnections(); target.close();
    proxy.closeAllConnections(); proxy.close();
  });

  const log = createTrafficLog({ previewBytes: 512 });
  const cfg = { protocol: "http", host: "127.0.0.1", port: PROXY, username: "", password: "", noProxy: [] };
  const r = await proxiedFetch("https://127.0.0.1:" + TARGET + "/tap?x=1", { method: "GET" }, cfg, fetch, { begin: (m) => log.begin(m) });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.equal(body, "LOG-TAP-OK-BODY");
  // body 消费完 finalize 已发生（异步泵）；轮询等一拍
  for (let i = 0; i < 20 && log.list(1).length === 0; i++) await new Promise((r2) => setTimeout(r2, 25));

  const [it] = log.list(1);
  assert.ok(it, "应有一条日志");
  assert.equal(it.kind, "fetch");
  assert.equal(it.method, "GET");
  assert.equal(it.status, 200);
  assert.equal(it.host, `127.0.0.1:${TARGET}`);
  assert.ok(it.upBytes > 0, "上行字节 > 0");
  assert.ok(it.downBytes >= body.length, `下行字节应 ≥ body 长度（${it.downBytes} >= ${body.length}）`);
  assert.match(it.resPreview, /LOG-TAP-OK-BODY/);
  assert.equal(it.error, null);
  assert.ok(it.ms >= 0);
  const s = log.summary();
  assert.equal(s.total, 1);
  assert.equal(s.downBytes, it.downBytes);
});

test("fetch 包装层日志：noProxy 直连也记录（status/content-length 口径）", async (t) => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Length": 5 });
    res.end("DIR-1");
  });
  await new Promise((r) => target.listen(19095, "127.0.0.1", r));
  t.after(() => { target.closeAllConnections(); target.close(); });
  const log = createTrafficLog({});
  const cfg = { protocol: "http", host: "127.0.0.1", port: 1, username: "", password: "", noProxy: ["127.0.0.1"] };
  const r = await proxiedFetch("http://127.0.0.1:19095/direct", {}, cfg, fetch, { begin: (m) => log.begin(m) });
  assert.equal(await r.text(), "DIR-1");
  const [it] = log.list(1);
  assert.ok(it, "直连也应记录");
  assert.equal(it.status, 200);
  assert.equal(it.downBytes, 5);
});
