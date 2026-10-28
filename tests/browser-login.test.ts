import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  importBrowserLogin,
  loginVerificationMarkerPath,
  sanitizeBrowserLoginStorageState,
} from "../src/browser-login";
import { defaultConfig } from "../src/config";

test("saved login state excludes identity-provider and partitioned state", () => {
  const cookie = (name: string, domain: string, extra = {}) => ({
    name,
    value: name,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    ...extra,
  });
  const state = sanitizeBrowserLoginStorageState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("google", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "removed" }] },
    ],
  });
  expect(state.cookies.map(value => value.name)).toEqual(["chatgpt", "openai"]);
  expect(state.origins).toEqual([
    { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
  ]);
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("login import rejects files that are not ChatGPT storage state", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-import-login-"));
  try {
    const executable = join(root, "fake-chrome");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const malformed = join(root, "malformed.json");
    writeFileSync(malformed, JSON.stringify({ cookies: "nope" }));
    await expect(importBrowserLogin(config, malformed)).rejects.toThrow("not a Playwright storage-state file");
    const foreign = join(root, "foreign.json");
    writeFileSync(foreign, JSON.stringify({
      cookies: [{ name: "sid", value: "x", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
      origins: [],
    }));
    await expect(importBrowserLogin(config, foreign)).rejects.toThrow("contains no ChatGPT/OpenAI cookies");
    expect(existsSync(config.storageStatePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
