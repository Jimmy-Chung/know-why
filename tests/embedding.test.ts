import { describe, it, expect } from "vitest";
import { toBlob, fromBlob, dot } from "../src/server/embedding.js";

describe("embedding BLOB 序列化", () => {
  it("往返保持向量值", () => {
    const v = new Float32Array([0.1, 0.2, 0.3, -0.4]);
    const blob = toBlob(v);
    const back = fromBlob(blob, v.length);
    expect(Array.from(back)).toEqual(Array.from(v));
  });

  it("拷贝独立，不污染原向量", () => {
    const v = new Float32Array([1, 2, 3]);
    const blob = toBlob(v);
    v[0] = 999;
    const back = fromBlob(blob, 3);
    expect(back[0]).toBe(1);
  });
});

describe("dot 点积", () => {
  it("相同方向归一化向量点积为 1", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0]);
    expect(dot(a, b)).toBeCloseTo(1, 5);
  });

  it("正交向量点积为 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(dot(a, b)).toBeCloseTo(0, 5);
  });
});
