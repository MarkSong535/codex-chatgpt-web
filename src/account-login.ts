import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { AppConfig } from "./config";
import { assertChromeExecutable, atomicWriteFile } from "./config";
import { chromeLaunchOptions } from "./chrome-launch";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_NEW_CHAT_URL,
  assertNewChatPage,
  chatGptSessionAuthenticated,
  detectChatGptAccountCapabilities,
} from "./chatgpt-session";
import {
  sanitizeBrowserLoginStorageState,
  writeVerificationMarker,
  type BrowserLoginResult,
} from "./browser-login";
import { parseTotpSecret, totpCode, totpMsUntilNextPeriod, type TotpParameters } from "./totp";

export const ACCOUNT_LOGIN_STEPS = [
  "Launch Chrome",
  "Open the ChatGPT sign-in page",
  "Enter the account email",
  "Enter the password",
  "Two-factor verification",
  "Confirm the signed-in session",
  "Save the session",
] as const;

export interface AccountLoginProgress {
  step: number;
  total: number;
  title: string;
  detail?: string;
  skipped?: boolean;
}

export type VerificationCodeKind = "authenticator" | "email" | "sms" | "unknown";

export interface VerificationCodeRequest {
  kind: VerificationCodeKind;
  /** 1 for the first code; higher after OpenAI rejected a code. */
  attempt: number;
}

export interface AccountLoginInput {
  email: string;
  password: string;
  /** Base32 authenticator key or otpauth:// URI; generates authenticator codes without a prompt. */
  totpSecret?: string;
  /** Asks a person for a code. Absent in unattended runs, where only TOTP codes are possible. */
  requestCode?: (request: VerificationCodeRequest) => Promise<string>;
  progress?: (event: AccountLoginProgress) => void;
  /** Budget for the browser flow, excluding time spent waiting for a typed code. */
  timeoutMs?: number;
}

export type AccountLoginFailure = "credentials" | "challenge" | "verification" | "unexpected-page" | "timeout";

export class AccountLoginError extends Error {
  constructor(
    message: string,
    readonly reason: AccountLoginFailure,
    readonly screenshotPath?: string,
  ) {
    super(message);
    this.name = "AccountLoginError";
  }
}

const CHATGPT_LOGIN_URL = "https://chatgpt.com/auth/login";
const CHATGPT_ORIGIN = new URL(CHATGPT_NEW_CHAT_URL).origin;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const TRANSITION_TIMEOUT_MS = 20_000;
const UNKNOWN_PAGE_TIMEOUT_MS = 30_000;
const MAX_CODE_ATTEMPTS = 3;
const STALE_ERROR_GRACE_MS = 4_000;
const POLL_MS = 500;

const LOGIN_BUTTON_SELECTOR = '[data-testid="login-button"], [data-testid="welcome-login-button"]';
const EMAIL_INPUT_SELECTOR = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
].join(", ");
const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';
const CODE_INPUT_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name="code"]',
  'input[name="otp"]',
  'input[inputmode="numeric"]',
].join(", ");
const CHALLENGE_SELECTOR = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="arkoselabs"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="recaptcha"]',
  "#challenge-form",
  "#cf-challenge-running",
].join(", ");
const ERROR_TEXT_SELECTOR = '[role="alert"], [aria-live="assertive"], [id*="error" i], [class*="error" i]';

type LoginPageState =
  | { kind: "authenticated" }
  | { kind: "challenge" }
  | { kind: "landing"; button: Locator }
  | { kind: "email"; input: Locator }
  | { kind: "password"; input: Locator }
  | { kind: "code"; input: Locator; codeKind: VerificationCodeKind }
  | { kind: "unknown" };

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

function verificationCodeKind(pageText: string): VerificationCodeKind {
  const text = pageText.toLowerCase();
  if (/authenticator|authentication app|one-time password app|totp/.test(text)) return "authenticator";
  if (/text message|\bsms\b|phone number/.test(text)) return "sms";
  if (/e-?mail|inbox/.test(text)) return "email";
  return "unknown";
}

async function detectLoginState(page: Page): Promise<LoginPageState> {
  if (await firstVisible(page.locator(CHALLENGE_SELECTOR))) return { kind: "challenge" };
  const title = await page.title().catch(() => "");
  if (/just a moment|attention required/i.test(title)) return { kind: "challenge" };
  const origin = new URL(page.url()).origin;
  if (origin === CHATGPT_ORIGIN) {
    const loginButton = await firstVisible(page.locator(LOGIN_BUTTON_SELECTOR))
      ?? await firstVisible(page.getByRole("button", { name: /^log in$/i }));
    if (loginButton) return { kind: "landing", button: loginButton };
    if (await firstVisible(page.locator(CHATGPT_COMPOSER_SELECTOR))) {
      const session = await chatGptSessionAuthenticated(page);
      if (session !== false) return { kind: "authenticated" };
    }
  }
  const code = await firstVisible(page.locator(CODE_INPUT_SELECTOR));
  if (code) {
    const text = await page.locator("body").innerText().catch(() => "");
    return { kind: "code", input: code, codeKind: verificationCodeKind(text) };
  }
  const password = await firstVisible(page.locator(PASSWORD_INPUT_SELECTOR));
  if (password) return { kind: "password", input: password };
  const email = await firstVisible(page.locator(EMAIL_INPUT_SELECTOR));
  if (email) return { kind: "email", input: email };
  return { kind: "unknown" };
}

async function visibleErrorText(page: Page): Promise<string | undefined> {
  const errors = page.locator(ERROR_TEXT_SELECTOR);
  const count = await errors.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = errors.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    const text = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 240);
  }
  return undefined;
}

async function submitField(input: Locator): Promise<void> {
  const button = await firstVisible(input.locator("xpath=ancestor::form[1]").locator('button[type="submit"]'));
  if (button && await button.isEnabled().catch(() => false)) await button.click();
  else await input.press("Enter");
}

/**
 * Waits for the page to leave `from`, or for OpenAI to show an error on the same page. An error
 * that was already visible before the submission counts only once it outlives a short grace period.
 */
async function waitForTransition(
  page: Page,
  from: LoginPageState["kind"],
  staleError: string | undefined,
  timeoutMs = TRANSITION_TIMEOUT_MS,
): Promise<{ changed: true } | { changed: false; error?: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(POLL_MS);
    if ((await detectLoginState(page)).kind !== from) return { changed: true };
    const error = await visibleErrorText(page);
    if (error && (error !== staleError || Date.now() - startedAt > STALE_ERROR_GRACE_MS)) return { changed: false, error };
  }
  return { changed: false };
}

async function fillCode(input: Locator, page: Page, code: string): Promise<void> {
  // Some verification pages split the code into one box per digit.
  const boxes = page.locator(CODE_INPUT_SELECTOR);
  if (await boxes.count() > 1 && await input.getAttribute("maxlength") === "1") {
    await input.click();
    await page.keyboard.type(code, { delay: 40 });
    return;
  }
  await input.fill(code);
}

function codeLabel(kind: VerificationCodeKind): string {
  switch (kind) {
    case "authenticator": return "authenticator app";
    case "email": return "email";
    case "sms": return "text message";
    default: return "verification";
  }
}

/**
 * Signs in to ChatGPT with an email and password in Chrome, completing two-factor
 * verification with a TOTP secret or a code typed by the user, and stores the verified session.
 * Human-verification challenges are never solved automatically; they end the attempt.
 */
export async function loginWithAccount(
  config: Pick<AppConfig, "chromeExecutablePath" | "chromeGpu" | "storageStatePath">,
  input: AccountLoginInput,
  dependencies: {
    prepareContext?: (context: BrowserContext) => Promise<void>;
    /** How long the post-sign-in model probe waits for ChatGPT's model control. */
    capabilityProbeTimeoutMs?: number;
    /** Local fixtures only: ChatGPT itself rejects headless Chrome. */
    headless?: boolean;
  } = {},
): Promise<BrowserLoginResult> {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("A ChatGPT account email address is required");
  if (!input.password) throw new Error("A ChatGPT account password is required");
  const totp: TotpParameters | undefined = input.totpSecret ? parseTotpSecret(input.totpSecret) : undefined;
  assertChromeExecutable(config.chromeExecutablePath);

  const total = ACCOUNT_LOGIN_STEPS.length;
  let reported = 0;
  const reach = (step: number, detail?: string) => {
    for (let skipped = reported + 1; skipped < step; skipped += 1) {
      input.progress?.({ step: skipped, total, title: ACCOUNT_LOGIN_STEPS[skipped - 1]!, detail: "not requested", skipped: true });
    }
    if (step > reported) {
      input.progress?.({ step, total, title: ACCOUNT_LOGIN_STEPS[step - 1]!, ...(detail ? { detail } : {}) });
      reported = step;
    } else if (detail) {
      input.progress?.({ step, total, title: ACCOUNT_LOGIN_STEPS[step - 1]!, detail });
    }
  };
  let deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const screenshotPath = join(dirname(config.storageStatePath), "login-failure.png");
  const fail = async (page: Page, reason: AccountLoginFailure, message: string): Promise<never> => {
    let saved: string | undefined;
    try {
      mkdirSync(dirname(screenshotPath), { recursive: true, mode: 0o700 });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      try { chmodSync(screenshotPath, 0o600); } catch {}
      saved = screenshotPath;
    } catch {
      // The original failure is more useful than a screenshot error.
    }
    throw new AccountLoginError(saved ? `${message} A screenshot of the page is at ${saved}.` : message, reason, saved);
  };

  reach(1);
  const browser = await chromium.launch(dependencies.headless
    ? { executablePath: config.chromeExecutablePath, headless: true }
    : await chromeLaunchOptions(config.chromeExecutablePath, config.chromeGpu, ["--no-first-run", "--no-default-browser-check"]));
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await dependencies.prepareContext?.(context);
    const page = await context.newPage();
    reach(2);
    await page.goto(CHATGPT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    let codeAttempt = 0;
    let lastTotpCounter: number | undefined;
    let unknownSince: number | undefined;
    for (;;) {
      if (Date.now() > deadline) await fail(page, "timeout", "Timed out before ChatGPT finished signing in.");
      const state = await detectLoginState(page);
      if (state.kind !== "unknown") unknownSince = undefined;
      if (state.kind === "authenticated") break;
      switch (state.kind) {
        case "challenge":
          await fail(page, "challenge",
            "OpenAI showed a human-verification check, which this tool does not complete automatically. "
            + "Retry later, or sign in on a computer with a browser and pass the saved session with --import-login.");
          break;
        case "landing":
          await state.button.click();
          await page.waitForTimeout(POLL_MS);
          break;
        case "email": {
          reach(3);
          const staleError = await visibleErrorText(page);
          await state.input.fill(email);
          await submitField(state.input);
          const result = await waitForTransition(page, "email", staleError);
          if (!result.changed) {
            await fail(page, "credentials", `OpenAI did not accept the email address${result.error ? `: ${result.error}` : "."}`);
          }
          break;
        }
        case "password": {
          reach(4);
          const staleError = await visibleErrorText(page);
          await state.input.fill(input.password);
          await submitField(state.input);
          const result = await waitForTransition(page, "password", staleError);
          if (!result.changed) {
            await fail(page, "credentials", `OpenAI did not accept the password${result.error ? `: ${result.error}` : "."}`);
          }
          break;
        }
        case "code": {
          codeAttempt += 1;
          if (codeAttempt > MAX_CODE_ATTEMPTS) {
            await fail(page, "verification", `OpenAI rejected ${MAX_CODE_ATTEMPTS} verification codes.`);
          }
          const label = codeLabel(state.codeKind);
          const article = /^[aeiou]/.test(label) ? "an" : "a";
          let code: string;
          if (totp && (state.codeKind === "authenticator" || state.codeKind === "unknown")) {
            const counter = Math.floor(Date.now() / 1000 / totp.periodSeconds);
            if (counter === lastTotpCounter) {
              const waitMs = totpMsUntilNextPeriod(totp);
              reach(5, `waiting ${Math.ceil(waitMs / 1000)}s for the next authenticator code`);
              await page.waitForTimeout(waitMs + 250);
              deadline += waitMs;
            }
            lastTotpCounter = Math.floor(Date.now() / 1000 / totp.periodSeconds);
            code = totpCode(totp);
            reach(5, `${codeAttempt > 1 ? "retrying with" : "entering"} a code generated from the TOTP secret`);
          } else {
            if (!input.requestCode) {
              await fail(page, "verification",
                `OpenAI asked for ${article} ${label} code, but no TOTP secret was given and no terminal is attached to type it.`);
            }
            reach(5, codeAttempt > 1 ? `OpenAI rejected the code; waiting for a new ${label} code` : `waiting for ${article} ${label} code`);
            const startedWaiting = Date.now();
            code = (await input.requestCode!({ kind: state.codeKind, attempt: codeAttempt })).replace(/\s+/g, "");
            deadline += Date.now() - startedWaiting;
            if (!/^\d{4,10}$/.test(code)) {
              throw new AccountLoginError("The verification code must contain only digits.", "verification");
            }
            reach(5, "entering the code");
          }
          const staleError = await visibleErrorText(page);
          await fillCode(state.input, page, code);
          await submitField(state.input);
          const result = await waitForTransition(page, "code", staleError);
          if (!result.changed && !result.error) {
            await fail(page, "verification", "The verification page did not respond to the code.");
          }
          break;
        }
        case "unknown":
          unknownSince ??= Date.now();
          if (Date.now() - unknownSince > UNKNOWN_PAGE_TIMEOUT_MS) {
            await fail(page, "unexpected-page", `The sign-in flow stopped on an unrecognized page (${page.url()}).`);
          }
          await page.waitForTimeout(POLL_MS);
          break;
      }
    }

    reach(6);
    const url = new URL(page.url());
    if (url.origin !== CHATGPT_ORIGIN || url.pathname !== "/") {
      await page.goto(CHATGPT_NEW_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => fail(page, "unexpected-page", "ChatGPT did not show its composer after signing in."));
    await assertNewChatPage(page);
    if (await chatGptSessionAuthenticated(page) === false) {
      await fail(page, "unexpected-page", "ChatGPT reports no signed-in session after the sign-in flow.");
    }
    const capabilities = await detectChatGptAccountCapabilities(page, dependencies.capabilityProbeTimeoutMs === undefined
      ? {}
      : { selectorTimeoutMs: dependencies.capabilityProbeTimeoutMs });

    reach(7);
    const storageState = sanitizeBrowserLoginStorageState(await context.storageState());
    if (storageState.cookies.length === 0) {
      throw new AccountLoginError("The signed-in browser holds no ChatGPT/OpenAI cookies to save.", "unexpected-page");
    }
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(storageState)}\n`);
    writeVerificationMarker(config.storageStatePath, capabilities);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: page.url(),
      solAvailable: capabilities.solAvailable,
      extraHighAvailable: capabilities.extraHighAvailable === true,
      proAvailable: capabilities.proAvailable,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
