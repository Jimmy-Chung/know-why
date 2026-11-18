import { describe, expect, it } from "vitest";
import { mentionAtCaret, selectMentionBranch, stripMentionTrigger } from "../src/client/mention.js";

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

describe("节点图引用范围", () => {
  const cards = [
    { id: "first", parent_card_id: "root" }, { id: "leaf", parent_card_id: "first" },
    { id: "second", parent_card_id: "root" }, { id: "root", parent_card_id: null },
    { id: "other", parent_card_id: null },
  ];

  it("默认选中整条分支，合并重叠选择并保留原先的选择", () => {
    const selected = selectMentionBranch(cards, ["other", "leaf"], "first", false);
    expect(new Set(selected)).toEqual(new Set(["other", "first", "leaf"]));
    expect(selectMentionBranch(cards, selected, "first", false)).toEqual(selected);
    expect(selected).toHaveLength(3);
  });

  it("反选只移除目标子树，可单独加回更深的节点或恢复整条分支", () => {
    const all = selectMentionBranch(cards, [], "root", true);
    const trimmed = selectMentionBranch(cards, all, "first", true);
    expect(new Set(trimmed)).toEqual(new Set(["root", "second"]));
    const restoredLeaf = selectMentionBranch(cards, trimmed, "leaf", true);
    expect(new Set(restoredLeaf)).toEqual(new Set(["root", "second", "leaf"]));
    expect(new Set(selectMentionBranch(cards, restoredLeaf, "first", true))).toEqual(new Set(all));
    expect(selectMentionBranch(cards, trimmed, "root", true)).toEqual([]);
    expect(all).toHaveLength(4);
  });
});
