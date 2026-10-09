// tests/manifest-compat.test.mjs — 清单与 DSH 版本闸门的契约测试。
//
// 为什么需要它：DSH ≥ 0.2 在启动时按 peerDependencies 逐条核对 `@deepseek-ai/dsh*`
// （`@deepseek-ai/dsh-app-boot` 的 evaluatePluginCompatibility）。任何一条不满足当前运行时，
// 宿主会把本 bundle 整条跳过——插件不报错、不生效，只是安静地不加载。
// 0.7.20 就是这样在 0.2.0-rc.2 上失效的：peer 区间只写了 0.1 线。
// 这里把闸门的判定原样复刻一遍，让区间再次收窄时 CI 先失败，而不是用户的 DSH 先不加载。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** DSH 运行时版本：闸门必须全部放行（含尚未发布的 0.2 正式版小版本）。 */
const SUPPORTED_DSH = ["0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2", "0.2.1", "0.2.9"];

/** 已发布且本插件实际验证过的 DSH 版本：这些要逐个登记，市场面板才能显示「兼容」。 */
const VERIFIED_RELEASES = ["0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2"];

/**
 * 复刻 dsh-app-boot 的 evaluatePluginCompatibility 的 peer 判定部分。
 * `workspace:^` / `workspace:~` / `workspace:*` 在宿主里被替换成当前运行时版本。
 * @returns 不满足的 peer 名单。
 */
function incompatiblePeers(manifest, runtimeVersion) {
  const peers = manifest.peerDependencies ?? {};
  const bad = [];
  for (const [name, range] of Object.entries(peers)) {
    if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
    const requirement = ["workspace:^", "workspace:~", "workspace:*"].includes(range)
      ? runtimeVersion
      : range;
    if (requirement.trim() === "") { bad.push([name, range]); continue; }
    if (!semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) bad.push([name, range]);
  }
  return bad;
}

test("manifest: peerDependencies 在每个已验证的 DSH 版本上都通过启动闸门", () => {
  for (const runtime of SUPPORTED_DSH) {
    const bad = incompatiblePeers(pkg, runtime);
    assert.deepEqual(
      bad,
      [],
      `dsh ${runtime} 会拒绝加载本插件：${JSON.stringify(bad)}。` +
        `DSH 遇到不兼容的 bundle 会整条跳过（不是报错），症状是插件静默失效。`,
    );
  }
});

test("manifest: 验证过的每个 DSH 发行版都登记在 dsh.compatibility.dshReleases", () => {
  const declared = pkg.dsh?.compatibility?.dshReleases ?? {};
  for (const runtime of VERIFIED_RELEASES) {
    assert.equal(
      declared[runtime],
      "compatible",
      `dsh ${runtime} 上验证过，却没有登记为 compatible——市场面板会显示「未声明」。`,
    );
  }
  // 反向也要成立：登记为 compatible 的版本必须真的过得去闸门。
  for (const [runtime, verdict] of Object.entries(declared)) {
    if (verdict !== "compatible") continue;
    assert.deepEqual(
      incompatiblePeers(pkg, runtime),
      [],
      `dsh.compatibility 把 dsh ${runtime} 登记为 compatible，但闸门会拒绝它——这是虚假声明。`,
    );
  }
});

test("manifest: dsh.engines.dsh 与 dsh.compatibility.dsh 覆盖全部已验证版本", () => {
  for (const field of [pkg.dsh?.engines?.dsh, pkg.dsh?.compatibility?.dsh]) {
    assert.equal(typeof field, "string", "必须声明 DSH 版本区间，否则市场无从判断兼容性");
    for (const runtime of SUPPORTED_DSH) {
      assert.ok(
        semver.satisfies(runtime, field, { includePrerelease: true }),
        `${field} 未覆盖已验证版本 dsh ${runtime}`,
      );
    }
  }
});

test("manifest: client bundle 满足 dsh-client-modules 的装载前提", () => {
  // resolveMeta()：dsh.client.platform 必须是 "web"，且 exports["./client"] 必须存在。
  assert.equal(pkg.dsh?.client?.platform, "web");
  assert.equal(pkg.exports?.["./client"], "./lib/client.js");
  assert.ok(fs.existsSync(path.join(ROOT, "lib", "client.js")), "client bundle 必须随包发布");
});

test("manifest: dsh.client.inject 覆盖 client 入口 inject 的全部服务", () => {
  // 壳层静态表（dsh-web-frontend 的 staticModules）由宿主提供，require 时直接命中，
  // 不必、也不会出现在启动图里；其余 inject 的服务必须来自图行，否则冷启动会排在宿主之前。
  const SEEDS = new Set([
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-dockkit",
  ]);
  // client 入口 inject 的服务名 → 提供该服务的宿主包。
  const SERVICE_OWNER = {
    slots: "@deepseek-ai/dsh-client-ui-renderer",
    locale: "@deepseek-ai/dsh-client-locale",
  };

  const declared = pkg.dsh?.client?.inject ?? [];
  for (const [service, owner] of Object.entries(SERVICE_OWNER)) {
    assert.ok(
      declared.includes(owner),
      `client 入口 inject 了 ${service}（由 ${owner} 提供），但 dsh.client.inject 没有声明 ${owner}；` +
        `冷启动时该图行可能还没到达，入口会一直停在等待激活。`,
    );
  }
  // 种子词列在 inject 里是无害的（arriveGraphRow 查不到图行就跳过），但也不该冒充依赖。
  const real = declared.filter((id) => !SEEDS.has(id));
  assert.ok(real.length > 0, "inject 里应当至少有一个真正的图行依赖");
});
