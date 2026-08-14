// dsh-net-proxy — 手写 HTTP/HTTPS-CONNECT/SOCKS5 代理客户端//
// proxiedFetch(input, init, proxy, originalFetch) —— 把一次 fetch 请求走代理发出。
// 返回 Response 兼容对象（status/headers/ok/url/text()/json()/流式 body）。
//
// 相对早期版本修复/加固（对应审查结论）：
//   - A1  Host 头对默认端口(80/443)省略，避免 nginx 精确匹配 server_name 落到默认 vhost → 404
//   - A2  本地解压 gzip/br/deflate 后移除 content-length（长度已不符），保留 content-encoding(兼容 fetch 语义)
//   - A3  HTTP 分支补 Proxy-Authorization；SOCKS5 支持 RFC1929 用户名/密码认证
//   - A4  尊重调用方显式 accept-encoding，仅在未设置时默认 identity
//   - A5  剔除调用方传入的 host 头，强制使用按目标计算的正确 Host
//   - B1  header 行 / chunk 大小上限，防内存 DoS
//   - B2  支持 init.signal(AbortSignal) 取消
//   - B3  IPv6 字面量去括号连接；IP 目标不发 SNI
//   - B4  结构化错误(ProxyError.code)便于区分故障类型
//   - C3  响应体队列化(合并计算推延)+ dec 写 drain 背压
//   - D1  超时可配(proxy.timeout，默认 60s)
//   - D4  NO_PROXY 支持 host 精确/后缀/CIDR(IPv4)/通配
//   - D3  可选日志回调 proxy.log

import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import http2 from "node:http2";
import { ProxyError, abortError, timeoutFor } from "./proxy/errors.js";
import { isNoProxy } from "./proxy/no-proxy.js";
import { createDecoder, parseStatusLine } from "./proxy/parse.js";
import { makeBodyController } from "./proxy/body.js";

/**
 * @typedef {{protocol:string, host:string, port:number, username?:string, password?:string, noProxy?:string[], timeout?:number}} NetProxyConfig
 * 代理配置契约。`protocol`：「http」/「socks5」/「socks」；`username`/`password` 可选；`noProxy` 命中直连；`timeout`(ms) 可选，默认 60000。
 */

const MAX_HEADER_LINE = 64 * 1024; // 单行头上限
const MAX_HEADERS = 256; // 响应头数量上限
const MAX_CHUNK = 64 * 1024 * 1024; // 单个 chunk 上限 64MB（防恶意超大 size）

function directFetch(originalFetch, input, init) {
  return originalFetch(input, init);
}

/** 连接到代理（可取消）。 */
function connectProxy(proxy, signal) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    sock.setNoDelay(true);
    const onAbort = () => { try { sock.destroy(); } catch {} reject(abortError()); };
    if (signal) {
      if (signal.aborted) { sock.destroy(); return reject(abortError()); }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const done = (err, val) => { if (signal) signal.removeEventListener("abort", onAbort); err ? reject(err) : resolve(val); };
    sock.once("connect", () => done(null, sock));
    sock.once("error", (e) => done(ProxyError("ECONNECT_PROXY", `proxy connect ${proxy.host}:${proxy.port} failed: ${e.message}`, e)));
  });
}

function proxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return "";
  return "Proxy-Authorization: Basic " + Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64") + "\r\n";
}

/** HTTP 代理 CONNECT 隧道（HTTPS 目标）。成功返回 raw socket。 */
function httpConnect(proxy, targetHost, targetPort, signal) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await connectProxy(proxy, signal); } catch (e) { return reject(e); }
    const host = `${targetHost}:${targetPort}`;
    const stream = new ByteStream(sock);
    sock.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${proxyAuthHeader(proxy)}\r\n`);
    try {
      const statusLine = await stream.readLine();
      stream.detach();
      const status = parseStatusLine(statusLine);
      if (status === 200) resolve(sock);
      else { sock.destroy(); reject(ProxyError("ECONNECT_TARGET", `CONNECT to ${host} via proxy failed: HTTP ${status}`)); }
    } catch (e) {
      stream.detach();
      sock.destroy();
      reject(e);
    }
  });
}

/** SOCKS5：协商（支持 RFC1929 用户名/密码）+ CONNECT。成功返回 raw socket。 */
function socksConnect(proxy, targetHost, targetPort, signal) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await connectProxy(proxy, signal); } catch (e) { return reject(e); }
    const fail = (msg) => { sock.destroy(); reject(ProxyError("ECONNECT_TARGET", msg)); };
    try {
      const stream = new ByteStream(sock);
      // 方法协商：0x00 no-auth（若无凭据）/ 0x02 user/pass（若有凭据）
      const wantAuth = !!(proxy.username || proxy.password);
      sock.write(Buffer.from([0x05, 0x01, wantAuth ? 0x02 : 0x00]));
      const verMethod = await stream.readExactly(2);
      if (verMethod[0] !== 0x05) { stream.detach(); return fail(`SOCKS5: bad version ${verMethod[0]}`); }
      if (verMethod[1] === 0x02) {
        const user = Buffer.from(proxy.username || "", "utf8");
        const pass = Buffer.from(proxy.password || "", "utf8");
        sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        const authResp = await stream.readExactly(2);
        if (authResp[0] !== 0x01 || authResp[1] !== 0x00) { stream.detach(); return fail(`SOCKS5: auth failed (code ${authResp[1]})`); }
      } else if (verMethod[1] !== 0x00) {
        stream.detach();
        return fail(`SOCKS5: server requires auth (method ${verMethod[1]})`);
      }
      // CONNECT：域名 → ATYP=0x03（IP 目标 → 0x01/0x04），为稳妥统一用域名形式
      const hostBuf = Buffer.from(targetHost, "utf8");
      const req = Buffer.alloc(4 + 1 + hostBuf.length + 2);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBuf.length);
      sock.write(req);
      const head = await stream.readExactly(4);
      if (head[1] !== 0x00) { stream.detach(); return fail(`SOCKS5: connect to ${targetHost}:${targetPort} failed, code ${head[1]}`); }
      // 吃掉 BND.ADDR
      const atyp = head[3];
      const alen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1;
      await stream.readExactly(alen + 2);
      stream.detach();
      resolve(sock);
    } catch (e) {
      sock.destroy();
      reject(e);
    }
  });
}

/**
 * 单数据泵 ByteStream：socket 只挂一套 data/end/error 监听，数据进队列，
 * 用 pull 式解析（不足则挂起）。避免多监听器互相消费丢数据；合并计算推延，
 * 减少 O(n²) 反复 concat。
 */
export class ByteStream {
  constructor(sock, idleMs = 0) {
    this.sock = sock;
    this.q = []; // 待消费 chunk 队列
    this.len = 0;
    this.waiters = [];
    this.ended = false;
    this.error = null;
    this._idleTimer = null;
    // 保存处理器引用，供 detach() 在把 socket 交给 TLS 前移除
    this._onData = (c) => this._push(c);
    this._onEnd = () => { this.ended = true; this._flush(); };
    this._onErr = (e) => { this.error = e; this.ended = true; this._flush(); };
    this._onIdleClear = null;
    sock.on("data", this._onData);
    sock.on("end", this._onEnd);
    sock.on("error", this._onErr);
    if (idleMs > 0) {
      const onIdle = () => { try { sock.destroy(); } catch {} this.error = ProxyError("ETIMEOUT", "proxiedFetch: response idle timeout"); this.ended = true; this._flush(); };
      const reset = () => { if (this._idleTimer) clearTimeout(this._idleTimer); this._idleTimer = setTimeout(onIdle, idleMs); };
      this._onIdleClear = () => { if (this._idleTimer) clearTimeout(this._idleTimer); };
      reset();
      sock.on("data", reset);
      sock.on("end", this._onIdleClear);
      sock.on("close", this._onIdleClear);
    }
  }
  // 把 socket「交还」给 TLS 等接管前调用：移除本流挂上的全部监听。
  detach() {
    const s = this.sock;
    s.removeListener("data", this._onData);
    s.removeListener("end", this._onEnd);
    s.removeListener("error", this._onErr);
    if (this._onIdleClear) {
      s.removeListener("data", this._onIdleClear); // 若已绑过（idleMs>0 时绑定的是同名 reset，实则不同闭包）
      s.removeListener("end", this._onIdleClear);
      s.removeListener("close", this._onIdleClear);
    }
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }
  _push(c) { this.q.push(c); this.len += c.length; this._flush(); }
  _flush() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  // 从队列头部精确切出 need 字节（need=null 取全部）。多余的部分留在队列，供下次读取。
  _take(need) {
    if (this.len === 0) return Buffer.alloc(0);
    const needN = need == null ? this.len : need;
    const parts = [];
    let have = 0, i = 0, done = false;
    for (; i < this.q.length; i++) {
      const c = this.q[i];
      const want = needN - have;
      if (c.length > want) {
        // 该块超出 need：取 want，剩余放回队列
        parts.push(c.subarray(0, want));
        const rest = c.subarray(want);
        this.q = [rest, ...this.q.slice(i + 1)];
        this.len -= want;
        return Buffer.concat(parts);
      }
      parts.push(c);
      have += c.length;
      if (have >= needN) { i++; done = true; break; }
    }
    this.q = this.q.slice(done ? i : this.q.length);
    this.len -= have;
    return Buffer.concat(parts);
  }
  _pull(need, cb) {
    if (this.len >= need) cb(null, this._take(need));
    else if (this.ended) cb(this.error || ProxyError("ERESP_END", "socket ended early"), null);
    else this.waiters.push(() => this._pull(need, cb));
  }
  readExactly(need) {
    return new Promise((res, rej) => this._pull(need, (e, b) => (e ? rej(e) : res(b))));
  }
  // 读一行（到 CRLF），带最大长度限制。换行之后多读的数据放回队列，
  // 保证后续 nextData/readExactly 不丢失 body。
  async readLine() {
    let scan = Buffer.alloc(0);
    for (;;) {
      if (this.len > 0) {
        const take = this._take(this.len);
        scan = scan.length ? Buffer.concat([scan, take]) : take;
      }
      const idx = scan.indexOf("\r\n");
      if (idx !== -1) {
        const out = scan.subarray(0, idx);
        const rest = scan.subarray(idx + 2);
        if (rest.length > 0) this._prepend(rest);
        return out.toString("latin1");
      }
      if (scan.length > MAX_HEADER_LINE) throw ProxyError("EHEADER", "response header line too long");
      if (this.ended) throw (this.error || ProxyError("ERESP_END", "socket ended"));
      await new Promise((r) => this.waiters.push(r));
    }
  }
  _prepend(buf) {
    if (buf && buf.length) { this.q.unshift(buf); this.len += buf.length; }
  }
  // 下一块数据（若有多块合并成一块返回）；结束返回 null。
  _nextBlock(cb) {
    if (this.len > 0) { const out = this._take(this.len); return cb(null, out); }
    if (this.ended) return cb(this.error || null, null);
    this.waiters.push(() => this._nextBlock(cb));
  }
  nextData() { return new Promise((res, rej) => this._nextBlock((e, b) => (e ? rej(e) : res(b)))); }
}

/** C2：经已协商出 h2 的 TLS socket 发起 HTTP/2 请求，返回 Response（流式 + 解压）。 */
async function sendViaHttp2(tlsSock, targetHost, targetPort, authority, urlObj, method, headers, body, signal) {
  const client = http2.connect(`https://${authority}`, { createConnection: () => tlsSock });
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
  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      const fin = (err, resp) => { if (done) return; done = true; err ? reject(err) : resolve(resp); };
      onAbort = () => { fin(abortError()); try { client.destroy(); } catch {} };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
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

async function sendViaSocket(sock, url, head, body, { signal, timeoutMs }) {
  let reqPacket = body != null ? Buffer.concat([Buffer.from(head, "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body)]) : Buffer.from(head, "latin1");
  if (body != null && !/content-length:/i.test(head)) {
    const cl = Buffer.byteLength(body);
    reqPacket = Buffer.concat([Buffer.from(head.replace(/\r\n\r\n$/, `\r\nContent-Length: ${cl}\r\n\r\n`), "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  }
  const stream = new ByteStream(sock, timeoutMs);

  const onAbort = () => {
    try { sock.destroy(); } catch {}
    stream.error = abortError();
    stream.ended = true;
    stream._flush();
  };
  if (signal) {
    if (signal.aborted) { try { sock.destroy(); } catch {} throw abortError(); }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  sock.write(reqPacket);
  if (body != null && typeof body.pipe === "function") body.pipe(sock);

  try {
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
                if (d === null) break;
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
            try { sock.destroy(); } catch {}
          }
        })();
      },
    });

    const m = statusLine.match(/^HTTP\/\d\.\d \d{3}(?: (.+))?$/);
    const statusText = (m && m[1] ? m[1] : "").trim();
    const response = new Response(streamBody, { status, statusText, headers: new Headers(hdrs) });
    Object.defineProperty(response, "url", { value: url });
    return response;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function proxiedOnce(url, init = {}, proxy, originalFetch) {
  const urlObj = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body == null ? null : (init.body instanceof ArrayBuffer ? Buffer.from(init.body) : (typeof init.body === "string" ? Buffer.from(init.body) : init.body));
  const signal = init.signal;

  if (isNoProxy(url, proxy.noProxy)) {
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
  try {
    if (urlObj.protocol === "https:") {
      raw = isSocks ? await socksConnect(proxy, targetHost, targetPort, signal) : await httpConnect(proxy, targetHost, targetPort, signal);
    } else if (urlObj.protocol !== "http:") {
      throw ProxyError("EPROTO", `unsupported protocol ${urlObj.protocol}`);
    }
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw e;
  }

  if (urlObj.protocol === "https:") {
    // B3：IP 目标不发 SNI
    const isIP = net.isIP(targetHost);
    const tlsSock = tls.connect({
      socket: raw,
      servername: isIP ? undefined : targetHost,
      host: targetHost,
      port: targetPort,
      ALPNProtocols: ["h2", "http/1.1"], // C2：协商 HTTP/2
    });
    await new Promise((resolve, reject) => {
      tlsSock.once("secureConnect", () => { tlsSock.removeAllListeners("error"); resolve(); });
      tlsSock.once("error", (e) => reject(ProxyError("ETLS", `TLS to ${targetHost} failed: ${e.message}`, e)));
    });
    if (tlsSock.alpnProtocol === "h2") {
      // C2：服务器协商出 HTTP/2 → 走 HTTP/2；否则回退 HTTP/1.1
      return sendViaHttp2(tlsSock, targetHost, targetPort, hostHeader, urlObj, method, headers, body, signal);
    }
    const path = urlObj.pathname + urlObj.search;
    const h = { Host: hostHeader, Connection: "close", ...headers };
    const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
    return sendViaSocket(tlsSock, url, head, body, { signal, timeoutMs: timeoutFor(proxy) });
  }

  // HTTP 目标：绝对 URL + Host；有凭据时补 Proxy-Authorization（A3）
  const sock = await connectProxy(proxy, signal);
  const absUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}${urlObj.search}`;
  const proxyAuth = (proxy.username || proxy.password)
    ? { "Proxy-Authorization": "Basic " + Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64") } : {};
  const h = { Host: urlObj.host, Connection: "close", ...proxyAuth, ...headers };
  const head = `${method} ${absUrl} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return sendViaSocket(sock, url, head, body, { signal, timeoutMs: timeoutFor(proxy) });
}

// 外层：跟随 30x 重定向（最多 5 跳），对齐标准 fetch。
export async function proxiedFetch(input, init = {}, proxy, originalFetch) {
  let url = typeof input === "string" ? input : (input && (input.url || String(input.url)));
  if (!url) throw new Error("proxiedFetch: invalid input");
  let cur = { ...(init || {}) };
  if (input && typeof input === "object" && input.url && !cur.method) cur.method = input.method || "GET";
  for (let i = 0; i < 6; i++) {
    try {
      const resp = await proxiedOnce(url, cur, proxy, originalFetch);
      const st = resp.status;
      if (st === 301 || st === 302 || st === 303 || st === 307 || st === 308) {
        const loc = resp.headers ? resp.headers.get("location") : null;
        if (loc) {
          const next = new URL(loc, url).href;
          const curMethod = (cur.method || "GET").toUpperCase();
          const toGet = st === 303 || ((st === 301 || st === 302) && curMethod !== "HEAD");
          cur = { ...cur, method: toGet ? "GET" : curMethod };
          if (toGet) delete cur.body;
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

export { isNoProxy } from "./proxy/no-proxy.js";
export { createDecoder, parseStatusLine } from "./proxy/parse.js";
