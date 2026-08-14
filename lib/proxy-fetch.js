// @local/dsh-proxy — 核心代理客户端（手写，不依赖 undici）
//
// 提供 proxiedFetch(input, init, proxy, originalFetch) —— 把一次 fetch 请求走
// HTTP / HTTPS-CONNECT / SOCKS5 代理发出。
//   - HTTTP 目标：绝对 URL 请求行经代理转发。
//   - HTTPS 目标：CONNECT 隧道 + TLS（带 servername）。
//   - SOCKS5：握手/认证/CONNECT；域名目标须 ATYP=0x03。
//   - NO_PROXY：命中列表直连（不经代理），避免把本机回环也代理断掉。
//
// 返回一个 Response 兼容的 plain 对象（status/headers/ok/url/text()/json()/...）。

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";

/** 判定该 URL 是否命中 noProxy 列表（命中则直连）。支持裸 host 前缀匹配。 */
export function isNoProxy(rawUrl, noProxy) {
  if (!Array.isArray(noProxy) || noProxy.length === 0) return false;
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    host = String(rawUrl).toLowerCase();
  }
  return noProxy.some((entry) => {
    if (!entry) return false;
    const e = String(entry).trim().toLowerCase();
    if (!e) return false;
    return host === e || host.endsWith("." + e);
  });
}

/** 从 socket 精确读取 n 字节。 */
export function readExactly(sock, n) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("end", onEnd);
    function onData(chunk) {
      chunks.push(chunk);
      got += chunk.length;
      if (got >= n) {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, n));
      }
    }
    function onErr(e) {
      cleanup();
      reject(e);
    }
    function onEnd() {
      cleanup();
      reject(new Error("readExactly: socket ended early"));
    }
    function cleanup() {
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      sock.removeListener("end", onEnd);
    }
  });
}

/** 从 socket 读取一行（到 \r\n）。 */
function readLine(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("end", onEnd);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n");
      if (idx !== -1) {
        cleanup();
        resolve(buf.subarray(0, idx).toString("latin1"));
      } else if (buf.length > 65536) {
        cleanup();
        reject(new Error("readLine: line too long"));
      }
    }
    function onErr(e) {
      cleanup();
      reject(e);
    }
    function onEnd() {
      cleanup();
      reject(new Error("readLine: socket ended"));
    }
    function cleanup() {
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      sock.removeListener("end", onEnd);
    }
  });
}

/** 从 socket 读取 HTTP 响应头（到 \r\n\r\n）。 */
export function readHead(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("end", onEnd);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx !== -1) {
        cleanup();
        resolve({
          head: buf.subarray(0, idx).toString("latin1"),
          rest: buf.subarray(idx + 4),
        });
      }
    }
    function onErr(e) {
      cleanup();
      reject(e);
    }
    function onEnd() {
      cleanup();
      reject(new Error("readHead: socket ended before headers"));
    }
    function cleanup() {
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      sock.removeListener("end", onEnd);
    }
  });
}

/** 解析 HTTP 状态行，返回 status。 */
export function parseStatusLine(line) {
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(line || "");
  return m ? Number(m[1]) : 0;
}

/** 直连（不经代理）发请求，委托给原始 fetch —— 用作 NO_PROXY 命中时的回退。 */
function directFetch(originalFetch, input, init) {
  return originalFetch(input, init);
}

/** 发起代理 TCP 连接：socks5 走协商；其余走 HTTP(CONNECT 由 sendHttp 处理)。 */
function proxyConnect(proxy) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({
      host: proxy.host,
      port: proxy.port,
    });
    sock.setNoDelay(true);
    sock.once("connect", () => resolve(sock));
    sock.once("error", (e) => reject(new Error(`proxy connect ${proxy.host}:${proxy.port} failed: ${e.message}`)));
  });
}

/** HTTP 代理的 CONNECT 隧道（HTTPS 目标）。返回已建隧道的 raw socket。 */
function httpConnect(proxy, targetHost, targetPort) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try {
      sock = await proxyConnect(proxy);
    } catch (e) {
      return reject(e);
    }
    const host = `${targetHost}:${targetPort}`;
    let auth = "";
    if (proxy.username || proxy.password) {
      auth = "Proxy-Authorization: Basic " + Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64") + "\r\n";
    }
    sock.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${auth}\r\n`);
    readHead(sock).then(
      ({ head }) => {
        const status = parseStatusLine(head);
        if (status === 200) {
          resolve(sock);
        } else {
          sock.destroy();
          reject(new Error(`CONNECT to ${host} via proxy failed: HTTP ${status}`));
        }
      },
      (e) => reject(e),
    );
  });
}

/**
 * 核心：把一次 fetch 请求经代理发出，返回 Response 兼容对象。
 * @param {RequestInfo} input
 * @param {RequestInit} [init]
 * @param {{protocol:string,host:string,port:number,username?:string,password?:string,noProxy?:string[]}} proxy
 * @param {typeof fetch} originalFetch 直连回退（NO_PROXY 命中时）。
 */
async function proxiedOnce(url, init = {}, proxy, originalFetch) {
  const urlObj = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  // dsh 的 fetch init.body 是 string；Buffer.concat 不接收 string，需转成 Buffer。
  const body = init.body == null ? null : (typeof init.body === "string" ? Buffer.from(init.body) : init.body);

  // NO_PROXY 命中：直连（原始 fetch）。
  if (isNoProxy(url, proxy.noProxy)) {
    return directFetch(originalFetch, input, init);
  }

  const { protocol, host, port } = proxy;
  const targetHost = urlObj.hostname;
  const targetPort = urlObj.port ? Number(urlObj.port) : (urlObj.protocol === "https:" ? 443 : 80);
  const isSocks = protocol === "socks5" || protocol === "socks";

  // 组装请求头（去掉仅适用于连接的 hop-by-hop 头）。
  // 注意：dsh 传的 init.headers 往往是 Headers 实例，其数据在内部 slot、无可枚举
  // 属性，用 {...} 展开会得到空对象，导致 Authorization 等头全丢（hankun 收到
  // 无认证头的请求 → "API key is invalid"）。必须用 forEach 取值。
  const headers = {};
  {
    const src = init.headers;
    if (src != null && typeof src === "object") {
      if (typeof Headers !== "undefined" && src instanceof Headers) {
        src.forEach((v, k) => (headers[k] = v));
      } else if (Array.isArray(src)) {
        for (const [k, v] of src) headers[k] = v;
      } else {
        Object.assign(headers, src);
      }
    }
  }
  // 保留 user-agent 等；移除 hop-by-hop
  ["proxy-connection", "keep-alive", "connection", "upgrade", "transfer-encoding"].forEach((h) => delete headers[h]);
  // 手写实现按需解压；先声明 identity，绝大多数服务器便不会 gzip。
  headers["accept-encoding"] = "identity";

  if (urlObj.protocol === "http:") {
    // ── HTTP 目标：绝对 URL 请求行经代理转发 ──
    const sock = await proxyConnect(proxy);
    const firstLine = `${method} ${url} HTTP/1.1\r\n`;
    const h = {
      Host: urlObj.host,
      Connection: "close",
      ...headers,
    };
    const head = `${firstLine}${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
    return sendViaSocket(sock, url, head, body);
  }

  if (urlObj.protocol === "https:") {
    // ── HTTPS 目标：先建代理隧道，再 TLS。 ──
    let raw;
    if (isSocks) {
      raw = await socksConnect(proxy, targetHost, targetPort);
    } else {
      raw = await httpConnect(proxy, targetHost, targetPort);
    }
    const tlsSock = tls.connect({
      socket: raw,
      servername: targetHost,
      host: targetHost,
      port: targetPort,
    });
    await new Promise((resolve, reject) => {
      tlsSock.once("secureConnect", resolve);
      tlsSock.once("error", (e) => reject(new Error(`TLS to ${targetHost} failed: ${e.message}`)));
    });
    const path = urlObj.pathname + urlObj.search;
    const h = { Host: urlObj.host, Connection: "close", ...headers };
    const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
    return sendViaSocket(tlsSock, url, head, body);
  }

  throw new Error(`proxiedFetch: unsupported protocol ${urlObj.protocol}`);
}

// 外层：跟随 30x 重定向（最多 5 跳），对齐标准 fetch。
export async function proxiedFetch(input, init = {}, proxy, originalFetch) {
  let url = typeof input === "string" ? input : (input && (input.url || String(input.url)));
  if (!url) throw new Error("proxiedFetch: invalid input");
  let cur = { ...(init || {}) };
  if (input && typeof input === "object" && input.url && !cur.method) cur.method = input.method || "GET";
  for (let i = 0; i < 6; i++) {
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
  }
  throw new Error("proxiedFetch: too many redirects");
}

/** SOCKS5 代理协商 + 连接目标。 */
function socksConnect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    proxyConnect(proxy).then((sock) => {
      const greet = Buffer.from([0x05, 0x01, 0x00]); // 无认证
      sock.write(greet);
      readExactly(sock, 2).then((resp) => {
        if (resp[1] !== 0x00) {
          sock.destroy();
          return reject(new Error(`SOCKS5: server requires auth (method ${resp[1]})`));
        }
        // CONNECT 请求：域名 → ATYP=0x03
        const hostBuf = Buffer.from(targetHost, "utf8");
        const len = hostBuf.length;
        const req = Buffer.alloc(4 + 1 + len + 2);
        req[0] = 0x05;
        req[1] = 0x01;
        req[2] = 0x00;
        req[3] = 0x03;
        req[4] = len;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(targetPort, 5 + len);
        sock.write(req);
        readExactly(sock, 4).then((h) => readSocksAddr(sock).then((addrResp) => {
          if (h[1] === 0x00) resolve(sock);
          else {
            sock.destroy();
            reject(new Error(`SOCKS5: connect to ${targetHost}:${targetPort} failed, code ${h[1]}`));
          }
        }));
      });
    }, reject);
  });
}

/** 读取 SOCKS5 回复中的 BND.ADDR（变长）。 */
function readSocksAddr(sock) {
  return readExactly(sock, 1).then((addrTypeBuf) => {
    const atyp = addrTypeBuf[0];
    const len = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1;
    return readExactly(sock, len + 2); // addr + port
  });
}

/** 统一把已建好的 socket 用于发 HTTP 请求并读响应，构造 Response 兼容对象。 */
/**
 * 单数据泵：一个 socket 只挂一个 data 监听，数据累积进内部 Buffer，用
 * pull 式解析（Buffer 不足则挂起等更多数据）。彻底避免多 data 监听器
 * 互相消费导致"丢数据 → readExactly ended early"。
 */
class ByteStream {
  constructor(sock, idleMs = 0) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.done = false;
    this.ended = false;
    this.error = null;
    sock.on("data", (c) => this._push(c));
    sock.on("end", () => {
      this.ended = true;
      this._flushWaiters();
    });
    sock.on("error", (e) => {
      this.error = e;
      this.ended = true;
      this._flushWaiters();
    });
    this._clearIdle = null;
    if (idleMs > 0) {
      const onIdle = () => {
        try { sock.destroy(); } catch {}
        this.error = new Error("proxiedFetch: response idle timeout");
        this.ended = true;
        this._flushWaiters();
      };
      const reset = () => {
        if (this._clearIdle) clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(onIdle, idleMs);
      };
      this._clearIdle = () => { if (this._idleTimer) clearTimeout(this._idleTimer); };
      reset();
      sock.on("data", reset);
      sock.on("end", this._clearIdle);
      sock.on("close", this._clearIdle);
    }
  }
  _push(c) {
    this.buf = Buffer.concat([this.buf, c]);
    this._flushWaiters();
  }
  _flushWaiters() {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }
  // 返回满足条件的最多字节，不足则挂起等待；结束则抛/返回 null。
  _pull(need, cb) {
    if (this.buf.length >= need) {
      const out = this.buf.subarray(0, need);
      this.buf = this.buf.subarray(need);
      cb(null, out);
    } else if (this.ended) {
      cb(this.error || new Error("socket ended early"), null);
    } else {
      this.waiters.push(() => this._pull(need, cb));
    }
  }
  // 读一个 CRLF 结尾的行。
  _line(cb) {
    if (this.ended && this.buf.length === 0) {
      return cb(this.error || new Error("socket ended early"), null);
    }
    const idx = this.buf.indexOf("\r\n");
    if (idx !== -1) {
      const out = this.buf.subarray(0, idx);
      this.buf = this.buf.subarray(idx + 2);
      return cb(null, out);
    }
    this.waiters.push(() => this._line(cb));
  }
  readExactly(need) {
    return new Promise((res, rej) => this._pull(need, (e, b) => (e ? rej(e) : res(b))));
  }
  readLine() {
    return new Promise((res, rej) => this._line((e, b) => (e ? rej(e) : res(b.toString("latin1")))));
  }
  readChunked() {
    const parts = [];
    const loop = () =>
      this.readLine().then((line) => {
        const size = parseInt(line.trim().split(";")[0], 16);
        if (!Number.isFinite(size) || size <= 0) return Promise.resolve();
        return this.readExactly(size).then((buf) => {
          parts.push(buf);
          return this.readLine().then(loop);
        });
      });
    return loop().then(() => Buffer.concat(parts));
  }
  readToEnd() {
    // 直到 socket 结束把所有已缓冲数据收集起来。
    return new Promise((res, rej) => {
      const gather = () => {
        if (this.ended) {
          if (this.error) return rej(this.error);
          const out = this.buf;
          this.buf = Buffer.alloc(0);
          return res(out);
        }
        this.waiters.push(gather);
      };
      gather();
    });
  }
  // 流式取下一块：buf 中现有的全部数据；无数据则等一个 data；连接结束返回 null。
  _nextBlock(cb) {
    if (this.buf.length > 0) {
      const out = this.buf;
      this.buf = Buffer.alloc(0);
      return cb(null, out);
    }
    if (this.ended) return cb(this.error || null, null);
    this.waiters.push(() => this._nextBlock(cb));
  }
  nextData() {
    return new Promise((res, rej) => this._nextBlock((e, b) => (e ? rej(e) : res(b))));
  }
}

async function sendViaSocket(sock, url, head, body) {
  let reqPacket = body != null ? Buffer.concat([Buffer.from(head, "latin1"), body]) : Buffer.from(head, "latin1");
  if (body != null && !/content-length:/i.test(head)) {
    const cl = Buffer.isBuffer(body) || typeof body === "string" ? Buffer.byteLength(body) : undefined;
    if (cl != null) {
      reqPacket = Buffer.concat([
        Buffer.from(head.replace(/\r\n\r\n$/, `\r\nContent-Length: ${cl}\r\n\r\n`), "latin1"),
        body,
      ]);
    }
  }
  const stream = new ByteStream(sock, 60000);

  // 发出请求（表头；若有 Stream body 再流式管道）。
  sock.write(reqPacket);
  if (body != null && typeof body.pipe === "function") body.pipe(sock);

  const timeout = setTimeout(() => {
    try { sock.destroy(); } catch {}
    stream.ended = true;
    stream.error = new Error("proxiedFetch: response timeout");
    stream._flushWaiters();
  }, 60000);

  // 读状态行 + 头（单泵）。
  const statusLine = await stream.readLine();
  const headerLines = [];
  for (;;) {
    const line = await stream.readLine();
    if (line === "") break;
    headerLines.push(line);
  }
  clearTimeout(timeout);

  const status = parseStatusLine(statusLine);
  const hdrs = {};
  for (const line of headerLines) {
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    hdrs[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
  }

  // ── 真流式响应体：逐块读即 enqueue，reader 边读边拿（SSE 逐事件到达）──
  //     若服务器压了 gzip/br/deflate，则流式解压后再 enqueue。
  const streamBody = new ReadableStream({
    start(controller) {
      (async () => {
        try {
          const ce = (hdrs["content-encoding"] || "").toLowerCase();
          let dec = null;
          let decDoneResolve = null;
          const decDone = new Promise((r) => (decDoneResolve = r));
          let decClosed = false;
          const decClose = () => {
            if (decClosed) return;
            decClosed = true;
            try { controller.close(); } catch {}
            decDoneResolve();
          };
          if (ce === "gzip") dec = zlib.createGunzip();
          else if (ce === "deflate") dec = zlib.createInflate();
          else if (ce === "br") dec = zlib.createBrotliDecompress();
          if (dec) {
            dec.on("data", (c) => controller.enqueue(new Uint8Array(c)));
            dec.on("end", decClose);
            dec.on("error", (e) => { try { controller.error(e); } catch {} decDoneResolve(); });
          }
          const write = (c) =>
            new Promise((res) => {
              if (dec) dec.write(c, () => res());
              else { controller.enqueue(new Uint8Array(c)); res(); }
            });
          const te = (hdrs["transfer-encoding"] || "").toLowerCase();
          if (te.includes("chunked")) {
            for (;;) {
              const line = await stream.readLine();
              const size = parseInt(line.trim().split(";")[0], 16);
              if (!Number.isFinite(size) || size <= 0) break;
              const chunk = await stream.readExactly(size);
              await write(chunk);
              await stream.readLine(); // 吃掉该 chunk 尾部 CRLF
            }
          } else {
            let rem = hdrs["content-length"] != null ? Number(hdrs["content-length"]) : -1;
            for (;;) {
              const d = await stream.nextData();
              if (d === null) break;
              let toPush = d;
              if (rem >= 0) {
                if (d.length >= rem) { toPush = d.subarray(0, rem); rem = 0; }
                else rem -= d.length;
              }
              await write(toPush);
              if (rem === 0) break;
            }
          }
          if (dec) { dec.end(); await decDone; }
          else controller.close();
        } catch (e) {
          try { controller.error(e); } catch {}
        } finally {
          try { sock.destroy(); } catch {}
        }
      })();
    }
  });

  const m = statusLine.match(/^HTTP\/\d\.\d \d{3}(?: (.+))?$/);
  const statusText = (m && m[1] ? m[1] : "").trim();
  const response = new Response(streamBody, {
    status,
    statusText,
    headers: new Headers(hdrs),
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
