// lib/proxy/http11.js — 经已建立 socket 的 HTTP/1.1 请求：读状态行+响应头，流式响应体（chunked/content-length + 解压）
import { ProxyError, abortError } from "./errors.js";
import { parseStatusLine } from "./parse.js";
import { ByteStream } from "./conn.js";
import { makeBodyController } from "./body.js";

export const MAX_HEADERS = 256; // 响应头数量上限
export const MAX_CHUNK = 64 * 1024 * 1024; // 单个 chunk 上限 64MB（防恶意超大 size）

/** 发送 HTTP/1.1 请求并返回流式 Response（解压 + 无 body 短路）。 */
export async function sendViaSocket(sock, url, head, body, { signal, timeoutMs }) {
  // body 已由 request.js 归一化：Buffer / string / Node 流（pipe） / null
  const isStream = body != null && typeof body.pipe === "function";
  let headStr = head;
  if (isStream && !/content-length:/i.test(head) && !/transfer-encoding:/i.test(head)) {
    // RFC 7230：请求体不能以连接关闭定界（那只适用于响应），
    // 无 Content-Length 的流式请求体必须用 chunked 编码。
    headStr = head.replace(/\r\n\r\n$/, "\r\nTransfer-Encoding: chunked\r\n\r\n");
  }
  let reqPacket = Buffer.from(headStr, "latin1");
  if (body != null && !isStream) {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const withCl = /content-length:/i.test(headStr)
      ? headStr
      : headStr.replace(/\r\n\r\n$/, `\r\nContent-Length: ${b.length}\r\n\r\n`);
    reqPacket = Buffer.concat([Buffer.from(withCl, "latin1"), b]);
  }
  const stream = new ByteStream(sock, timeoutMs);

  // abort 监听器跟随整个响应生命周期（头 + body）：此前在头解析完就移除，
  // 导致 body 读取期间 abort 是静默 no-op、body 无法取消。
  let detachAbort = () => {};
  if (signal) {
    const onAbort = () => {
      try { sock.destroy(); } catch {}
      stream.error = abortError();
      stream.ended = true;
      stream._flush();
    };
    if (signal.aborted) { try { sock.destroy(); } catch {} throw abortError(); }
    signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => signal.removeEventListener("abort", onAbort);
  }

  sock.write(reqPacket);
  if (isStream) {
    // chunked 编码器：data → "<hex len>\r\n<data>\r\n"，end → "0\r\n\r\n"
    body.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      sock.write(Buffer.concat([Buffer.from(chunk.length.toString(16) + "\r\n", "latin1"), chunk, Buffer.from("\r\n", "latin1")]));
    });
    body.on("end", () => { try { sock.write("0\r\n\r\n"); } catch {} });
    body.on("error", () => { try { sock.destroy(); } catch {} });
  }

  {
    // 读状态行 + 头（单泵）
    const statusLine = await stream.readLine();
    let n = 0;
    const headerLines = [];
    for (;;) {
      const line = await stream.readLine();
      if (line === "") break;
      headerLines.push(line);
      if (++n > MAX_HEADERS) { try { sock.destroy(); } catch {} throw ProxyError("EHEADER", "too many response headers"); }
    }

    const status = parseStatusLine(statusLine);
    const hdrs = {};
    for (const line of headerLines) {
      const ci = line.indexOf(":");
      if (ci === -1) continue;
      hdrs[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    }

    // ── 流式响应体：逐块 enqueue；若 gzip/br/deflate 则流式解压 ──
    const ce = (hdrs["content-encoding"] || "").toLowerCase();
    const doDecode = ce === "gzip" || ce === "deflate" || ce === "br";
    // A2：本地解压后 content-length 不再匹配 → 移除；content-encoding 保留(兼容 fetch 语义)
    if (doDecode) delete hdrs["content-length"];

    const reqMethod = head.split(" ")[0].toUpperCase();
    if (status === 204 || status === 205 || status === 304 || reqMethod === "HEAD") {
      // 无 body 状态码：标准 fetch 返回空 Response，及早关闭连接不再读 body
      detachAbort();
      try { sock.destroy(); } catch {}
      const sm = statusLine.match(/^HTTP\/\d\.\d \d{3}(?: (.+))?$/);
      const emptyResp = new Response(null, { status, statusText: (sm && sm[1] ? sm[1] : "").trim(), headers: new Headers(hdrs) });
      Object.defineProperty(emptyResp, "url", { value: url });
      return emptyResp;
    }

    const streamBody = new ReadableStream({
      start(controller) {
        (async () => {
          const sink = makeBodyController(controller, ce);
          try {
            const te = (hdrs["transfer-encoding"] || "").toLowerCase();
            if (te.includes("chunked")) {
              for (;;) {
                const line = await stream.readLine();
                const size = parseInt(line.trim().split(";")[0], 16);
                if (!Number.isFinite(size) || size <= 0) break;
                if (size > MAX_CHUNK) { try { sock.destroy(); } catch {} throw ProxyError("ECHUNK", "chunk too large"); }
                const chunk = await stream.readExactly(size);
                await sink.write(chunk);
                await stream.readLine(); // 尾部 CRLF
              }
            } else {
              const hasCl = /^\d+$/.test((hdrs["content-length"] || "").trim());
              let rem = hasCl ? Number(hdrs["content-length"]) : -1;
              for (;;) {
                const d = await stream.nextData();
                if (d === null) {
                  // 声明了 Content-Length 却提前断流：不能把截断的 body 静默当作
                  // 完整响应（标准 fetch 会报错），否则数据损坏不可察觉。
                  if (rem > 0) throw ProxyError("ERESP_END", `response body ended early: ${rem} of ${hasCl ? Number(hdrs["content-length"]) : "?"} bytes missing`);
                  break;
                }
                let toPush = d;
                if (rem >= 0) {
                  if (d.length >= rem) { toPush = d.subarray(0, rem); rem = 0; } else rem -= d.length;
                }
                await sink.write(toPush);
                if (rem === 0) break;
              }
            }
            await sink.finish();
          } catch (e) {
            sink.destroy();
            try { controller.error(e); } catch {}
          } finally {
            detachAbort();
            try { sock.destroy(); } catch {}
          }
        })();
      },
      // 消费方放弃 body（resp.body.cancel()）→ 销毁 socket、终止泵，
      // 不再占用代理连接直到服务端关流。
      cancel() {
        detachAbort();
        stream.error = stream.error || abortError();
        stream.ended = true;
        stream._flush();
        try { sock.destroy(); } catch {}
      },
    });

    const m = statusLine.match(/^HTTP\/\d\.\d \d{3}(?: (.+))?$/);
    const statusText = (m && m[1] ? m[1] : "").trim();
    const response = new Response(streamBody, { status, statusText, headers: new Headers(hdrs) });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }
}
