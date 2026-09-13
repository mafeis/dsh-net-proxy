// tests/full-body.test.mjs — 完整内容池：存取/预算挤出/二进制与超限/路由 full 查询
import test from "node:test";
import assert from "node:assert/strict";
import { createTrafficLog } from "../lib/traffic-log.js";
import { logHandler } from "../lib/routes.js";

function mockRes() {
  return { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = String(b == null ? "" : b); } };
}

test("full-body: 请求完整体入池并可查（JSON 内容完整返回）", () => {
  const log = createTrafficLog({});
  const e = log.begin({ method: "POST", url: "https://api.example.com/chat" });
  e.setRequestPreview(Buffer.from(JSON.stringify({ model: "deepseek", messages: ["a".repeat(2000)] })));
  e.setResponse(200);
  e.finalize();
  const r = log.full(1, "req");
  assert.equal(r.state, "ok");
  assert.ok(r.body.length > 2000, `应返回完整内容（${r.body.length}）`);
  assert.match(r.body, /"model":"deepseek"/);
});

test("full-body: 响应完整体跨多块累积，finalize 后完整", () => {
  const log = createTrafficLog({});
  const e = log.begin({ url: "https://api.example.com/stream" });
  e.setResponse(200);
  e.addPlain(Buffer.from('{"a":"'));
  e.addPlain(Buffer.from("x".repeat(3000)));
  e.addPlain(Buffer.from('"}'));
  e.finalize();
  const r = log.full(1, "res");
  assert.equal(r.state, "ok");
  assert.equal(r.body.length, 3008); // 6 + 3000 + 2
  assert.ok(r.body.endsWith('"}'));
});

test("full-body: 超过单条上限 → too-large 不入池；二进制 → binary", () => {
  const log = createTrafficLog({ maxFullBytes: 1024 });
  const big = log.begin({ url: "https://x.com/big" });
  big.setResponse(200);
  big.addPlain(Buffer.from("y".repeat(2000)));
  big.finalize();
  assert.equal(big ? log.full(1, "res").state : "", "too-large");

  const bin = log.begin({ url: "https://x.com/png" });
  bin.setRequestPreview(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 1)]));
  bin.finalize();
  assert.equal(log.full(2, "req").state, "binary");
});

test("full-body: 总池预算 → 最旧条目被挤出（evicted），新条目仍可查", () => {
  const log = createTrafficLog({ maxFullPool: 3000, maxFullBytes: 1000 });
  for (let i = 1; i <= 4; i++) {
    const e = log.begin({ url: `https://x.com/${i}` });
    e.setRequestPreview(Buffer.from("d".repeat(1000)));
    e.finalize();
  }
  assert.equal(log.full(1, "req").state, "evicted"); // 最旧被挤
  assert.equal(log.full(4, "req").state, "ok"); // 最新的在
  const gone = log.full(99, "req");
  assert.equal(gone.state, "gone"); // 不存在的 id
});

test("full-body: list() 不泄漏内部 Buffer 字段；clear 后 full 返回 gone", () => {
  const log = createTrafficLog({});
  const e = log.begin({ url: "https://x.com/1" });
  e.setRequestPreview(Buffer.from('{"k":"v"}'));
  e.finalize();
  const items = log.list(10);
  assert.equal(items.length, 1);
  assert.ok(!("_reqFull" in items[0]) && !("_resFull" in items[0]), "内部字段不得出现在列表");
  JSON.stringify(items); // 必须可安全序列化
  log.clear();
  assert.equal(log.full(1, "req").state, "gone");
});

test("full-body: 路由 ?full=<id>&side= 查询（Host 校验同规则）", () => {
  const log = createTrafficLog({});
  const e = log.begin({ url: "https://x.com/api" });
  e.setRequestPreview(Buffer.from('{"q":1}'));
  e.finalize();
  const ok = mockRes();
  logHandler({ method: "GET", headers: { host: "127.0.0.1:43120" }, url: "/_dsh/net-proxy/log?full=1&side=req" }, ok, log, () => null, ["127.0.0.1"]);
  assert.equal(ok.code, 200);
  const j = JSON.parse(ok.body);
  assert.equal(j.ok, true);
  assert.equal(j.full.state, "ok");
  assert.equal(JSON.parse(j.full.body).q, 1);
  // 恶意 Host 照样拒绝
  const bad = mockRes();
  logHandler({ method: "GET", headers: { host: "evil.com" }, url: "/log?full=1&side=req" }, bad, log, () => null, ["127.0.0.1"]);
  assert.equal(bad.code, 403);
});
