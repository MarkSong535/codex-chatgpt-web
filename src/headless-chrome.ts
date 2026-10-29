import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { ChromeGpuMode } from "./chrome-launch";
import { CHROME_SOFTWARE_GPU_ARGS } from "./chrome-launch";

/**
 * Runs Chrome in its modern headless mode (`--headless=new`) and drives it over CDP.
 *
 * Playwright's own `headless: true` still passes the legacy `--headless` flag plus fingerprinting
 * tells (`--hide-scrollbars`, synthetic pointer/hover settings), and ChatGPT's Cloudflare
 * protection answers with an endless "Just a moment..." interstitial. A real Chrome binary in
 * `--headless=new` mode with a clean CDP connection clears that interstitial, so headless hosts
 * (containers, CI) can sign in without a display.
 */
export interface HeadlessChromeOptions {
  executablePath: string;
  gpu?: ChromeGpuMode;
  /** Extra Chrome arguments, each passed verbatim (no shell splitting). */
  args?: string[];
  /** Override the user agent; headless Chrome otherwise advertises "HeadlessChrome". */
  userAgent?: string;
}

const CDP_READY_TIMEOUT_MS = 30_000;

const HEADLESS_TELL_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--lang=en-US",
  "--window-size=1280,900",
];

/**
 * Waits for Chrome to report its DevTools WebSocket URL and returns its port. Port 0 lets Chrome
 * pick a free port, so concurrent runs (test files, several daemons) never collide on a fixed one.
 */
async function waitForCdpPort(child: ChildProcess, timeoutMs: number): Promise<number> {
  const reported = new Promise<number>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      child.stderr?.off("data", onData);
      reject(new Error(`Chrome did not report a DevTools endpoint within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      text += String(chunk);
      const match = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//.exec(text);
      if (match) {
        clearTimeout(timer);
        child.stderr?.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    child.stderr?.on("data", onData);
    child.once("exit", code => {
      if (!/devtools\/browser\/|ws:\/\/127\.0\.0\.1:\d+/i.test(text)) {
        clearTimeout(timer);
        reject(new Error(`Chrome exited (code ${code}) before reporting a DevTools endpoint${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}`));
      }
    });
  });
  return await reported;
}

/**
 * Launches Chrome with `--headless=new` and returns a connected Playwright browser plus a
 * cleanup function. The caller still sets the user agent on its context: headless Chrome reports
 * "HeadlessChrome" in its UA string, and Cloudflare reads it.
 */
export async function launchHeadlessChrome(options: HeadlessChromeOptions): Promise<{ browser: Browser; close: () => Promise<void> }> {
  const userDataDir = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-headless-"));
  const args = [
    "--headless=new",
    // 0 asks Chrome for a free port; the actual port is read from its DevTools log line.
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    ...HEADLESS_TELL_ARGS,
    ...(options.gpu === "software" ? CHROME_SOFTWARE_GPU_ARGS : []),
    ...(options.args ?? []),
  ];
  const child = spawn(options.executablePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  const cleanup = async () => {
    child.kill();
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  };
  try {
    const port = await waitForCdpPort(child, CDP_READY_TIMEOUT_MS);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let closed = false;
    return {
      browser,
      close: async () => {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Playwright context user-agent for headless Chrome on this platform. */
export function headlessChromeUserAgent(platform: NodeJS.Platform = process.platform): string {
  const base = "Mozilla/5.0 (%VENDOR%) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%MAJOR%.0.0.0 Safari/537.36";
  const vendor = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return base.replace("%VENDOR%", vendor).replace("%MAJOR%", "156");
}
