import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { proxiedFetch } from "../lib/proxy-fetch.js";

const TARGET = 18992, PROXY = 18991;
const proxyCfg = { protocol: "http", host: "127.0.0.1", port: PROXY, username: "", password: "", noProxy: [] };
const listen = (srv, port) => new Promise((r) => srv.listen(port, r));

test("proxiedFetch: 普通 / redirect / gzip / br / deflate 均正确", async (t) => {
  const bodies = {
    "/real": "REAL-BODY",
    "/gzip": zlib.gzipSync(Buffer.from("GZIP-BODY")),
    "/br": zlib.brotliCompressSync(Buffer.from("BR-BODY")),
    "/deflate": zlib.deflateSync(Buffer.from("DEFLATE-BODY")),
  };
  const encodings = { "/gzip": "gzip", "/br": "br", "/deflate": "deflate" };

  const target = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://127.0.0.1:" + TARGET + "/real" });
      return res.end();
    }
    const b = bodies[req.url];
    if (b) {
      const h = { "Content-Length": b.length };
      if (encodings[req.url]) h["Content-Encoding"] = encodings[req.url];
      res.writeHead(200, h);
      return res.end(b);
    }
    res.writeHead(404); res.end();
  });
  // agent:false → 不使用 keep-alive，测试结束 server 才能正确关闭、进程才能退出
  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url);
    const p = http.request({
      host: u.hostname, port: +(u.port || 80), path: u.pathname + u.search,
      method: req.method, headers: req.headers, agent: false,
    });
    p.on("response", (r) => { res.writeHead(r.statusCode || 200, r.headers); r.pipe(res); });
    p.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  await listen(target, TARGET);
  await listen(proxy, PROXY);
  t.after(() => { target.close(); proxy.close(); });

  await t.test("普通请求", async () => {
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/real", { method: "GET" }, proxyCfg, fetch);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "REAL-BODY");
  });

  await t.test("302 自动跟随", async () => {
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/redirect", { method: "GET" }, proxyCfg, fetch);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "REAL-BODY");
  });

  await t.test("gzip 自动解压", async () => {
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/gzip", { method: "GET" }, proxyCfg, fetch);
    assert.equal(await r.text(), "GZIP-BODY");
  });

  await t.test("brotli 自动解压", async () => {
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/br", { method: "GET" }, proxyCfg, fetch);
    assert.equal(await r.text(), "BR-BODY");
  });

  await t.test("deflate 自动解压", async () => {
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/deflate", { method: "GET" }, proxyCfg, fetch);
    assert.equal(await r.text(), "DEFLATE-BODY");
  });
});
