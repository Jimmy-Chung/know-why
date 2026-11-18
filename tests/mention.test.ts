import { describe, expect, it } from "vitest";
import { stripMentionTrigger } from "../src/client/mention.js";

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
