import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { httpConnect } from "../lib/proxy/conn.js";

const PROXY = 18986;

test("httpConnect: 消费完整 CONNECT 响应头（分包到达也不残留）", async (t) => {
  const clients = new Set();
  // mock HTTP 代理：CONNECT 响应分两次写（状态行  其余头），隧道建好后推送标记数据
  const server = net.createServer((sock) => {
    clients.add(sock);
    sock.on("error", () => {});
    let phase = 0;
    sock.on("data", (buf) => {
      const text = buf.toString();
      if (phase === 0 && text.startsWith("CONNECT")) {
        phase = 1;
        sock.write("HTTP/1.1 200 Connection established\r\n"); // 第一包：仅状态行
        setTimeout(() => sock.write("Proxy-Agent: split-packet-test\r\n\r\n"), 30); // 第二包：剩余头
        setTimeout(() => sock.write("POST-TUNNEL-MARKER"), 90); // 隧道层第一个数据块
      }
    });
  });
  await new Promise((r) => server.listen(PROXY, "127.0.0.1", r));
  t.after(() => {
    for (const c of clients) { try { c.destroy(); } catch {} }
    try { server.closeAllConnections(); } catch {}
    try { server.close(); } catch {}
  });

  const proxy = { protocol: "http", host: "127.0.0.1", port: PROXY, noProxy: [] };
  const raw = await httpConnect(proxy, "example.com", 443, undefined, 5000);

  // 隧道建立后，socket 上的第一个数据块必须是隧道层数据，不得混入代理响应头残留
  const first = await new Promise((resolve) => {
    raw.once("data", (d) => resolve(d.toString()));
  });
  assert.equal(first, "POST-TUNNEL-MARKER", `CONNECT 响应头残留泄漏进隧道: ${JSON.stringify(first)}`);
  raw.destroy();
});
