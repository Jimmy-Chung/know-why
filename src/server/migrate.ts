import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DBType } from "better-sqlite3";
import { getDb } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations(db: DBType = getDb()): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const migrationsDir = join(__dirname, "..", "..", "migrations");
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    // 迁移目录缺失是部署错误（常见于只拷贝了编译产物）。静默返回 0 会让服务
    // 带着空库启动、在后续查询处崩溃，错误信息完全指不到根因。
    throw new Error(
      `找不到数据库迁移目录：${migrationsDir}。请把 migrations/ 一并放到运行时目录（官方镜像已包含）。`,
    );
  }
  if (files.length === 0) {
    throw new Error(`数据库迁移目录为空：${migrationsDir}`);
  }

  const applied = new Set(
    db.prepare("SELECT version FROM schema_version").all().map((r: any) => r.version),
  );

  let count = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match) continue;
    const version = parseInt(match[1]!, 10);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    // 每个 migration 在自身事务中执行
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      count++;
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(e as Error).message}`);
    }
  }
  return count;
}

// 作为脚本直接运行
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void process.argv[1];
  const n = runMigrations();
  console.log(`applied ${n} migration(s)`);
  process.exit(0);
}
