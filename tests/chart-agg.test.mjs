// 图表聚合纯函数测试：不依赖浏览器，直接加载 lib/client.js 的工厂并取 exports.charts
// 用法: node --test tests/chart-agg.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── 桩：最小 require（client.js 工厂顶部 require react 等，测试不渲染组件，给空壳即可）──
const jsxStub = (type, props) => ({ type, props });
function requireStub(id) {
	if (id === "react") return { useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
	if (id === "react/jsx-runtime") return { jsx: jsxStub, jsxs: jsxStub };
	if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: () => null, Input: () => null };
	throw new Error("unexpected require: " + id);
}

let factory = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { factory = def.factory; } } };
new Function("window", readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"))(window);
assert.equal(typeof factory, "function", "client.js 应通过 __ModuleLoader__.load 暴露工厂");
const charts = factory(requireStub).charts;
assert.equal(typeof charts.timeline, "function", "exports.charts 应包含聚合函数");

// 构造一条日志记录（字段与 traffic-log.js 的 entry 对齐）
function ent(over) {
	return Object.assign(
		{ id: 1, ts: Date.now(), kind: "fetch", method: "GET", url: "https://a.example/x", host: "a.example", status: 200, upBytes: 10, downBytes: 20, ms: 50, error: null, live: false },
		over
	);
}

test("timeline: 按 bucketMs 分桶并统计错误", () => {
	const now = 1_700_000_000_000;
	const entries = [
		ent({ ts: now, status: 500 }), // 错误（状态≥400）
		ent({ ts: now - 1000, error: "boom", status: null }), // 错误（error 字段）
		ent({ ts: now - 2000 }),
	];
	const r = charts.timeline(entries, now, 30);
	assert.ok(r.bucketMs >= 1000);
	assert.ok(r.buckets.length >= 1); // 最小窗口 30s（n*1000），桶数≥1
	assert.equal(r.buckets.reduce((s, b) => s + b.total, 0), 3);
	assert.equal(r.buckets.reduce((s, b) => s + b.errors, 0), 2);
});

test("timeline: 空输入返回空桶；跨度大时自动放大桶宽", () => {
	const empty = charts.timeline([], 1_700_000_000_000, 30);
	assert.deepEqual(empty.buckets, []);
	const now = 1_700_000_000_000;
	const r = charts.timeline([ent({ ts: now - 3600_000 }), ent({ ts: now })], now, 30);
	assert.ok(r.bucketMs >= Math.ceil(3600_000 / 30 / 1000) * 1000 - 999, "桶宽应覆盖全部跨度");
	const total = r.buckets.reduce((s, b) => s + b.total, 0);
	assert.equal(total, 2);
});

test("topHosts: 按请求数降序、截断到 n、聚合字节", () => {
	const entries = [
		ent({ host: "a.example", upBytes: 1, downBytes: 2 }),
		ent({ host: "a.example", upBytes: 3, downBytes: 4 }),
		ent({ host: "b.example", downBytes: 100, status: 404 }),
		ent({ host: null }), // 无 host 归入 unknown
	];
	const r = charts.topHosts(entries, 2);
	assert.equal(r.length, 2);
	assert.equal(r[0].host, "a.example");
	assert.equal(r[0].count, 2);
	assert.equal(r[0].upBytes, 4);
	assert.equal(r[0].downBytes, 6);
	assert.equal(r[1].host, "b.example");
	assert.equal(r[1].errors, 1);
	assert.ok(charts.topHosts(entries, 8).some((x) => x.host === "unknown"));
});

test("statusDist: 七类互不重叠，live 优先于 error", () => {
	const entries = [
		ent({ status: 200 }), ent({ status: 299 }),
		ent({ status: 301 }),
		ent({ status: 404 }), ent({ status: 429 }),
		ent({ status: 500 }),
		ent({ status: null, error: "ECONNREFUSED" }),
		ent({ status: null, live: true }),
		ent({ status: null }), // 无状态非 live → other
	];
	const d = charts.statusDist(entries);
	assert.deepEqual([d.s2, d.s3, d.s4, d.s5, d.err, d.live, d.other], [2, 1, 2, 1, 1, 1, 1]);
	assert.equal(d.total, 9);
});

test("latency: 五档边界与平均/中位", () => {
	const entries = [
		ent({ ms: 0 }), ent({ ms: 99 }), // 桶0
		ent({ ms: 100 }), ent({ ms: 299 }), // 桶1
		ent({ ms: 300 }), // 桶2
		ent({ ms: 1000 }), ent({ ms: 2999 }), // 桶3
		ent({ ms: 3000 }), // 桶4
		ent({ ms: null }), ent({ ms: -5 }), // 不统计
	];
	const r = charts.latency(entries);
	assert.deepEqual(r.counts, [2, 2, 1, 2, 1]);
	assert.equal(r.total, 8);
	assert.ok(r.avgMs > 0 && r.p50Ms > 0);
	const none = charts.latency([ent({ ms: null })]);
	assert.equal(none.total, 0);
	assert.equal(none.avgMs, null);
});

test("channels: kind 三分类并聚合上下行字节", () => {
	const entries = [
		ent({ kind: "fetch", upBytes: 1, downBytes: 2 }),
		ent({ kind: "relay-tunnel", upBytes: 10, downBytes: 20 }),
		ent({ kind: "relay-http", upBytes: 100, downBytes: 200 }),
		ent({}), // 无 kind → fetch
	];
	const r = charts.channels(entries);
	assert.deepEqual(r.map((x) => x.key), ["fetch", "tunnel", "plain"]);
	assert.equal(r[0].count, 2);
	assert.equal(r[0].upBytes, 11); // 显式 1 + 默认记录的 10
	assert.equal(r[1].downBytes, 20);
	assert.equal(r[2].downBytes, 200);
});
