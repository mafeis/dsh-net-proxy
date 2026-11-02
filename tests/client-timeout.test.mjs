import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { act, create } from "react-test-renderer";
import { settingsHandler } from "../lib/routes.js";
import { loadConfig, writeConfig } from "../lib/config.js";

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// Mount the actual registered settings component with React. Only host services
// and primitive controls are substituted; saves use the real settings handler.
async function mountSettings(t, initial = {}, language = "en") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "np-ui-timeout-"));
  const file = path.join(directory, "net-proxy.json");
  writeConfig(initial, file);
  const posts = [];
  let failNextPost = null;
  const routeFetch = async (url, init = {}) => {
    const method = init.method || "GET";
    if (method === "POST") {
      posts.push(JSON.parse(init.body));
      if (failNextPost) {
        const mode = failNextPost;
        failNextPost = null;
        if (mode === "network") throw new Error("fixture offline");
        return { json: async () => ({ ok: false, error: "fixture write failed" }) };
      }
    }
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const req = { method, headers: { host: "localhost", ...headers }, on(event, fn) { if (event === "data" && init.body) fn(init.body); if (event === "end") fn(); } };
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    settingsHandler(req, res, file);
    return { status: res.status, json: async () => res.body };
  };
  let definition;
  new Function("window", "fetch", source)({ __ModuleLoader__: { load(value) { definition = value; } } }, routeFetch);
  const plugin = definition.factory(name => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Button: "button", Input: "input" };
    throw new Error(`unexpected module: ${name}`);
  });
  let Section, props, dictionaries;
  plugin.apply({
    effect(fn) { return fn(); },
    locale: { bind() { return key => dictionaries[language][key]; }, register(ns, value) { dictionaries = value; return () => {}; } },
    slots: { inject(name, fn) { return fn(); }, register(options, component) { Section = component; props = options.inject(); return () => {}; } },
  });
  let renderer;
  await act(async () => { renderer = create(React.createElement(Section, props)); });
  t.after(async () => {
    await act(async () => { renderer.unmount(); });
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const labels = dictionaries[language];
  const input = () => renderer.root.findAllByType("input").find(node => node.props["aria-label"] === labels.timeout);
  const button = text => renderer.root.findAllByType("button").find(node => node.props.children === text);
  return {
    renderer, file, posts, labels, input, button,
    change: async text => { await act(async () => { input().props.onChange({ target: { value: text } }); }); },
    click: async text => { await act(async () => { button(text).props.onClick(); }); },
    fail(mode) { failNextPost = mode; },
    async toggle(index, checked) { await act(async () => { renderer.root.findAllByType("input").filter(node => node.props.type === "checkbox")[index].props.onChange({ target: { checked } }); }); },
    text: () => JSON.stringify(renderer.toJSON()),
  };
}

for (const language of ["en", "zh"]) {
  test(`timeout UI (${language}): loads seconds, saves milliseconds and reloads the saved value`, async t => {
    const ui = await mountSettings(t, { timeout: 300000 }, language);
    assert.equal(ui.input().props.value, "300");
    assert.equal(ui.button(ui.labels.save).props.disabled, false);
    await ui.change("300.125");
    await ui.click(ui.labels.save);
    assert.equal(ui.posts.at(-1).timeout, 300125);
    assert.equal(loadConfig(ui.file).timeout, 300125);
    assert.ok(ui.text().includes(ui.labels.saved));
    await ui.change("600");
    await ui.click(ui.labels.reload);
    assert.equal(ui.input().props.value, "300.125");
  });
}

test("timeout UI: one input edits the draft; saving and switches preserve follow mode and other settings", async t => {
  const ui = await mountSettings(t, { enabled: true, followSystem: true, password: "fixture-secret", logEnabled: false, logPreviewBytes: 1234 });
  assert.equal(ui.input().props.value, "60");
  assert.equal(ui.renderer.root.findAllByType("details").length, 0);
  assert.equal(ui.renderer.root.findAllByType("button").some(node => /^(60|300|600) (s|秒)$/.test(node.props.children)), false);
  await ui.change("300");
  assert.equal(ui.posts.length, 0);
  await ui.click(ui.labels.save);
  const saved = loadConfig(ui.file);
  assert.equal(saved.timeout, 300000);
  assert.equal(saved.followSystem, true);
  assert.equal(saved.password, "fixture-secret");
  assert.equal(saved.logEnabled, false);
  assert.equal(saved.logPreviewBytes, 1234);
  await ui.change("600");
  await ui.toggle(0, false);
  assert.equal(Object.hasOwn(ui.posts.at(-1), "timeout"), false);
  assert.equal(loadConfig(ui.file).timeout, 300000);
  assert.equal(ui.input().props.value, "300");
  await ui.toggle(1, false);
  assert.equal(loadConfig(ui.file).timeout, 300000);
});

test("timeout UI: invalid and out-of-range seconds cannot be saved", async t => {
  const ui = await mountSettings(t);
  for (const value of ["", " ", "0", "-1", "NaN", "Infinity", "0.0001", "1.0001", "2147483.648", "1e9"]) {
    await ui.change(value);
    assert.equal(ui.input().props["aria-invalid"], true, value);
    assert.equal(ui.button(ui.labels.save).props.disabled, true, value);
    assert.ok(ui.text().includes(ui.labels.timeoutInvalid));
    await ui.click(ui.labels.save); // Guard also applies if an event bypasses disabled.
    assert.equal(ui.posts.length, 0);
  }
});

test("timeout UI: millisecond precision round-trips without floating point rejection", async t => {
  const ui = await mountSettings(t);
  for (const [value, ms] of [["0.001", 1], ["1.001", 1001], ["60.123", 60123], ["2147483.647", 2147483647]]) {
    await ui.change(value);
    assert.equal(ui.button(ui.labels.save).props.disabled, false, value);
    await ui.click(ui.labels.save);
    assert.equal(loadConfig(ui.file).timeout, ms);
    assert.equal(ui.input().props.value, value);
  }
});

test("timeout UI: rejected saves leave the stored value intact and expose failure", async t => {
  const ui = await mountSettings(t, { timeout: 300000 });
  for (const failure of ["server", "network"]) {
    await ui.change("600");
    ui.fail(failure);
    await ui.click(ui.labels.save);
    assert.equal(loadConfig(ui.file).timeout, 300000);
    assert.ok(ui.text().includes(ui.labels.saveFailed));
    assert.equal(ui.text().includes(ui.labels.saved), false);
    await ui.click(ui.labels.reload);
    assert.equal(ui.input().props.value, "300");
  }
});
