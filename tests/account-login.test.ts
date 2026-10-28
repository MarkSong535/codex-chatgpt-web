import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Route } from "playwright-core";
import {
  AccountLoginError,
  loginWithAccount,
  type AccountLoginInput,
  type AccountLoginProgress,
} from "../src/account-login";
import { loginVerificationMarkerPath } from "../src/browser-login";
import { defaultChromeExecutable } from "../src/config";
import { parseTotpSecret, totpCode } from "../src/totp";

setDefaultTimeout(90_000);

const chrome = process.env.CHATGPT_LOGIN_TEST_CHROME ?? defaultChromeExecutable();
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const EMAIL = "user@example.com";
const PASSWORD = "correct horse";

interface MockOptions {
  challenge?: boolean;
  codeKind?: "authenticator" | "email";
}

function html(body: string): string {
  return `<!doctype html><html><head><title>Mock</title></head><body>${body}</body></html>`;
}

/** A local stand-in for the ChatGPT landing page and OpenAI's email → password → code flow. */
async function mockOpenAiSignIn(context: BrowserContext, options: MockOptions = {}): Promise<{ codes: string[] }> {
  // Registered first so it runs last: nothing in these tests may reach the real network.
  await context.route("**/*", route => route.abort("blockedbyclient"));
  let signedIn = false;
  const codes: string[] = [];
  const page = (route: Route, body: string, status = 200) =>
    route.fulfill({ status, contentType: "text/html", body: html(body) });
  // Fulfilled redirects bypass request interception, so navigation happens in the page instead.
  const redirect = (route: Route, location: string) =>
    page(route, `<script>location.replace(${JSON.stringify(location)})</script>`);
  const codePage = (error = "") => options.codeKind === "email"
    ? `<p>Check your inbox. We emailed you a code.</p>${error}
       <form action="/check-code"><input name="code" autocomplete="one-time-code" inputmode="numeric">
       <button type="submit">Continue</button></form>`
    : `<p>Enter the code from your authenticator app.</p>${error}
       <form action="/check-code"><input name="code" autocomplete="one-time-code" inputmode="numeric">
       <button type="submit">Continue</button></form>`;

  await context.route("https://chatgpt.com/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(signedIn ? { user: { id: "user-1" }, accessToken: "token" } : {}),
      });
    }
    if (signedIn) return page(route, '<form><div id="prompt-textarea" contenteditable="true"></div></form>');
    return page(route, `<button data-testid="login-button" onclick="location.href='https://auth.openai.com/log-in'">Log in</button>`);
  });
  await context.route("https://auth.openai.com/**", async route => {
    const url = new URL(route.request().url());
    if (options.challenge) {
      return page(route, '<iframe src="https://challenges.cloudflare.com/turnstile"></iframe>');
    }
    switch (url.pathname) {
      case "/log-in":
        return page(route, `<form action="/log-in/password"><input type="email" name="email">
          <button type="submit">Continue</button></form>`);
      case "/log-in/password":
        return page(route, `<form action="/check-password"><input type="hidden" name="email" value="${url.searchParams.get("email")}">
          <input type="password" name="password"><button type="submit">Continue</button></form>`);
      case "/check-password":
        if (url.searchParams.get("email") !== EMAIL || url.searchParams.get("password") !== PASSWORD) {
          return page(route, `<div role="alert">Wrong email or password.</div>
            <form action="/check-password"><input type="password" name="password"><button type="submit">Continue</button></form>`);
        }
        return redirect(route, "/mfa-challenge");
      case "/mfa-challenge":
        return page(route, codePage());
      case "/check-code": {
        const code = url.searchParams.get("code") ?? "";
        codes.push(code);
        const expected = options.codeKind === "email" ? "424242" : totpCode(parseTotpSecret(TOTP_SECRET));
        if (code !== expected) return page(route, codePage('<div role="alert">Incorrect code. Try again.</div>'));
        signedIn = true;
        await context.addCookies([{
          name: "__Secure-next-auth.session-token", value: "session", domain: "chatgpt.com", path: "/",
          secure: true, httpOnly: true, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600,
        }, {
          name: "tracker", value: "x", domain: "example.com", path: "/",
          secure: true, httpOnly: true, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600,
        }]);
        return redirect(route, "https://chatgpt.com/");
      }
      default:
        return page(route, "<p>Not found</p>", 404);
    }
  });
  return { codes };
}

async function signIn(input: Partial<AccountLoginInput>, options: MockOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-account-login-"));
  const storageStatePath = join(root, "browser", "storage-state.json");
  const progress: AccountLoginProgress[] = [];
  let mock: { codes: string[] } | undefined;
  const attempt = loginWithAccount({ chromeExecutablePath: chrome, storageStatePath }, {
    email: EMAIL,
    password: PASSWORD,
    progress: event => progress.push(event),
    timeoutMs: 60_000,
    ...input,
  }, {
    prepareContext: async context => { mock = await mockOpenAiSignIn(context, options); },
    // The mock has no model control, so the probe concludes Luna after its stable-absence window.
    capabilityProbeTimeoutMs: 4_000,
    // The fixture has no bot protection; headless keeps test runs from opening windows.
    headless: true,
  });
  return { root, storageStatePath, progress, attempt, codes: () => mock?.codes ?? [] };
}

const available = existsSync(chrome);

test.skipIf(!available)("signs in with a TOTP secret and stores only the verified ChatGPT session", async () => {
  const run = await signIn({ totpSecret: TOTP_SECRET });
  try {
    const result = await run.attempt;
    expect(result).toMatchObject({ solAvailable: false, proAvailable: false, accountSurfaceUrl: "https://chatgpt.com/" });
    expect([...new Set(run.progress.map(event => event.step))]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(run.progress.some(event => event.skipped)).toBeFalse();
    expect(run.progress.find(event => event.step === 5 && event.detail)?.detail).toContain("TOTP secret");
    const state = JSON.parse(readFileSync(run.storageStatePath, "utf8")) as { cookies: Array<{ name: string; domain: string }> };
    expect(state.cookies.map(cookie => cookie.name)).toEqual(["__Secure-next-auth.session-token"]);
    expect(existsSync(loginVerificationMarkerPath(run.storageStatePath))).toBeTrue();
    expect(readFileSync(run.storageStatePath, "utf8")).not.toContain(PASSWORD);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test.skipIf(!available)("asks for an email code, reports a rejected code, and accepts the retry", async () => {
  const requests: Array<{ kind: string; attempt: number }> = [];
  const run = await signIn({
    requestCode: async request => {
      requests.push(request);
      return request.attempt === 1 ? "000000" : "424242";
    },
  }, { codeKind: "email" });
  try {
    await run.attempt;
    expect(requests).toEqual([{ kind: "email", attempt: 1 }, { kind: "email", attempt: 2 }]);
    expect(run.codes()).toEqual(["000000", "424242"]);
    const details = run.progress.filter(event => event.step === 5).map(event => event.detail ?? "");
    expect(details).toContain("waiting for an email code");
    expect(details.some(detail => detail.includes("rejected the code"))).toBeTrue();
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test.skipIf(!available)("a wrong password stops with OpenAI's message and a private screenshot", async () => {
  const run = await signIn({ password: "wrong", totpSecret: TOTP_SECRET });
  try {
    const error = await run.attempt.catch(cause => cause);
    expect(error).toBeInstanceOf(AccountLoginError);
    expect(error).toMatchObject({ reason: "credentials" });
    expect((error as Error).message).toContain("Wrong email or password");
    expect(existsSync((error as AccountLoginError).screenshotPath!)).toBeTrue();
    expect(existsSync(run.storageStatePath)).toBeFalse();
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test.skipIf(!available)("a human-verification challenge is reported, never solved", async () => {
  const run = await signIn({ totpSecret: TOTP_SECRET }, { challenge: true });
  try {
    await expect(run.attempt).rejects.toMatchObject({ reason: "challenge" });
    expect(run.codes()).toEqual([]);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test.skipIf(!available)("an unattended run without a TOTP secret stops at the code page", async () => {
  const run = await signIn({}, { codeKind: "email" });
  try {
    const error = await run.attempt.catch(cause => cause);
    expect(error).toMatchObject({ reason: "verification" });
    expect((error as Error).message).toContain("asked for an email code");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("credentials are validated before Chrome starts", async () => {
  const config = { chromeExecutablePath: "/nonexistent/chrome", storageStatePath: join(tmpdir(), "unused.json") };
  await expect(loginWithAccount(config, { email: "not-an-email", password: "x" })).rejects.toThrow("email address");
  await expect(loginWithAccount(config, { email: EMAIL, password: "" })).rejects.toThrow("password is required");
  await expect(loginWithAccount(config, { email: EMAIL, password: "x", totpSecret: "!!" })).rejects.toThrow("base32");
});
