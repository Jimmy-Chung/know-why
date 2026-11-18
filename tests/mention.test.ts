import { describe, expect, it } from "vitest";
import { mentionAtCaret, stripMentionTrigger } from "../src/client/mention.js";

describe("stripMentionTrigger", () => {
  it("删除行首的 @ 触发文本", () => {
    expect(stripMentionTrigger("@abc", 0, 4)).toEqual({ text: "", caret: 0 });
    expect(stripMentionTrigger("@", 0, 1)).toEqual({ text: "", caret: 0 });
  });

  it("保留触发文本前后的正文", () => {
    expect(stripMentionTrigger("hello @abc", 6, 10)).toEqual({ text: "hello ", caret: 6 });
    expect(stripMentionTrigger("前文 @abc 后文", 3, 7)).toEqual({ text: "前文  后文", caret: 3 });
  });

  it("至少吃掉 @ 本身，越界位置会被收敛", () => {
    expect(stripMentionTrigger("@abc", 0, 0)).toEqual({ text: "abc", caret: 0 });
    expect(stripMentionTrigger("ab@", 2, 99)).toEqual({ text: "ab", caret: 2 });
    expect(stripMentionTrigger("abc", 99, 99)).toEqual({ text: "abc", caret: 3 });
  });
});

it("识别光标前的中英文提及，保留邮箱和普通文本", () => {
  expect(mentionAtCaret("比较＠城市与电影", 5)).toEqual({ start: 2, end: 5, query: "城市" });
  expect(mentionAtCaret("hello @", 7)).toEqual({ start: 6, end: 7, query: "" });
  expect(mentionAtCaret("a@b.com", 7)).toBeNull();
  expect(mentionAtCaret("@词 继续", 5)).toBeNull();
});
