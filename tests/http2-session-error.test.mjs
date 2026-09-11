import test from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import url from "node:url";
import { proxiedFetch } from "../lib/proxy-fetch.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const TLS_KEY = fs.readFileSync(path.join(here, "fixtures", "test-key.pem"));
const TLS_CERT = fs.readFileSync(path.join(here, "fixtures", "test-cert.pem"));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const TARGET = 18971, PROXY = 18972;

test("h2 长连接中途断开：调用方收到错误，且不得逃逸成 uncaughtException", async (t) => {
  const escapes = [];
  const onUncaught = (e) => escapes.push(e);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.off("uncaughtException", onUncaught));

  // h2 目标：发响应头 + 一块数据后保持流不结束（模拟 SSE 长连接）
  const target = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT, allowHTTP1: false });
  target.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200, "content-type": "text/event-stream" });
    stream.write(": keep-alive\n\n");
  });

  // mock HTTP 代理：CONNECT 隧道，保留 client 侧 socket 以便注入坏字节
  const clientSockets = new Set();
  const upstreams = new Set();
  const proxy = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  proxy.on("connect", (req, clientSock, head) => {
    const u = new URL("http://" + req.url);
    const upstream = net.connect(Number(u.port), "127.0.0.1", () => {
      upstreams.add(upstream);
      upstream.on("close", () => upstreams.delete(upstream));
      clientSockets.add(clientSock);
      clientSock.on("close", () => clientSockets.delete(clientSock));
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
    for (const s of clientSockets) { try { s.destroy(); } catch {} }
    for (const u of upstreams) { try { u.destroy(); } catch {} }
    target.closeAllConnections?.(); target.close();
    proxy.closeAllConnections?.(); proxy.close();
  });

  const cfg = { protocol: "http", host: "127.0.0.1", port: PROXY, username: "", password: "", noProxy: [] };
  const response = await proxiedFetch("https://127.0.0.1:" + TARGET + "/stream", { method: "GET" }, cfg, fetch);
  assert.equal(response.status, 200);

  // 连接仍在使用中（响应体未结束）时，往 TLS 流里注入非法记录 → 客户端 TLS 层报错
  for (const s of clientSockets) s.write(Buffer.from("not-a-tls-record"));

  let rejected = null;
  await response.text().catch((e) => { rejected = e; });
  await new Promise((r) => setTimeout(r, 300));

  assert.notEqual(rejected, null, "响应体读取应因连接中断而失败");
  assert.deepEqual(escapes.map((e) => e && e.message), [], "不得出现 uncaughtException");
});
