import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { proxiedFetch } from "../lib/proxy-fetch.js";

const TARGET = 18990;

/** 最小 SOCKS5 mock：无认证(0x00) / 用户密码(0x02, socksuser/sockspass)；CONNECT 支持 ATYP 0x01/0x03。 */
function startSocks5(port, { requireAuth = false } = {}) {
  const upstreams = new Set();
  const server = net.createServer((client) => {
    client.on("error", () => {});
    const handleConnect = (buf) => {
      const atyp = buf[3];
      let host;
      if (atyp === 0x01) host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      else if (atyp === 0x03) host = buf.subarray(5, 5 + buf[4]).toString();
      else host = "::1";
      const targetPort = buf.readUInt16BE(buf.length - 2);
      const upstream = net.connect(targetPort, host, () => {
        upstreams.add(upstream);
        upstream.on("close", () => upstreams.delete(upstream));
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => { try { client.destroy(); } catch {} });
      client.on("error", () => { try { upstream.destroy(); } catch {} });
    };
    const afterGreeting = () => client.once("data", (d) => handleConnect(d));
    client.once("data", function greeting(buf) {
      if (buf[0] !== 0x05) return client.destroy();
      const methods = buf.subarray(2, 2 + buf[1]);
      if (requireAuth) {
        if (!methods.includes(0x02)) return client.end(Buffer.from([0x05, 0xff]));
        client.write(Buffer.from([0x05, 0x02]));
        client.once("data", function authReq(a) {
          const ulen = a[1];
          const plen = a[2 + ulen];
          const user = a.subarray(2, 2 + ulen).toString();
          const pass = a.subarray(3 + ulen, 3 + ulen + plen).toString();
          if (user === "socksuser" && pass === "sockspass") {
            client.write(Buffer.from([0x01, 0x00]));
            client.resume();
            afterGreeting();
          } else {
            client.end(Buffer.from([0x01, 0x01]));
          }
        });
      } else {
        if (!methods.includes(0x00)) return client.end(Buffer.from([0x05, 0xff]));
        client.write(Buffer.from([0x05, 0x00]));
        afterGreeting();
      }
    });
  });
  server.destroyUpstreams = () => { for (const u of upstreams) { try { u.destroy(); } catch {} } };
  server.ready = new Promise((r) => server.listen(port, "127.0.0.1", r));
  return server;
}

test("socks5 端到端：无认证 / 正确认证 / 错误认证", async (t) => {
  const target = http.createServer((req, res) => { res.writeHead(200); res.end("SOCKS-TARGET-BODY"); });
  const noAuthSrv = startSocks5(18989, { requireAuth: false });
  await noAuthSrv.ready;
  const authSrv = startSocks5(18988, { requireAuth: true });
  await authSrv.ready;
  await new Promise((r) => target.listen(TARGET, r));
  t.after(() => {
    try { noAuthSrv.destroyUpstreams(); } catch {}
    try { authSrv.destroyUpstreams(); } catch {}
    for (const srv of [noAuthSrv, authSrv, target]) {
      try { srv.closeAllConnections(); } catch {}
      try { srv.close(); } catch {}
    }
  });

  const noAuth = { protocol: "socks5", host: "127.0.0.1", port: 18989, noProxy: [] };
  const r1 = await proxiedFetch("http://127.0.0.1:" + TARGET + "/x", { method: "GET" }, noAuth, fetch);
  assert.equal(r1.status, 200);
  assert.equal(await r1.text(), "SOCKS-TARGET-BODY");

  const goodAuth = { protocol: "socks5", host: "127.0.0.1", port: 18988, username: "socksuser", password: "sockspass", noProxy: [] };
  const r2 = await proxiedFetch("http://127.0.0.1:" + TARGET + "/x", { method: "GET" }, goodAuth, fetch);
  assert.equal(r2.status, 200);
  assert.equal(await r2.text(), "SOCKS-TARGET-BODY");

  const badAuth = { protocol: "socks5", host: "127.0.0.1", port: 18988, username: "wrong", password: "nope", noProxy: [] };
  await assert.rejects(
    proxiedFetch("http://127.0.0.1:" + TARGET + "/x", { method: "GET" }, badAuth, fetch),
    (e) => /auth failed/.test(e.message)
  );
});


