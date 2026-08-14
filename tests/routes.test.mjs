import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsHandler } from "../lib/routes.js";

function fakeRes() {
  const r = { status: null, headers: null, data: "" };
  r.writeHead = (c, o) => { r.status = c; r.headers = o; };
  r.end = (s) => { r.data = s; };
  return r;
}
function fakeReq(method, body) {
  const r = { method, _body: body };
  r.on = (ev, cb) => { if (ev === "data" && r._body != null) cb(r._body); if (ev === "end") cb(); };
  return r;
}
const flush = () => new Promise((r) => setImmediate(r));

test("routes: GET 返回当前配置（文件不存在 → defaults）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nproutes-"));
  try {
    const file = path.join(dir, "net-proxy.json");
    const res = fakeRes();
    settingsHandler(fakeReq("GET"), res, file);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.ok, true);
    assert.equal(body.value.enabled, false);
    assert.deepEqual(body.value.noProxy, ["127.0.0.1", "localhost", "::1"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("routes: POST 写配置并触发 reloadFn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nproutes-"));
  try {
    const file = path.join(dir, "net-proxy.json");
    let reloaded = 0;
    const res = fakeRes();
    settingsHandler(fakeReq("POST", JSON.stringify({ enabled: true, host: "1.2.3.4", protocol: "socks5" })), res, file, () => { reloaded++; });
    await flush();
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.ok, true);
    assert.equal(body.value.enabled, true);
    assert.equal(body.value.host, "1.2.3.4");
    assert.equal(reloaded, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("routes: POST action=probe 调用 probeFn 且不改配置", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nproutes-"));
  try {
    const file = path.join(dir, "net-proxy.json");
    let got = null;
    const res = fakeRes();
    settingsHandler(fakeReq("POST", JSON.stringify({ action: "probe", proxy: { host: "x", port: 9 } })), res, file, undefined,
      (p) => { got = p; return Promise.resolve({ ok: true, connectMs: 3 }); });
    await flush();
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.ok, true);
    assert.equal(body.connectMs, 3);
    assert.equal(got.host, "x");
    assert.equal(fs.existsSync(file), false); // 探测不改配置
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("routes: 非 GET/POST → 405", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nproutes-"));
  try {
    const res = fakeRes();
    settingsHandler(fakeReq("PUT"), res, path.join(dir, "net-proxy.json"));
    assert.equal(res.status, 405);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
