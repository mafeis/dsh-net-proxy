import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaults, toCfg, toProxy, loadConfig, writeConfig } from "../lib/config.js";
import { Config } from "../lib/index.js";
import { timeoutFor, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../lib/proxy/errors.js";
import { settingsHandler } from "../lib/routes.js";
import { applyFollowSystem } from "../lib/system-proxy.js";

function configFile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "np-timeout-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, "net-proxy.json");
}

function request(file, method, payload, reload = () => {}) {
  const req = {
    method, headers: { host: "localhost", "x-dsh-net-proxy": "1" },
    on(event, fn) {
      if (event === "data" && payload !== undefined) fn(JSON.stringify(payload));
      if (event === "end") fn();
    },
  };
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  settingsHandler(req, res, file, reload);
  return res;
}

test("timeout: absent settings retain the 60s default across schema, disk and projection", t => {
  const file = configFile(t);
  fs.writeFileSync(file, JSON.stringify({ enabled: true, host: "saved-proxy", port: 8080 }));
  assert.equal(defaults().timeout, 60000);
  assert.equal(Config({}).timeout, DEFAULT_TIMEOUT_MS);
  assert.equal(loadConfig(file).enabled, true);
  assert.equal(toProxy(loadConfig(file)).timeout, DEFAULT_TIMEOUT_MS);
  assert.equal(timeoutFor(toProxy({})), DEFAULT_TIMEOUT_MS);
});

test("timeout: valid boundaries and numeric strings survive the full config chain", t => {
  const file = configFile(t);
  for (const value of [1, 1001, 60000, 300000, MAX_TIMEOUT_MS, "300000", " 600000 "]) {
    const written = writeConfig({ timeout: value }, file);
    const expected = Number(value);
    assert.equal(written.timeout, expected);
    assert.equal(loadConfig(file).timeout, expected);
    assert.equal(timeoutFor(toProxy(loadConfig(file))), expected);
  }
  assert.equal(Config({ timeout: MAX_TIMEOUT_MS }).timeout, MAX_TIMEOUT_MS);
  for (const value of [0, -1, 1.5, MAX_TIMEOUT_MS + 1]) assert.throws(() => Config({ timeout: value }));
});

test("timeout: invalid writes fail without changing disk; direct callers safely fall back", t => {
  const file = configFile(t);
  writeConfig({ enabled: true, timeout: 300000 }, file);
  const before = fs.readFileSync(file, "utf8");
  for (const value of [null, true, false, "", " ", "bad", [], [300000], {}, 0, -1, 1.5, "1.5", NaN, Infinity, MAX_TIMEOUT_MS + 1]) {
    assert.throws(() => toCfg({ timeout: value }), /timeout/);
    assert.throws(() => writeConfig({ timeout: value }, file), /timeout/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(timeoutFor({ timeout: value }), DEFAULT_TIMEOUT_MS);
  }
});

test("timeout: malformed legacy timeout only resets that field without rewriting the file", t => {
  const file = configFile(t);
  const warnings = [];
  t.mock.method(console, "error", message => warnings.push(message));
  for (const value of [null, true, "bad", 0, -1, 1.5, [300000], MAX_TIMEOUT_MS + 1]) {
    const initial = { enabled: true, followSystem: true, host: "saved-proxy", port: 8080, password: "fixture-password", logEnabled: false, timeout: value };
    const raw = JSON.stringify(initial);
    fs.writeFileSync(file, raw);
    const loaded = loadConfig(file);
    assert.equal(loaded.timeout, DEFAULT_TIMEOUT_MS);
    for (const key of ["enabled", "followSystem", "host", "port", "password", "logEnabled"]) assert.equal(loaded[key], initial[key]);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
  assert.equal(warnings.length, 8);
  assert.ok(warnings.every(message => message.includes("timeout")));
});

test("timeout: settings API persists milliseconds, rejects invalid input, and preserves partial saves", t => {
  const file = configFile(t);
  let reloads = 0;
  const saved = request(file, "POST", { timeout: 300000, enabled: true, followSystem: true }, () => reloads++);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.value.timeout, 300000);
  assert.equal(reloads, 1);
  const before = fs.readFileSync(file, "utf8");
  for (const timeout of [null, true, [], "", 0, -1, 1.5, MAX_TIMEOUT_MS + 1]) {
    const rejected = request(file, "POST", { timeout }, () => reloads++);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /timeout/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  assert.equal(reloads, 1);
  assert.equal(request(file, "POST", { enabled: false }).body.value.timeout, 300000);
  assert.equal(request(file, "POST", { followSystem: false }).body.value.timeout, 300000);
  assert.equal(request(file, "GET").body.value.timeout, 300000);
  const effective = applyFollowSystem(toCfg({ enabled: true, followSystem: true, timeout: 300000 }), { supported: true, enabled: true, mode: "manual", host: "system-proxy", port: 8888, protocol: "http" });
  assert.equal(effective.host, "system-proxy");
  assert.equal(timeoutFor(toProxy(effective)), 300000);
});
