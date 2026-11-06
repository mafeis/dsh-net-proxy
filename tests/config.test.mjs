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

test("config: alpn/h2Fallback 契约（issue #13）", () => {
  // 默认不再声明 h2：见 h2 就 RST 的链路才会通
  assert.equal(defaults().alpn, "http/1.1");
  assert.equal(defaults().h2Fallback, true);
  assert.equal(toProxy({ protocol: "http", host: "h", port: 1 }).alpn, "http/1.1");
  assert.equal(toProxy({ protocol: "http", host: "h", port: 1 }).h2Fallback, true);
  assert.equal(toProxy({ protocol: "http", host: "h", port: 1, alpn: "h2" }).alpn, "h2");
  assert.equal(toProxy({ protocol: "http", host: "h", port: 1, alpn: "off" }).alpn, "off");
  assert.equal(toProxy({ protocol: "http", host: "h", port: 1, h2Fallback: false }).h2Fallback, false);
  // 大小写/空格归一；非法值落在默认，不让坏配置 deafen 整个代理
  assert.equal(toProxy({ protocol: "http", host: "h", port: 1, alpn: " H2 " }).alpn, "h2");
  assert.equal(toProxy({ protocol: "http", host: "h", port: 1, alpn: "h3" }).alpn, "http/1.1");
  // toCfg 是写入侧校验：和其他字段一样，未知取值直接报错
  assert.equal(toCfg({ alpn: "h2" }).alpn, "h2");
  assert.throws(() => toCfg({ alpn: "h3" }), /invalid alpn/);
  // 只有明确的 false 才关掉降级
  assert.equal(toCfg({}).h2Fallback, true);
  assert.equal(toCfg({ h2Fallback: false }).h2Fallback, false);
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
