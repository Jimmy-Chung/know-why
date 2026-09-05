// 密钥管理：macOS Keychain（keytar）为主，加密文件回退。
// Key 只在本地服务使用，接口返回时仅返回掩码与是否已配置。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { getDataDir } from "./db.js";

let keytar: typeof import("keytar") | null = null;
let keytarAvailable: boolean | null = null;

const SERVICE = "KnowKnow";
const FALLBACK_FILE = "secrets.enc";
// 固定盐派生密钥（单机本地保护，防止明文落盘；非高强度加密，但满足"不存明文"）
const SALT = Buffer.from("know-know-local-secret-salt-v1");

function getKey(): Buffer {
  // 机器级口令：组合用户名 + 数据目录路径，保证不同环境不同
  const user = process.env.USER || "default";
  const pass = `${user}:${getDataDir()}:know-know`;
  return scryptSync(pass, SALT, 32);
}

function fallbackPath(): string {
  return join(getDataDir(), FALLBACK_FILE);
}

function readFallback(): Record<string, string> {
  const p = fallbackPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p);
    const key = getKey();
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    const tag = raw.subarray(12, 28);
    decipher.setAuthTag(tag);
    const enc = raw.subarray(28);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString("utf-8"));
  } catch {
    return {};
  }
}

function writeFallback(map: Record<string, string>): void {
  mkdirSync(getDataDir(), { recursive: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.from(JSON.stringify(map), "utf-8");
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(fallbackPath(), Buffer.concat([iv, tag, enc]), { mode: 0o600 });
}

async function loadKeytar(): Promise<typeof import("keytar") | null> {
  if (keytarAvailable !== null) return keytar ? keytar : null;
  try {
    const mod: any = await import("keytar");
    // 兼容 ESM/CJS 互操作：函数可能在 default 或具名导出
    const k = mod.setPassword ? mod : mod.default ? mod.default : null;
    // 必须三个函数都可用；否则视为不可用（回退到加密文件）
    if (k && typeof k.setPassword === "function" && typeof k.getPassword === "function" && typeof k.deletePassword === "function") {
      keytar = k;
      keytarAvailable = true;
      return k;
    }
    keytarAvailable = false;
    return null;
  } catch {
    keytarAvailable = false;
    return null;
  }
}

export async function setSecret(account: string, value: string): Promise<void> {
  const k = await loadKeytar();
  if (k) {
    await k.setPassword(SERVICE, account, value);
  } else {
    const map = readFallback();
    map[account] = value;
    writeFallback(map);
  }
}

export async function getSecret(account: string): Promise<string | null> {
  const k = await loadKeytar();
  if (k) {
    const cred = await k.getPassword(SERVICE, account);
    return cred ?? null;
  }
  const map = readFallback();
  return map[account] ?? null;
}

export async function deleteSecret(account: string): Promise<void> {
  const k = await loadKeytar();
  if (k) {
    await k.deletePassword(SERVICE, account);
  } else {
    const map = readFallback();
    delete map[account];
    writeFallback(map);
  }
}

export function maskSecret(value: string | null): { has: boolean; mask: string } {
  if (!value) return { has: false, mask: "" };
  const v = value;
  if (v.length <= 6) return { has: true, mask: "•".repeat(v.length) };
  return { has: true, mask: v.slice(0, 3) + "•".repeat(Math.min(8, v.length - 6)) + v.slice(-3) };
}
