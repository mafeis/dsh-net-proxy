// tests/desktop-session.test.mjs — Desktop 浏览器 session 代理同步器单测（issue #6，方案 D）
// 用注入的假 electron 对象验证：Chromium 规则构造、fromPartition 包装识别前缀、
// guest 创建时立即应用、策略变化重放、停用/卸载还原、Web/CLI 降级状态机。
import test from "node:test";
import assert from "node:assert/strict";
import { buildChromiumProxy, createDesktopSessionSync } from "../lib/desktop-session.js";

const HTTP_PROXY = { protocol: "http", host: "127.0.0.1", port: 7890, noProxy: ["127.0.0.1", "localhost", "::1"] };
const SIDEBAR_PREFIX = "dsh-sidebar-browser-";

/** 假 electron：session.fromPartition 按名创建/复用 fake session（记录 setProxy 调用）。 */
function fakeElectron(log) {
  const partitions = new Map();
  const session = {
    fromPartition(partition) {
      let s = partitions.get(partition);
      if (!s) {
        s = {
          partition,
          lastProxy: null,
          history: [],
          setProxy(cfg) {
            s.lastProxy = cfg;
            s.history.push(cfg);
            log.push(`setProxy:${partition}:${cfg.mode || cfg.proxyRules}`);
            return Promise.resolve();
          },
        };
        partitions.set(partition, s);
      }
      return s;
    },
  };
  return { session, partitions };
}

test("buildChromiumProxy: http 映射双槽位 proxyRules（同时覆盖 HTTP 与 HTTPS）", () => {
  const p = buildChromiumProxy(HTTP_PROXY);
  assert.equal(p.proxyRules, "http=127.0.0.1:7890;https=127.0.0.1:7890");
  assert.equal(p.proxyBypassRules, "127.0.0.1,localhost,::1");
  assert.equal(p.credentials, "none");
});

test("buildChromiumProxy: socks5 → socks5:// 规则（Chromium 原生支持）", () => {
  const p = buildChromiumProxy({ ...HTTP_PROXY, protocol: "socks5" });
  assert.equal(p.proxyRules, "socks5://127.0.0.1:7890");
});

test("buildChromiumProxy: IPv6 加括号；凭据标注 unsupported；无效入参返回 null", () => {
  assert.equal(buildChromiumProxy({ ...HTTP_PROXY, host: "::1" }).proxyRules, "http=[::1]:7890;https=[::1]:7890");
  assert.equal(buildChromiumProxy({ ...HTTP_PROXY, username: "u", password: "p" }).credentials, "unsupported");
  assert.equal(buildChromiumProxy(null), null);
  assert.equal(buildChromiumProxy({ ...HTTP_PROXY, port: 0 }), null);
  assert.equal(buildChromiumProxy({ ...HTTP_PROXY, host: "" }), null);
});

test("sync: 包装 fromPartition → 新 guest 创建时立即应用（先于 loadURL）", async () => {
  const log = [];
  const fake = fakeElectron(log);
  const d = createDesktopSessionSync({ report: () => {}, loadModule: async () => ({ electron: fake, via: "require" }) });
  await d.sync(HTTP_PROXY);
  assert.equal(d.status().mode, "installed");
  // 包装安装后，宿主创建 guest session → 立即拿到当前策略
  const guest = fake.session.fromPartition(SIDEBAR_PREFIX + "aaa");
  assert.equal(guest.lastProxy.proxyRules, "http=127.0.0.1:7890;https=127.0.0.1:7890");
  assert.equal(d.status().sessions, 1);
});

test("sync: 非 sidebar 前缀的 partition 不碰（避免方案 C 全局副作用）", async () => {
  const log = [];
  const fake = fakeElectron(log);
  const d = createDesktopSessionSync({ report: () => {}, loadModule: async () => ({ electron: fake, via: "require" }) });
  await d.sync(HTTP_PROXY);
  const platform = fake.session.fromPartition("persist:dsh-platform-x");
  const policy = fake.session.fromPartition("dsh-policy-auth-x");
  assert.equal(platform.lastProxy, null);
  assert.equal(policy.lastProxy, null);
  assert.equal(d.status().sessions, 0);
});

test("sync: 策略变化重放到全部已记录 guest；同 partition 重建复用同一 session", async () => {
  const log = [];
  const fake = fakeElectron(log);
  const d = createDesktopSessionSync({ report: () => {}, loadModule: async () => ({ electron: fake, via: "require" }) });
  await d.sync(HTTP_PROXY);
  const guest = fake.session.fromPartition(SIDEBAR_PREFIX + "aaa");
  const guest2 = fake.session.fromPartition(SIDEBAR_PREFIX + "bbb");
  await d.sync({ ...HTTP_PROXY, port: 7891 });
  assert.equal(guest.lastProxy.proxyRules, "http=127.0.0.1:7891;https=127.0.0.1:7891");
  assert.equal(guest2.lastProxy.proxyRules, "http=127.0.0.1:7891;https=127.0.0.1:7891");
  assert.equal(d.status().proxy, "http://127.0.0.1:7891");
});

test("sync: 停用 → 全部 guest 还原 mode:system（Chromium 默认策略）", async () => {
  const log = [];
  const fake = fakeElectron(log);
  const d = createDesktopSessionSync({ report: () => {}, loadModule: async () => ({ electron: fake, via: "require" }) });
  await d.sync(HTTP_PROXY);
  const guest = fake.session.fromPartition(SIDEBAR_PREFIX + "aaa");
  await d.sync(null);
  assert.equal(guest.lastProxy.mode, "system");
  assert.equal(d.status().mode, "off");
  assert.equal(d.status().sessions, 0);
  // 停用后新创建的 guest 不再被应用策略（包装已还原为 no-op 跟踪）
});

test("dispose: 还原全部 guest 并拆除 fromPartition 包装", async () => {
  const log = [];
  const fake = fakeElectron(log);
  const d = createDesktopSessionSync({ report: () => {}, loadModule: async () => ({ electron: fake, via: "require" }) });
  await d.sync(HTTP_PROXY);
  const guest = fake.session.fromPartition(SIDEBAR_PREFIX + "aaa");
  await d.dispose();
  assert.equal(guest.lastProxy.mode, "system");
  assert.equal(d.status().mode, "off");
  assert.equal(d.status().sessions, 0);
  // 包装拆除后再建 guest：不再进跟踪表（fromPartition 已还原为原实现）
  const after = fake.session.fromPartition(SIDEBAR_PREFIX + "new");
  assert.equal(after.lastProxy, null);
  assert.equal(d.status().sessions, 0);
});

test("降级: 非 Electron 环境（loadModule 失败）→ unavailable，不影响状态机", async () => {
  const log = [];
  const d = createDesktopSessionSync({ report: () => {}, loadModule: async () => ({ electron: null, attempts: ["require: not found"] }) });
  await d.sync(HTTP_PROXY);
  assert.equal(d.status().mode, "unavailable");
  assert.ok(d.status().error.includes("require: not found"));
  await d.sync(null);
  assert.equal(d.status().mode, "off");
});
