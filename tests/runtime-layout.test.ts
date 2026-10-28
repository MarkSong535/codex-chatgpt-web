import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDurableRuntimeCommand,
  CHATGPT_CONNECTOR_NAME,
  defaultBrokerEndpoint,
  defaultConfig,
  expandUserPath,
  isWindowsPipeEndpoint,
  installedBunExecutable,
  loadConfig,
  loadConfigForSetup,
  saveConfig,
  providerConfig,
  resolveBrokerEndpoint,
  resolveConnectorName,
  runtimeCommandForProcess,
  validateConnectorNameSuffix,
} from "../src/config";
import { removeLegacyRuntimeArtifacts } from "../src/service";
import { processRunning } from "../src/process";

const roots: string[] = [];
afterEach(() => {
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("managed runtime commands reject every ephemeral path component", () => {
  expect(() => assertDurableRuntimeCommand(["/private/tmp/codex-chatgpt-web"])).toThrow("ephemeral path");
  expect(() => assertDurableRuntimeCommand([process.execPath, "/tmp/build/app/cli.js"])).toThrow("ephemeral path");
  expect(() => assertDurableRuntimeCommand([process.execPath])).not.toThrow();
});

test("Windows Bun shims resolve to the installed Bun executable before service setup", () => {
  const ephemeralBun = join(tmpdir(), "bun-node-test", "bun");
  expect(runtimeCommandForProcess({
    executable: ephemeralBun,
    bunExecutable: process.execPath,
    entry: import.meta.path,
  })).toEqual([process.execPath, import.meta.path]);
  expect(() => runtimeCommandForProcess({
    executable: ephemeralBun,
    entry: import.meta.path,
  })).toThrow("ephemeral path");
});

test("installed Bun discovery ignores a temporary self-extract executable", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-bun-discovery-${process.pid}-${Date.now()}`);
  const ephemeralBun = join(root, "bun-node-test", "bun.exe");
  roots.push(root);
  mkdirSync(join(root, "bun-node-test"), { recursive: true });
  writeFileSync(ephemeralBun, "");
  expect(installedBunExecutable({
    platform: "win32",
    pathValue: "",
    candidates: [ephemeralBun, process.execPath],
  })).toBe(process.execPath);
});

test("Windows uses a stable native named pipe for the outer Codex tool broker", () => {
  const first = defaultBrokerEndpoint("C:\\Users\\alice\\.codex-chatgpt-web", "win32");
  const second = defaultBrokerEndpoint("C:\\Users\\alice\\.codex-chatgpt-web", "win32");
  expect(first).toBe(second);
  expect(isWindowsPipeEndpoint(first)).toBe(true);
  expect(resolveBrokerEndpoint(first)).toBe(first);
  expect(defaultBrokerEndpoint("/home/alice/.codex-chatgpt-web", "linux")).toEndWith(join("runtime", "turn-broker.sock"));
});

test("permission-denied process probes preserve ownership evidence", () => {
  expect(processRunning(123, () => {
    const error = new Error("access denied") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  })).toBe(true);
  expect(processRunning(123, () => {
    const error = new Error("not found") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  })).toBe(false);
  expect(processRunning(0)).toBe(false);
});

test("user-home expansion accepts native Unix and Windows separators", () => {
  expect(expandUserPath("~/runtime")).toBe(join(homedir(), "runtime"));
  expect(expandUserPath("~\\runtime")).toBe(join(homedir(), "runtime"));
});

test("default setup uses the fixed production connector identity", () => {
  expect(defaultConfig("full").appName).toBe(CHATGPT_CONNECTOR_NAME);
  expect(defaultConfig("full").subagentProtocol).toBe("compatibility-v1");
  expect(defaultConfig("full")).not.toHaveProperty("headed");
  expect(defaultConfig("full")).not.toHaveProperty("browserInteractionMode");
});

test("setup explicitly migrates v1 pro-only config to v3 managed browser-only", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-config-migration-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), `${JSON.stringify({
    version: 1,
    releaseVersion: "0.1.0",
    mode: "pro-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    chromeExecutablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    storageStatePath: join(root, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(root),
    headed: true,
    extraHighAvailable: true, proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "config-migration-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);

  expect(() => loadConfig()).toThrow("rerun setup to migrate");
  const migrated = loadConfigForSetup();
  expect(migrated).toMatchObject({
    version: 3,
    mode: "browser-only",
    subagentProtocol: "compatibility-v1",
    solAvailable: true,
  });
  expect(migrated).not.toHaveProperty("headed");
});

test("launcher and Zero Risk configurations are rejected at runtime and adopted by setup", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-retired-host-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const tunnel = (id: string) => ({ binaryPath: join(root, "tunnel"), runtimeKeyFile: join(root, "key"),
    profileDir: root, tunnelId: `tunnel_${id.repeat(32)}`, profileName: "test", alias: "test" });
  const launcher = {
    ...defaultConfig("full"),
    browserHost: "launcher",
    browserHostDescriptorPath: join(root, "launcher-browser.json"),
    browserInteractionMode: "manual",
    appName: "Codex Zero Risk",
    automaticAppName: "Codex Work",
    manualAppName: "Codex Zero Risk",
    headed: true,
    zeroRiskProEnabled: true,
    tunnel: tunnel("b"),
    automaticTunnel: tunnel("a"),
    manualTunnel: tunnel("b"),
  };
  writeFileSync(join(root, "config.json"), `${JSON.stringify(launcher)}\n`);
  expect(() => loadConfig()).toThrow("no longer supported; rerun setup");

  const adopted = loadConfigForSetup();
  expect(adopted.appName).toBe("Codex Work");
  expect(adopted.mode).toBe("full");
  expect(adopted.tunnel?.tunnelId).toBe(`tunnel_${"a".repeat(32)}`);
  for (const key of ["browserHost", "browserHostDescriptorPath", "browserInteractionMode", "automaticAppName",
    "manualAppName", "headed", "zeroRiskProEnabled", "automaticTunnel", "manualTunnel"]) {
    expect(adopted).not.toHaveProperty(key);
  }

  // A Zero Risk-only install has no automatic tunnel, so it is adopted as browser-only.
  writeFileSync(join(root, "config.json"), `${JSON.stringify({ ...launcher, automaticTunnel: undefined })}\n`);
  expect(loadConfigForSetup()).toMatchObject({ mode: "browser-only", appName: "Codex Work" });
});

test("ordinary configurations written with per-mode tunnel keys still load", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-automatic-tunnel-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const tunnel = { binaryPath: join(root, "tunnel"), runtimeKeyFile: join(root, "key"),
    profileDir: root, tunnelId: `tunnel_${"a".repeat(32)}`, profileName: "test", alias: "test" };
  writeFileSync(join(root, "config.json"), JSON.stringify({
    ...defaultConfig("full"), browserHost: "managed-chrome", browserInteractionMode: "automatic",
    automaticAppName: CHATGPT_CONNECTOR_NAME, manualAppName: "Codex Zero Risk", headed: true,
    tunnel, automaticTunnel: tunnel,
  }));
  const loaded = loadConfig();
  expect(loaded.tunnel).toEqual(tunnel);
  expect(loaded).not.toHaveProperty("automaticTunnel");
  expect(loaded).not.toHaveProperty("headed");
});

test("legacy temp-path wrapper and vendor are removed only after runtime ownership changes", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-legacy-runtime-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const wrapper = join(root, "bin", "serve-with-playwright.sh");
  const vendorFile = join(root, "vendor", "node_modules", "playwright-core", "package.json");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "vendor", "node_modules", "playwright-core"), { recursive: true });
  writeFileSync(wrapper, "#!/bin/sh\n");
  writeFileSync(vendorFile, "{}\n");

  const config = defaultConfig("browser-only");
  config.runtimeCommand = [wrapper];
  expect(() => removeLegacyRuntimeArtifacts(config)).toThrow("still references");
  expect(existsSync(wrapper)).toBe(true);
  config.runtimeCommand = [process.execPath];
  removeLegacyRuntimeArtifacts(config);
  expect(existsSync(wrapper)).toBe(false);
  expect(existsSync(join(root, "vendor"))).toBe(false);
});

test("provider configuration carries the Chrome settings", () => {
  const config = defaultConfig("browser-only");
  config.chromeGpu = "software";
  config.stallTimeoutSec = 900;
  const chatgptWeb = providerConfig(config).chatgptWeb!;
  expect(chatgptWeb).toMatchObject({ chromeGpu: "software", solAvailable: true, stallTimeoutSec: 900 });
  expect(chatgptWeb).not.toHaveProperty("headed");
  expect(chatgptWeb).not.toHaveProperty("browserHost");
});

test("Luna-only provider configuration exposes only the Luna backend", () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  const provider = providerConfig(config);
  expect(provider.models).toEqual(["gpt-5.6-luna"]);
  expect(provider.defaultModel).toBe("gpt-5.6-luna");
  expect(provider.modelReasoningEfforts).toEqual({ "gpt-5.6-luna": ["low", "medium"] });
  expect(provider.chatgptWeb).toMatchObject({ solAvailable: false, extraHighAvailable: false, proAvailable: false });
});

test("retired chat preferences are removed without changing current configuration", () => {
  const root = join(tmpdir(), `codex-web-fresh-config-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const original = { ...defaultConfig("browser-only"), experimentalFreshConversationPerTurn: true,
    composerPredictionsEnabled: false, autoApproveToolCalls: true };
  expect(original).not.toHaveProperty("useSavedChats");
  for (const useSavedChats of [undefined, false, true, "retired-value"]) {
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...original, useSavedChats }));
    for (const loaded of [loadConfig(), loadConfigForSetup()]) {
      expect(loaded).toEqual(original);
      expect(providerConfig(loaded).chatgptWeb).not.toHaveProperty("useSavedChats");
      expect(providerConfig(loaded).chatgptWeb!.experimentalFreshConversationPerTurn).toBe(true);
      saveConfig(loaded);
      expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8"))).toEqual(original);
    }
  }
  writeFileSync(join(root, "config.json"), JSON.stringify({ ...original, experimentalFreshConversationPerTurn: "true" }));
  expect(() => loadConfig()).toThrow("experimentalFreshConversationPerTurn");
});

test("composer predictions default on for existing configurations and persist an explicit opt-out", () => {
  const root = join(tmpdir(), `codex-predictions-config-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const config: Record<string, unknown> = { ...defaultConfig("browser-only") };
  expect(config.composerPredictionsEnabled).toBe(true);
  delete config.composerPredictionsEnabled;
  const persist = () => writeFileSync(join(root, "config.json"), JSON.stringify(config));
  persist();
  expect(loadConfig().composerPredictionsEnabled).toBe(true);
  config.composerPredictionsEnabled = false;
  persist();
  expect(loadConfig().composerPredictionsEnabled).toBe(false);
  expect(loadConfigForSetup().composerPredictionsEnabled).toBe(false);
  config.composerPredictionsEnabled = "false";
  persist();
  expect(() => loadConfig()).toThrow("composerPredictionsEnabled");
});

test("skill attachments config defaults off, reaches the adapter, and rejects invalid settings", () => {
  const root = join(tmpdir(), `codex-skills-config-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const config: Record<string, unknown> = { ...defaultConfig("full") };
  config.tunnel = { binaryPath: join(root, "tunnel"), runtimeKeyFile: join(root, "key"),
    profileDir: root, tunnelId: `tunnel_${"a".repeat(32)}`, profileName: "test", alias: "test" };
  expect(config.experimentalSkillAttachments).toBe(false);
  const persist = () => writeFileSync(join(root, "config.json"), JSON.stringify(config));
  delete config.experimentalSkillAttachments;
  persist();
  expect(loadConfig()!.experimentalSkillAttachments).toBe(false);
  config.experimentalSkillAttachments = true;
  persist();
  expect(providerConfig(loadConfig()!).chatgptWeb!.experimentalSkillAttachments).toBe(true);
  config.experimentalSkillAttachments = "true";
  persist();
  expect(() => loadConfig()).toThrow("experimentalSkillAttachments");
});


test("the whole name after Codex is editable", () => {
  for (const suffix of ["Native2", "Work", "DEV", "研究_2", "Zero Risk", "a".repeat(74)]) {
    expect(validateConnectorNameSuffix(suffix)).toBe(suffix);
    const name = resolveConnectorName(undefined, suffix);
    expect(name).toBe(`Codex ${suffix}`);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(resolveConnectorName(name)).toBe(name);
  }
  for (const suffix of [null, 5, "", "x".repeat(75), " Work", "Work ", "x\ny", "x`y", "x@y", "--flag"]) {
    expect(() => validateConnectorNameSuffix(suffix)).toThrow("part after Codex");
  }
  expect(() => validateConnectorNameSuffix("Native")).toThrow("retired");
  expect(resolveConnectorName("Codex Native")).toBe(CHATGPT_CONNECTOR_NAME);
  expect(resolveConnectorName()).toBe(CHATGPT_CONNECTOR_NAME);
});

test("stored names survive config loading without an additional naming preference", () => {
  const root = join(tmpdir(), `cgw-name-config-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const config = {
    ...defaultConfig("full"),
    tunnel: { binaryPath: join(root, "tunnel"), tunnelId: `tunnel_${"a".repeat(32)}`,
      runtimeKeyFile: join(root, "key"), profileDir: root, profileName: "test", alias: "test" },
    appName: resolveConnectorName(undefined, "Work"),
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  expect(loadConfig().appName).toBe("Codex Work");
  expect(loadConfigForSetup().appName).toBe("Codex Work");
  // An older locally configured name also remains exact; it is not renamed on upgrade.
  writeFileSync(join(root, "config.json"), JSON.stringify({ ...config, appName: "Codex Native2 - Work" }));
  expect(loadConfigForSetup().appName).toBe("Codex Native2 - Work");
  writeFileSync(join(root, "config.json"), JSON.stringify({ ...config, appName: "Another plugin" }));
  expect(() => loadConfig()).toThrow("must start with Codex");
});
