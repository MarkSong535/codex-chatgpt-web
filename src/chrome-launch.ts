import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import type { LaunchOptions } from "playwright-core";

/**
 * Chrome always runs as an ordinary (non-headless) browser: ChatGPT's bot protection rejects
 * headless Chrome. On Linux it renders into a private Xvfb display, so no monitor is needed.
 *
 * `hardware` leaves GPU selection to Chrome. `software` forces WebGL/compositing through ANGLE's
 * SwiftShader backend, which needs no GPU device. `auto` picks software on a virtual display and on
 * Linux hosts without a DRM render node (servers, containers, CI, VMs without virtio-gpu).
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

export function resolveChromeGpuMode(
  configured: ChromeGpuMode | undefined,
  facts: ChromeHostFacts,
  virtualDisplay = false,
): "hardware" | "software" {
  const override = facts.env.CODEX_CHATGPT_WEB_CHROME_GPU?.trim();
  const mode = override ? parseChromeGpuMode(override, "CODEX_CHATGPT_WEB_CHROME_GPU") : configured ?? "auto";
  if (mode !== "auto") return mode;
  if (facts.platform !== "linux") return "hardware";
  return virtualDisplay || !facts.hasRenderNode ? "software" : "hardware";
}

export interface ChromeLaunchPlan {
  args: string[];
  gpu: "hardware" | "software";
  /** Present only when Chrome runs on a private Xvfb display. */
  virtualDisplay?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ChromeLaunchDependencies {
  facts?: ChromeHostFacts;
  startVirtualDisplay?: () => Promise<string | undefined>;
}

export async function chromeLaunchPlan(
  gpu: ChromeGpuMode | undefined,
  dependencies: ChromeLaunchDependencies = {},
): Promise<ChromeLaunchPlan> {
  const facts = dependencies.facts ?? currentChromeHostFacts();
  let virtualDisplay: string | undefined;
  if (facts.platform === "linux") {
    // A private display keeps Chrome's windows off any desktop session the user may have.
    if (facts.env.CODEX_CHATGPT_WEB_XVFB?.trim() !== "0") {
      virtualDisplay = await (dependencies.startVirtualDisplay ?? ensureVirtualDisplay)();
    }
    if (!virtualDisplay && !hasGraphicalDisplay(facts)) {
      throw new Error(
        "Chrome needs a display, and this Linux host has none. Install Xvfb (for example "
        + "`sudo apt install xvfb`) so Chrome can run on a private virtual display.",
      );
    }
  }
  const resolved = resolveChromeGpuMode(gpu, facts, virtualDisplay !== undefined);
  const args: string[] = [];
  if (resolved === "software") args.push(...CHROME_SOFTWARE_GPU_ARGS);
  if (facts.platform === "linux") {
    // Containers commonly mount a 64 MB /dev/shm, which crashes renderers on large pages.
    args.push("--disable-dev-shm-usage");
    // Chrome refuses to start as root with its sandbox enabled.
    if (facts.isRoot) args.push("--no-sandbox");
  }
  args.push(...(facts.env.CODEX_CHATGPT_WEB_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean));
  return {
    args,
    gpu: resolved,
    ...(virtualDisplay ? { virtualDisplay, env: { ...facts.env, DISPLAY: virtualDisplay } } : {}),
  };
}

/** Playwright launch options for this host. Callers append their own `args`. */
export async function chromeLaunchOptions(
  executablePath: string,
  gpu: ChromeGpuMode | undefined,
  extraArgs: string[] = [],
  dependencies?: ChromeLaunchDependencies,
): Promise<LaunchOptions> {
  const plan = await chromeLaunchPlan(gpu, dependencies);
  return {
    executablePath,
    headless: false,
    args: [...plan.args, ...extraArgs],
    ...(plan.env ? { env: plan.env as LaunchOptions["env"] } : {}),
  };
}

let virtualDisplayStart: Promise<string | undefined> | undefined;

export function xvfbExecutable(): string | undefined {
  const lookup = spawnSync("sh", ["-c", "command -v Xvfb"], { encoding: "utf8" });
  const path = lookup.status === 0 ? lookup.stdout.trim() : "";
  return path && existsSync(path) ? path : undefined;
}

/**
 * Starts one private Xvfb server for this process and returns its DISPLAY. Xvfb picks a free display
 * number itself (-displayfd) and serves every later launch; it is stopped when this process exits,
 * and systemd stops it with the rest of the service's process group.
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
    "-noreset",
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
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited before reporting a display (${code})`));
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
