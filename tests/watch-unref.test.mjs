import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";

// issue #12：宿主退出走的不是插件 dispose 路径；配置文件 watcher 若是 ref 句柄，
// 进程就会被它钉住永不退出（桌面更新器等满超时后 SIGTERM，安装失败）。
// 这里在子进程里只做 apply、不 dispose：句柄若已孤儿化，事件循环自然排空、进程自行退出。
const here = path.dirname(url.fileURLToPath(import.meta.url));
const pluginEntry = path.join(here, "..", "lib", "index.js");

test("issue #12：apply 之后即使不 dispose，进程也能自行退出（watcher 不钉住事件循环）", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "np-unref-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const script = `
    const handlers = new Map();
    const { apply } = await import(${JSON.stringify(url.pathToFileURL(pluginEntry).href)});
    apply({
      logger: { info() {}, error() {} },
      inject(names, fn) {
        fn({ effect(e) { return e(); }, webServer: { register(r) { handlers.set(r.path, r.handler); return () => handlers.delete(r.path); } } });
      },
    }, {});
    // 不再做任何事，也不调用 dispose：让事件循环自行排空
    console.log("APPLIED");
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  if (exited === null) child.kill();

  assert.ok(stdout.includes("APPLIED"), `子进程应成功 apply：${stderr}`);
  assert.notEqual(exited, null, "apply 后未 dispose 也应自行退出（watcher 须为 unref 句柄）");
  assert.equal(exited, 0);
});
