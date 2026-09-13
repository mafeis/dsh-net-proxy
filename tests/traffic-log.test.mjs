// tests/traffic-log.test.mjs — 流量日志器单测：生命周期/汇总/环形/截断/清空
import test from "node:test";
import assert from "node:assert/strict";
import { createTrafficLog } from "../lib/traffic-log.js";

test("traffic-log: 一条完整记录（字节累计、预览、状态、耗时口径）", () => {
  const log = createTrafficLog({ previewBytes: 64 });
  const e = log.begin({ kind: "fetch", method: "post", url: "https://example.com/api?token=1" });
  e.setRequestPreview(Buffer.from('{"q":"hi"}'));
  e.addUp(120);
  e.setResponse(200);
  e.addDown(10);
  e.addPlain(Buffer.from("hello world"));
  e.addDown(500);
  e.finalize();
  const [it] = log.list(1);
  assert.equal(it.kind, "fetch");
  assert.equal(it.method, "POST");
  assert.equal(it.host, "example.com");
  assert.equal(it.status, 200);
  assert.equal(it.upBytes, 120);
  assert.equal(it.downBytes, 510);
  assert.equal(it.reqPreview, '{"q":"hi"}');
  assert.match(it.resPreview, /hello world/);
  assert.equal(it.error, null);
  assert.equal(it.live, false);
  assert.equal(typeof it.ms, "number");
  const s = log.summary();
  assert.equal(s.total, 1);
  assert.equal(s.upBytes, 120);
  assert.equal(s.downBytes, 510);
  assert.equal(s.errors, 0);
});

test("traffic-log: finalize 幂等，重复收尾不重复计数", () => {
  const log = createTrafficLog({});
  const e = log.begin({ url: "https://x.com/" });
  e.addDown(5);
  e.finalize();
  e.finalize();
  const s = log.summary();
  assert.equal(s.total, 1);
  assert.equal(s.downBytes, 5);
});

test("traffic-log: 错误与 4xx/5xx 计入 errors", () => {
  const log = createTrafficLog({});
  const a = log.begin({ url: "https://a.com/" });
  a.setResponse(502); a.finalize();
  const b = log.begin({ url: "https://b.com/" });
  b.finalize(new Error("boom"));
  const c = log.begin({ url: "https://c.com/" });
  c.setResponse(200); c.finalize();
  assert.equal(log.summary().errors, 2);
  const [second, first] = log.list(2);
  assert.match(first.error, /boom/);
  assert.equal(second.error, null);
});

test("traffic-log: 环形缓冲上限", () => {
  const log = createTrafficLog({ maxEntries: 5 });
  for (let i = 0; i < 8; i++) {
    const e = log.begin({ url: `https://h${i}.com/` });
    e.finalize();
  }
  const items = log.list(100);
  assert.equal(items.length, 5);
  assert.equal(items[0].host, "h7.com"); // 新的在前
  assert.equal(items[4].host, "h3.com");
  assert.equal(log.summary().total, 8); // 汇总是累计口径，不随环形截断
});

test("traffic-log: 预览截断与关闭（previewBytes=0）", () => {
  const log = createTrafficLog({ previewBytes: 4 });
  const e = log.begin({ url: "https://x.com/" });
  e.setRequestPreview(Buffer.from("abcdef"));
  e.addPlain(Buffer.from("zyxwvu"));
  e.finalize();
  const [it] = log.list(1);
  assert.equal(it.reqPreview, "abcd…(+2B)");
  assert.equal(it.resPreview, "zyxw…(+2B)");

  const log2 = createTrafficLog({ previewBytes: 0 });
  const e2 = log2.begin({ url: "https://x.com/" });
  e2.setRequestPreview(Buffer.from("abcdef"));
  e2.addPlain(Buffer.from("zzz"));
  e2.finalize();
  const [it2] = log2.list(1);
  assert.equal(it2.reqPreview, null);
  assert.equal(it2.resPreview, null);
});

test("traffic-log: clear 清空条目与汇总", () => {
  const log = createTrafficLog({});
  const e = log.begin({ url: "https://x.com/" });
  e.addUp(1); e.finalize();
  log.clear();
  assert.deepEqual(log.summary(), { total: 0, upBytes: 0, downBytes: 0, errors: 0, since: log.summary().since });
  assert.equal(log.list(10).length, 0);
});

test("traffic-log: configure 热更预览长度", () => {
  const log = createTrafficLog({ previewBytes: 4 });
  log.configure({ previewBytes: 2 });
  const e = log.begin({ url: "https://x.com/" });
  e.setRequestPreview(Buffer.from("abcdef"));
  e.finalize();
  const [it] = log.list(1);
  assert.equal(it.reqPreview, "ab…(+4B)");
});
