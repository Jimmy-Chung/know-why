import Database from "better-sqlite3";
import type { Database as DBType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

let dataDir: string;
let dbPath: string;

export function resolveDataDir(): string {
  if (process.env.KNOW_KNOW_DATA_DIR) {
    dataDir = process.env.KNOW_KNOW_DATA_DIR;
  } else {
    dataDir = join(homedir(), "Library", "Application Support", "KnowKnow");
  }
  return dataDir;
}

export function getDataDir(): string {
  return dataDir ?? resolveDataDir();
}

export function getDbPath(): string {
  if (dbPath) return dbPath;
  resolveDataDir();
  dbPath = join(dataDir, "know-know.sqlite");
  return dbPath;
}

let instance: DBType | null = null;

export function getDb(): DBType {
  if (instance) return instance;
  resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  mkdirSync(join(dataDir, "exports"), { recursive: true });
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  mkdirSync(join(dataDir, "attachments"), { recursive: true });
  const db = new Database(getDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  instance = db;
  return db;
}

// 测试用：传入自定义路径
export function getDbForPath(path: string): DBType {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
