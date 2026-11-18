// 访问控制：浏览器来源校验 + 最简口令门禁。
//
// 设计目标：
// 1. 默认行为不变——只接受本机来源，公网域名一律拒绝。
// 2. 显式配置后，同源部署（域名经反向代理指到本服务）可以正常工作：
//    浏览器对同源 POST 会带 Origin，此时 Origin 与 Host 一致即放行。
// 3. 口令门禁是可选的；一旦设置，除 /api/health 外所有请求都要 HTTP Basic Auth。
import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/** 只接受 http/https 的 Origin；解析失败视为非法。 */
export function parseHttpOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** 去掉 http/https 默认端口，便于 `a.com` 与 `a.com:443` 视为同一来源。 */
export function stripDefaultPort(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.endsWith(":80")) return value.slice(0, -3);
  if (value.endsWith(":443")) return value.slice(0, -4);
  return value;
}

export function originKey(url: URL): string {
  return `${url.protocol}//${stripDefaultPort(url.host)}`;
}

export interface OriginCheck {
  origin?: string | null;
  hostHeader?: string | null;
  forwardedHost?: string | null;
  allowedOrigins?: readonly string[];
  trustProxy?: boolean;
}

/**
 * 浏览器来源是否允许。
 * - 没有 Origin：非浏览器请求或顶层导航（同源 GET 不带 Origin），放行。
 * - 回环来源：本机开发直接连后端，放行。
 * - 命中白名单：放行。
 * - Origin 与本次请求的 Host 相同：放行（反代保留 Host 时即同源访问）。
 */
export function isOriginAllowed(check: OriginCheck): boolean {
  const { origin, hostHeader, forwardedHost, allowedOrigins = [], trustProxy = false } = check;
  if (!origin) return true;

  const url = parseHttpOrigin(origin);
  if (!url) return false;
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return true;

  const key = originKey(url);
  for (const allowed of allowedOrigins) {
    const parsed = parseHttpOrigin(allowed);
    if (parsed && originKey(parsed) === key) return true;
  }

  const forwarded = trustProxy && forwardedHost ? forwardedHost.split(",")[0] : undefined;
  const expectedHost = stripDefaultPort((forwarded || hostHeader || "").trim());
  if (expectedHost && stripDefaultPort(url.host) === expectedHost) return true;

  return false;
}

/**
 * 校验 HTTP Basic Auth。用户名不参与判断（浏览器会缓存用户填的值），只校验口令。
 */
export function verifyBasicAuth(header: string | null | undefined, password: string): boolean {
  if (!header) return false;
  const separator = header.indexOf(" ");
  if (separator <= 0) return false;
  if (header.slice(0, separator).toLowerCase() !== "basic") return false;
  const encoded = header.slice(separator + 1).trim();
  if (!encoded) return false;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;

  return constantTimeEqual(decoded.slice(colon + 1), password);
}

/** 定长比较，避免通过响应时间推测口令长度或内容。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  const size = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(size);
  const paddedRight = Buffer.alloc(size);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}
