#!/usr/bin/env node
// tools/proxy-probe.mjs — 命令行代理连通/延迟测试
//
// 用法：
//   node tools/proxy-probe.mjs [--proxy 127.0.0.1:7890] [--target <url>] [--timeout <ms>]
//
// 输出一行摘要： OK/FAIL，代理 TCP 延迟、整体总延迟、目标 HTTP 状态。
import { probeProxy } from "../lib/probe.js";

function parseArgs(argv) {
  const out = { proxy: { protocol: "http", host: "127.0.0.1", port: 7890, noProxy: [] }, target: undefined, timeout: 15000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proxy") {
      const v = argv[++i];
      const m = /^(?:((?:socks5?):)?\/\/)?([^:]+):(\d+)$/.exec(v);
      if (m) {
        out.proxy.protocol = m[1] ? m[1].replace("://", "") : "http";
        out.proxy.host = m[2];
        out.proxy.port = Number(m[3]);
      } else {
        out.proxy = { protocol: "http", host: v.split(":")[0], port: Number(v.split(":")[1] || 7890), noProxy: [] };
      }
    } else if (a === "--target") out.target = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
  }
  return out;
}

const cfg = parseArgs(process.argv.slice(2));
const t0 = performance.now();
const res = await probeProxy(cfg.proxy, { target: cfg.target, timeout: cfg.timeout }).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));

const line = `${res.ok ? "✔ OK  " : "✘ FAIL"}  proxy=${cfg.proxy.host}:${cfg.proxy.port} target=${res.target}`;
console.log(line);
console.log(`   代理 TCP: ${res.connectMs >= 0 ? res.connectMs + " ms" : "失败"}`);
console.log(`   总延迟(经代理到目标): ${res.totalMs >= 0 ? res.totalMs + " ms" : "—"}`);
console.log(`   目标 HTTP 状态: ${res.httpStatus >= 0 ? res.httpStatus : "—"}`);
console.log(res.error ? `   原因: ${res.error}` : "");
process.exit(res.ok ? 0 : 1);
