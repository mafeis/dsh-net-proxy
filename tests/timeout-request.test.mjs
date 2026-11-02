import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { once } from "node:events";
import { apply } from "../lib/index.js";
import { loadConfig, writeConfig, toProxy } from "../lib/config.js";
import { proxiedFetch } from "../lib/proxy-fetch.js";

// Self-signed loopback fixture only, isolated by node:test's per-file process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const key = fs.readFileSync(new URL("fixtures/test-key.pem", import.meta.url));
const cert = fs.readFileSync(new URL("fixtures/test-cert.pem", import.meta.url));
const SHORT = 300;
const LONG = 2000;
const DELAY = 700;

async function fixture(t, protocol) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "np-request-timeout-"));
  const file = path.join(directory, "net-proxy.json");
  const sockets = new Set(), sessions = new Set(), timers = new Set();
  let onRequest = () => {};
  function track(socket) {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    return socket;
  }
  function later(fn, ms) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  }
  function serve(mode, response, h2) {
    response.on("error", () => {});
    onRequest();
    const alive = () => !response.destroyed && !response.closed;
    const headers = () => {
      if (!alive()) return;
      if (h2) response.respond({ ":status": 200, "content-type": "text/event-stream" });
      else { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); }
    };
    const data = () => { if (alive()) response.write(": heartbeat\n\n"); };
    const end = () => { if (alive()) response.end("data: done\n\n"); };
    if (mode === "/delayed") later(() => { headers(); end(); }, DELAY);
    else if (mode === "/active") {
      headers(); data();
      for (let n = 1; n <= 7; n++) later(data, n * 100);
      later(end, 800);
    } else { headers(); data(); later(end, DELAY); }
  }
  const target = protocol === "h2"
    ? http2.createSecureServer({ key, cert, allowHTTP1: false })
    : http.createServer((req, res) => serve(new URL(req.url, "http://fixture.invalid").pathname, res, false));
  target.on("connection", track);
  target.on("session", session => { sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session)); });
  if (protocol === "h2") target.on("stream", (stream, headers) => { stream.resume(); serve(headers[":path"], stream, true); });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  let proxy = target;
  if (protocol === "h2") {
    proxy = http.createServer();
    proxy.on("connection", track);
    proxy.on("connect", (req, client, head) => {
      const upstream = track(net.connect(target.address().port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      }));
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
  }
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    proxy.close();
    if (target !== proxy) target.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = protocol === "h2" ? `https://fixture.invalid:${target.address().port}` : "http://fixture.invalid";
  function save(timeout) { writeConfig({ enabled: true, host: "127.0.0.1", port: proxy.address().port, timeout }, file); }
  function request(route, signal = AbortSignal.timeout(5000)) {
    // Intentionally cross disk + validation + projection, not a hand-built proxy.
    return proxiedFetch(origin + route, { signal }, toProxy(loadConfig(file)), fetch);
  }
  return { file, directory, origin, save, request, setOnRequest(fn) { onRequest = fn; } };
}

for (const protocol of ["h1", "h2"]) {
  test(`timeout ${protocol}: saved limits control delayed response headers`, { timeout: 10000 }, async t => {
    const f = await fixture(t, protocol);
    f.save(SHORT);
    await assert.rejects(f.request("/delayed"), { code: "ETIMEOUT" });
    f.save(LONG);
    assert.match(await (await f.request("/delayed")).text(), /data: done/);
  });

  test(`timeout ${protocol}: active streams can outlast the configured value`, { timeout: 10000 }, async t => {
    const f = await fixture(t, protocol);
    f.save(SHORT);
    const started = performance.now();
    const text = await (await f.request("/active")).text();
    assert.match(text, /data: done/);
    assert.ok(performance.now() - started > SHORT * 2);
  });

  test(`timeout ${protocol}: response-body behavior remains unchanged`, { timeout: 10000 }, async t => {
    const f = await fixture(t, protocol);
    f.save(SHORT);
    const response = await f.request("/stall");
    if (protocol === "h1") await assert.rejects(response.text(), { code: "ETIMEOUT" });
    else assert.match(await response.text(), /data: done/); // h2 only times response headers.
  });

  test(`timeout ${protocol}: caller cancellation works before and after headers`, { timeout: 10000 }, async t => {
    const f = await fixture(t, protocol);
    f.save(LONG);
    for (const route of ["/delayed", "/stall"]) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 80);
      try {
        await assert.rejects((async () => { const response = await f.request(route, ac.signal); return response.text(); })(), { name: "AbortError" });
      } finally { clearTimeout(timer); }
    }
  });
}

test("timeout: saving through the plugin route updates new fetches without extending in-flight ones", { timeout: 10000 }, async t => {
  const f = await fixture(t, "h1");
  f.save(SHORT);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = f.directory;
  const originalFetch = globalThis.fetch;
  const handlers = new Map();
  const dispose = apply({
    logger: { info() {}, error() {} },
    inject(names, fn) {
      fn({ effect(effect) { return effect(); }, webServer: { register(route) { handlers.set(route.path, route.handler); return () => handlers.delete(route.path); } } });
    },
  }, {});
  t.after(async () => {
    dispose();
    globalThis.fetch = originalFetch;
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    // Let the plugin's asynchronous harness synchronization/disposal finish.
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  f.setOnRequest(markStarted);
  const oldRequest = globalThis.fetch(f.origin + "/delayed", { signal: AbortSignal.timeout(5000) });
  const oldResult = assert.rejects(oldRequest, { code: "ETIMEOUT" });
  await started;
  const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
  handlers.get("/_dsh/net-proxy")({
    method: "POST", headers: { host: "localhost", "x-dsh-net-proxy": "1" },
    on(event, fn) { if (event === "data") fn(JSON.stringify({ timeout: LONG })); if (event === "end") fn(); },
  }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.value.timeout, LONG);
  const newRequest = globalThis.fetch(f.origin + "/delayed", { signal: AbortSignal.timeout(5000) });
  await oldResult;
  assert.match(await (await newRequest).text(), /data: done/);
});

test("timeout: NO_PROXY continues to defer to the original fetch", async () => {
  let called = false;
  const signal = new AbortController().signal;
  const response = await proxiedFetch("http://localhost/", { signal }, toProxy({ timeout: 1 }), async (url, init) => {
    called = true;
    assert.equal(init.signal, signal);
    return new Response("direct");
  });
  assert.equal(called, true);
  assert.equal(await response.text(), "direct");
});
