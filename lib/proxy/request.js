// lib/proxy/request.js — proxiedFetch 入口：直连判定、请求头组装、https/http 协议分发、重定向跟随
import net from "node:net";
import { ProxyError, abortError, timeoutFor } from "./errors.js";
import { connectProxy, httpConnect, socksConnect } from "./conn.js";
import { sendViaSocket } from "./http11.js";
import { sendViaHttp2 } from "./http2.js";
import { tlsHandshake, shouldRetryWithoutH2 } from "./tls.js";
import { isNoProxy } from "./no-proxy.js";

/**
 * @typedef {{protocol:string, host:string, port:number, username?:string, password?:string, noProxy?:string[], timeout?:number, alpn?:"http/1.1"|"h2"|"off", h2Fallback?:boolean}} NetProxyConfig
 * 代理配置契约。`protocol`：「http」/「socks5」/「socks」；`username`/`password` 可选；`noProxy` 命中直连；
 * `timeout`(ms) 可选，默认 60000；`alpn` 默认「http/1.1」，`h2Fallback`（默认开）控制 h2 握手被 RST 时是否降级重试。
 */

function directFetch(originalFetch, input, init) {
  return originalFetch(input, init);
}

/**
 * 归一化请求体：string/Buffer/ArrayBuffer/TypedArray/URLSearchParams/Blob → Buffer；
 * Node 流（有 .pipe）原样透传（由 sendViaSocket/http2 负责管道写入）；
 * 其余类型（如 ReadableStream、普通对象）明确报错，避免 Buffer.from(obj) 产生错误结果。
 */
async function normalizeBody(body) {
  if (body == null) return null;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (typeof body.pipe === "function") return body;
  if (typeof body.getReader === "function") throw ProxyError("EBODY", "proxiedFetch: ReadableStream request body not supported; pass a string, Buffer, Blob or Node stream");
  const name = (body && body.constructor && body.constructor.name) || typeof body;
  throw ProxyError("EBODY", `proxiedFetch: unsupported request body type: ${name}`);
}

async function proxiedOnce(url, init = {}, proxy, originalFetch, log) {
  const urlObj = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const body = await normalizeBody(init.body == null ? null : init.body);
  const signal = init.signal;
  const timeoutMs = timeoutFor(proxy);

  // 流量日志：一条请求一条记录（含 noProxy 直连），body 流结束/取消/出错时收尾。
  const entry = log ? log.begin({ kind: "fetch", method, url }) : null;
  if (entry) {
    const isStreamBody = body != null && typeof body === "object" && typeof body.pipe === "function";
    if (!isStreamBody) entry.setRequestPreview(body);
    if (isStreamBody) entry.setRequestPreview(Buffer.alloc(0)); // 流式请求体不读，只计字节
  }

  if (isNoProxy(url, proxy.noProxy)) {
    if (entry) {
      // 直连：不经我们的协议栈，请求字节按归一化 body 估（不含头），响应按 content-length 记
      entry.addUp(body == null ? 0 : (Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body))));
      try {
        const resp = await directFetch(originalFetch, url, init);
        entry.setResponse(resp.status);
        const cl = resp.headers ? Number(resp.headers.get("content-length")) : NaN;
        if (Number.isFinite(cl) && cl > 0) entry.addDown(cl);
        entry.finalize();
        return resp;
      } catch (e) {
        entry.finalize(e);
        throw e;
      }
    }
    return directFetch(originalFetch, url, init);
  }

  const targetHostRaw = urlObj.hostname; // IPv6 形如 [::1]
  const targetHost = targetHostRaw.startsWith("[") && targetHostRaw.endsWith("]") ? targetHostRaw.slice(1, -1) : targetHostRaw;
  const defaultPort = urlObj.protocol === "https:" ? 443 : 80;
  const targetPort = urlObj.port ? Number(urlObj.port) : defaultPort;
  // A1：Host 头默认端口省略；非默认才带 `:port`
  const hostHeader = targetPort === defaultPort ? targetHostRaw : `${targetHostRaw}:${targetPort}`;
  const isSocks = proxy.protocol === "socks5" || proxy.protocol === "socks";

  // 组装请求头：正确处理 Headers 实例（forEach 才能取到内部 slot 的值）
  const headers = {};
  {
    const src = init.headers;
    if (src != null && typeof src === "object") {
      if (typeof Headers !== "undefined" && src instanceof Headers) src.forEach((v, k) => (headers[k] = v));
      else if (Array.isArray(src)) for (const [k, v] of src) headers[k] = v;
      else Object.assign(headers, src);
    }
  }
  // 移除 hop-by-hop；A5：host 一律以计算值为准
  ["proxy-connection", "keep-alive", "connection", "upgrade", "transfer-encoding", "host", "content-length", "accept-encoding"].forEach((h) => delete headers[h]);
  // A4：尊重调用方显式 accept-encoding；未设置才默认 identity
  let declaredAE = null;
  {
    const src = init.headers;
    if (src != null && typeof src === "object") {
      if (typeof Headers !== "undefined" && src instanceof Headers) declaredAE = src.get("accept-encoding");
      else if (Array.isArray(src)) { const f = src.find((x) => String(x[0]).toLowerCase() === "accept-encoding"); declaredAE = f && f[1]; }
      else if ("accept-encoding" in src) declaredAE = src["accept-encoding"];
    }
  }
  headers["accept-encoding"] = declaredAE != null && String(declaredAE).trim() !== "" ? String(declaredAE) : "identity";

  let raw;
  // HTTPS 目标被拨隧道的地方；降级（去掉 h2 重握）时要再拨一条，故抽成函数。
  const tunnel = () => isSocks
    ? socksConnect(proxy, targetHost, targetPort, signal, timeoutMs)
    : httpConnect(proxy, targetHost, targetPort, signal, timeoutMs);
  try {
    if (urlObj.protocol === "https:") {
      raw = await tunnel();
    } else if (urlObj.protocol !== "http:") {
      throw ProxyError("EPROTO", `unsupported protocol ${urlObj.protocol}`);
    }
  } catch (e) {
    if (entry) entry.finalize(e);
    throw e;
  }
  if (urlObj.protocol === "https:") {
    // 本次尝试是否已经向连接写过请求字节；写过就不再重试（流式 body 已被消费，无法重放）
    let sent = false;
    const onBeforeSend = () => { sent = true; };
    const sendViaPlain = (sock) => {
      const path = urlObj.pathname + urlObj.search;
      const h = { Host: hostHeader, Connection: "close", ...headers };
      const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
      return sendViaSocket(sock, url, head, body, { signal, timeoutMs, entry, onBeforeSend });
    };
    let outcome;
    try {
      outcome = await tlsHandshake({
        targetHost,
        targetPort,
        isIP: net.isIP(targetHost) !== 0,
        proxy,
        alpn: proxy.alpn,
        h2Fallback: proxy.h2Fallback,
        signal,
        timeoutMs,
        raw,
        attempt: tunnel,
      });
    } catch (e) {
      if (entry) entry.finalize(e);
      throw e;
    }
    const tlsSock = outcome.sock;
    if (outcome.h2) {
      // C2：服务器协商出 HTTP/2 → 走 HTTP/2；否则回退 HTTP/1.1。
      // 调用本身不加 await：sendViaHttp2 在首个 await 之前同步建流，返回时 sent 已可信。
      try {
        return await sendViaHttp2(tlsSock, targetHost, targetPort, hostHeader, urlObj, method, headers, body, signal, { timeoutMs, entry, onBeforeSend });
      } catch (e) {
        // issue #13：h2 能得手却一上来就断（代理放行 ALPN 但砸 h2 会话）——请求头尚未发出时
        // 按 http/1.1 重来一次，避免 h2Fallback 只在握手阶段生效、会话阶段照样硬失败。
        if (!outcome.retried && !sent && shouldRetryWithoutH2("h2", e)) {
          try { tlsSock.destroy(); } catch {}
          try {
            const again = await tunnel();
            const plain = await tlsHandshake({
              targetHost, targetPort, isIP: net.isIP(targetHost) !== 0, proxy,
              alpn: "http/1.1", h2Fallback: false, signal, timeoutMs, raw: again, attempt: tunnel,
            });
            return sendViaPlain(plain.sock);
          } catch (e2) {
            if (entry) entry.finalize(e2);
            throw e2;
          }
        }
        throw e;
      }
    }
    return sendViaPlain(tlsSock);
  }

  // HTTP 目标：Host + 绝对 URL；HTTP 代理有凭据时补 Proxy-Authorization（A3）。
  // socks5 时先经隧道直连目标，改发 origin-form 且不带 Proxy-Authorization（认证已在握手中完成）。
  const h = { Host: urlObj.host, Connection: "close", ...headers };
  try {
    if (isSocks) {
      raw = await socksConnect(proxy, targetHost, targetPort, signal, timeoutMs);
    } else {
      const proxyAuth = (proxy.username || proxy.password)
        ? { "Proxy-Authorization": "Basic " + Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64") } : {};
      Object.assign(h, proxyAuth);
      raw = await connectProxy(proxy, signal, timeoutMs);
    }
  } catch (e) {
    // 连接阶段失败（代理不可达/超时，最常见故障）：日志条目必须收尾，
    // 否则 live 记录只增不减，累计 2000 条后流量日志永久熔断。
    if (entry) entry.finalize(e);
    throw e;
  }
  if (isSocks) {
    const socksHead = `${method} ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
    return sendViaSocket(raw, url, socksHead, body, { signal, timeoutMs, entry });
  }
  const absUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}${urlObj.search}`;
  const httpHead = `${method} ${absUrl} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return sendViaSocket(raw, url, httpHead, body, { signal, timeoutMs, entry });
}

// 外层：跟随 30x 重定向（最多 5 跳），对齐标准 fetch。log 为流量日志器（可选）。
export async function proxiedFetch(input, init = {}, proxy, originalFetch, log) {
  // 标准 fetch 的 input 可为 string / URL 实例 / Request 对象
  let url = typeof input === "string"
    ? input
    : (input instanceof URL ? input.href : (input && typeof input.url === "string" ? input.url : null));
  if (!url) throw new Error("proxiedFetch: invalid input");
  let cur = { ...(init || {}) };
  // 标准 fetch 契约：input 为 Request 对象时，init 未覆盖的字段继承自 Request
  // （method/headers/body/signal）。此前只继承 method，导致 headers/body/signal
  // 被静默丢弃——该包装替换了整个进程的 fetch，丢失不可见。
  if (input && typeof input === "object" && !(input instanceof URL) && typeof input.url === "string") {
    if (!cur.method && input.method) cur.method = input.method;
    if (cur.headers == null && input.headers != null) cur.headers = input.headers;
    if (cur.body == null && input.body != null) {
      // Request.body 是一次性 ReadableStream；归一化不支持它，先缓冲成 Buffer
      cur.body = Buffer.from(await input.arrayBuffer());
    }
    if (cur.signal == null && input.signal != null) cur.signal = input.signal;
  }
  for (let i = 0; i < 6; i++) {
    try {
      const resp = await proxiedOnce(url, cur, proxy, originalFetch, log);
      const st = resp.status;
      if (st === 301 || st === 302 || st === 303 || st === 307 || st === 308) {
        const loc = resp.headers ? resp.headers.get("location") : null;
        if (loc) {
          const next = new URL(loc, url).href;
          const curMethod = (cur.method || "GET").toUpperCase();
          const toGet = st === 303 || ((st === 301 || st === 302) && curMethod !== "HEAD");
          cur = { ...cur, method: toGet ? "GET" : curMethod };
          if (toGet) delete cur.body;
          // 对齐标准 fetch：跨源重定向时剥掉 Authorization，避免凭据泄漏给跳转目标
          try {
            if (cur.headers && new URL(next).origin !== new URL(url).origin) {
              const h = new Headers(cur.headers);
              h.delete("authorization");
              cur = { ...cur, headers: h };
            }
          } catch {}
          try { if (resp.body && resp.body.cancel) await resp.body.cancel(); } catch {}
          url = next;
          continue;
        }
      }
      return resp;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw e;
    }
  }
  throw ProxyError("EREDIRECT", "proxiedFetch: too many redirects");
}
