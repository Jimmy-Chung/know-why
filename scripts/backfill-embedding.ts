// 一次性脚本：给指定会话补建 embedding 索引（存量消息改造前未跑过 embedding）。
// 用法：node scripts/backfill-embedding.mjs <conversationId>
import { indexEmbeddings } from "../src/server/knowledge.js";

const convId = process.argv[2];
if (!convId) {
  console.error("用法: node scripts/backfill-embedding.mjs <conversationId>");
  process.exit(1);
}
console.log("补建 embedding:", convId);
console.log("（首次会下载模型 ~120MB 到应用数据目录/models，请等待）…");
try {
  await indexEmbeddings(convId);
  const { getDb } = await import("../src/server/db.js");
  const n = getDb().prepare("SELECT COUNT(*) n FROM knowledge_embedding WHERE conversation_id=?").get(convId);
  console.log("完成。embedding 行数:", n);
} catch (e) {
  console.error("失败:", e);
  process.exit(1);
}
