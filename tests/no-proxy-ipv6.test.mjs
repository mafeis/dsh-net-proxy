import test from "node:test";
import assert from "node:assert/strict";
import { isNoProxy } from "../lib/proxy-fetch.js";

test("noProxy: IPv6 回环（默认列表含 ::1）命中直连", () => {
  const def = ["127.0.0.1", "localhost", "::1"];
  assert.equal(isNoProxy("http://[::1]:5173/x", def), true);   // 回归：URL.hostname 带方括号
  assert.equal(isNoProxy("http://[::1]/x", def), true);
  assert.equal(isNoProxy("http://127.0.0.1:5173/x", def), true);
  assert.equal(isNoProxy("http://localhost:3000/x", def), true);
});

test("noProxy: '::1' 条目不被 host:port 正则误拆", () => {
  // 回归：/:\d+$/ 曾把 "::1" 拆成 host=":" port=1
  const def = ["127.0.0.1", "localhost", "::1"];
  assert.equal(isNoProxy("http://[::1]:8080/x", def), true);
  assert.equal(isNoProxy("http://[::1]/x", def), true);
});

test("noProxy: IPv6 条目带端口/括号形式", () => {
  assert.equal(isNoProxy("http://[::1]:443/x", ["[::1]:443"]), true);
  assert.equal(isNoProxy("http://[::1]:8080/x", ["[::1]:443"]), false);
  assert.equal(isNoProxy("http://[::1]/x", ["[::1]"]), true);
});

test("noProxy: 原有语义不回归", () => {
  assert.equal(isNoProxy("http://a.example.com/x", ["example.com"]), true);
  assert.equal(isNoProxy("http://example.com:8080/x", ["example.com:443"]), false);
  assert.equal(isNoProxy("http://example.com:443/x", ["example.com:443"]), true);
  assert.equal(isNoProxy("http://10.1.2.3/x", ["10.0.0.0/8"]), true);
  assert.equal(isNoProxy("http://192.168.1.5/x", ["10.0.0.0/8"]), false);
  assert.equal(isNoProxy("http://example.com/x", ["*"]), true);
  assert.equal(isNoProxy("http://localhost/x", ["<local>"]), true);
  assert.equal(isNoProxy("http://other.org/x", ["example.com"]), false);
});
