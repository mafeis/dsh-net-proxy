// @local/dsh-proxy — 服务端 bundle（Node 半边）
// 读 net-proxy.json、包装全局 fetch 走代理；设置页通过 dsh 同源 webServer
// 路由 /_dsh/net-proxy 读写同一份配置（与 dsh-vision-toolkit 的 /_dsh 方式一致）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { proxiedFetch } from "./proxy-fetch.js";
import { probeProxy } from "./probe.js";
import z from "@deepseek-ai/schemastery";
import { loadConfig, writeConfig, configPath, toCfg, toProxy } from "./config.js";
import { settingsHandler } from "./routes.js";

export const name = "net-proxy";
export const inject = [];

const ProxySchema = z.object({
  enabled: z.boolean().default(false),
  protocol: z.string().default("http"),
  host: z.string().default("127.0.0.1"),
  port: z.number().default(7890),
  username: z.string().default(""),
  password: z.string().default(""),
  noProxy: z.array(z.string()).default(["127.0.0.1", "localhost", "::1"]),
}).default({});
export const Config = ProxySchema;

/** 设置路由允许的 Host 白名单：回环 + 本机所有网卡地址/主机名（支持从局域网访问 GUI）。 */
function localHostAllowlist() {
  const names = new Set(["127.0.0.1", "localhost", "::1"]);
  try { if (os.hostname()) names.add(os.hostname().toLowerCase()); } catch {}
  try {
    const ifs = os.networkInterfaces();
    for (const list of Object.values(ifs || {})) {
      for (const it of list || []) {
        if (it && typeof it.address === "string") names.add(it.address.toLowerCase());
      }
    }
  } catch {}
  return [...names].filter(Boolean);
}

export function apply(ctx, config) {
  const file = configPath();
  // 优先用 harness 注入的 logger（统一日志/级别开关），无则退回 console
  const logger = (ctx && ctx.logger && typeof ctx.logger.error === "function") ? ctx.logger : console;
  const info = typeof logger.info === "function" ? logger.info.bind(logger) : logger.error.bind(logger);
  const error = typeof logger.error === "function" ? logger.error.bind(logger) : console.error.bind(console);
  let cfg = loadConfig(file);
  let originalFetch = globalThis.fetch;
  let wrapper = null; // 本插件安装的 fetch 包装器引用（卸载时校验用）
  let wrapped = false;
  let disposed = false;
  let watchers = [];

  function refreshProxy() {
    if (disposed) return;
    if (cfg.enabled) {
      if (!wrapped) {
        // 只在「未包装 → 包装」翻转时才赋值 globalThis.fetch；
        // 已包装时闭包惰性读取 cfg，热更后下一次请求自动用新配置，
        // 不会覆盖其他插件在此之后安装的 fetch 包装器。
        originalFetch = globalThis.fetch;
        wrapper = (input, init) => proxiedFetch(input, init, toProxy(cfg), originalFetch);
        globalThis.fetch = wrapper;
        wrapped = true;
        info(`[net-proxy] 已启用代理 ${toProxy(cfg).protocol}://${toProxy(cfg).host}:${toProxy(cfg).port}`);
      }
    } else if (wrapped) {
      // 仅当全局 fetch 仍是自己装的包装器时才还原，避免把后装的其他包装器一起拆掉
      if (globalThis.fetch === wrapper) globalThis.fetch = originalFetch;
      wrapper = null;
      wrapped = false;
      info("[net-proxy] 已停用代理（直连）");
    }
  }

  function reloadFrom(f) {
    if (disposed) return;
    try {
      const next = loadConfig(f);
      const changed = JSON.stringify(next) !== JSON.stringify(cfg);
      cfg = next;
      refreshProxy();
      if (changed) info(`[net-proxy] 配置已加载: ${JSON.stringify({ ...cfg, password: cfg.password ? "***" : "" })}`);
    } catch (err) {
      error("[net-proxy] 热更失败:", err && err.message);
    }
  }

  // 连通/延迟探测：用给定(或当前)配置测一次代理链路，不改配置。target 可自定义测试目标。
  // 安全：只有当探测目标与当前配置的代理是同一个（host+port+protocol）时，才回填已保存的
  // 凭据；探测任意第三方主机一律不带凭据，防止把存储的代理密码发到攻击者控制的服务器。
  function runProbe(p, target) {
    const pr = (p && typeof p === "object") ? p : {};
    const sameProxy = pr.host === cfg.host
      && Number(pr.port) === Number(cfg.port)
      && (pr.protocol || cfg.protocol) === cfg.protocol;
    const creds = sameProxy ? cfg : { username: "", password: "" };
    const proxy = toProxy({
      protocol: pr.protocol || cfg.protocol,
      host: pr.host || cfg.host,
      port: pr.port != null ? pr.port : cfg.port,
      username: pr.username != null ? pr.username : creds.username,
      password: pr.password != null ? pr.password : creds.password,
      noProxy: cfg.noProxy,
    });
    return probeProxy(proxy, target ? { target } : {});
  }

  // 同源设置路由（挂 dsh webServer，/ _dsh/net-proxy）。与 dsh-vision-toolkit 一致。
  ctx.inject(["webServer"], function (webCtx) {
    webCtx.effect(function () {
      const dispose = webCtx.webServer.register({
        kind: "exact",
        path: "/_dsh/net-proxy",
        handler: function (req, res) {
          settingsHandler(req, res, file, function () { reloadFrom(file); }, runProbe, { allowedHosts: localHostAllowlist() });
        },
      });
      info("[net-proxy] 同源设置路由: /_dsh/net-proxy");
      return dispose;
    }, "net-proxy: web settings route");
  });

  info(`[net-proxy] 配置文件: ${file}（enabled=${cfg.enabled}）`);
  refreshProxy();

  // 监听配置变化热更。writeConfig 用 tmp+rename 原子替换，文件 inode 会换——
  // fs.watch(file) 在 rename 后失效，因此改为 watch 父目录，按文件名过滤。
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    let debounce = null;
    const w = fs.watch(dir, (evt, fname) => {
      if (fname && fname !== base) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; reloadFrom(file); }, 100);
      debounce.unref?.();
      watchers.push(debounce);
    });
    w.on("error", () => {});
    watchers.push(w);
  } catch {}
  if (!fs.existsSync(file)) {
    // 目录 watch 已兜底新文件出现；此 poll 仅在 watch 不可用（如目录不存在）时补充
    const poll = setInterval(() => {
      if (fs.existsSync(file)) reloadFrom(file);
    }, 1000);
    poll.unref?.();
    watchers.push(poll);
  }

  return () => {
    disposed = true;
    for (const w of watchers) {
      try { if (typeof w.close === "function") w.close(); else clearInterval(w); } catch {}
    }
    watchers = [];
    if (wrapped && globalThis.fetch === wrapper) globalThis.fetch = originalFetch;
    wrapper = null;
  };
}
