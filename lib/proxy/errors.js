// lib/proxy/errors.js — 结构化错误与公共工具（纯函数，无依赖）

export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_TIMEOUT_MS = 2147483647;

/** 带机器可读 code 的错误。 */
export function ProxyError(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

/** 对齐 fetch 的取消错误。 */
export function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}

/** 接受数值或非空数字字符串；拒绝布尔值/数组的隐式转换与定时器溢出。 */
export function parseTimeout(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const ms = Number(value);
  return Number.isInteger(ms) && ms >= 1 && ms <= MAX_TIMEOUT_MS ? ms : null;
}

/** 超时（ms）：proxy.timeout 可用则用之，否则默认 60000。 */
export function timeoutFor(proxy) {
  return parseTimeout(proxy && proxy.timeout) ?? DEFAULT_TIMEOUT_MS;
}
