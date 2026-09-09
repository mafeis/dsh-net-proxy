// lib/proxy/http2.js — 经已协商出 h2 的 TLS socket 发起 HTTP/2 请求（C2），返回流式 + 解压 Response
import http2 from "node:http2";
import { ProxyError, abortError } from "./errors.js";
import { makeBodyController } from "./body.js";

/** 经已协商出 h2 的 TLS socket 发起 HTTP/2 请求，返回 Response（流式 + 解压）。 */
export async function sendViaHttp2(tlsSock, targetHost, targetPort, authority, urlObj, method, headers, body, signal, { timeoutMs = 0 } = {}) {
  const client = http2.connect(`https://${authority}`, { createConnection: () => tlsSock });
  // 持有 session 级 error 监听：底层 TLS/TCP 出错时 Node 会在 Http2Session 上
  // emit('error')，无人监听即抛成 uncaughtException（会带走整个宿主进程）。
  // 请求级错误仍由下方 req.on("error") 上报给调用方，这里只兜底重复投递。
  client.on("error", () => {});
  const reqHeaders = {
    ":method": method,
    ":path": urlObj.pathname + urlObj.search,
    ":scheme": "https",
    ":authority": authority,
    ...headers,
  };
  if (body != null && (Buffer.isBuffer(body) || typeof body === "string")) reqHeaders["content-length"] = Buffer.byteLength(body);
  const req = client.request(reqHeaders);
  let onAbort = () => {};
  let timer = null;
  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      const fin = (err, resp) => {
        if (done) return;
        done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        err ? reject(err) : resolve(resp);
      };
      onAbort = () => { fin(abortError()); try { client.destroy(); } catch {} };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (Number(timeoutMs) > 0) {
        timer = setTimeout(() => {
          fin(ProxyError("ETIMEOUT", `HTTP/2 request timeout after ${timeoutMs}ms`));
          try { client.destroy(); } catch {}
        }, timeoutMs);
      }
      req.on("error", (e) => fin(ProxyError("EHTTP2", `HTTP/2 request failed: ${e.message}`, e)));
      req.on("response", (h) => {
        try {
          const status = Number(h[":status"]) || 0;
          const hdrs = {};
          for (const k of Object.keys(h)) {
            const lk = k.toLowerCase();
            if (lk === ":status") continue;
            hdrs[lk] = Array.isArray(h[k]) ? h[k].join(", ") : String(h[k]);
          }
          const ce = (hdrs["content-encoding"] || "").toLowerCase();
          const doDecode = ce === "gzip" || ce === "deflate" || ce === "br";
          if (doDecode) delete hdrs["content-length"];
          if (status === 204 || status === 205 || status === 304) {
            const emptyResp = new Response(null, { status, headers: new Headers(hdrs) });
            Object.defineProperty(emptyResp, "url", { value: urlObj.href });
            try { client.close(); } catch {}
            return fin(null, emptyResp);
          }
          const streamBody = new ReadableStream({
            start(c) {
              const sink = makeBodyController(c, ce);
              req.on("data", (d) => { if (sink.dec) { if (!sink.dec.write(d)) req.pause(); } else { try { c.enqueue(new Uint8Array(d)); } catch {} } });
              if (sink.dec) sink.dec.on("drain", () => req.resume());
              req.on("end", () => { sink.finish(); try { client.close(); } catch {} });
              req.on("error", (e) => { sink.destroy(); try { c.error(e); } catch {} });
            },
          });
          const resp = new Response(streamBody, { status, headers: new Headers(hdrs) });
          Object.defineProperty(resp, "url", { value: urlObj.href });
          fin(null, resp);
        } catch (e) {
          fin(ProxyError("EHTTP2", `HTTP/2 response parse failed: ${e.message}`, e));
        }
      });
      if (body != null && (Buffer.isBuffer(body) || typeof body === "string")) req.end(Buffer.isBuffer(body) ? body : Buffer.from(body));
      else if (body != null && typeof body.pipe === "function") body.pipe(req);
      else req.end();
    });
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
