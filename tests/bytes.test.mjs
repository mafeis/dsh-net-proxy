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

test("ByteStream._take 跨块记账：len 必须与队列真实剩余一致（issue #14）", async () => {
  const s = new PassThrough();
  const b = new ByteStream(s);
  s.write(Buffer.alloc(100, 0x41));
  s.write(Buffer.alloc(400, 0x42));

  const first = await b.readExactly(300);
  assert.equal(first.length, 300);
  // 真实队列只剩 200 字节；修复前 len 虚高成 300
  assert.equal(b.q.reduce((a, c) => a + c.length, 0), 200);
  assert.equal(b.len, 200);

  // 修复前 _pull 认定 len(300) >= 300 → 立即兑现但只给 200（短读）
  const second = await b.readExactly(200);
  assert.equal(second.length, 200);
  assert.equal(b.len, 0);
  s.destroy();
});

test("ByteStream 随机切片压测：任意切断位置下 readExactly 都不短读、不丢字节", async () => {
  const total = 32000;
  const payload = Buffer.alloc(total);
  for (let i = 0; i < total; i++) payload[i] = (i * 31 + 7) & 0xff;

  const s = new PassThrough();
  const b = new ByteStream(s);

  // 先把整条流按随机长度切成碎片写入
  let off = 0;
  const chunks = [];
  while (off < total) {
    const n = 1 + ((off * 17 + chunks.length * 41) % 97);
    const piece = payload.subarray(off, Math.min(off + n, total));
    chunks.push(piece);
    s.write(piece);
    off += piece.length;
  }

  // 再按随机长度逐次精确读取，逐字节比对
  const got = [];
  let read = 0;
  let k = 0;
  while (read < total) {
    const want = Math.min(1 + ((k++ * 53 + read * 7) % 211), total - read);
    const part = await b.readExactly(want);
    assert.equal(part.length, want, `short read at offset ${read}: got ${part.length} of ${want}`);
    assert.equal(b.len, b.q.reduce((a, c) => a + c.length, 0), "len 与队列不一致");
    got.push(part);
    read += want;
  }
  assert.equal(read, total);
  assert.ok(Buffer.concat(got).equals(payload), "内容必须逐字节一致");
  s.destroy();
});
