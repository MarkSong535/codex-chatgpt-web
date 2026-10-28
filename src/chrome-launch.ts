import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import type { LaunchOptions } from "playwright-core";

/**
 * `hardware` leaves GPU selection to Chrome. `software` forces WebGL/compositing through ANGLE's
 * SwiftShader backend, which needs no GPU device. `auto` picks software on Linux hosts without a
 * graphical session or a DRM render node (servers, containers, CI, VMs without virtio-gpu).
 */
export type ChromeGpuMode = "auto" | "hardware" | "software";

export const CHROME_GPU_MODES: readonly ChromeGpuMode[] = ["auto", "hardware", "software"];

/** Chrome 13x+ refuses the SwiftShader WebGL fallback unless it is requested explicitly. */
export const CHROME_SOFTWARE_GPU_ARGS: readonly string[] = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

const VIRTUAL_DISPLAY_TIMEOUT_MS = 10_000;
const VIRTUAL_DISPLAY_SCREEN = "1920x1080x24";

export interface ChromeHostFacts {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isRoot: boolean;
  hasRenderNode: boolean;
}

export function currentChromeHostFacts(): ChromeHostFacts {
  return {
    platform: process.platform,
    env: process.env,
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    hasRenderNode: linuxRenderNodeExists(),
  };
}

function linuxRenderNodeExists(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readdirSync("/dev/dri").some(name => name.startsWith("renderD"));
  } catch {
    return false;
  }
}

export function parseChromeGpuMode(value: unknown, source: string): ChromeGpuMode {
  if (typeof value === "string" && (CHROME_GPU_MODES as readonly string[]).includes(value)) {
    return value as ChromeGpuMode;
  }
  throw new Error(`${source} must be one of ${CHROME_GPU_MODES.join(", ")}`);
}

/** macOS and Windows always have a window server; Linux needs X11 or Wayland. */
export function hasGraphicalDisplay(facts: Pick<ChromeHostFacts, "platform" | "env">): boolean {
  if (facts.platform !== "linux") return true;
  return Boolean(facts.env.DISPLAY?.trim() || facts.env.WAYLAND_DISPLAY?.trim());
}

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be 1 or 0`);
}

export function resolveChromeGpuMode(
  configured: ChromeGpuMode | undefined,
  facts: ChromeHostFacts,
): "hardware" | "software" {
  const override = facts.env.CODEX_CHATGPT_WEB_CHROME_GPU?.trim();
  const mode = override ? parseChromeGpuMode(override, "CODEX_CHATGPT_WEB_CHROME_GPU") : configured ?? "auto";
  if (mode !== "auto") return mode;
  if (facts.platform !== "linux") return "hardware";
  return hasGraphicalDisplay(facts) && facts.hasRenderNode ? "hardware" : "software";
}

export interface ChromeLaunchPlan {
  headless: boolean;
  args: string[];
  /** Present only when the plan changes the inherited environment (a virtual DISPLAY). */
  env?: NodeJS.ProcessEnv;
  gpu: "hardware" | "software";
  virtualDisplay?: string;
}

export interface ChromeLaunchRequest {
  /** Whether the caller wants a real (non-headless) browser window. */
  headed: boolean;
  gpu?: ChromeGpuMode;
}

export interface ChromeLaunchDependencies {
  facts?: ChromeHostFacts;
  startVirtualDisplay?: () => Promise<string | undefined>;
  warn?: (message: string) => void;
}

/**
 * Resolves how Chrome should start on this host. A headed request on a Linux host without a
 * display runs on a private Xvfb server when one is installed, which keeps the ordinary headed
 * Chrome fingerprint; otherwise it falls back to Chrome's new headless mode.
 */
export async function chromeLaunchPlan(
  request: ChromeLaunchRequest,
  dependencies: ChromeLaunchDependencies = {},
): Promise<ChromeLaunchPlan> {
  const facts = dependencies.facts ?? currentChromeHostFacts();
  const warn = dependencies.warn ?? (message => console.warn(`[chrome] ${message}`));
  let headless = !request.headed;
  if (envFlag(facts.env, "CODEX_CHATGPT_WEB_HEADLESS") === true) headless = true;

  let env: NodeJS.ProcessEnv | undefined;
  let virtualDisplay: string | undefined;
  if (!headless && !hasGraphicalDisplay(facts)) {
    if (envFlag(facts.env, "CODEX_CHATGPT_WEB_XVFB") !== false) {
      virtualDisplay = await (dependencies.startVirtualDisplay ?? ensureVirtualDisplay)();
    }
    if (virtualDisplay) {
      env = { ...facts.env, DISPLAY: virtualDisplay };
    } else {
      warn("No X11/Wayland display and no Xvfb; starting Chrome in headless mode");
      headless = true;
    }
  }
  const effectiveFacts = env ? { ...facts, env } : facts;
  const gpu = resolveChromeGpuMode(request.gpu, effectiveFacts);

  const args: string[] = [];
  if (gpu === "software") args.push(...CHROME_SOFTWARE_GPU_ARGS);
  if (facts.platform === "linux") {
    // Containers commonly mount a 64 MB /dev/shm, which crashes renderers on large pages.
    args.push("--disable-dev-shm-usage");
    // Chrome refuses to start as root with its sandbox enabled.
    if (facts.isRoot) args.push("--no-sandbox");
  }
  args.push(...extraChromeArgs(facts.env));
  return {
    headless,
    args,
    ...(env ? { env } : {}),
    gpu,
    ...(virtualDisplay ? { virtualDisplay } : {}),
  };
}

function extraChromeArgs(env: NodeJS.ProcessEnv): string[] {
  return (env.CODEX_CHATGPT_WEB_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean);
}

/** Playwright launch options for a plan. Callers append their own `args` after these. */
export function playwrightLaunchOptions(
  plan: ChromeLaunchPlan,
  executablePath: string,
  extraArgs: string[] = [],
): LaunchOptions {
  return {
    executablePath,
    headless: plan.headless,
    args: [...plan.args, ...extraArgs],
    ...(plan.env ? { env: plan.env as LaunchOptions["env"] } : {}),
  };
}

let virtualDisplayStart: Promise<string | undefined> | undefined;

function xvfbExecutable(): string | undefined {
  const lookup = spawnSync("sh", ["-c", "command -v Xvfb"], { encoding: "utf8" });
  const path = lookup.status === 0 ? lookup.stdout.trim() : "";
  return path && existsSync(path) ? path : undefined;
}

/**
 * Starts one private Xvfb server and returns its DISPLAY. Xvfb picks a free display number itself
 * (-displayfd) and exits when its last client disconnects (-terminate), so a closed browser never
 * leaves a server behind; the next launch starts a fresh one.
 */
export function ensureVirtualDisplay(): Promise<string | undefined> {
  virtualDisplayStart ??= startVirtualDisplay().catch(error => {
    virtualDisplayStart = undefined;
    console.warn(`[chrome] Xvfb failed to start: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  return virtualDisplayStart;
}

async function startVirtualDisplay(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  const executable = xvfbExecutable();
  if (!executable) return undefined;
  const child = spawn(executable, [
    "-displayfd", "3",
    "-screen", "0", VIRTUAL_DISPLAY_SCREEN,
    "-nolisten", "tcp",
    "-terminate",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  const displayPipe = child.stdio[3] as NodeJS.ReadableStream & { destroy(): void };
  const display = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for a display number"));
    }, VIRTUAL_DISPLAY_TIMEOUT_MS);
    displayPipe.on("data", chunk => {
      output += String(chunk);
      const match = /^(\d+)\s*$/m.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve(`:${match[1]}`);
    });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited before reporting a display (${signal ?? code})`));
    });
  });
  displayPipe.destroy();
  child.removeAllListeners("exit");
  child.once("exit", () => { virtualDisplayStart = undefined; });
  child.unref();
  const stop = () => { child.kill(); };
  process.once("exit", stop);
  child.once("exit", () => { process.off("exit", stop); });
  return display;
}
