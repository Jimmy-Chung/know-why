// 延迟诊断 v2：精确定位每段耗时。
import { getSecret } from "../src/server/secret.js";

const KEY_ACCOUNT = "provider:06G72BR347VW1VZFPX6W7XDAZ8"; // know (default, deepseek-v4-flash)
const MODEL = "deepseek-v4-flash";
const LLM_BASE = "https://api.deepseek.com/v1";

async function main() {
  const key = await getSecret(KEY_ACCOUNT);
  if (!key) { console.log("NO_KEY"); return; }

  const q = "你好，请用一句话介绍你自己。";

  // 1) 模拟 know-know 的 planQueries：auto 模式下先让模型决定是否需要搜索
  {
    const t0 = Date.now();
    const prompt = [
      "You are a search query planner. Based on the user's latest question, decide whether web search is needed, and generate 1-3 concise search queries IN ENGLISH.",
      "Always generate queries in English regardless of the user's language — English queries return the most authoritative and globally relevant results; the answering model will translate as needed.",
      "If the question does not need fresh or external info, you may skip searching.",
      'Return JSON only: {"search": true/false, "queries": ["...", "..."]}',
      `User's latest question: ${q}`,
    ].join("\n");
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: 60 }),
    });
    const j = await res.json();
    console.log(`[planQueries模拟] 耗时=${Date.now() - t0}ms`);
    console.log(`  回: ${(j.choices?.[0]?.message?.content || "").trim().slice(0, 60)}`);
  }

  // 2) 同一个连接（同一并发下）两次串行请求的"先后"开销模拟：
  //    planQueries → 再流式回答。测量两段之和。
  {
    // 段 A：planQueries
    const tA0 = Date.now();
    const prompt = "You are a search query planner... 'hello, introduce yourself' needs no search: {\"search\": false, \"queries\": []}";
    const rA = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: 10 }),
    });
    await rA.json();
    const segA = Date.now() - tA0;

    // 段 B：流式回答
    const tB0 = Date.now();
    const rB = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: q }], stream: true, max_tokens: 100 }),
    });
    const reader = rB.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ttf = 0, first = 0;
    let content = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = Date.now();
      if (first === 0 && value.length) first = now - tB0;
      ttf = now - tB0;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const d = l.slice(5).trim();
        if (d === "[DONE]") continue;
        try { const j = JSON.parse(d); content += j.choices?.[0]?.delta?.content || ""; } catch {}
      }
    }
    console.log(`\n[串行两段模拟]`);
    console.log(`  段A planQueries(短问题,<10 token)=${segA}ms`);
    console.log(`  段B 流式回答: 首块=${first}ms 全文=${ttf}ms 内容=${content.length}字`);
    console.log(`  两段合计≈${segA + ttf}ms`);
  }
}

await main();
process.exit(0);