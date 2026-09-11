// tests/system-proxy.test.mjs — v0.3.0 跟随系统代理：
//   1. ProxyServer / scutil / 环境变量解析
//   2. ProxyOverride 绕过列表转换 + noProxy 前缀通配
//   3. readSystemProxy（注入 fake execFn / env / platform）
//   4. applyFollowSystem 合并语义（开/关/PAC/读取失败/未开启跟随）
//   5. followSystem 配置字段读写往返
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRegValues, parseProxyServer, parseBypassList,
  parseScutilOutput, parseUrlProxy,
  readSystemProxy, applyFollowSystem, describeSystemState,
} from "../lib/system-proxy.js";
import { isNoProxy } from "../lib/proxy-fetch.js";
import { writeConfig, loadConfig, toCfg } from "../lib/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ───────────────────────── ProxyServer 解析 ─────────────────────────

test("parseProxyServer: 单值 / 分协议 / socks", () => {
  assert.deepEqual(parseProxyServer("127.0.0.1:7890"), { protocol: "http", host: "127.0.0.1", port: 7890 });
  assert.deepEqual(parseProxyServer("http=127.0.0.1:8080;https=127.0.0.1:8081"), { protocol: "http", host: "127.0.0.1", port: 8081 });
  assert.deepEqual(parseProxyServer("socks=127.0.0.1:1080"), { protocol: "socks5", host: "127.0.0.1", port: 1080 });
  assert.deepEqual(parseProxyServer("[::1]:7890"), { protocol: "http", host: "::1", port: 7890 });
  assert.equal(parseProxyServer(""), null);
  assert.equal(parseProxyServer(null), null);
});

test("parseRegValues: reg query 输出", () => {
  const v = parseRegValues([
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    127.0.0.1:5678",
    "    ProxyOverride    REG_SZ    localhost;127.*;192.168.*;*.foo.com;<local>",
  ].join("\r\n"));
  assert.equal(v.proxyenable, "0x1");
  assert.equal(v.proxyserver, "127.0.0.1:5678");
  assert.equal(v.proxyoverride, "localhost;127.*;192.168.*;*.foo.com;<local>");
});

test("parseBypassList: 通配/后缀/<local> 转换", () => {
  assert.deepEqual(
    parseBypassList("localhost;127.*;192.168.*;*.foo.com;<local>"),
    ["localhost", "127.*", "192.168.*", ".foo.com", "<local>"]
  );
});

test("isNoProxy: Windows ProxyOverride 风格前缀通配", () => {
  assert.equal(isNoProxy("http://192.168.1.5/x", ["192.168.*"]), true);
  assert.equal(isNoProxy("http://10.1.2.3/x", ["10.*"]), true);
  assert.equal(isNoProxy("http://192.167.1.5/x", ["192.168.*"]), false); // 前缀必须带点边界
  assert.equal(isNoProxy("http://a.foo.com/x", ["*.foo.com"]), true);   // *.foo.com → .foo.com 后缀
  assert.equal(isNoProxy("http://xbar.com/x", ["*.bar.com"]), false);
});

// ───────────────────────── scutil / 环境变量 ─────────────────────────

test("parseScutilOutput: HTTP 启用 / SOCKS 启用 / 关闭", () => {
  const on = parseScutilOutput([
    "<dictionary> {",
    "  HTTPEnable : 1",
    "  HTTPPort : 7890",
    "  HTTPProxy : 127.0.0.1",
    "  HTTPSEnable : 1",
    "  HTTPSPort : 7890",
    "  HTTPSProxy : 127.0.0.1",
    "  SOCKSEnable : 0",
    "  ExceptionsList : <array> {",
    "    0 : 127.0.0.1",
    "    1 : 192.168.0.0/16",
    "  }",
    "}",
  ].join("\n"));
  assert.equal(on.enabled, true);
  assert.equal(on.protocol, "http");
  assert.equal(on.host, "127.0.0.1");
  assert.equal(on.port, 7890);
  assert.deepEqual(on.bypass, ["127.0.0.1", "192.168.0.0/16"]);

  const socks = parseScutilOutput("SOCKSEnable : 1\nSOCKSProxy : 10.0.0.1\nSOCKSPort : 1080\n");
  assert.equal(socks.enabled, true);
  assert.equal(socks.protocol, "socks5");
  assert.equal(socks.port, 1080);

  const off = parseScutilOutput("HTTPEnable : 0\nSOCKSEnable : 0\n");
  assert.equal(off.enabled, false);
});

test("parseUrlProxy: http / socks5+凭据", () => {
  assert.deepEqual(parseUrlProxy("http://127.0.0.1:7890"), { protocol: "http", username: undefined, password: undefined, host: "127.0.0.1", port: 7890 });
  assert.deepEqual(parseUrlProxy("socks5://u:p@1.2.3.4:1080"), { protocol: "socks5", username: "u", password: "p", host: "1.2.3.4", port: 1080 });
  assert.equal(parseUrlProxy("not-a-url"), null);
});

// ───────────────────────── readSystemProxy（注入依赖） ─────────────────────────

test("readSystemProxy: win32 注册表文本", async () => {
  const regText = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    127.0.0.1:7890",
    "    ProxyOverride    REG_SZ    localhost;192.168.*;<local>",
  ].join("\r\n");
  const sys = await readSystemProxy({ platform: "win32", execFn: async () => regText });
  assert.equal(sys.supported, true);
  assert.equal(sys.enabled, true);
  assert.equal(sys.host, "127.0.0.1");
  assert.equal(sys.port, 7890);
  assert.deepEqual(sys.bypass, ["localhost", "192.168.*", "<local>"]);
});

test("readSystemProxy: win32 PAC 模式 / 未开启", async () => {
  const pac = await readSystemProxy({
    platform: "win32",
    execFn: async () => "    AutoConfigURL    REG_SZ    http://pac.test/w.pac",
  });
  assert.equal(pac.mode, "pac");
  assert.equal(pac.pacUrl, "http://pac.test/w.pac");

  const off = await readSystemProxy({
    platform: "win32",
    execFn: async () => "    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890",
  });
  assert.equal(off.enabled, false);

  const fail = await readSystemProxy({ platform: "win32", execFn: async () => null });
  assert.equal(fail.supported, false);
});

test("readSystemProxy: linux 环境变量", async () => {
  const on = await readSystemProxy({ platform: "linux", env: { HTTP_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1" } });
  assert.equal(on.enabled, true);
  assert.equal(on.port, 7890);
  assert.deepEqual(on.bypass, ["localhost", "127.0.0.1"]);
  const off = await readSystemProxy({ platform: "linux", env: {} });
  assert.equal(off.enabled, false);
});

// ───────────────────────── applyFollowSystem 合并语义 ─────────────────────────

const baseCfg = {
  enabled: true, followSystem: true, protocol: "http", host: "127.0.0.1", port: 7890,
  username: "u", password: "p", noProxy: ["127.0.0.1", "localhost"],
};

test("applyFollowSystem: 系统开 → 系统地址 + 凭据沿用 + noProxy 并集", () => {
  const eff = applyFollowSystem(baseCfg, {
    supported: true, mode: "manual", enabled: true,
    protocol: "socks5", host: "127.0.0.1", port: 1080,
    bypass: ["192.168.*", "<local>"],
  });
  assert.equal(eff.enabled, true);
  assert.equal(eff.protocol, "socks5");
  assert.equal(eff.port, 1080);
  assert.equal(eff.username, "u"); // 凭据沿用
  assert.ok(eff.noProxy.includes("192.168.*") && eff.noProxy.includes("127.0.0.1"));
  assert.equal(eff.followNote, "ok");
});

test("applyFollowSystem: 系统关 → 直连；PAC/失败 → 回退手动", () => {
  const off = applyFollowSystem(baseCfg, { supported: true, mode: "none", enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.followNote, "system-off");

  const pac = applyFollowSystem(baseCfg, { supported: true, mode: "pac", pacUrl: "http://x/w.pac", enabled: false });
  assert.equal(pac.enabled, true); // 回退手动配置（手动 enabled=true）
  assert.equal(pac.host, "127.0.0.1");
  assert.equal(pac.followNote, "pac");

  const bad = applyFollowSystem(baseCfg, { supported: false });
  assert.equal(bad.enabled, true);
  assert.equal(bad.followNote, "unavailable");
});

test("applyFollowSystem: 未开启跟随 → 原样", () => {
  const manual = { ...baseCfg, followSystem: false, host: "9.9.9.9", port: 1 };
  const eff = applyFollowSystem(manual, { supported: true, mode: "manual", enabled: true, protocol: "socks5", host: "1.1.1.1", port: 2, bypass: [] });
  assert.equal(eff.host, "9.9.9.9");
  assert.equal(eff.followNote, "");
});

test("describeSystemState: ok/off/pac/unavailable", () => {
  assert.deepEqual(describeSystemState({ supported: true, mode: "manual", enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 }),
    { state: "ok", proxy: "http://127.0.0.1:7890" });
  assert.deepEqual(describeSystemState({ supported: true, mode: "none", enabled: false }), { state: "off" });
  assert.deepEqual(describeSystemState({ supported: true, mode: "pac", pacUrl: "u" }), { state: "pac", url: "u" });
  assert.deepEqual(describeSystemState(null), { state: "unavailable" });
});

// ───────────────────────── 配置字段往返 ─────────────────────────

test("config: followSystem 字段默认/写入/读取往返", () => {
  assert.equal(toCfg({}).followSystem, false);
  assert.equal(toCfg({ followSystem: true }).followSystem, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npfollow-"));
  const file = path.join(dir, "net-proxy.json");
  try {
    writeConfig({ enabled: true, followSystem: true, protocol: "http", host: "127.0.0.1", port: 7890 }, file);
    assert.equal(loadConfig(file).followSystem, true);
    // 旧版配置文件（无该字段）读取后补默认 false
    fs.writeFileSync(file, JSON.stringify({ enabled: true, host: "127.0.0.1", port: 7890 }));
    assert.equal(loadConfig(file).followSystem, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
