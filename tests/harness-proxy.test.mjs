// tests/harness-proxy.test.mjs — harness 代理层同步器单测（issue #5）
// 用注入的假 dsh-http-proxy 模块验证：env 入参形状、装卸载顺序、幂等、降级状态机。
import test from "node:test";
import assert from "node:assert/strict";
import { buildProxyEnv, createHarnessProxySync } from "../lib/harness-proxy.js";

const HTTP_PROXY = { protocol: "http", host: "127.0.0.1", port: 7890, noProxy: ["127.0.0.1", "localhost", "::1"] };

function fakeModule(log) {
  return {
    installProxyFromEnvironment: (env, report) => {
      log.push("install");
      fakeModule.lastEnv = env;
      return Promise.resolve(() => { log.push("dispose"); });
    },
    proxyRouteFor: () => ({ proxied: true }),
  };
}

test("buildProxyEnv: Map 形状 + 小写键 + 双槽位（issue #5 注意事项 1/2）", () => {
  const env = buildProxyEnv(HTTP_PROXY);
  assert.ok(env instanceof Map, "入参必须是 Map（resolveProxyPolicy 用 env.get）");
  assert.equal(env.get("http_proxy").value, "http://127.0.0.1:7890");
  assert.equal(env.get("https_proxy").value, "http://127.0.0.1:7890");
  assert.equal(env.get("no_proxy").value, "127.0.0.1,localhost,::1");
  // 不提供大写键：readEnv 先查小写
  assert.equal(env.has("HTTPS_PROXY"), false);
});

test("buildProxyEnv: socks5/socks 一律拒绝（dsh-http-proxy 只接受 http:/https:）", () => {
  assert.equal(buildProxyEnv({ ...HTTP_PROXY, protocol: "socks5" }), null);
  assert.equal(buildProxyEnv({ ...HTTP_PROXY, protocol: "socks" }), null);
  assert.equal(buildProxyEnv(null), null);
  assert.equal(buildProxyEnv({ ...HTTP_PROXY, port: 0 }), null);
  assert.equal(buildProxyEnv({ ...HTTP_PROXY, host: "" }), null);
});

test("buildProxyEnv: 凭据 URL 编码、IPv6 加括号、<local> 过滤", () => {
  const env = buildProxyEnv({ protocol: "http", host: "::1", port: 8080, username: "a@b", password: "p:ss", noProxy: ["<local>", "foo.com"] });
  assert.equal(env.get("http_proxy").value, "http://a%40b:p%3Ass@[::1]:8080");
  assert.equal(env.get("no_proxy").value, "foo.com");
});

test("buildProxyEnv: 无 noProxy 时不写 no_proxy 键（由 withLoopback 自动补回环）", () => {
  const env = buildProxyEnv({ protocol: "http", host: "h", port: 1, noProxy: [] });
  assert.equal(env.has("no_proxy"), false);
});

test("sync: 安装 → 幂等 → 变更先还原后安装 → 停用还原", async () => {
  const log = [];
  const h = createHarnessProxySync({
    loadModule: async () => ({ mod: fakeModule(log), via: "bare" }),
  });
  await h.sync(HTTP_PROXY);
  assert.deepEqual(log, ["install"]);
  assert.equal(h.status().mode, "installed");
  assert.equal(h.status().verified, true);
  assert.equal(h.status().via, "bare");
  assert.equal(h.status().proxy, "http://127.0.0.1:7890");

  await h.sync(HTTP_PROXY); // 同配置 → 幂等，不重装卸载
  assert.deepEqual(log, ["install"]);

  await h.sync({ ...HTTP_PROXY, port: 7891 }); // 变更 → 先 dispose 再 install
  assert.deepEqual(log, ["install", "dispose", "install"]);
  assert.equal(fakeModule.lastEnv.get("https_proxy").value, "http://127.0.0.1:7891");

  await h.sync(null); // 停用 → 还原
  assert.deepEqual(log, ["install", "dispose", "install", "dispose"]);
  assert.equal(h.status().mode, "off");
});

test("sync: socks5 生效时不装 harness 层并还原已装策略（注意事项 7）", async () => {
  const log = [];
  const h = createHarnessProxySync({ loadModule: async () => ({ mod: fakeModule(log), via: "bare" }) });
  await h.sync(HTTP_PROXY);
  await h.sync({ ...HTTP_PROXY, protocol: "socks5" });
  assert.deepEqual(log, ["install", "dispose"]); // 装了又还原，没有新 install
  assert.equal(h.status().mode, "unsupported-socks");
  assert.equal(h.status().proxy, "socks5://127.0.0.1:7890");
});

test("sync: 模块解析失败 → unavailable，且下次 sync 会重试解析", async () => {
  let n = 0;
  const h = createHarnessProxySync({
    loadModule: async () => (++n === 1 ? { mod: null, attempts: ["bare: Cannot find package"] } : { mod: fakeModule([]), via: "bare" }),
  });
  await h.sync(HTTP_PROXY);
  assert.equal(h.status().mode, "unavailable");
  assert.match(h.status().error, /Cannot find package/);
  await h.sync(HTTP_PROXY);
  assert.equal(h.status().mode, "installed"); // 负结果不缓存，重试成功
});

test("sync: installProxyFromEnvironment 抛错 → error 状态且带原因", async () => {
  const h = createHarnessProxySync({
    loadModule: async () => ({
      mod: { installProxyFromEnvironment: () => Promise.reject(new Error("boom")), proxyRouteFor: () => ({ proxied: false }) },
      via: "bare",
    }),
  });
  await h.sync(HTTP_PROXY);
  assert.equal(h.status().mode, "error");
  assert.match(h.status().error, /boom/);
});

test("sync: 自检不通过（proxyRouteFor 说直连）→ installed 但 verified=false", async () => {
  const h = createHarnessProxySync({
    loadModule: async () => ({
      mod: { installProxyFromEnvironment: () => Promise.resolve(() => {}), proxyRouteFor: () => ({ proxied: false }) },
      via: "asar",
    }),
  });
  await h.sync(HTTP_PROXY);
  assert.equal(h.status().mode, "installed");
  assert.equal(h.status().verified, false);
});

test("dispose: 卸载时还原策略；未安装时 dispose 是安全 no-op", async () => {
  const log = [];
  const h = createHarnessProxySync({ loadModule: async () => ({ mod: fakeModule(log), via: "bare" }) });
  await h.dispose();
  assert.deepEqual(log, []);
  await h.sync(HTTP_PROXY);
  await h.dispose();
  assert.deepEqual(log, ["install", "dispose"]);
  assert.equal(h.status().mode === "off" || h.status().mode === "installed", true);
});
