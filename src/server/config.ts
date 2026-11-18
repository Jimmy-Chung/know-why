// 运行时配置：全部来自环境变量。
// 默认值与 1.0 的「本机个人版」行为完全一致（127.0.0.1 + 无口令）；
// 只有显式设置 HOST / 口令 / 允许来源，才会变成可被外部 URL 访问的部署。

export interface ServerConfig {
  /** 监听地址。默认 127.0.0.1；容器内需要 0.0.0.0。 */
  host: string;
  /** 监听端口。默认 5179。 */
  port: number;
  /** 额外允许的浏览器来源（反向代理改写 Host 时使用）。 */
  allowedOrigins: string[];
  /** 访问口令；为空表示不启用口令门禁（仅适合本机）。 */
  authPassword: string | null;
  /** 是否信任反向代理传来的 X-Forwarded-Host。 */
  trustProxy: boolean;
}

const DEFAULT_PORT = 5179;

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawPort = Number(env.PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_PORT;

  const host = (env.HOST || "").trim() || "127.0.0.1";

  const allowedOrigins = (env.KNOW_KNOW_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const password = (env.KNOW_KNOW_AUTH_PASSWORD || "").trim();

  return {
    host,
    port,
    allowedOrigins,
    authPassword: password.length > 0 ? password : null,
    trustProxy: env.KNOW_KNOW_TRUST_PROXY === "1",
  };
}

/** 回环地址：只有这些值才等价于「仅本机可访问」。 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}
