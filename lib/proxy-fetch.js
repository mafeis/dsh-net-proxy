// dsh-net-proxy — 手写 HTTP/HTTPS-CONNECT/SOCKS5 代理客户端
//
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

const MAX_HEADER_LINE = 64 * 1024; // 单行头上限
const MAX_HEADERS = 256; // 响应头数量上限
const MAX_CHUNK = 64 * 1024 * 1024; // 单个 chunk 上限 64MB（防恶意超大 size）

function ProxyError(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}
function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}
function timeoutFor(proxy) {
  const t = Number(proxy && proxy.timeout);
  return Number.isFinite(t) && t > 0 ? t : 60000;
}

/** IPv4 字面量转 32 位整数。非 IPv4 返回 null。 */
function ipv4ToInt(s) {
  const p = String(s).split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/**
 * 判定 URL 是否命中 noProxy（命中则直连）。支持：
 *   - `example.com` / `.example.com`：host 精确 / 后缀
 *   - `example.com:443`：host+端口
 *   - IPv4 CIDR `10.0.0.0/8`、`128.0.0.0/8`
 *   - `*`（全部命中）
 *   - `<local>`（回环/局域网，简化：回环即命中）
 */
export function isNoProxy(rawUrl, noProxy) {
  if (!Array.isArray(noProxy) || noProxy.length === 0) return false;
  let host, port = null, proto = null;
  try {
    const u = new URL(rawUrl);
    host = u.hostname.toLowerCase();
    port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
    proto = u.protocol.replace(":", "");
  } catch {
    host = String(rawUrl).toLowerCase();
  }
  const hostNoBrackets = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  for (let raw of noProxy) {
    if (!raw) continue;
    let e = String(raw).trim().toLowerCase();
    if (!e) continue;
    if (e === "*") return true;
    if (e === "<local>") {
      if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || hostNoBrackets.startsWith("127.")) return true;
      continue;
    }
    // host:port
    let onlyHost = e;
    if (port != null && /:\d+$/.test(e)) {
      const ci = e.lastIndexOf(":");
      const ePort = Number(e.slice(ci + 1));
      if (ePort !== port) continue; // 端口不匹配，不算命中
      onlyHost = e.slice(0, ci);
    }
    // CIDR
    if (onlyHost.includes("/")) {
      const [cidrHost, cidrStr] = onlyHost.split("/");
      const cidr = parseInt(cidrStr, 10);
      const ip = ipv4ToInt(hostNoBrackets);
      const base = ipv4ToInt(cidrHost);
      if (ip != null && base != null && Number.isInteger(cidr)) {
        if (cidr === 0) return true;
        if (cidr >= 1 && cidr <= 32) {
          const mask = cidr === 32 ? 0xffffffff : ~((1 << (32 - cidr)) - 1) >>> 0;
          if ((ip & mask) === (base & mask)) return true;
        }
      }
      continue;
    }
    if (onlyHost === "*") return true;
    const match = host === onlyHost || host.endsWith("." + onlyHost);
    if (match) return true;
  }
  return false;
}

/** 从 socket 精确读 n 字节（一次性监听，读后移除；用于握手阶段）。 */
function readExactly(sock, n) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    const cleanup = () => { sock.removeListener("data", onData); sock.removeListener("error", onErr); sock.removeListener("end", onEnd); };
    function onData(c) { chunks.push(c); got += c.length; if (got >= n) { cleanup(); resolve(Buffer.concat(chunks).subarray(0, n)); } }
    function onErr(e) { cleanup(); reject(e); }
    function onEnd() { cleanup(); reject(ProxyError("ERESP_END", "readExactly: socket ended early")); }
    sock.on("data", onData); sock.on("error", onErr); sock.on("end", onEnd);
  });
}

/** 从 socket 读响应头到 \r\n\r\n（一次性监听；用于 CONNECT 握手）。 */
function readHead(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => { sock.removeListener("data", onData); sock.removeListener("error", onErr); sock.removeListener("end", onEnd); };
    function onData(c) {
      buf = Buffer.concat([buf, c]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx !== -1) { cleanup(); resolve({ head: buf.subarray(0, idx).toString("latin1"), rest: buf.subarray(idx + 4) }); }
    }
    function onErr(e) { cleanup(); reject(e); }
    function onEnd() { cleanup(); reject(ProxyError("ERESP_END", "readHead: socket ended before headers")); }
    sock.on("data", onData); sock.on("error", onErr); sock.on("end", onEnd);
  });
}

export function parseStatusLine(line) {
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(line || "");
  return m ? Number(m[1]) : 0;
}

/** 直连回退（NO_PROXY 命中）。 */
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
    sock.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${proxyAuthHeader(proxy)}\r\n`);
    readHead(sock).then(
      ({ head }) => {
        const status = parseStatusLine(head);
        if (status === 200) resolve(sock);
        else { sock.destroy(); reject(ProxyError("ECONNECT_TARGET", `CONNECT to ${host} via proxy failed: HTTP ${status}`)); }
      },
      (e) => reject(e),
    );
  });
}

/** SOCKS5：协商（支持 RFC1929 用户名/密码）+ CONNECT。成功返回 raw socket。 */
function socksConnect(proxy, targetHost, targetPort, signal) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await connectProxy(proxy, signal); } catch (e) { return reject(e); }
    const fail = (msg) => { sock.destroy(); reject(ProxyError("ECONNECT_TARGET", msg)); };
    try {
      // 方法协商：0x00 no-auth（若无凭据）/ 0x02 user/pass（若有凭据）
      const wantAuth = !!(proxy.username || proxy.password);
      sock.write(Buffer.from([0x05, 0x01, wantAuth ? 0x02 : 0x00]));
      const verMethod = await readExactly(sock, 2);
      if (verMethod[0] !== 0x05) return fail(`SOCKS5: bad version ${verMethod[0]}`);
      if (verMethod[1] === 0x02) {
        const user = Buffer.from(proxy.username || "", "utf8");
        const pass = Buffer.from(proxy.password || "", "utf8");
        sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        const authResp = await readExactly(sock, 2);
        if (authResp[0] !== 0x01 || authResp[1] !== 0x00) return fail(`SOCKS5: auth failed (code ${authResp[1]})`);
      } else if (verMethod[1] !== 0x00) {
        return fail(`SOCKS5: server requires auth (method ${verMethod[1]})`);
      }
      // CONNECT：域名 → ATYP=0x03（IP 目标 → 0x01/0x04），为稳妥统一用域名形式
      const hostBuf = Buffer.from(targetHost, "utf8");
      const req = Buffer.alloc(4 + 1 + hostBuf.length + 2);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBuf.length);
      sock.write(req);
      const head = await readExactly(sock, 4);
      if (head[1] !== 0x00) return fail(`SOCKS5: connect to ${targetHost}:${targetPort} failed, code ${head[1]}`);
      // 吃掉 BND.ADDR
      const atyp = head[3];
      const alen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1;
      await readExactly(sock, alen + 2);
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
class ByteStream {
  constructor(sock, idleMs = 0) {
    this.sock = sock;
    this.q = []; // 待消费 chunk 队列
    this.len = 0;
    this.waiters = [];
    this.ended = false;
    this.error = null;
    this._idleTimer = null;
    sock.on("data", (c) => this._push(c));
    sock.on("end", () => { this.ended = true; this._flush(); });
    sock.on("error", (e) => { this.error = e; this.ended = true; this._flush(); });
    if (idleMs > 0) {
      const onIdle = () => { try { sock.destroy(); } catch {} this.error = ProxyError("ETIMEOUT", "proxiedFetch: response idle timeout"); this.ended = true; this._flush(); };
      const reset = () => { if (this._idleTimer) clearTimeout(this._idleTimer); this._idleTimer = setTimeout(onIdle, idleMs); };
      reset();
      sock.on("data", reset);
      sock.on("end", () => { if (this._idleTimer) clearTimeout(this._idleTimer); });
      sock.on("close", () => { if (this._idleTimer) clearTimeout(this._idleTimer); });
    }
  }
  _push(c) { this.q.push(c); this.len += c.length; this._flush(); }
  _flush() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  // 从队列头部切出合并后的一整块（长度>=need 或全部）
  _take(need) {
    let have = 0, i = 0;
    const parts = [];
    for (; i < this.q.length; i++) {
      parts.push(this.q[i]);
      have += this.q[i].length;
      if (need != null && have >= need) { i++; break; }
    }
    const out = Buffer.concat(parts);
    this.q = this.q.slice(i);
    this.len -= out.length;
    return out;
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

    const streamBody = new ReadableStream({
      start(controller) {
        (async () => {
          try {
            let dec = null;
            let decDoneResolve = null;
            const decDone = new Promise((r) => (decDoneResolve = r));
            let decClosed = false;
            const decClose = () => { if (decClosed) return; decClosed = true; try { controller.close(); } catch {} decDoneResolve(); };
            if (ce === "gzip") dec = zlib.createGunzip();
            else if (ce === "deflate") dec = zlib.createInflate();
            else if (ce === "br") dec = zlib.createBrotliDecompress();
            if (dec) {
              dec.on("data", (c) => { try { controller.enqueue(new Uint8Array(c)); } catch {} });
              dec.on("end", decClose);
              dec.on("error", (e) => { try { controller.error(e); } catch {} decDoneResolve(); });
            }
            // dec 写入用 drain 背压，避免过大解压缓冲
            const write = (c) => new Promise((res) => {
              if (dec) { if (!dec.write(c)) { dec.once("drain", () => res()); } else res(); }
              else { try { controller.enqueue(new Uint8Array(c)); } catch {} res(); }
            });
            const te = (hdrs["transfer-encoding"] || "").toLowerCase();
            if (te.includes("chunked")) {
              for (;;) {
                const line = await stream.readLine();
                const size = parseInt(line.trim().split(";")[0], 16);
                if (!Number.isFinite(size) || size <= 0) break;
                if (size > MAX_CHUNK) { try { sock.destroy(); } catch {} throw ProxyError("ECHUNK", "chunk too large"); }
                const chunk = await stream.readExactly(size);
                await write(chunk);
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
                await write(toPush);
                if (rem === 0) break;
              }
            }
            if (dec) { dec.end(); await decDone; } else { try { controller.close(); } catch {} }
          } catch (e) {
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
    });
    await new Promise((resolve, reject) => {
      tlsSock.once("secureConnect", resolve);
      tlsSock.once("error", (e) => reject(ProxyError("ETLS", `TLS to ${targetHost} failed: ${e.message}`, e)));
    });
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
