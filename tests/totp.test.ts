import { expect, test } from "bun:test";
import { parseTotpSecret, totpCode, totpMsUntilNextPeriod } from "../src/totp";

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" for SHA-1.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("RFC 6238 SHA-1 test vectors", () => {
  const parameters = parseTotpSecret(`otpauth://totp/test?secret=${RFC_SECRET}&digits=8`);
  for (const [seconds, code] of [
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
  ] as const) {
    expect(totpCode(parameters, seconds * 1000)).toBe(code);
  }
});

test("plain base32 setup keys tolerate spacing, case, and padding", () => {
  const spaced = parseTotpSecret("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==");
  expect(spaced).toMatchObject({ digits: 6, periodSeconds: 30, algorithm: "sha1" });
  expect(totpCode(spaced, 59_000)).toBe("287082");
});

test("otpauth parameters are honored and invalid secrets are rejected", () => {
  const sha256 = parseTotpSecret(`otpauth://totp/a?secret=${RFC_SECRET}&algorithm=SHA256&period=60`);
  expect(sha256).toMatchObject({ algorithm: "sha256", periodSeconds: 60, digits: 6 });
  expect(totpMsUntilNextPeriod(sha256, 61_000)).toBe(59_000);
  expect(() => parseTotpSecret("not base32!")).toThrow("must be base32");
  expect(() => parseTotpSecret("otpauth://hotp/a?secret=ABCD")).toThrow("Only otpauth://totp");
  expect(() => parseTotpSecret("otpauth://totp/a")).toThrow("no secret");
  expect(() => parseTotpSecret(`otpauth://totp/a?secret=${RFC_SECRET}&digits=4`)).toThrow("digits");
});
