import { describe, expect, it } from "vitest";
import {
  documentedReasoning,
  parseEffortMetadata,
  parseModelLimits,
  parseReasoningMetadata,
  resolveModelAlias,
  resolveSearchCapability,
} from "../src/server/model-capabilities.js";

describe("模型别名", () => {
  it("退役名称映射到接口中的当前 ID", () => {
    expect(resolveModelAlias("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(resolveModelAlias("deepseek-v4-flash-vision-exp")).toBe("deepseek-flash");
  });

  it("未知名称原样返回", () => {
    expect(resolveModelAlias("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(resolveModelAlias("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
  });
});

describe("DeepSeek effort 元数据", () => {
  it("解析 supported_levels / default_level（接口真实返回结构）", () => {
    const cap = parseEffortMetadata({
      id: "deepseek-flash",
      effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
    });
    expect(cap).not.toBeNull();
    expect(cap!.status).toBe("supported");
    expect(cap!.efforts).toEqual(["low", "high", "max"]);
    expect(cap!.defaultEffort).toBe("high");
    // DeepSeek 通过 thinking.type=disabled 关闭思考
    expect(cap!.canDisable).toBe(true);
    expect(cap!.mandatory).toBe(false);
    expect(cap!.source).toBe("api");
  });

  it("没有 effort 字段时返回 null，交给规则回退", () => {
    expect(parseEffortMetadata({ id: "x" })).toBeNull();
    expect(parseEffortMetadata({ effort: { supported_levels: [] } })).toBeNull();
    expect(parseEffortMetadata(null)).toBeNull();
  });

  it("规则回退覆盖 deepseek-v4 系列", () => {
    const cap = documentedReasoning("deepseek", "deepseek-v4-flash");
    expect(cap.status).toBe("supported");
    expect(cap.efforts).toEqual(["low", "high", "max"]);
    expect(cap.canDisable).toBe(true);
  });

  it("OpenRouter 风格的 reasoning.supported_efforts 仍然优先", () => {
    const cap = parseReasoningMetadata({ reasoning: { supported_efforts: ["low", "medium", "high"], default_effort: "medium" } });
    expect(cap?.efforts).toEqual(["low", "medium", "high"]);
    expect(cap?.defaultEffort).toBe("medium");
  });
});

describe("模型限制解析", () => {
  it("DeepSeek：context_window / max_output_tokens / 多模态", () => {
    expect(
      parseModelLimits({
        id: "deepseek-flash",
        context_window: 1048576,
        max_output_tokens: 393216,
        input_modalities: ["text", "image"],
      }),
    ).toEqual({ contextWindow: 1048576, maxOutputTokens: 393216, inputModalities: ["text", "image"] });
  });

  it("OpenRouter：context_length，没有输出上限", () => {
    expect(parseModelLimits({ context_length: 1048576 })).toEqual({
      contextWindow: 1048576,
      maxOutputTokens: undefined,
      inputModalities: undefined,
    });
  });

  it("非法值一律丢弃", () => {
    expect(parseModelLimits({ context_window: -1, max_output_tokens: "abc" })).toEqual({
      contextWindow: undefined,
      maxOutputTokens: undefined,
      inputModalities: undefined,
    });
    expect(parseModelLimits(null)).toEqual({});
  });
});

describe("原生联网能力判定", () => {
  it("OpenAI：支持原生搜索且可强制", () => {
    expect(resolveSearchCapability("openai")).toEqual({ webSearch: true, forceSearch: true });
  });

  it("DeepSeek：支持原生搜索，但接口无法强制", () => {
    expect(resolveSearchCapability("deepseek")).toEqual({ webSearch: true, forceSearch: false });
  });

  it("OpenRouter / 自定义：不支持原生搜索", () => {
    expect(resolveSearchCapability("openrouter")).toEqual({ webSearch: false, forceSearch: false });
    expect(resolveSearchCapability("custom")).toEqual({ webSearch: false, forceSearch: false });
  });
});
