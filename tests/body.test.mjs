import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { makeBodyController } from "../lib/proxy/body.js";

/** 把若干原始 chunk 经 makeBodyController 灌进 ReadableStream，取回解压/透传后的完整字节。 */
function collectBody(chunks, ce) {
  return new Promise((resolve, reject) => {
    const rs = new ReadableStream({
      start(c) {
        const sink = makeBodyController(c, ce);
        (async () => {
          for (const ch of chunks) await sink.write(ch);
          await sink.finish();
        })().catch((e) => { sink.destroy(); try { c.error(e); } catch {} reject(e); });
      },
    });
    const out = [];
    const reader = rs.getReader();
    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) return resolve(Buffer.concat(out));
        out.push(Buffer.from(value));
        return pump();
      }).catch(reject);
    }
    pump();
  });
}

test("makeBodyController: 无编码时透传（直接 enqueue）", async () => {
  const buf = Buffer.from("plain text body");
  const got = await collectBody([buf], "");
  assert.equal(got.toString("utf8"), "plain text body");
});

test("makeBodyController: gzip/br/deflate 流式解压", async () => {
  assert.equal((await collectBody([zlib.gzipSync(Buffer.from("gzip-payload"))], "gzip")).toString(), "gzip-payload");
  assert.equal((await collectBody([zlib.brotliCompressSync(Buffer.from("brotli-payload"))], "br")).toString(), "brotli-payload");
  assert.equal((await collectBody([zlib.deflateSync(Buffer.from("deflate-payload"))], "deflate")).toString(), "deflate-payload");
});

test("makeBodyController: 分块写入（模拟网络分帧）仍解压正确", async () => {
  const full = zlib.gzipSync(Buffer.from("split into three chunks over the wire"));
  const parts = [full.subarray(0, 4), full.subarray(4, 20), full.subarray(20)];
  const got = await collectBody(parts, "gzip");
  assert.equal(got.toString(), "split into three chunks over the wire");
});
