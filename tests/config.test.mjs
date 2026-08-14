import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaults, toProxy, toCfg, loadConfig, writeConfig } from "../lib/config.js";

test("config: defaults/toProxy/toCfg 契约", () => {
  const d = defaults();
  assert.equal(d.protocol, "http");
  assert.equal(d.port, 7890);
  assert.deepEqual(d.noProxy, ["127.0.0.1", "localhost", "::1"]);

  const p = toProxy({ protocol: "socks5", host: "h", port: 1111, noProxy: [] });
  assert.equal(p.protocol, "socks5");
  assert.equal(p.host, "h");
  assert.equal(p.port, 1111);

  const c = toCfg({ enabled: true, host: "x" });
  assert.equal(c.enabled, true);
  assert.equal(c.host, "x");
  assert.equal(c.protocol, "http"); // 未提供时用默认
});

test("config: writeConfig -> loadConfig 往返", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npcfg-"));
  const file = path.join(dir, "net-proxy.json");
  const written = writeConfig({ enabled: true, protocol: "socks5", host: "127.0.0.1", port: 7777, noProxy: ["a"] }, file);
  assert.equal(written.enabled, true);
  const loaded = loadConfig(file);
  assert.equal(loaded.protocol, "socks5");
  assert.equal(loaded.port, 7777);
  fs.rmSync(dir, { recursive: true, force: true });
});
