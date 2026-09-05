import { describe, it, expect } from "vitest";
import { markdownToPlaintext, resolveAnchor, locateAnchor } from "../src/server/selection.js";

describe("markdownToPlaintext", () => {
  it("去除强调与标题标记", () => {
    expect(markdownToPlaintext("**粗体** 和 *斜体*")).toBe("粗体 和 斜体");
    expect(markdownToPlaintext("# 标题\n正文")).toBe("标题\n正文");
  });
  it("链接保留文本", () => {
    expect(markdownToPlaintext("[Anthropic](https://anthropic.com)")).toBe("Anthropic");
  });
  it("列表标记去除", () => {
    expect(markdownToPlaintext("- 项一\n- 项二\n1. 项三")).toBe("项一\n项二\n项三");
  });
  it("行内代码与代码块保留内容", () => {
    expect(markdownToPlaintext("用 `foo` 函数")).toBe("用 foo 函数");
  });
});

describe("resolveAnchor", () => {
  const plain = "知识管理是把信息转化为可复用知识的过程。知识管理包括采集、组织与分享。";

  it("偏移准确时按偏移解析", () => {
    const sel = "知识管理";
    const start = plain.indexOf(sel);
    const r = resolveAnchor(plain, sel, start, start + sel.length);
    expect(r.start).toBe(start);
    expect(r.end).toBe(start + sel.length);
    expect(plain.slice(r.start, r.end)).toBe(sel);
  });

  it("偏移不准确时回退到选文首现", () => {
    const sel = "采集、组织与分享";
    const r = resolveAnchor(plain, sel, 0, 0);
    expect(plain.slice(r.start, r.end)).toBe(sel);
  });

  it("重复选文时定位首个", () => {
    const sel = "知识管理";
    const r = resolveAnchor(plain, sel, -1, -1);
    expect(r.start).toBe(0);
  });

  it("产生前后缀校验字段", () => {
    const sel = "过程";
    const r = resolveAnchor(plain, sel, -1, -1);
    expect(r.prefix.length).toBeGreaterThan(0);
    expect(r.suffix.length).toBeGreaterThanOrEqual(0);
  });
});

describe("locateAnchor", () => {
  const plain = "知识管理是把信息转化为可复用知识的过程。";
  it("偏移匹配时直接还原", () => {
    const sel = "信息转化为可复用知识";
    const start = plain.indexOf(sel);
    const anchor = { selected_text: sel, start_offset: start, end_offset: start + sel.length, prefix: "", suffix: "" };
    const loc = locateAnchor(plain, anchor);
    expect(loc).not.toBeNull();
    expect(plain.slice(loc!.start, loc!.end)).toBe(sel);
  });
  it("找不到时返回 null", () => {
    const anchor = { selected_text: "不存在的选文XYZ", start_offset: 0, end_offset: 0, prefix: "", suffix: "" };
    expect(locateAnchor(plain, anchor)).toBeNull();
  });
});
