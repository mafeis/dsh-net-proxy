import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import url from "node:url";
import { proxiedFetch } from "../lib/proxy-fetch.js";
import { resetAlpnAffinity } from "../lib/proxy/tls.js";

// issue #13：ALPN 曾硬编码 ["h2","http/1.1"]，部分代理链路/目标边缘见 h2 即 RST。
// 这里让对端真的「见 h2 就砸链路」来复现，并验证：默认 http/1.1 不再触发；
// 显式 alpn="h2" 时握手与会话两个阶段都能降级；h2Fallback=false 时保持硬失败。
const here = path.dirname(url.fileURLToPath(import.meta.url));
const TLS_KEY = fs.readFileSync(path.join(here, "fixtures", "test-key.pem"));
const TLS_CERT = fs.readFileSync(path.join(here, "fixtures", "test-cert.pem"));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // 测试专用自签证书

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", r));
const cfgFor = (port, extra = {}) => ({ protocol: "http", host: "127.0.0.1", port, username: "", password: "", noProxy: [], ...extra });

/**
 * 记录 ClientHello 的 ALPN；含 h2 就 RST（模拟可疑代理出口），否则把这条连接原样转给一个
 * 内层 TLS 服务端。用裸 net 监听 + 显式回写首块，才不会丢 ClientHello：tls.Server 在
 * connection 里立刻接管读取，外部监听器拿不到首块数据。
 * 返回 { port, hellos }。
 */
async function rstOnH2(t) {
  const hellos = [];
  const sockets = new Set();
  const track = (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {}); };

  const inner = tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (sock) => {
    sock.on("error", () => {});
    sock.on("data", () => {
      sock.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 11\r\nConnection: close\r\n\r\nFALLBACK-OK");
    });
  });
  await new Promise((r) => inner.listen(0, "127.0.0.1", r));
  const innerPort = inner.address().port;

  const target = net.createServer((sock) => {
    track(sock);
    sock.once("data", (d) => {
      const hasH2 = d.includes(Buffer.from([0x02, 0x68, 0x32])); // ALPN 条目 "h2"
      hellos.push(hasH2);
      if (hasH2) return void sock.destroy(); // RST：ClientHello 之后立即掐断
      const up = net.connect(innerPort, "127.0.0.1", () => {
        up.write(d); // 回放已被本层读走的 ClientHello
        sock.pipe(up);
        up.pipe(sock);
      });
      track(up);
    });
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const port = target.address().port;
  t.after(() => { for (const s of sockets) try { s.destroy(); } catch {}; inner.close(); target.close(); });
  return { port, hellos };
}

/** HTTP CONNECT 代理，隧道接到 targetPort；记录拨隧道次数，返回 { port, connects, close }。 */
async function proxyTo(targetPort) {
  const sockets = new Set();
  const proxy = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  const st = { port: 0, connects: 0, close: null };
  proxy.on("connect", (req, clientSock) => {
    st.connects++;
    const target = net.connect(targetPort, "127.0.0.1", () => {
      clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");
      clientSock.pipe(target);
      target.pipe(clientSock);
    });
    sockets.add(clientSock);
    sockets.add(target);
    target.on("error", () => { try { clientSock.destroy(); } catch {} });
    clientSock.on("error", () => { try { target.destroy(); } catch {} });
  });
  await listen(proxy);
  st.port = proxy.address().port;
  st.close = () => { for (const s of sockets) try { s.destroy(); } catch {}; proxy.closeAllConnections?.(); proxy.close(); };
  return st;
}
void 0;

/** 带 h2 的握手会被 RST 的目标（tls.Server 直接回 HTTP/1.1 文本）；返回目标端口、代理与 hello 记录。 */
async function brokenH2Target(t) {
  const spy = await rstOnH2(t);
  const proxy = await proxyTo(spy.port);
  t.after(() => proxy.close());
  return { port: spy.port, proxy, hellos: spy.hellos };
}

test("issue #13：默认 http/1.1 的 ClientHello 不含 h2，见 h2 就 RST 的链路可直接访问", async (t) => {
  resetAlpnAffinity();
  const { port, proxy } = await brokenH2Target(t);
  const r = await proxiedFetch(`https://127.0.0.1:${port}/`, {}, cfgFor(proxy.port), fetch);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "FALLBACK-OK");
  assert.equal(proxy.connects, 1, "默认策略一次握手即成功，不需要降级重拨");
});

test("issue #13：显式 alpn=h2 被 RST 后自动改发 http/1.1 成功", async (t) => {
  resetAlpnAffinity();
  const { port, proxy, hellos } = await brokenH2Target(t);
  const r = await proxiedFetch(`https://127.0.0.1:${port}/`, {}, cfgFor(proxy.port, { alpn: "h2" }), fetch);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "FALLBACK-OK");
  assert.deepEqual(hellos, [true, false], "首次带 h2 被 RST，降级重试只发 http/1.1");
  assert.equal(proxy.connects, 2, "降级需要重新拨一条隧道");
});

test("issue #13：h2 握手成功但会话一上来就断 —— 未发请求字节时也降级", async (t) => {
  resetAlpnAffinity();
  // allowHTTP1=false 且一律 RST 已建立的 h2 会话：模拟「放行 ALPN 但砸 h2 会话」的出口
  const target = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT, allowHTTP1: true });
  target.on("request", (req, res) => { res.writeHead(200); res.end("H1-STREAM-OK"); });
  target.on("connection", (s) => { s.on("error", () => {}); });
  target.on("session", (s) => { s.on("error", () => {}); setImmediate(() => { try { s.socket.destroy(); } catch {} }); });
  await listen(target);
  const proxy = await proxyTo(target.address().port);
  t.after(() => { proxy.close(); target.close(); });

  const r = await proxiedFetch(`https://127.0.0.1:${target.address().port}/`, {}, cfgFor(proxy.port, { alpn: "h2" }), fetch);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "H1-STREAM-OK");
});

test("issue #13：alpn=off 不发 ALPN 扩展", async (t) => {
  resetAlpnAffinity();
  const { port, proxy, hellos } = await brokenH2Target(t);
  const r = await proxiedFetch(`https://127.0.0.1:${port}/`, {}, cfgFor(proxy.port, { alpn: "off" }), fetch);
  assert.equal(r.status, 200);
  assert.deepEqual(hellos, [false], "off 的 ClientHello 里没有 h2 条目");
});

test("issue #13：h2Fallback=false 保持现状，只握手一次并硬失败", async (t) => {
  resetAlpnAffinity();
  const { proxy } = await brokenH2Target(t);
  await assert.rejects(
    proxiedFetch(`https://127.0.0.1:13400/`, {}, cfgFor(proxy.port, { alpn: "h2", h2Fallback: false }), fetch),
    { code: "ETLS" },
  );
  assert.equal(proxy.connects, 1, "关闭降级后不重拨隧道");
});
