// lib/harness-proxy.js — 把生效代理装进 harness 自己的代理层（issue #5）
//
// 背景：DSH ≥ 0.1.5-rc.1 起，web_fetch（@deepseek-ai/dsh-web-fetch-http）的出口不再经过
// globalThis.fetch，而是自己 import('undici') 的独立传输层；它每个请求先问
// @deepseek-ai/dsh-http-proxy 的 proxyRouteFor(url) 决定走代理还是钉住 IP 直连。
// 该模块的 active/installed 是模块级状态，因此本层修复的成立前提是：
// **写入的必须是 harness 已加载的那一份模块实例**（不同实例各写各的，互相看不见）。
// 解析顺序（先到先用）：
//   1) Electron 桌面端：包在 <resources>/app.asar.unpacked | app.asar 的 node_modules 里，
//      经 process.resourcesPath 定位、按 file URL 动态 import —— ESM 按 URL 缓存，
//      与 harness 静态 import 命中的是同一模块实例；
//   2) 从 harness 主脚本（process.argv[1]）所在目录解析 —— 覆盖 dsh CLI 独立安装的树；
//   3) bare specifier —— 覆盖与 harness 共享同一 node_modules 树的布局。
// 解析不到时优雅降级：仅 web_fetch 不跟随，globalThis.fetch 包装层不受影响
// （两层面向不同调用方，不能互相替代，见 issue #5 注意事项 4）。
//
// 协议限制：dsh-http-proxy 只接受 http:/https: 的代理 URL（isSupportedProxyUrl）；
// 把 socks5:// 填进 http_proxy/https_proxy 槽位会被拒绝并报「直连」，故 SOCKS5 配置
// 一律不装 harness 层（mode: unsupported-socks），只保留 fetch 包装层。
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const PKG_NAME = "@deepseek-ai/dsh-http-proxy";
const PKG_MAIN = path.join("node_modules", "@deepseek-ai", "dsh-http-proxy", "lib", "index.js");

function looksLikeProxyModule(m) {
  return !!m && typeof m.installProxyFromEnvironment === "function" && typeof m.proxyRouteFor === "function";
}

/**
 * 定位并加载 harness 进程实际使用的 dsh-http-proxy 实例。
 * @returns {Promise<{mod: object|null, via?: string, attempts?: string[]}>}
 */
export async function loadHarnessProxyModule() {
  const attempts = [];
  const rp = typeof process.resourcesPath === "string" && process.resourcesPath ? process.resourcesPath : "";
  if (rp) {
    for (const [via, pkg] of [["asar-unpacked", "app.asar.unpacked"], ["asar", "app.asar"]]) {
      const file = path.join(rp, pkg, PKG_MAIN);
      try {
        const m = await import(pathToFileURL(file).href);
        if (looksLikeProxyModule(m)) return { mod: m, via };
        attempts.push(`${via}: 缺少 installProxyFromEnvironment 导出`);
      } catch (e) {
        attempts.push(`${via}: ${(e && e.message) || e}`);
      }
    }
  }
  const argv1 = process.argv && process.argv[1];
  if (argv1 && path.isAbsolute(argv1)) {
    try {
      const p = createRequire(argv1).resolve(PKG_NAME);
      const m = await import(pathToFileURL(p).href);
      if (looksLikeProxyModule(m)) return { mod: m, via: "argv" };
      attempts.push(`argv: 缺少 installProxyFromEnvironment 导出`);
    } catch (e) {
      attempts.push(`argv: ${(e && e.message) || e}`);
    }
  }
  try {
    const m = await import(PKG_NAME);
    if (looksLikeProxyModule(m)) return { mod: m, via: "bare" };
    attempts.push(`bare: 缺少 installProxyFromEnvironment 导出`);
  } catch (e) {
    attempts.push(`bare: ${(e && e.message) || e}`);
  }
  return { mod: null, attempts };
}

/** host 含冒号（IPv6 字面量）时加方括号，否则 new URL 会解析失败。 */
function bracketHost(host) {
  const h = String(host || "");
  return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

/**
 * 生效代理 → installProxyFromEnvironment 的 env 入参。
 * 注意两点（issue #5 注意事项 1/2）：入参必须是 `Map<string, {value:string}>`
 * （resolveProxyPolicy 用 env.get(name)?.value），且键名小写（readEnv 先查小写再回退大写）。
 * @returns {Map<string, {value: string}>|null} 非 http 协议（socks5/socks）返回 null。
 */
export function buildProxyEnv(proxy) {
  if (!proxy) return null;
  const protocol = String(proxy.protocol || "").toLowerCase();
  const host = String(proxy.host || "").trim();
  const port = Number(proxy.port);
  if (protocol !== "http" || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const auth = proxy.username
    ? encodeURIComponent(String(proxy.username)) +
      (proxy.password ? ":" + encodeURIComponent(String(proxy.password)) : "") + "@"
    : "";
  const url = `http://${auth}${bracketHost(host)}:${port}`;
  const env = new Map();
  env.set("http_proxy", { value: url });
  env.set("https_proxy", { value: url });
  // <local> 是 Windows ProxyOverride 的专有记号，dsh-http-proxy 不认识；
  // 回环地址反正由它的 withLoopback 恒定补齐，直接过滤。
  const list = (Array.isArray(proxy.noProxy) ? proxy.noProxy : [])
    .map((s) => String(s).trim())
    .filter((s) => s && !/^<local>$/i.test(s));
  if (list.length) env.set("no_proxy", { value: list.join(",") });
  return env;
}

/** 状态机：off（无策略）/ installed（已装）/ unsupported-socks / unavailable（解析不到模块）/ error。 */
function makeStatus(mode, extra) {
  return { mode, via: null, proxy: null, error: null, verified: false, ...extra };
}

/**
 * 创建 harness 代理层同步器。调用方约定：所有状态变化（启用/停用/热更/跟随切换）
 * 都调 sync(effProxy|null)，内部负责幂等、先还原后安装、串行安全（调用方自行排队）。
 *
 * @param opts.report 诊断回调（dsh-http-proxy 的拒绝原因、自检结果等）。
 * @param opts.loadModule 模块解析注入点（测试用）。
 */
export function createHarnessProxySync({ report = () => {}, loadModule = loadHarnessProxyModule } = {}) {
  let loaded = null;    // 首次成功解析后记住 { mod, via }（负结果不缓存，允许下次重试）
  let disposeFn = null; // installGlobalProxy 返回的 disposer：还原 dispatcher/policy/env 并 close agent
  let activeKey = null; // 当前已装策略的原始键（含凭据，仅内存，用于变更检测）
  let st = makeStatus("off");

  async function teardown() {
    if (!disposeFn) { activeKey = null; return; }
    const d = disposeFn;
    disposeFn = null;
    activeKey = null;
    try { await d(); } catch (e) { report(`还原 harness 层旧策略失败: ${(e && e.message) || e}`); }
  }

  /**
   * @param proxy - 生效代理（toProxy 形状）；null/禁用 → 还原为直连。
   */
  async function sync(proxy) {
    const masked = proxy ? `${proxy.protocol}://${bracketHost(proxy.host)}:${proxy.port}` : null;
    if (!proxy) {
      await teardown();
      st = makeStatus("off", { via: loaded && loaded.via });
      return;
    }
    const env = buildProxyEnv(proxy);
    if (!env) {
      await teardown();
      st = makeStatus("unsupported-socks", { via: loaded && loaded.via, proxy: masked });
      return;
    }
    const key = `${proxy.protocol}|${proxy.username || ""}|${proxy.password || ""}|${bracketHost(proxy.host)}:${proxy.port}|${(proxy.noProxy || []).join(",")}`;
    if (disposeFn && activeKey === key) return; // 幂等：策略未变不重装卸载
    if (!loaded || !loaded.mod) loaded = await loadModule();
    if (!loaded || !loaded.mod) {
      st = makeStatus("unavailable", {
        proxy: masked,
        error: String((loaded && loaded.attempts && loaded.attempts.join("; ")) || `无法加载 ${PKG_NAME}`).slice(0, 400),
      });
      report(`harness 代理层不可用: ${st.error}`);
      return;
    }
    // disposer 会把状态回滚到「自己安装前」的快照，因此必须先还原旧策略再装新的，顺序不可反。
    await teardown();
    try {
      disposeFn = await loaded.mod.installProxyFromEnvironment(env, (msg) => report(`dsh-http-proxy: ${msg}`));
      activeKey = key;
      let verified = false;
      try {
        // 纯策略自检（不发网络请求）：装好后一个公网 https URL 应被判为走代理。
        verified = loaded.mod.proxyRouteFor(new URL("https://dsh-net-proxy-selfcheck.invalid/")).proxied === true;
      } catch {}
      st = makeStatus("installed", { via: loaded.via, proxy: masked, verified });
      report(`harness 代理层已安装: ${masked}（来源 ${loaded.via}${verified ? "，路由自检通过" : "，路由自检未通过"}）`);
    } catch (e) {
      st = makeStatus("error", { via: loaded.via, proxy: masked, error: String((e && e.message) || e).slice(0, 400) });
      report(`harness 代理层安装失败: ${st.error}`);
    }
  }

  return { sync, dispose: teardown, status: () => ({ ...st }) };
}
