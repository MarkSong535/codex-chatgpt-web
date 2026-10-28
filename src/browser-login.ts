import { existsSync, readFileSync } from "node:fs";
import { chromium, type BrowserContext, type BrowserContextOptions } from "playwright-core";
import type { AppConfig } from "./config";
import { assertChromeExecutable, atomicWriteFile } from "./config";
import { chromeLaunchOptions } from "./chrome-launch";
import {
  assertAuthenticatedChatGptPage,
  assertNewChatPage,
  CHATGPT_NEW_CHAT_URL,
  CHATGPT_COMPOSER_SELECTOR,
  detectChatGptAccountCapabilities,
} from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  extraHighAvailable: boolean;
  proAvailable: boolean;
}

export type BrowserLoginStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  extraHighAvailable?: boolean;
  proAvailable?: boolean;
}

const LOGIN_STORAGE_ROOT_DOMAINS = ["chatgpt.com", "openai.com"] as const;
const CHATGPT_ORIGIN = new URL(CHATGPT_NEW_CHAT_URL).origin;

function allowedLoginStorageHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)
    || hostname.startsWith(".")
    || hostname.endsWith(".")
    || hostname.includes("..")) return false;
  try {
    const parsed = new URL(`https://${hostname}/`);
    if (parsed.hostname !== hostname
      || parsed.host !== hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) return false;
  } catch {
    return false;
  }
  return LOGIN_STORAGE_ROOT_DOMAINS.some(root => hostname === root || hostname.endsWith(`.${root}`));
}

export function sanitizeBrowserLoginStorageState(
  storageState: BrowserLoginStorageState,
): BrowserLoginStorageState {
  return {
    cookies: storageState.cookies
      .filter(cookie => !Object.prototype.hasOwnProperty.call(cookie, "partitionKey")
        && allowedLoginStorageHost(cookie.domain.replace(/^\.+/, "")))
      .map(cookie => ({ ...cookie })),
    origins: storageState.origins
      .filter(origin => origin.origin === CHATGPT_ORIGIN)
      .map(origin => ({
        origin: origin.origin,
        localStorage: origin.localStorage.map(item => ({ ...item })),
      })),
  };
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

export function writeVerificationMarker(
  storageStatePath: string,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  const verifierBrowser = await chromium.launch(
    await chromeLaunchOptions(config.chromeExecutablePath, config.chromeGpu, ["--no-first-run", "--no-default-browser-check"]),
  );
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_NEW_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      // A missing or expired session is redirected to the login page instead of showing a composer.
      const signedOut = verifierPage.waitForURL(url => url.pathname.startsWith("/auth/"), { timeout: 60_000 })
        .then(() => true, () => false);
      const composer = verifierPage.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first()
        .waitFor({ state: "visible", timeout: 60_000 }).then(() => false);
      composer.catch(() => {}); // The losing wait rejects when the browser closes.
      if (await Promise.race([signedOut, composer])) {
        throw new Error("ChatGPT is signed out: the saved session is missing or expired; run codex-chatgpt-web login");
      }
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertNewChatPage(verifierPage);
      return { ...await detectChatGptAccountCapabilities(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected);
  return { solAvailable: inspected.solAvailable, extraHighAvailable: inspected.extraHighAvailable, proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return {
      ...(typeof marker.solAvailable === "boolean" ? { solAvailable: marker.solAvailable } : {}),
      ...(typeof marker.extraHighAvailable === "boolean" ? { extraHighAvailable: marker.extraHighAvailable } : {}),
      ...(typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {}),
    };
  } catch {
    return {};
  }
}

function isStorageStateFile(value: unknown): value is BrowserLoginStorageState {
  if (!value || typeof value !== "object") return false;
  const { cookies, origins } = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(cookies)
    && cookies.every(cookie => cookie && typeof cookie === "object"
      && ["name", "value", "domain", "path"].every(key => typeof (cookie as Record<string, unknown>)[key] === "string"))
    && Array.isArray(origins)
    && origins.every(origin => origin && typeof origin === "object"
      && typeof (origin as { origin?: unknown }).origin === "string"
      && Array.isArray((origin as { localStorage?: unknown }).localStorage));
}

/**
 * Adopts a Playwright storage state captured elsewhere, for accounts whose sign-in cannot be
 * automated. The state is reduced to ChatGPT/OpenAI cookies and verified before use.
 */
export async function importBrowserLogin(config: AppConfig, sourcePath: string): Promise<BrowserLoginResult> {
  assertChromeExecutable(config.chromeExecutablePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ChatGPT login state ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isStorageStateFile(raw)) {
    throw new Error(`${sourcePath} is not a Playwright storage-state file with cookies and origins`);
  }
  const state = sanitizeBrowserLoginStorageState(raw);
  if (state.cookies.length === 0) throw new Error(`${sourcePath} contains no ChatGPT/OpenAI cookies`);
  const inspected = await inspectStoredState(config, state);
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
  writeVerificationMarker(config.storageStatePath, inspected);
  return {
    storageStatePath: config.storageStatePath,
    accountSurfaceUrl: inspected.url,
    solAvailable: inspected.solAvailable,
    extraHighAvailable: inspected.extraHighAvailable === true,
    proAvailable: inspected.proAvailable,
  };
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  assertChromeExecutable(config.chromeExecutablePath);
  const browser = await chromium.launch(
    await chromeLaunchOptions(config.chromeExecutablePath, config.chromeGpu, ["--no-first-run", "--no-default-browser-check"]),
  );
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
