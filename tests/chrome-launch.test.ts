import { expect, test } from "bun:test";
import {
  CHROME_SOFTWARE_GPU_ARGS,
  chromeLaunchOptions,
  chromeLaunchPlan,
  parseChromeGpuMode,
  resolveChromeGpuMode,
  type ChromeHostFacts,
} from "../src/chrome-launch";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertChromeExecutable, defaultChromeExecutable, isSnapBrowser, playwrightChromiumExecutable } from "../src/config";

function facts(overrides: Partial<ChromeHostFacts> = {}): ChromeHostFacts {
  return { platform: "linux", env: {}, isRoot: false, hasRenderNode: false, ...overrides };
}

const xvfb = (display = ":42") => async () => display;
const noXvfb = async () => undefined;

test("auto GPU uses SwiftShader on a virtual display or a Linux host without a render node", () => {
  expect(resolveChromeGpuMode("auto", facts())).toBe("software");
  expect(resolveChromeGpuMode("auto", facts({ hasRenderNode: true }))).toBe("hardware");
  expect(resolveChromeGpuMode("auto", facts({ hasRenderNode: true }), true)).toBe("software");
  expect(resolveChromeGpuMode(undefined, facts({ platform: "darwin" }))).toBe("hardware");
  expect(resolveChromeGpuMode("software", facts({ platform: "win32" }))).toBe("software");
  expect(resolveChromeGpuMode("hardware", facts(), true)).toBe("hardware");
});

test("the GPU environment override wins and is validated", () => {
  expect(resolveChromeGpuMode("hardware", facts({ env: { CODEX_CHATGPT_WEB_CHROME_GPU: "software" } }))).toBe("software");
  expect(() => resolveChromeGpuMode("auto", facts({ env: { CODEX_CHATGPT_WEB_CHROME_GPU: "metal" } })))
    .toThrow("CODEX_CHATGPT_WEB_CHROME_GPU");
  expect(parseChromeGpuMode("software", "--chrome-gpu")).toBe("software");
  expect(() => parseChromeGpuMode("swiftshader", "--chrome-gpu")).toThrow("--chrome-gpu must be one of auto, hardware, software");
});

test("Linux Chrome runs on a private Xvfb display with SwiftShader and container-safe arguments", async () => {
  const plan = await chromeLaunchPlan(undefined, {
    facts: facts({ env: { PATH: "/usr/bin", DISPLAY: ":0" }, hasRenderNode: true }),
    startVirtualDisplay: xvfb(),
  });
  expect(plan).toEqual({
    gpu: "software",
    args: [...CHROME_SOFTWARE_GPU_ARGS, "--disable-dev-shm-usage"],
    virtualDisplay: ":42",
    env: { PATH: "/usr/bin", DISPLAY: ":42" },
  });
});

test("without Xvfb Linux uses an existing display, and fails clearly when there is none", async () => {
  const desktop = await chromeLaunchPlan("hardware", { facts: facts({ env: { DISPLAY: ":0" } }), startVirtualDisplay: noXvfb });
  expect(desktop).toEqual({ gpu: "hardware", args: ["--disable-dev-shm-usage"] });
  await expect(chromeLaunchPlan(undefined, { facts: facts(), startVirtualDisplay: noXvfb }))
    .rejects.toThrow("Install Xvfb");
  let started = false;
  await expect(chromeLaunchPlan(undefined, {
    facts: facts({ env: { CODEX_CHATGPT_WEB_XVFB: "0" } }),
    startVirtualDisplay: async () => { started = true; return ":1"; },
  })).rejects.toThrow("Install Xvfb");
  expect(started).toBeFalse();
});

test("root on Linux disables the sandbox and extra arguments are appended", async () => {
  const plan = await chromeLaunchPlan("hardware", {
    facts: facts({ isRoot: true, env: { CODEX_CHATGPT_WEB_CHROME_ARGS: " --lang=en-US  --window-size=1280,900 " } }),
    startVirtualDisplay: xvfb(":7"),
  });
  expect(plan.args).toEqual(["--disable-dev-shm-usage", "--no-sandbox", "--lang=en-US", "--window-size=1280,900"]);
});

test("macOS and Windows open an ordinary Chrome window with Chrome's own defaults", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    expect(await chromeLaunchPlan(undefined, { facts: facts({ platform, isRoot: true }), startVirtualDisplay: xvfb() }))
      .toEqual({ gpu: "hardware", args: [] });
  }
});

test("Playwright options never use headless mode and keep caller arguments last", async () => {
  expect(await chromeLaunchOptions("/usr/bin/chromium", "auto", ["--no-first-run"], {
    facts: facts(), startVirtualDisplay: xvfb(":3"),
  })).toEqual({
    executablePath: "/usr/bin/chromium",
    headless: false,
    args: [...CHROME_SOFTWARE_GPU_ARGS, "--disable-dev-shm-usage", "--no-first-run"],
    env: { DISPLAY: ":3" },
  });
});

test("Linux Chrome discovery accepts Chromium installs", () => {
  expect(defaultChromeExecutable("linux", undefined, () => false)).toBe("/usr/bin/google-chrome");
  expect(defaultChromeExecutable("linux", undefined, path => path === "/usr/bin/chromium")).toBe("/usr/bin/chromium");
  expect(defaultChromeExecutable("linux", undefined, path => path === "/usr/local/bin/chromium", "/usr/local/bin:/opt/bin"))
    .toBe("/usr/local/bin/chromium");
});

test("a missing browser explains how to install one or point at it", () => {
  expect(() => assertChromeExecutable("/nonexistent/google-chrome", "linux"))
    .toThrow("Chrome was not found at /nonexistent/google-chrome. Install Google Chrome (x64) or run `codex-chatgpt-web browser install`");
  expect(() => assertChromeExecutable("/nonexistent/google-chrome", "linux")).toThrow("--chrome");
  expect(() => assertChromeExecutable(process.execPath)).not.toThrow();
});

test("snap browsers are detected and never chosen automatically", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chrome-snap-"));
  try {
    const shim = join(root, "chromium-browser");
    writeFileSync(shim, "#!/bin/sh\nif ! [ -x /snap/bin/chromium ]; then\n  exit 1\nfi\nexec /snap/bin/chromium \"$@\"\n");
    const real = join(root, "chrome");
    writeFileSync(real, "\u007fELF binary");
    expect(isSnapBrowser(shim)).toBeTrue();
    expect(isSnapBrowser("/snap/bin/chromium")).toBeTrue();
    expect(isSnapBrowser(real)).toBeFalse();
    expect(defaultChromeExecutable("linux", undefined, path => path === shim, "", join(root, "none"))).toBe("/usr/bin/google-chrome");
    expect(() => assertChromeExecutable(shim, "linux")).toThrow("is a snap package");
    expect(() => assertChromeExecutable(shim, "linux")).toThrow("codex-chatgpt-web browser install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Playwright's Chromium is found after system browsers, newest revision first", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chrome-playwright-"));
  try {
    for (const [revision, directory] of [["1200", "chrome-linux"], ["1234", "chrome-linux"], ["1300", "chrome-linux64"]] as const) {
      mkdirSync(join(root, `chromium-${revision}`, directory), { recursive: true });
      writeFileSync(join(root, `chromium-${revision}`, directory, "chrome"), "binary");
    }
    mkdirSync(join(root, "chromium_headless_shell-1300"), { recursive: true });
    const newest = join(root, "chromium-1300", "chrome-linux64", "chrome");
    expect(playwrightChromiumExecutable(root)).toBe(newest);
    const installed = (path: string) => path.startsWith(root) && existsSync(path);
    expect(defaultChromeExecutable("linux", undefined, installed, "", root)).toBe(newest);
    expect(defaultChromeExecutable("linux", undefined, path => path === "/usr/bin/chromium" || installed(path), "", root))
      .toBe("/usr/bin/chromium");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
