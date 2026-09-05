// 稳定 ID 生成：时间排序的 ULID 风格，便于按创建顺序排列且全局唯一。
// 48 位毫秒时间戳 + 80 位随机，Crockford base32 编码，26 字符定长。

const ENCODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  const ts = Date.now();
  const time = new Uint8Array(6);
  let t = ts;
  for (let i = 5; i >= 0; i--) {
    time[i] = t & 0xff;
    t = Math.floor(t / 256);
  }
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const bytes = new Uint8Array(16);
  bytes.set(time, 0);
  bytes.set(rand, 6);
  return encode(bytes);
}

function encode(bytes: Uint8Array): string {
  let out = "";
  // 16 bytes -> 26 base32 chars (130 bits, pad with 0 bits)
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ENCODE[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ENCODE[(value << (5 - bits)) & 0x1f];
  }
  return out.slice(0, 26);
}
