// tests/harness-proxy-integration.test.mjs — 对真实 @deepseek-ai/dsh-http-proxy 的端到端验证（issue #5）
// 验证「插件装策略 → harness 侧 proxyRouteFor 立刻可见 → 还原后回到直连」这条核心链路。
// 门控：dsh-http-proxy 使用 URL.parse（Node ≥ 22.6）；旧运行时或依赖缺失时整组 skip。
import test from "node:test";
import assert from "node:assert/strict";
import { createHarnessProxySync } from "../lib/harness-proxy.js";

let pkg = null;
let skip = typeof URL.parse !== "function" ? "URL.parse requires Node >= 22.6" : false;
// undici 8.x（dsh-http-proxy 的传递依赖，engines: >=22.19）用到 markAsUncloneable；
// Node 20 能装上包但运行时报 markAsUncloneable is not a function，按能力门控整组 skip。
let markAsUncloneable = null;
try {
  markAsUncloneable = (await import("node:worker_threads")).markAsUncloneable;
} catch {}
skip = skip || (typeof markAsUncloneable !== "function" ? "undici 8 (dsh-http-proxy) requires markAsUncloneable (Node >= 22.19)" : false);
try {
  pkg = await import("@deepseek-ai/dsh-http-proxy");
} catch {
  skip = skip || "@deepseek-ai/dsh-http-proxy not installed";
}

const PROXY = { protocol: "http", host: "127.0.0.1", port: 59399, noProxy: ["example.org"] };
const ENV_NAMES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"];

test("install → 真实 proxyRouteFor 判代理；noProxy/回环仍直连；dispose 后还原", { skip }, async () => {
  const before = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const h = createHarnessProxySync();
  try {
    await h.sync(PROXY);
    const st = h.status();
    assert.equal(st.mode, "installed", `harness 层应安装成功，实际 ${st.mode}: ${st.error || ""}`);
    assert.equal(st.verified, true, "自检应通过（同一模块实例写入的 active/installed 立即可见）");

    const via = pkg.proxyRouteFor(new URL("https://huggingface.co/api/models"));
    assert.equal(via.proxied, true, "web_fetch 的 https 请求应判定走代理");
    assert.equal(via.proxy, "http://127.0.0.1:59399");
    assert.ok(via.dispatcher, "代理路由应带回 dispatcher（requestVia 依赖它）");
    assert.equal(pkg.proxyRouteFor(new URL("https://example.org/x")).proxied, false, "noProxy 命中应直连");
    assert.equal(pkg.proxyRouteFor(new URL("http://127.0.0.1:43120/_dsh/net-proxy")).proxied, false, "回环永远直连");

    // 策略同时发布进环境变量（node:http / 子进程消费），小写键
    assert.equal(process.env.https_proxy, "http://127.0.0.1:59399");
    assert.equal(process.env.http_proxy, "http://127.0.0.1:59399");
  } finally {
    await h.dispose();
  }
  assert.equal(pkg.proxyRouteFor(new URL("https://huggingface.co/api/models")).proxied, false, "dispose 后应恢复直连");
  for (const n of ENV_NAMES) {
    assert.equal(process.env[n], before[n], `环境变量 ${n} 应还原到安装前的值`);
  }
});
