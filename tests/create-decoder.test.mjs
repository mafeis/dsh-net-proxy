import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createDecoder } from "../lib/proxy-fetch.js";

function decodeAll(dec, input) {
  return new Promise((resolve, reject) => {
    const parts = [];
    dec.on("data", (d) => parts.push(d));
    dec.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    dec.on("error", reject);
    dec.end(input);
  });
}

test("createDecoder: gzip/br/deflate 可解压", async () => {
  assert.equal(await decodeAll(createDecoder("gzip"), zlib.gzipSync(Buffer.from("hi-gzip"))), "hi-gzip");
  assert.equal(await decodeAll(createDecoder("br"), zlib.brotliCompressSync(Buffer.from("hello-br"))), "hello-br");
  assert.equal(await decodeAll(createDecoder("deflate"), zlib.deflateSync(Buffer.from("def"))), "def");
});

test("createDecoder: 未知/空 content-encoding 返回 null（不解压）", () => {
  assert.equal(createDecoder("identity"), null);
  assert.equal(createDecoder(""), null);
  assert.equal(createDecoder("zzz"), null);
  assert.equal(createDecoder(undefined), null);
});
