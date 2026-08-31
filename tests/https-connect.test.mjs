import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import url from "node:url";
import { proxiedFetch } from "../lib/proxy-fetch.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const TLS_KEY = fs.readFileSync(path.join(here, "fixtures", "test-key.pem"));
const TLS_CERT = fs.readFileSync(path.join(here, "fixtures", "test-cert.pem"));
// 测试专用自签证书（仅 CN=127.0.0.1），与生产无关
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const TARGET = 18993, PROXY = 18994;

test("https 经 HTTP CONNECT 隧道端到端（真实 TLS + 自签证书）", async (t) => {
  const target = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("HTTPS-TUNNEL-OK");
  });
  // mock HTTP 代理：收到 CONNECT 时打开到目标的 TCP，随后双向转发原始字节
  const upstreams = new Set();
  const proxy = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  proxy.on("connect", (req, clientSock, head) => {
    const u = new URL("http://" + req.url);
    const upstream = net.connect(Number(u.port), "127.0.0.1", () => {
      upstreams.add(upstream);
      upstream.on("close", () => upstreams.delete(upstream));
      clientSock.write("HTTP/1.1 200 Connection established\r\nProxy-Agent: dsh-net-proxy-test\r\n\r\n");
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
    target.closeAllConnections();
    target.close();
    proxy.closeAllConnections();
    proxy.close();
  });

  const cfg = { protocol: "http", host: "127.0.0.1", port: PROXY, username: "", password: "", noProxy: [] };
  const r = await proxiedFetch("https://127.0.0.1:" + TARGET + "/tunnel", { method: "GET" }, cfg, fetch);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "HTTPS-TUNNEL-OK");
});

