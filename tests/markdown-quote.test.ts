import { expect, it } from "vitest";
import { renderMarkdown } from "../src/client/markdown.js";

function strong(s: string): boolean {
  return renderMarkdown(s).includes("<strong>");
}

it("bold after CJK closing paren followed by text", () => {
  expect(strong('**"Treasury Twist"（财政部版扭曲操作）**')).toBe(true);
  expect(strong("**重点（内容）**说明")).toBe(true);
  expect(strong("**又说：**那")).toBe(true);
});

it("bold closing after quote followed by text", () => {
  expect(strong('**"保底"**好')).toBe(true);
  expect(strong('查看**"保底"实际回报**。')).toBe(true);
});

it("bold when paren closes at line end / whitespace / punct unchanged", () => {
  expect(strong("**（重点）**")).toBe(true);
  expect(strong("**（重点）** 说明")).toBe(true);
  expect(strong("**（重点）**，说明")).toBe(true);
});

it("bold inside parens and followed by text", () => {
  expect(strong("（**重点**）接着")).toBe(true);
  expect(strong("**（重点）**说明")).toBe(true);
});

it("regression: plain bold and triple asterisk still work", () => {
  expect(strong("**这段**。结束")).toBe(true);
  expect(strong("***x***")).toBe(true);
  expect(strong('***"x"***')).toBe(true);
});

it("does not insert stray ZWSP in plain text", () => {
  const out = renderMarkdown("普通文本**加粗**。");
  expect(out).not.toContain("​");
});