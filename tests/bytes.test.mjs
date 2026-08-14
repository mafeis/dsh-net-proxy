import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { ByteStream } from "../lib/proxy-fetch.js";

test("ByteStream._take 分帧：一次多帧 + 分多次小块都正确读取（防 BND 丢帧回归）", async () => {
  // 场景A：10 字节一次到达，readExactly(4) 后再 readExactly(6) —— 复现之前 socks BND 被吞的 bug
  const s1 = new PassThrough();
  const b1 = new ByteStream(s1);
  s1.write(Buffer.from([0x05, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x1e, 0xd2, 0x00]));
  const a = await b1.readExactly(4);
  assert.deepEqual(Buffer.from(a), Buffer.from([0x05, 0x00, 0x01, 0x7f]));
  const rest = await b1.readExactly(6);
  assert.deepEqual(Buffer.from(rest), Buffer.from([0x00, 0x00, 0x01, 0x1e, 0xd2, 0x00]));

  // 场景B：数据分多次小块到达
  const s2 = new PassThrough();
  const b2 = new ByteStream(s2);
  s2.write(Buffer.from("ab"));
  s2.write(Buffer.from("cd"));
  s2.write(Buffer.from("e"));
  const v2 = await b2.readExactly(5);
  assert.equal(Buffer.from(v2).toString(), "abcde");
  s2.destroy();

  // 场景C：readLine 跨块 + 多余放回队列（后续 readExactly 能读到）
  const s3 = new PassThrough();
  const b3 = new ByteStream(s3);
  const lineP = b3.readLine();
  // 先给一行 + 紧跟的 body 数据（同一帧太大时截断，这里一次给全）
  s3.write(Buffer.from("HTTP/1.1 200 OK\r\nX:1\r\n\r\nBODY-DATA"));
  const line = await lineP;
  assert.match(line, /HTTP\/1\.1 200 OK/);
  // 多余(含 body)应留在队列，供后续读取
  s3.write(Buffer.from("-TAIL"));
  const body = await b3.nextData();
  assert.ok(Buffer.from(body).toString().includes("BODY-DATA"));
  s3.destroy();
});
