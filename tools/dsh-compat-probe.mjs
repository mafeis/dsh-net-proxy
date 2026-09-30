// tools/dsh-compat-probe.mjs — 在真实 DSH 组合里挂载本插件，复现/验证与宿主版本的兼容性。
//
// 用法：
//   node tools/dsh-compat-probe.mjs <dsh-package-root>
//   dsh-package-root = 含 node_modules/@deepseek-ai 的目录（例如 ~/.dsh/profiles，
//   它是宿主包树的 junction，所以从任一 profile 目录都能取到真实版本）
//
// 它不猜、不模拟：用真的 @deepseek-ai/cordis Context + cordis-plugin-loader 起组合，
// 挂载真的 @deepseek-ai/dsh-host-webserver 与本插件入口，然后报告激活期与请求期的
// 每一条错误。退出码非 0 = 存在硬错误。
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = process.argv[2] || process.env.DSH_PACKAGE_ROOT;
if (!root) {
  console.error("用法: node tools/dsh-compat-probe.mjs <含 node_modules/@deepseek-ai 的目录>");
  process.exit(2);
}
const abs = path.resolve(root);
const nm = (...parts) => path.join(abs, "node_modules", ...parts);
const asUrl = (p) => pathToFileURL(p).href;

async function pkgVersion(name) {
  try {
    return JSON.parse(await fs.readFile(path.join(nm(...name.split("/")), "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

console.log(`# host tree: ${abs}`);
for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/schemastery", "@deepseek-ai/dsh-host-webserver",
                    "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-http-proxy"]) {
  console.log(`#   ${name} @ ${await pkgVersion(name)}`);
}

const { Context } = await import(asUrl(path.join(nm("@deepseek-ai", "cordis"), "lib", "index.js")));
const { Loader } = await import(asUrl(path.join(nm("@deepseek-ai", "cordis-plugin-loader"), "lib", "index.js")));
const { WebServer } = await import(asUrl(path.join(nm("@deepseek-ai", "dsh-host-webserver"), "lib", "index.js")));

const errors = [];
const step = async (label, fn) => {
  try {
    await fn();
    console.log(`# step ok: ${label}`);
  } catch (e) {
    console.log(`# step FAILED: ${label} -> ${e?.message ?? e}`);
    errors.push(e);
  }
};

const ctx = new Context();
ctx.baseUrl = asUrl(path.join(abs, "plugin-probe") + path.sep);
await step("mount Loader", () => ctx.plugin(Loader));
await step("mount dsh-host-webserver", () => ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 }));

const netProxy = await import("../lib/index.js");
console.log(`# plugin entry: name=${netProxy.name} inject=${JSON.stringify(netProxy.inject)}`);
await step("mount dsh-net-proxy", () => ctx.plugin(netProxy));

await new Promise((r) => setTimeout(r, 1200));

const ws = ctx.get("webServer");
if (!ws) {
  console.log("# webServer service NOT registered");
  errors.push(new Error("webServer missing"));
} else {
  console.log(`# webServer listening on ${ws.host}:${ws.port}`);
  for (const p of ["/_dsh/net-proxy", "/_dsh/net-proxy/log"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${ws.port}${p}`, { headers: { host: "127.0.0.1" } });
      const body = await res.text();
      console.log(`# GET ${p} -> ${res.status} ${body.slice(0, 400)}`);
      if (res.status !== 200) errors.push(new Error(`${p} -> ${res.status}`));
    } catch (e) {
      console.log(`# GET ${p} -> THREW ${e.message}`);
      errors.push(e);
    }
  }
}

if (errors.length === 0) console.log("# RESULT: OK - no activation or request errors");
else console.log(`# RESULT: ${errors.length} error(s): ${errors.map((e) => e.message).join(" | ")}`);
process.exit(errors.length === 0 ? 0 : 1);
