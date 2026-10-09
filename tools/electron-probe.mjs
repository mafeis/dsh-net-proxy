// tools/electron-probe.mjs — 探测当前 Node 进程能否拿到 Electron 的 session API。
// 用途：验证方案 D 的前提（插件宿主进程在 Desktop 主进程内，可直接调用 session.setProxy）。
// 用法：把下面这段复制进任意会在 Desktop 宿主进程里执行的插件代码，或作为独立诊断输出。
//
// 判定表：
//   process.versions.electron 存在            → 跑在 Electron 进程内
//   require("electron") 返回字符串            → 主进程拿到的仍是不完整状态（不应出现）
//   require("electron").session 有 fromPartition → 主进程，session API 可用 ✅
import { createRequire } from "node:module";

export function describeElectronSession() {
  const out = {
    electronVersion: process.versions.electron || null,
    nodeVersion: process.versions.node || null,
    isElectron: Boolean(process.versions.electron),
    sessionAvailable: false,
    reason: "",
  };
  if (!out.isElectron) {
    out.reason = "process.versions.electron 不存在：不是 Electron 进程（Web/CLI 运行时）";
    return out;
  }
  try {
    const req = createRequire(import.meta.url);
    const electron = req("electron");
    if (typeof electron === "string") {
      out.reason = 'require("electron") 返回路径字符串：渲染/打包布局异常';
      return out;
    }
    if (electron && electron.session && typeof electron.session.fromPartition === "function") {
      out.sessionAvailable = true;
      return out;
    }
    out.reason = "electron.session.fromPartition 不可用（可能是 utility/fork 进程）";
  } catch (e) {
    out.reason = `require("electron") 失败: ${(e && e.message) || e}`;
  }
  return out;
}
