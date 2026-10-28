import { createHmac } from "node:crypto";

export interface TotpParameters {
  secret: Buffer;
  digits: number;
  periodSeconds: number;
  algorithm: "sha1" | "sha256" | "sha512";
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(value: string): Buffer {
  const normalized = value.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error("The TOTP secret must be base32 (letters A-Z and digits 2-7) or an otpauth:// URI");
  }
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Accepts the base32 key shown under "can't scan the QR code", or the full otpauth:// URI. */
export function parseTotpSecret(value: string): TotpParameters {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("otpauth://")) {
    return { secret: decodeBase32(trimmed), digits: 6, periodSeconds: 30, algorithm: "sha1" };
  }
  const uri = new URL(trimmed);
  if (uri.host.toLowerCase() !== "totp") throw new Error("Only otpauth://totp URIs are supported");
  const secret = uri.searchParams.get("secret");
  if (!secret) throw new Error("The otpauth URI has no secret parameter");
  const digits = Number(uri.searchParams.get("digits") ?? 6);
  const periodSeconds = Number(uri.searchParams.get("period") ?? 30);
  const algorithm = (uri.searchParams.get("algorithm") ?? "SHA1").toLowerCase().replace("-", "");
  if (![6, 7, 8].includes(digits)) throw new Error("The otpauth URI digits must be 6, 7 or 8");
  if (!Number.isInteger(periodSeconds) || periodSeconds < 1) throw new Error("The otpauth URI period is invalid");
  if (algorithm !== "sha1" && algorithm !== "sha256" && algorithm !== "sha512") {
    throw new Error("The otpauth URI algorithm must be SHA1, SHA256 or SHA512");
  }
  return { secret: decodeBase32(secret), digits, periodSeconds, algorithm };
}

/** RFC 6238 time-based one-time password. */
export function totpCode(parameters: TotpParameters, nowMs = Date.now()): string {
  const counter = Math.floor(nowMs / 1000 / parameters.periodSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(parameters.algorithm, parameters.secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** parameters.digits;
  return binary.toString().padStart(parameters.digits, "0");
}

/** Milliseconds until the current code expires, so a retry never resubmits the same code. */
export function totpMsUntilNextPeriod(parameters: TotpParameters, nowMs = Date.now()): number {
  const periodMs = parameters.periodSeconds * 1000;
  return periodMs - (nowMs % periodMs);
}
