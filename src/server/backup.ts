// 备份、结构化导出与恢复。导出不含明文密钥。
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, getDataDir, getDbPath } from "./db.js";

// 运行中备份：使用 SQLite 在线备份 API（避免直接复制正在写入的文件）
export async function backup(): Promise<{ ok: boolean; file: string }> {
  const dir = join(getDataDir(), "backups");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(dir, `know-know-${ts}.sqlite`);
  const db = getDb();
  await db.backup(target);
  return { ok: true, file: target };
}

// 结构化导出（JSON，保留分支、锚点、配置版本；不含密钥）
export function exportJson(): any {
  const db = getDb();
  const tables = [
    "provider_config",
    "search_config",
    "conversation",
    "card",
    "message",
    "message_quote",
    "selection_anchor",
    "context_snapshot",
    "run",
    "source",
    "knowledge_assistant_message",
    "knowledge_topic",
    "draft",
    "view_state",
    "summary_record",
  ];
  const out: any = { version: 1, exported_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    out.tables[t] = db.prepare(`SELECT * FROM ${t}`).all().map((r: any) => {
      // 脱敏：移除密钥引用字段值（仅保留是否存在标记）
      if (t === "provider_config") return { ...r, secret_ref: r.has_secret ? "[redacted]" : "" };
      if (t === "search_config") return { ...r, secret_ref: r.has_secret ? "[redacted]" : "" };
      return r;
    });
  }
  return out;
}

// 从导出 JSON 恢复（写入干净测试库或当前库）
export function restore(data: any): { ok: boolean; counts: Record<string, number> } {
  const db = getDb();
  const counts: Record<string, number> = {};
  db.exec("BEGIN");
  try {
    for (const [t, rows] of Object.entries(data.tables || {})) {
      if (!Array.isArray(rows as any)) continue;
      // 清空目标表（按依赖反序）
      db.prepare(`DELETE FROM ${t}`).run();
      for (const row of rows as any[]) {
        const cols = Object.keys(row);
        const placeholders = cols.map(() => "?").join(",");
        db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(",")}) VALUES (${placeholders})`).run(...cols.map((c) => row[c]));
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    db.exec("COMMIT");
    return { ok: true, counts };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
