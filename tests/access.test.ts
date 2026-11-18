import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  isOriginAllowed,
  parseHttpOrigin,
  stripDefaultPort,
  verifyBasicAuth,
} from "../src/server/access.js";
import { isLoopbackHost, readServerConfig } from "../src/server/config.js";

describe("来源校验 isOriginAllowed", () => {
  it("没有 Origin 时放行（同源导航与 curl）", () => {
    expect(isOriginAllowed({ origin: "", hostHeader: "know.example.com" })).toBe(true);
    expect(isOriginAllowed({ origin: null })).toBe(true);
  });

  it("本机来源放行（开发模式 5180 直连 5179）", () => {
    expect(isOriginAllowed({ origin: "http://127.0.0.1:5180", hostHeader: "127.0.0.1:5179" })).toBe(true);
    expect(isOriginAllowed({ origin: "http://localhost:3000" })).toBe(true);
    expect(isOriginAllowed({ origin: "http://[::1]:8080" })).toBe(true);
  });

  it("Origin 与 Host 一致时放行（反代保留 Host 的同源部署）", () => {
    expect(
      isOriginAllowed({ origin: "https://know.example.com", hostHeader: "know.example.com" }),
    ).toBe(true);
    // 默认端口差异视为同一来源
    expect(
      isOriginAllowed({ origin: "https://know.example.com:443", hostHeader: "know.example.com" }),
    ).toBe(true);
    expect(
      isOriginAllowed({ origin: "http://know.example.com:80", hostHeader: "know.example.com:80" }),
    ).toBe(true);
  });

  it("跨站来源默认拒绝", () => {
    expect(
      isOriginAllowed({ origin: "https://evil.example.com", hostHeader: "know.example.com" }),
    ).toBe(false);
  });

  it("白名单命中时放行，且忽略大小写与默认端口", () => {
    const allowedOrigins = ["https://Know.Example.com/"];
    expect(
      isOriginAllowed({
        origin: "https://know.example.com:443",
        hostHeader: "127.0.0.1:8080",
        allowedOrigins,
      }),
    ).toBe(true);
    expect(
      isOriginAllowed({
        origin: "https://other.example.com",
        hostHeader: "127.0.0.1:8080",
        allowedOrigins,
      }),
    ).toBe(false);
  });

  it("trustProxy 打开时使用 X-Forwarded-Host", () => {
    expect(
      isOriginAllowed({
        origin: "https://know.example.com",
        hostHeader: "127.0.0.1:8080",
        forwardedHost: "know.example.com, inner-proxy",
        trustProxy: true,
      }),
    ).toBe(true);
    // 未开启信任代理时，不采信该头
    expect(
      isOriginAllowed({
        origin: "https://know.example.com",
        hostHeader: "127.0.0.1:8080",
        forwardedHost: "know.example.com",
        trustProxy: false,
      }),
    ).toBe(false);
  });

  it("非法协议与非法 URL 拒绝", () => {
    expect(isOriginAllowed({ origin: "javascript:alert(1)" })).toBe(false);
    expect(isOriginAllowed({ origin: "file:///etc/passwd" })).toBe(false);
    expect(isOriginAllowed({ origin: "not-a-url" })).toBe(false);
  });
});

describe("口令校验 verifyBasicAuth", () => {
  const credential = (user: string, pass: string) =>
    `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;

  it("口令正确时通过，用户名不参与判断", () => {
    expect(verifyBasicAuth(credential("knowknow", "s3cret"), "s3cret")).toBe(true);
    expect(verifyBasicAuth(credential("任意用户", "s3cret"), "s3cret")).toBe(true);
    // 口令里带冒号也能正确切分
    expect(verifyBasicAuth(credential("u", "a:b:c"), "a:b:c")).toBe(true);
  });

  it("口令错误、缺失、格式非法时拒绝", () => {
    expect(verifyBasicAuth(credential("u", "wrong"), "s3cret")).toBe(false);
    expect(verifyBasicAuth(credential("u", "s3cret "), "s3cret")).toBe(false);
    expect(verifyBasicAuth(undefined, "s3cret")).toBe(false);
    expect(verifyBasicAuth("", "s3cret")).toBe(false);
    expect(verifyBasicAuth("Bearer abc", "s3cret")).toBe(false);
    expect(verifyBasicAuth("Basic", "s3cret")).toBe(false);
    expect(verifyBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`, "s3cret")).toBe(false);
  });

  it("定长比较在长度不同时也返回 false", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("运行时配置 readServerConfig", () => {
  it("默认值与 1.0 本机行为一致", () => {
    const config = readServerConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(5179);
    expect(config.authPassword).toBeNull();
    expect(config.allowedOrigins).toEqual([]);
    expect(config.trustProxy).toBe(false);
  });

  it("读取容器/公网部署所需变量", () => {
    const config = readServerConfig({
      HOST: "0.0.0.0",
      PORT: "8080",
      KNOW_KNOW_AUTH_PASSWORD: "  s3cret  ",
      KNOW_KNOW_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com ,",
      KNOW_KNOW_TRUST_PROXY: "1",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.authPassword).toBe("s3cret");
    expect(config.allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(config.trustProxy).toBe(true);
  });

  it("非法端口回退默认值，空白口令视为未设置", () => {
    expect(readServerConfig({ PORT: "abc" }).port).toBe(5179);
    expect(readServerConfig({ PORT: "70000" }).port).toBe(5179);
    expect(readServerConfig({ PORT: "-1" }).port).toBe(5179);
    expect(readServerConfig({ KNOW_KNOW_AUTH_PASSWORD: "   " }).authPassword).toBeNull();
  });

  it("识别回环地址", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("辅助函数", () => {
  it("只接受 http/https", () => {
    expect(parseHttpOrigin("https://a.com")?.host).toBe("a.com");
    expect(parseHttpOrigin("ftp://a.com")).toBeNull();
    expect(parseHttpOrigin("")).toBeNull();
  });

  it("剥离默认端口", () => {
    expect(stripDefaultPort("A.com:443")).toBe("a.com");
    expect(stripDefaultPort("a.com:80")).toBe("a.com");
    expect(stripDefaultPort("a.com:8080")).toBe("a.com:8080");
  });
});
