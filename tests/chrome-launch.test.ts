import { expect, test } from "bun:test";
import {
  CHROME_SOFTWARE_GPU_ARGS,
  chromeLaunchPlan,
  parseChromeGpuMode,
  playwrightLaunchOptions,
  resolveChromeGpuMode,
  type ChromeHostFacts,
} from "../src/chrome-launch";
import { defaultChromeExecutable } from "../src/config";

function facts(overrides: Partial<ChromeHostFacts> = {}): ChromeHostFacts {
  return { platform: "linux", env: {}, isRoot: false, hasRenderNode: false, ...overrides };
}

const quiet = { warn: () => {} };

test("auto GPU uses SwiftShader only on Linux hosts without a display or render node", () => {
  expect(resolveChromeGpuMode("auto", facts())).toBe("software");
  expect(resolveChromeGpuMode("auto", facts({ env: { DISPLAY: ":0" } }))).toBe("software");
  expect(resolveChromeGpuMode("auto", facts({ hasRenderNode: true }))).toBe("software");
  expect(resolveChromeGpuMode("auto", facts({ env: { DISPLAY: ":0" }, hasRenderNode: true }))).toBe("hardware");
  expect(resolveChromeGpuMode(undefined, facts({ platform: "darwin" }))).toBe("hardware");
  expect(resolveChromeGpuMode("software", facts({ platform: "win32" }))).toBe("software");
  expect(resolveChromeGpuMode("hardware", facts())).toBe("hardware");
});

test("the GPU environment override wins and is validated", () => {
  expect(resolveChromeGpuMode("hardware", facts({ env: { CODEX_CHATGPT_WEB_CHROME_GPU: "software" } }))).toBe("software");
  expect(() => resolveChromeGpuMode("auto", facts({ env: { CODEX_CHATGPT_WEB_CHROME_GPU: "metal" } })))
    .toThrow("CODEX_CHATGPT_WEB_CHROME_GPU");
  expect(parseChromeGpuMode("software", "--chrome-gpu")).toBe("software");
  expect(() => parseChromeGpuMode("swiftshader", "--chrome-gpu")).toThrow("--chrome-gpu must be one of auto, hardware, software");
});

test("headed Chrome on a display-less Linux host runs on a private virtual display", async () => {
  const plan = await chromeLaunchPlan({ headed: true }, {
    ...quiet,
    facts: facts({ env: { PATH: "/usr/bin" } }),
    startVirtualDisplay: async () => ":42",
  });
  expect(plan.headless).toBe(false);
  expect(plan.virtualDisplay).toBe(":42");
  expect(plan.env).toEqual({ PATH: "/usr/bin", DISPLAY: ":42" });
  expect(plan.gpu).toBe("software");
  expect(plan.args).toEqual([...CHROME_SOFTWARE_GPU_ARGS, "--disable-dev-shm-usage"]);
});

test("without Xvfb a headed request falls back to headless with software GPU", async () => {
  const warnings: string[] = [];
  const plan = await chromeLaunchPlan({ headed: true }, {
    facts: facts(),
    startVirtualDisplay: async () => undefined,
    warn: message => warnings.push(message),
  });
  expect(plan.headless).toBe(true);
  expect(plan.env).toBeUndefined();
  expect(plan.args).toContain("--use-angle=swiftshader");
  expect(warnings).toHaveLength(1);
});

test("Xvfb can be disabled and headless can be forced from the environment", async () => {
  let started = false;
  const startVirtualDisplay = async () => { started = true; return ":1"; };
  const disabled = await chromeLaunchPlan({ headed: true }, {
    ...quiet, facts: facts({ env: { CODEX_CHATGPT_WEB_XVFB: "0" } }), startVirtualDisplay,
  });
  expect(disabled.headless).toBe(true);
  const forced = await chromeLaunchPlan({ headed: true }, {
    ...quiet, facts: facts({ env: { CODEX_CHATGPT_WEB_HEADLESS: "1", DISPLAY: ":0" } }), startVirtualDisplay,
  });
  expect(forced.headless).toBe(true);
  expect(started).toBe(false);
});

test("root on Linux disables the sandbox and extra arguments are appended", async () => {
  const plan = await chromeLaunchPlan({ headed: false, gpu: "hardware" }, {
    ...quiet,
    facts: facts({ isRoot: true, env: { CODEX_CHATGPT_WEB_CHROME_ARGS: " --lang=en-US  --window-size=1280,900 " } }),
  });
  expect(plan.args).toEqual(["--disable-dev-shm-usage", "--no-sandbox", "--lang=en-US", "--window-size=1280,900"]);
});

test("macOS and Windows keep Chrome's own defaults", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const plan = await chromeLaunchPlan({ headed: true }, { ...quiet, facts: facts({ platform, isRoot: true }) });
    expect(plan).toEqual({ headless: false, args: [], gpu: "hardware" });
  }
});

test("Playwright options carry the plan's display and caller arguments", () => {
  const options = playwrightLaunchOptions(
    { headless: false, args: ["--a"], env: { DISPLAY: ":3" }, gpu: "software", virtualDisplay: ":3" },
    "/usr/bin/google-chrome",
    ["--b"],
  );
  expect(options).toEqual({
    executablePath: "/usr/bin/google-chrome",
    headless: false,
    args: ["--a", "--b"],
    env: { DISPLAY: ":3" },
  });
});

test("Linux Chrome discovery accepts Chromium installs", () => {
  expect(defaultChromeExecutable("linux", undefined, () => false)).toBe("/usr/bin/google-chrome");
  expect(defaultChromeExecutable("linux", undefined, path => path === "/usr/bin/chromium")).toBe("/usr/bin/chromium");
});
