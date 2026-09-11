import { describe, expect, it } from "vitest";
import { parseToSpecs, specsToMarkdown, prefixOf, nextPrefixOf, hasOnlyMarker } from "../src/client/wysiwyg-core.js";

describe("wysiwyg parseToSpecs", () => {
  it("splits headings / list items / quotes into single-line blocks", () => {
    const specs = parseToSpecs("# 标题\n- 甲\n- 乙\n> 引文\n普通段落");
    expect(specs).toEqual([
      { kind: "p", lang: "", text: "# 标题" },
      { kind: "p", lang: "", text: "- 甲" },
      { kind: "p", lang: "", text: "- 乙" },
      { kind: "p", lang: "", text: "> 引文" },
      { kind: "p", lang: "", text: "普通段落" },
    ]);
  });

  it("groups consecutive plain lines into one multiline paragraph", () => {
    const specs = parseToSpecs("第一行\n第二行");
    expect(specs).toEqual([{ kind: "p", lang: "", text: "第一行\n第二行" }]);
  });

  it("blank lines separate paragraphs", () => {
    const specs = parseToSpecs("甲\n\n乙");
    expect(specs.map((s) => s.text)).toEqual(["甲", "乙"]);
  });

  it("parses fenced code blocks with lang and multiline body", () => {
    const specs = parseToSpecs("```ts\nconst a = 1;\nconst b = 2;\n```\n正文");
    expect(specs).toEqual([
      { kind: "code", lang: "ts", text: "const a = 1;\nconst b = 2;" },
      { kind: "p", lang: "", text: "正文" },
    ]);
  });

  it("parses bare fences without lang", () => {
    const specs = parseToSpecs("```\nx\n```");
    expect(specs[0]).toEqual({ kind: "code", lang: "", text: "x" });
  });

  it("parses thematic breaks as hr blocks", () => {
    const specs = parseToSpecs("前文\n---\n前文2\n***");
    expect(specs).toEqual([
      { kind: "p", lang: "", text: "前文" },
      { kind: "hr", lang: "", text: "---" },
      { kind: "p", lang: "", text: "前文2" },
      { kind: "hr", lang: "", text: "***" },
    ]);
  });

  it("empty markdown yields no blocks", () => {
    expect(parseToSpecs("")).toEqual([]);
    expect(parseToSpecs("\n\n")).toEqual([]);
  });
});

describe("wysiwyg round-trip", () => {
  it("canonical doc survives parse → serialize", () => {
    const md = "# 标题\n\n- 甲\n- 乙\n\n> 引文\n\n---\n\n```ts\nconst a = 1;\n```\n\n正文";
    expect(specsToMarkdown(parseToSpecs(md))).toBe(md);
  });

  it("keeps soft-wrapped paragraph newlines and separates block kinds with blanks", () => {
    // 同段内软换行原样保留（不拆词行长句）
    expect(specsToMarkdown(parseToSpecs("标题\n正文"))).toBe("标题\n正文");
    // 不同结构块之间补空行分隔
    expect(specsToMarkdown(parseToSpecs("# 标题\n- 甲"))).toBe("# 标题\n\n- 甲");
  });

  it("empty in → empty out", () => {
    expect(specsToMarkdown(parseToSpecs(""))).toBe("");
  });
});

describe("wysiwyg structural markers", () => {
  it("prefixOf detects block-start prefixes", () => {
    expect(prefixOf("## 标题")).toBe("## ");
    expect(prefixOf("# 标题")).toBe("# ");
    expect(prefixOf("- 甲")).toBe("- ");
    expect(prefixOf("* 甲")).toBe("* ");
    expect(prefixOf("1. 甲")).toBe("1. ");
    expect(prefixOf("10) 甲")).toBe("10) ");
    expect(prefixOf("> 引")).toBe("> ");
    expect(prefixOf("普通段落")).toBeNull();
    expect(prefixOf("含有 # 的段落")).toBeNull();
  });

  it("nextPrefixOf inherits marker and increments ordered lists", () => {
    expect(nextPrefixOf("- 甲")).toBe("- ");
    expect(nextPrefixOf("> 引")).toBe("> ");
    expect(nextPrefixOf("1. 甲")).toBe("2. ");
    expect(nextPrefixOf("10) 甲")).toBe("11) ");
  });

  it("hasOnlyMarker recognizes empty structural blocks", () => {
    expect(hasOnlyMarker("- ")).toBe(true);
    expect(hasOnlyMarker("## ")).toBe(true);
    expect(hasOnlyMarker("> ")).toBe(true);
    expect(hasOnlyMarker("")).toBe(true);
    expect(hasOnlyMarker("- 甲")).toBe(false);
    expect(hasOnlyMarker("## 标题")).toBe(false);
  });
});