import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { proxiedFetch } from "../lib/proxy-fetch.js";

const TARGET = 18985, PROXY = 18984;

test("proxiedFetch 入参与 body 类型", async (t) => {
  const target = http.createServer((req, res) => {
    if (req.url === "/echo") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": req.headers["content-type"] || "text/plain" });
        res.end(Buffer.concat(chunks).toString() || "NO-BODY");
      });
      return;
    }
    res.writeHead(200); res.end("OK");
  });
  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url);
    const fwd = { ...req.headers };
    delete fwd.connection; delete fwd["content-length"]; delete fwd["transfer-encoding"]; // hop-by-hop / 定界交给 http 模块
    const p = http.request({ host: u.hostname, port: +(u.port || 80), path: u.pathname + u.search, method: req.method, headers: fwd, agent: false });
    p.on("response", (r) => { res.writeHead(r.statusCode || 200, r.headers); r.pipe(res); });
    p.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  const listen = (srv, port) => new Promise((r) => srv.listen(port, r));
  await listen(target, TARGET);
  await listen(proxy, PROXY);
  t.after(() => { for (const s of [target, proxy]) { try { s.closeAllConnections(); } catch {} try { s.close(); } catch {} } });
  const cfg = { protocol: "http", host: "127.0.0.1", port: PROXY, noProxy: [] };

  await t.test("URL 实例作为 input（标准 fetch 合法入参）", async () => {
    const r = await proxiedFetch(new URL("http://127.0.0.1:" + TARGET + "/echo"), { method: "GET" }, cfg, fetch);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "NO-BODY");
  });

  await t.test("URLSearchParams body 正确发送", async () => {
    const body = new URLSearchParams({ a: "1", b: "二" });
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/echo", { method: "POST", body }, cfg, fetch);
    assert.equal(await r.text(), "a=1&b=%E4%BA%8C");
  });

  await t.test("Blob body 正确发送", async () => {
    const blob = new Blob(["BLOB-BODY"], { type: "text/plain" });
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/echo", { method: "POST", body: blob }, cfg, fetch);
    assert.equal(await r.text(), "BLOB-BODY");
  });

  await t.test("Node 流 body 经 pipe 发送", async () => {
    const { Readable } = await import("node:stream");
    const stream = Readable.from(["STREAM-", "BODY"]);
    const r = await proxiedFetch("http://127.0.0.1:" + TARGET + "/echo", { method: "POST", body: stream }, cfg, fetch);
    assert.equal(await r.text(), "STREAM-BODY");
  });

  await t.test("ReadableStream body 明确报 EBODY", async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } });
    await assert.rejects(
      proxiedFetch("http://127.0.0.1:" + TARGET + "/echo", { method: "POST", body }, cfg, fetch),
      (e) => e.code === "EBODY"
    );
  });
});


