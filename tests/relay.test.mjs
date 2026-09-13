// tests/relay.test.mjs — 本地中继 e2e：CONNECT 隧道桥接 + absolute-form 明文转发 + 日志记录
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createRelay } from "../lib/relay.js";
import { createTrafficLog } from "../lib/traffic-log.js";

const UPSTREAM = 19193, TARGET = 19194;

function startUpstream() {
  // fake HTTP 代理：CONNECT → 打通目标；absolute-form → 转发到目标
  const upstreams = new Set();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url); // absolute-form
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: { host: u.host }, agent: false }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    r.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
    req.pipe(r);
  });
  srv.on("connect", (req, clientSock, head) => {
    const u = new URL("http://" + req.url);
    const upstream = net.connect(Number(u.port), u.hostname, () => {
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
  return new Promise((resolve) => srv.listen(UPSTREAM, "127.0.0.1", () => resolve({
    close: () => {
      for (const u of upstreams) { try { u.destroy(); } catch {} }
      srv.closeAllConnections(); srv.close();
    },
  })));
}

function startTarget() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "X-Relay-Path": req.url });
    res.end(`TARGET-BODY:${req.url}`);
  });
  return new Promise((resolve) => srv.listen(TARGET, "127.0.0.1", () => resolve({
    close: () => { srv.closeAllConnections(); srv.close(); },
  })));
}

async function readAll(sock) {
  const chunks = [];
  for await (const c of sock) chunks.push(c);
  return Buffer.concat(chunks).toString("latin1");
}

test("relay: CONNECT 隧道桥接到上游代理并记录字节日志", async (t) => {
  const up = await startUpstream();
  const target = await startTarget();
  const log = createTrafficLog({ previewBytes: 128 });
  const relay = createRelay({
    log,
    getProxy: () => ({ protocol: "http", host: "127.0.0.1", port: UPSTREAM, noProxy: [] }),
    timeoutMs: 5000,
  });
  const { port } = await relay.start();
  t.after(() => { relay.stop(); up.close(); target.close(); });
  assert.ok(port > 0);
  assert.equal(relay.status().listening, true);

  const sock = net.connect(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  sock.write(`CONNECT 127.0.0.1:${TARGET} HTTP/1.1\r\nHost: 127.0.0.1:${TARGET}\r\n\r\n`);
  // 读到 200 后在隧道里发明文 HTTP（测试内不必真 TLS）
  let head = "";
  const buf = [];
  await new Promise((resolve) => {
    const onData = (c) => {
      buf.push(c);
      head += c.toString("latin1");
      if (head.includes("\r\n\r\n")) { sock.removeListener("data", onData); resolve(); }
    };
    sock.on("data", onData);
  });
  assert.match(head, /^HTTP\/1\.1 200/);
  sock.write(`GET /via-tunnel HTTP/1.1\r\nHost: 127.0.0.1:${TARGET}\r\nConnection: close\r\n\r\n`);
  const rest = head.slice(head.indexOf("\r\n\r\n") + 4);
  const bodyText = rest + await readAll(sock);
  assert.match(bodyText, /TARGET-BODY:\/via-tunnel/);

  for (let i = 0; i < 20 && log.list(1).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  const [it] = log.list(1);
  assert.ok(it, "隧道应有一条日志");
  assert.equal(it.kind, "relay-tunnel");
  assert.equal(it.status, 200);
  assert.equal(it.url, `connect://127.0.0.1:${TARGET}`);
  assert.ok(it.upBytes > 0 && it.downBytes > 0, `双向字节应 > 0（up=${it.upBytes} down=${it.downBytes}）`);
  assert.match(it.reqPreview, /TLS 隧道/);
});

test("relay: absolute-form 明文转发 + 完整请求/响应日志", async (t) => {
  const up = await startUpstream();
  const target = await startTarget();
  const log = createTrafficLog({ previewBytes: 256 });
  const relay = createRelay({
    log,
    getProxy: () => ({ protocol: "http", host: "127.0.0.1", port: UPSTREAM, noProxy: [] }),
    timeoutMs: 5000,
  });
  const { port } = await relay.start();
  t.after(() => { relay.stop(); up.close(); target.close(); });

  const sock = net.connect(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  sock.end(`GET http://127.0.0.1:${TARGET}/abs?q=2 HTTP/1.1\r\nHost: 127.0.0.1:${TARGET}\r\nConnection: close\r\n\r\n`);
  const resp = await readAll(sock);
  assert.match(resp, /^HTTP\/1\.1 200/);
  assert.match(resp, /TARGET-BODY:\/abs\?q=2/);

  for (let i = 0; i < 20 && log.list(1).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  const [it] = log.list(1);
  assert.ok(it, "明文请求应有一条日志");
  assert.equal(it.kind, "relay-http");
  assert.equal(it.method, "GET");
  assert.equal(it.status, 200);
  assert.equal(it.url, `http://127.0.0.1:${TARGET}/abs?q=2`);
  assert.ok(it.upBytes > 0 && it.downBytes > 0);
  assert.match(it.resPreview, /TARGET-BODY:\/abs\?q=2/);
  const s = log.summary();
  assert.equal(s.total, 1);
  assert.ok(s.downBytes > 0);
});

test("relay: getProxy 返回 null（停用）→ 507 且日志记录失败", async (t) => {
  const log = createTrafficLog({});
  const relay = createRelay({ log, getProxy: () => null, timeoutMs: 2000 });
  const { port } = await relay.start();
  t.after(() => relay.stop());
  const sock = net.connect(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  sock.end("GET http://example.com/x HTTP/1.1\r\nHost: example.com\r\n\r\n");
  const resp = await readAll(sock);
  assert.match(resp, /507/);
  for (let i = 0; i < 20 && log.list(1).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  const [it] = log.list(1);
  assert.ok(it);
  assert.match(it.error, /proxy disabled/);
  assert.equal(log.summary().errors, 1);
});

test("relay: stop 关闭监听与既有连接", async (t) => {
  const relay = createRelay({ getProxy: () => null });
  const { port } = await relay.start();
  const sock = net.connect(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  relay.stop();
  assert.equal(relay.status().listening, false);
  const closed = await new Promise((r) => { sock.once("close", () => r(true)); setTimeout(() => r(false), 1000); });
  assert.equal(closed, true);
});

test("relay: 客户端中途断开 → 上游销毁、日志 finalize、无泄漏", async (t) => {
  // 目标：慢速大响应（撑满客户端缓冲触发 writeChunk 的 await drain）
  const target = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    for (let i = 0; i < 100; i++) res.write("SLOW-CHUNK-".repeat(100));
    // 不 end：响应保持打开
  });
  await new Promise((r) => target.listen(19195, "127.0.0.1", r));
  const up = await startUpstream();
  const log = createTrafficLog({});
  const relay = createRelay({
    log,
    getProxy: () => ({ protocol: "http", host: "127.0.0.1", port: UPSTREAM, noProxy: [] }),
    timeoutMs: 5000,
  });
  const { port } = await relay.start();
  t.after(() => { relay.stop(); up.close(); target.closeAllConnections(); target.close(); });

  const sock = net.connect(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  sock.write(`GET http://127.0.0.1:19195/slow HTTP/1.1\r\nHost: x\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 150)); // 让响应开始流动
  sock.destroy(); // 客户端中途断开
  // 中继应尽快收尾（上游销毁 → rs 读取报错/请求体写失败 → finalize），不挂死不泄漏
  for (let i = 0; i < 40 && log.summary().live !== 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(log.summary().live, 0, "客户端断开后 live 记录应被回收");
  assert.equal(relay.status().connections, 0, "连接应被清理");
});
