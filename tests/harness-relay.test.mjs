// tests/harness-relay.test.mjs — harness 层与中继的协同：中继不得被「先还原再装」误杀
// 用注入的假模块替代真实 dsh-http-proxy，聚焦生命周期正确性。
import test from "node:test";
import assert from "node:assert/strict";
import { createHarnessProxySync } from "../lib/harness-proxy.js";
import { createRelay } from "../lib/relay.js";
import { createTrafficLog } from "../lib/traffic-log.js";

function fakeModule() {
  let disposed = 0;
  return {
    mod: {
      installProxyFromEnvironment: async (env) => {
        const url = env.get("http_proxy").value;
        return async () => { disposed++; };
      },
      proxyRouteFor: () => ({ proxied: true }),
    },
    via: "fake",
    disposedCount: () => disposed,
  };
}

const PROXY = { protocol: "http", host: "127.0.0.1", port: 7890, noProxy: ["127.0.0.1"] };

test("harness-relay: 首次 sync 安装后中继必须仍在监听（回归：teardown 误杀）", async () => {
  const log = createTrafficLog({});
  const relay = createRelay({ log, getProxy: () => PROXY, timeoutMs: 2000 });
  const fake = fakeModule();
  const harness = createHarnessProxySync({ loadModule: async () => fake, relay });
  try {
    await harness.sync(PROXY);
    const rs = relay.status();
    assert.equal(rs.listening, true, "安装完成后中继必须仍在监听");
    assert.ok(rs.port > 0);
    assert.equal(harness.status().relayPort, rs.port);
  } finally {
    await harness.dispose();
  }
  assert.equal(relay.status().listening, false, "dispose 后中继应停止");
});

test("harness-relay: 重复 sync（策略未变）幂等且中继保持；变体触发重装时中继也不停", async () => {
  const log = createTrafficLog({});
  const relay = createRelay({ log, getProxy: () => PROXY, timeoutMs: 2000 });
  const fake = fakeModule();
  const harness = createHarnessProxySync({ loadModule: async () => fake, relay });
  try {
    await harness.sync(PROXY);
    const port1 = relay.status().port;
    await harness.sync(PROXY); // 幂等路径
    assert.equal(relay.status().listening, true);
    assert.equal(relay.status().port, port1);
    // noProxy 变化 → key 变 → 重装（先还原再装），中继必须存活且端口不变
    await harness.sync({ ...PROXY, noProxy: ["127.0.0.1", "example.com"] });
    assert.equal(relay.status().listening, true, "重装路径不得停中继");
    assert.equal(relay.status().port, port1);
  } finally {
    await harness.dispose();
  }
});

test("harness-relay: sync(null) 停用 → 策略还原，中继保持待命（端口终身制 v0.7.20）", async () => {
  const log = createTrafficLog({});
  const relay = createRelay({ log, getProxy: () => PROXY, timeoutMs: 2000 });
  const fake = fakeModule();
  const harness = createHarnessProxySync({ loadModule: async () => fake, relay });
  try {
    await harness.sync(PROXY);
    const port1 = relay.status().port;
    await harness.sync(null);
    assert.equal(fake.disposedCount(), 1, "策略必须还原");
    assert.equal(relay.status().listening, true, "中继保持待命：第三方单例 agent 的 env 引用永不过期");
    assert.equal(relay.status().port, port1, "端口不变");
    // 重新启用：端口必须复用（env 不变 → 第三方 agent 连接池永续）
    await harness.sync(PROXY);
    assert.equal(relay.status().port, port1, "重启用后端口必须复用");
  } finally {
    relay.stop(); // 测试收尾：端口终身制下中继常驻，必须显式关闭否则 node --test 挂起
  }
});

test("harness-relay: dispose（插件卸载）→ 中继真正关闭", async () => {
  const log = createTrafficLog({});
  const relay = createRelay({ log, getProxy: () => PROXY, timeoutMs: 2000 });
  const fake = fakeModule();
  const harness = createHarnessProxySync({ loadModule: async () => fake, relay });
  await harness.sync(PROXY);
  assert.equal(relay.status().listening, true);
  await harness.sync(null);
  assert.equal(relay.status().listening, true, "停用不停中继");
  await harness.dispose();
  assert.equal(relay.status().listening, false, "卸载才真正关闭");
});

test("harness-relay: 中继被外部停止后再次 sync 自愈（新端口重装，回归：死端口 env）", async () => {
  const log = createTrafficLog({});
  const relay = createRelay({ log, getProxy: () => PROXY, timeoutMs: 2000 });
  const fake = fakeModule();
  const harness = createHarnessProxySync({ loadModule: async () => fake, relay });
  try {
    await harness.sync(PROXY);
    const port1 = relay.status().port;
    relay.stop(); // 模拟中继意外死亡（宿主 fetch 会指向死端口）
    assert.equal(relay.status().listening, false);
    // 看护/配置变化触发的再次 sync：relay.start 换新端口 → 幂等键变化 → 重装
    await harness.sync(PROXY);
    const rs = relay.status();
    assert.equal(rs.listening, true, "sync 必须把中继重新拉起");
    assert.notEqual(rs.port, port1, "新端口必须与死端口不同");
    assert.equal(harness.status().relayPort, rs.port, "策略必须重指到新端口");
    assert.equal(fake.disposedCount(), 1, "重装前旧策略被卸载一次（首次安装不计卸载）");
  } finally {
    await harness.dispose();
  }
});
