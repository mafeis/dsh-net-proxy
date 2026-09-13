// lib/traffic-log.js — 请求流量日志：经过插件的每条请求一条记录（内存环形缓冲，不落盘）
//
// 覆盖两条通道，互不重叠：
//   1) fetch 包装层（globalThis.fetch → proxiedFetch）——完整元数据 + 请求/响应体预览；
//   2) harness 中继层（web_fetch 经本地中继）——CONNECT 隧道记目标与双向字节（TLS 内容
//      不可见，如实标注），明文 http 记完整请求/响应 + 预览。
// 汇总（条数/上行/下行/错误数）随记录累加，进程重启清零。
//
// 隐私边界：全部数据只存本进程内存，GET /_dsh/net-proxy/log 返回给同源设置页，
// 不写磁盘、不外发。URL 与响应体预览可能包含业务数据，属预期行为（用户要看的正是它）。

const MAX_PREVIEW_CHARS = 4096; // 单侧预览存储上限（字符），超出截断

// 常见二进制魔数（图片/压缩包/PDF 等）：命中直接存占位符，不存乱码
const BIN_MAGIC = [
  [0, [0x89, 0x50, 0x4e, 0x47], "PNG"],
  [0, [0xff, 0xd8, 0xff], "JPEG"],
  [0, [0x47, 0x49, 0x46, 0x38], "GIF"],
  [0, [0x25, 0x50, 0x44, 0x46], "PDF"],
  [0, [0x50, 0x4b, 0x03, 0x04], "ZIP"],
  [0, [0x1f, 0x8b], "GZIP"],
  [0, [0x42, 0x4d], "BMP"],
  [0, [0x00, 0x00, 0x00], "MP4/二进制"],
];

function clip(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) : s;
}

/** 二进制嗅探：魔数命中或控制字符占比过高（>8%）→ 返回类型名，否则 null（按文本处理）。 */
function sniffBinary(buf) {
  for (const [off, magic, name] of BIN_MAGIC) {
    if (buf.length >= off + magic.length) {
      let hit = true;
      for (let i = 0; i < magic.length; i++) {
        if (buf[off + i] !== magic[i]) { hit = false; break; }
      }
      if (hit) return name;
    }
  }
  const sample = Math.min(buf.length, 512);
  let ctrl = 0;
  for (let i = 0; i < sample; i++) {
    const c = buf[i];
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) ctrl++;
  }
  return ctrl / sample > 0.08 ? "二进制" : null;
}

/** 字节块 → 预览字符串：二进制存占位符；文本取前 previewBytes 字节，控制字符以 · 展示。 */
function previewOf(buf, previewBytes) {
  if (!previewBytes || !buf || !buf.length) return null;
  const bin = sniffBinary(buf);
  if (bin) return `‹${bin} ${buf.length}B，不存内容›`;
  const b = buf.length > previewBytes ? buf.subarray(0, previewBytes) : buf;
  let s = Buffer.from(b).toString("utf8");
  if (buf.length > previewBytes) s += `…(+${buf.length - previewBytes}B)`;
  // 去掉会撑破 UI 的控制字符（保留 \t \n \r；不用正则，避免 no-control-regex）
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127 ? "·" : ch;
  }
  return clip(out, MAX_PREVIEW_CHARS);
}

/**
 * 创建流量日志器。
 * @param opts.maxEntries   环形缓冲条数上限（默认 500）
 * @param opts.previewBytes 请求/响应体预览的最大字节数（默认 512，0 = 不记预览）
 * @param opts.maxLive      进行中记录数上限（默认 2000）：挂死/长连接的记录在
 *                          finalize 前不进环形缓冲，为防半开连接无限积累设此保险丝，
 *                          超限后新请求不再记录（转发不受影响），旧记录回收后自动恢复。
 */
export function createTrafficLog({ maxEntries = 500, previewBytes = 512, maxLive = 2000 } = {}) {
  let entries = []; // 新的在前
  let nextId = 1;
  let cfg = { previewBytes };
  let liveN = 0;
  const sum = { total: 0, upBytes: 0, downBytes: 0, errors: 0, live: 0, since: Date.now() };

  function configure({ previewBytes: pb } = {}) {
    if (pb != null && Number.isInteger(pb) && pb >= 0 && pb <= 8192) cfg = { previewBytes: pb };
  }

  /**
   * 开一条新记录。返回 handle 供协议栈沿途回填；调用方必须在流结束时 finalize。
   * 全部调用点都以 `if (entry)` 判空，熔断/禁用时返回 null 即整体不记录。
   */
  function begin(meta) {
    if (liveN >= maxLive) return null; // 熔断：防挂死连接把内存拖穿
    const m = meta || {};
    const entry = {
      id: nextId++,
      ts: Date.now(),
      kind: m.kind || "fetch",
      method: String(m.method || "GET").toUpperCase(),
      url: clip(String(m.url || ""), 2048), // 超长 URL（巨型 query）也设上限，防条目膨胀
      host: safeHost(m.url),
      status: null,
      upBytes: 0,
      downBytes: 0,
      ms: null,
      reqPreview: null,
      resPreview: null,
      error: null,
      live: true,
    };
    let reqSeen = 0;
    let resSeen = 0;
    const h = {
      /** 请求体预览（Buffer/string，一次性） */
      setRequestPreview(buf) {
        if (entry.reqPreview == null && cfg.previewBytes > 0) {
          const b = Buffer.isBuffer(buf) ? buf : buf != null ? Buffer.from(String(buf)) : null;
          entry.reqPreview = previewOf(b, cfg.previewBytes);
        }
      },
      setResponse(status) {
        if (entry.status == null && Number.isFinite(Number(status))) entry.status = Number(status);
      },
      addUp(n) { const v = Number(n); if (Number.isFinite(v) && v > 0) entry.upBytes += v; },
      addDown(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return;
        entry.downBytes += v;
        resSeen += v;
      },
      /** 明文（解压后）响应块 → 首块即预览 */
      addPlain(buf) {
        if (entry.resPreview == null && cfg.previewBytes > 0 && buf && buf.length) {
          entry.resPreview = previewOf(buf, cfg.previewBytes);
        }
      },
      finalize(err) {
        if (!entry.live) return;
        entry.live = false;
        liveN -= 1;
        entry.ms = Date.now() - entry.ts;
        if (err) entry.error = clip(String((err && err.message) || err), 300);
        sum.total += 1;
        sum.upBytes += entry.upBytes;
        sum.downBytes += entry.downBytes;
        if (err || (entry.status != null && entry.status >= 400)) sum.errors += 1;
        entries.unshift(entry);
        if (entries.length > maxEntries) entries.length = maxEntries;
      },
    };
    liveN += 1;
    return h;
  }

  function summary() { return { ...sum, live: liveN }; }
  function list(limit = 200) {
    const n = Math.max(1, Math.min(Number(limit) || 200, maxEntries));
    return entries.slice(0, n);
  }
  function liveCount() { return liveN; }
  function clear() {
    entries = [];
    // liveN 不清零：进行中的记录仍会 finalize（届时正常累加统计），清零会导致计数变负
    sum.total = 0; sum.upBytes = 0; sum.downBytes = 0; sum.errors = 0; sum.since = Date.now();
  }

  return { begin, configure, summary, list, clear, liveCount, get maxEntries() { return maxEntries; } };
}

function safeHost(u) {
  try { return new URL(String(u)).host || null; } catch { return null; }
}
