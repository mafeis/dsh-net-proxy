// lib/proxy/tls.js — TLS 目标握手（ALPN 策略 + ECONNRESET 降级，issue #13）
//
// 背景：ALPN 扩展位于 ClientHello 明文段，代理链路全程可见。部分代理节点/目标边缘
// 对「带 h2 的 ClientHello」直接 RST（CONNECT 隧道已 200，RST 紧跟在 ClientHello 之后）。
// 因此默认只声明 http/1.1，与 undici ≤7 的行为一致。
//
// 显式选了 alpn="h2" 时另有补救，不需要用户判断目标：
//   1. 首次失败（ECONNRESET 等）→ 重新拨隧道、只声明 http/1.1 再握一次；
//   2. 已知「确实能用 h2」的目标记进模块级亲和表，后续请求直接按原策略协商，
//      不让默认值给每条请求都加一次「h2 → 被拒 → 重连」。
// 亲和表随配置版次失效（换代理后此前学到的链路结论不再成立）。
import tls from "node:tls";
import { ProxyError, abortError } from "./errors.js";

/** 单次调用可用的 ALPN 列表；null 表示不发送 ALPN 扩展。 */
const ALPN_DEFAULT = ["http/1.1"];
const ALPN_WITH_H2 = ["h2", "http/1.1"];

/** 这些失败值得去掉 h2 试第二次：RST/链路抖动，以及只因声明了 h2 才可能出现的握手告警
 * （如 h2-only 服务端回 no_application_protocol；OpenSSL lib 错误码无 errno，靠 code 前缀认）。 */
const RETRYABLE_ERRNO = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

function retryable(errno) {
  return typeof errno === "string" && (RETRYABLE_ERRNO.has(errno) || errno.startsWith("ERR_SSL_"));
}

const MAX_H2_AFFINITY = 256;
const h2Affinity = new Set();

/** 配置版次变化（换代理/改策略）时调用：清空亲和表。 */
export function resetAlpnAffinity() {
  h2Affinity.clear();
}

/** proxy.alpn（"http/1.1" / "h2" / "off"）→ ALPNProtocols；未识别按默认。 */
function alpnList(alpn) {
  if (alpn === "off") return null;
  if (alpn === "h2") return ALPN_WITH_H2;
  return ALPN_DEFAULT;
}

function affinityKey(proxy, targetHost, targetPort) {
  if (!proxy) return "";
  return `${proxy.protocol}://${proxy.host}:${proxy.port}|${targetHost}:${targetPort}`;
}

function rememberH2(key) {
  if (!key || h2Affinity.has(key)) return;
  while (h2Affinity.size >= MAX_H2_AFFINITY) h2Affinity.delete(h2Affinity.values().next().value); // 淘汰最旧
  h2Affinity.add(key);
}

/** 底层 errno：沿 cause 链取，供 sendViaHttp2 二次包装（EHTTP2）之后仍能判定。 */
function rootErrno(e) {
  for (let c = e, n = 0; c && n < 4; c = c.cause, n++) {
    if (typeof c === "number") return ""; // ABORT_ERR 用数值 code
    if (retryable(c.code)) return c.code;
    if (c.code === "ABORT_ERR") return "ABORT_ERR";
  }
  return "";
}

/**
 * h2 已协商且失败发生时是否值得按 http/1.1 重来。调用方只在「还没发出任何请求字节」
 * 之前询问（h2 建连阶段 / sendViaHttp2 的建流阶段），因此重发不会产生重复副作用。
 */
export function shouldRetryWithoutH2(alpnProtocol, err, { sent = false } = {}) {
  if (alpnProtocol !== "h2" || sent) return false;
  return retryable(rootErrno(err));
}

/**
 * 建立到目标的 TLS。raw 是已就绪的隧道 socket；attempt() 用于降级重连时重新拨隧道。
 * 握手用完即弃的失败路径在这里收尾（销毁 socket），超时/取消与原实现同义。
 * @returns {Promise<{sock: import("node:tls").TLSSocket, h2: boolean, retried: boolean}>}
 */
export async function tlsHandshake(opts) {
  const { targetHost, targetPort, isIP, proxy, alpn, h2Fallback, signal, timeoutMs, raw, attempt } = opts;
  const key = affinityKey(proxy, targetHost, targetPort);
  // 大小写/空格按配置契约归一；非法值落到默认
  const mode = typeof alpn === "string" && ["h2", "off"].includes(alpn.trim().toLowerCase()) ? alpn.trim().toLowerCase() : "http/1.1";
  // allowH2：策略本身要 h2 且没被关掉降级；亲和命中则首次就直接带 h2，省掉一轮注定被拒的握手
  const allowH2 = mode === "h2" && h2Fallback !== false;
  const first = allowH2 && h2Affinity.has(key) ? ALPN_WITH_H2 : alpnList(mode);

  let sock;
  try {
    sock = await handshakeOnce({ targetHost, targetPort, isIP, alpn: first, signal, timeoutMs, raw, key });
  } catch (err) {
    if (!(allowH2 && retryable(rootErrno(err)))) throw err;
    // 降级：原隧道已被销毁，重新拨一条，只声明 http/1.1 再握一次（失败则抛出该次原始错误）
    if (signal && signal.aborted) throw abortError();
    const down = await attempt();
    sock = await handshakeOnce({ targetHost, targetPort, isIP, alpn: ALPN_DEFAULT, signal, timeoutMs, raw: down, key: null });
    return { sock, h2: sock.alpnProtocol === "h2", retried: true };
  }
  return { sock, h2: sock.alpnProtocol === "h2", retried: false };
}

function handshakeOnce({ targetHost, targetPort, isIP, alpn, signal, timeoutMs, raw, key }) {
  // 解析为 TLSSocket；失败抛原始错误，是否降级由调用方按 rootErrno 判定
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      socket: raw,
      servername: isIP ? undefined : targetHost, // B3：IP 目标不发 SNI
      host: targetHost,
      port: targetPort,
      ...(alpn ? { ALPNProtocols: alpn } : {}),
    });
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };
    const fail = (err) => {
      cleanup();
      try { sock.destroy(); } catch {}
      reject(err);
    };
    const timer = setTimeout(
      () => fail(ProxyError("ETIMEOUT", `TLS handshake to ${targetHost} timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onAbort = () => fail(abortError());
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    sock.once("secureConnect", () => {
      cleanup();
      sock.removeListener("error", onTlsError);
      // 永久兜底监听（issue #2）：握手之后 socket 在任何时刻都必须至少有一个 error
      // 监听。此前握手成功即 removeAllListeners("error")，靠后续分支（h2 session /
      // ByteStream）各自挂监听兜底——新增分支或调整移交顺序时会出现无监听窗口，
      // 底层错误会逃逸成 uncaughtException 带走宿主进程。no-op 只保证 EventEmitter
      // 不抛，真正的错误仍由各分支自己的监听上报给调用方。
      sock.on("error", () => {});
      if (sock.alpnProtocol === "h2") rememberH2(key);
      resolve(sock);
    });
    const onTlsError = (e) => fail(ProxyError("ETLS", `TLS to ${targetHost} failed: ${e.message}`, e));
    sock.once("error", onTlsError);
  });
}
