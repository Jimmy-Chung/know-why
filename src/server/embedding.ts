// 本地 embedding：transformers.js + multilingual-e5-small。
// 惰性加载（动态 import），不拖慢服务启动；权重缓存到应用数据目录。
// 失败由调用方 catch 降级（退回纯 FTS 检索）。
import { join } from "node:path";
import { getDataDir } from "./db.js";

// 模型常量：multilingual-e5-small，384 维，中英多语，适合检索。
// e5 系列要求文档加 "passage: " 前缀、查询加 "query: " 前缀。
export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_DIM = 384;

// transformers.js 模块类型（惰性加载）
type Extractor = (texts: string | string[], opts: { pooling: "mean"; normalize: true }) => Promise<{
  data: Float32Array;
  dims: number[];
  tolist: () => number[][];
}>;

let pipelinePromise: Promise<Extractor> | null = null;
let ready = false;
let retryAfter = 0;
let inferenceQueue: Promise<unknown> = Promise.resolve();
const queryCache = new Map<string, Float32Array>();
function infer<T>(work: () => Promise<T>): Promise<T> {
  const next = inferenceQueue.then(work, work);
  inferenceQueue = next.catch(() => {});
  return next;
}

async function getPipeline(): Promise<Extractor> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const mod = await import("@huggingface/transformers");
    const env = (mod as any).env;
    // 权重缓存到应用数据目录，随应用数据走，可随备份导出
    env.cacheDir = join(getDataDir(), "models");
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    const pipeline = (mod as any).pipeline;
    const extractor = (await pipeline("feature-extraction", EMBEDDING_MODEL)) as Extractor;
    ready = true;
    return extractor;
  })();
  // 失败则清空，允许下次重试
  pipelinePromise.catch(() => {
    pipelinePromise = null;
    ready = false;
    retryAfter = Date.now() + 60_000;
  });
  return pipelinePromise;
}

// Never make a keyword query wait for a cold model download. Warm up in the background.
export function warmEmbeddings(): void {
  if (process.env.KNOW_KNOW_EMBEDDINGS === "off") return;
  if (Date.now() >= retryAfter) void getPipeline().catch(() => {});
}
export async function embeddingAvailable(): Promise<boolean> {
  if (process.env.KNOW_KNOW_EMBEDDINGS === "off") return false;
  warmEmbeddings();
  return ready;
}

// 批量 embedding（文档侧）：每条文本前加 "passage: "，mean pooling + L2 归一化
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  if (process.env.KNOW_KNOW_EMBEDDINGS === "off") throw new Error("语义索引已禁用");
  if (!ready && Date.now() < retryAfter) throw new Error("语义模型稍后重试");
  const extractor = await getPipeline();
  const prefixed = texts.map((t) => `passage: ${t}`);
  const out = await infer(() => extractor(prefixed, { pooling: "mean", normalize: true }));
  const list = out.tolist();
  return list.map((row) => new Float32Array(row));
}

// 查询 embedding：加 "query: " 前缀，归一化
export async function embedQuery(text: string): Promise<Float32Array> {
  const key = `${EMBEDDING_MODEL}:${text}`;
  const cached = queryCache.get(key);
  if (cached) return new Float32Array(cached);
  const extractor = await getPipeline();
  const out = await infer(() => extractor(`query: ${text}`, { pooling: "mean", normalize: true }));
  const result = new Float32Array(out.tolist()[0]!);
  queryCache.set(key,result);
  while (queryCache.size > 128) queryCache.delete(queryCache.keys().next().value!);
  return new Float32Array(result);
}

// —— BLOB ↔ Float32Array 工具 ——

// 归一化向量存为 BLOB（拷贝以保证独立底层 buffer、字节偏移为 0）
export function toBlob(vec: Float32Array): Buffer {
  const copy = new Float32Array(vec.length);
  copy.set(vec);
  return Buffer.from(copy.buffer);
}

// 从 BLOB 还原为指定维度的 Float32Array
export function fromBlob(buf: Buffer, dim: number): Float32Array {
  const copy = Uint8Array.from(buf);
  const view = new Float32Array(copy.buffer, 0, copy.byteLength / 4);
  const out = new Float32Array(dim);
  out.set(view.subarray(0, dim));
  return out;
}

// 点积（向量已归一化时即 cosine 相似度）
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
