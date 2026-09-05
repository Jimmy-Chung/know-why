import { describe, it, expect } from "vitest";
import { estimateTokens, estimateMessagesTokens, shouldCompress, splitContext } from "../src/server/summary.js";

describe("estimateTokens", () => {
  it("中文按约 1 token/字估算", () => {
    expect(estimateTokens("知识管理")).toBe(4);
  });
  it("拉丁文按约 4 字符/token 估算", () => {
    expect(estimateTokens("hello")).toBe(2); // ceil(5/4)=2
  });
  it("空字符串为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateMessagesTokens", () => {
  it("累加各消息 token", () => {
    const msgs = [
      { role: "user", content: "知识管理" },
      { role: "assistant", content: "知识管理是过程" },
    ] as any;
    expect(estimateMessagesTokens(msgs)).toBe(4 + 7);
  });
});

describe("shouldCompress", () => {
  it("未达阈值不压缩", () => {
    expect(shouldCompress(1000, 128000)).toBe(false);
  });
  it("达到阈值触发压缩", () => {
    // (128000 - 6000) * 0.7 = 85400
    expect(shouldCompress(90000, 128000)).toBe(true);
  });
  it("小窗口也尊重阈值", () => {
    expect(shouldCompress(20000, 32000)).toBe(true);
  });
});

describe("splitContext", () => {
  it("分离系统消息与主体并保留 ID 对应", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ] as any;
    const ids = [null, "m1", "m2"];
    const parts = splitContext(msgs, ids);
    expect(parts.system?.content).toBe("sys");
    expect(parts.body.length).toBe(2);
    expect(parts.bodyMessageIds).toEqual(["m1", "m2"]);
  });
  it("无系统消息时 system 为 null", () => {
    const parts = splitContext([{ role: "user", content: "u" }] as any, ["m1"]);
    expect(parts.system).toBeNull();
    expect(parts.bodyMessageIds).toEqual(["m1"]);
  });
});
