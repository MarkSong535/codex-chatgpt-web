import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { tmpdir } from "node:os";
import type { CodexProviderConfig } from "./types";
import { VERSION } from "./version";
import { parseChromeGpuMode, type ChromeGpuMode } from "./chrome-launch";

export type RuntimeMode = "browser-only" | "full";
export type SubagentProtocol = "compatibility-v1" | "native";

/**
 * ChatGPT caches a connector's public MCP contract by connector identity. The direct turn-token
 * contract therefore has a new identity instead of mutating the retired connector in place.
 */
export const CHATGPT_CONNECTOR_NAME = "Codex Native2";
export const LEGACY_CHATGPT_CONNECTOR_NAMES = ["Codex Native"] as const;

export function isLegacyChatGptConnectorName(value: string): boolean {
  return (LEGACY_CHATGPT_CONNECTOR_NAMES as readonly string[]).includes(value);
}

export function legacyChatGptConnectorMigrationMessage(legacyName: string): string {
  return `Legacy ChatGPT connector ${JSON.stringify(legacyName)} was found, but this release requires`
    + ` a newly created connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)}. Create`
    + ` ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the same tunnel with Authentication set to None;`
    + ` do not rename or refresh ${JSON.stringify(legacyName)}.`;
}

export function validateConnectorNameSuffix(value: unknown): string {
  if (typeof value !== "string" || value.length > 74
    || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(value)
    || value !== value.trim()) {
    throw new Error("The part after Codex must contain 1–74 letters, numbers, spaces, hyphens or underscores");
  }
  if (value === "Native") throw new Error("Codex Native is retired; choose another plugin name");
  return value;
}

function validateCurrentConnectorName(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("Codex ")) {
    throw new Error("Plugin names must start with Codex followed by a space");
  }
  validateConnectorNameSuffix(value.slice(6));
  return value;
}

/** The connector name to keep or set; `suffix` replaces everything after "Codex ". */
export function resolveConnectorName(existing?: string, suffix?: string): string {
  if (suffix !== undefined) return `Codex ${validateConnectorNameSuffix(suffix)}`;
  const name = existing && !isLegacyChatGptConnectorName(existing) ? existing : CHATGPT_CONNECTOR_NAME;
  return validateCurrentConnectorName(name);
}

export interface TunnelConfig {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileDir: string;
  profileName: string;
  alias: string;
}

export interface AppConfig {
  version: 3;
  releaseVersion: string;
  mode: RuntimeMode;
  subagentProtocol: SubagentProtocol;
  host: "127.0.0.1";
  port: number;
  contextWindow: number;
  appName: string;
  chromeExecutablePath: string;
  storageStatePath: string;
  brokerSocketPath: string;
  /** Chrome GPU backend; `auto` uses SwiftShader on a virtual display or a GPU-less Linux host. */
  chromeGpu?: ChromeGpuMode;
  solAvailable: boolean;
  extraHighAvailable?: boolean;
  proAvailable: boolean;
  experimentalBiggerContext: boolean;
  composerPredictionsEnabled: boolean;
  experimentalSkillAttachments: boolean;
  experimentalFreshConversationPerTurn: boolean;
  /** Optional adapter-silence budget for the Responses watchdog. */
  stallTimeoutSec?: number;
  autoApproveToolCalls: boolean;
  controlToken: string;
  runtimeCommand: string[];
  acknowledgedUnofficialAt?: string;
  tunnel?: TunnelConfig;
}

/** Fields written by releases that shipped the desktop launcher and Zero Risk mode. */
const RETIRED_CONFIG_KEYS = [
  "purpose", "automaticAppName", "manualAppName", "browserHost", "browserInteractionMode",
  "browserHostDescriptorPath", "headed", "zeroRiskProEnabled", "automaticTunnel", "manualTunnel",
] as const;

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function getConfigDir(): string {
  const configured = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex-chatgpt-web")));
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function isWindowsPipeEndpoint(value: string): boolean {
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value);
}

export function defaultBrokerEndpoint(home = getConfigDir(), platform = process.platform): string {
  if (platform !== "win32") return join(home, "runtime", "turn-broker.sock");
  const identity = createHash("sha256").update(resolve(home).toLowerCase()).digest("hex").slice(0, 20);
  return `\\\\.\\pipe\\codex-chatgpt-web-${identity}`;
}

export function resolveBrokerEndpoint(value: string): string {
  const expanded = expandUserPath(value);
  return isWindowsPipeEndpoint(expanded) ? expanded : resolve(expanded);
}

const atomicWaitCell = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500] as const;

function renameAtomicFile(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = process.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!transientWindowsError || delay === undefined) throw error;
      Atomics.wait(atomicWaitCell, 0, 0, delay);
    }
  }
}

export function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  { mode = 0o600, protectDirectory = true, durable = false }: { mode?: number; protectDirectory?: boolean; durable?: boolean } = {},
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (protectDirectory) {
    try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  }
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, data);
    if (durable) fsyncSync(fd);
    closeSync(fd);
    renameAtomicFile(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
  try { chmodSync(path, mode); } catch { /* Windows ACLs are managed by the installer. */ }
}

export function stripUtf8Bom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

export function preserveUtf8Bom(text: string, original: string): string {
  return original.startsWith("\uFEFF") ? `\uFEFF${stripUtf8Bom(text)}` : stripUtf8Bom(text);
}

export function defaultConfig(mode: RuntimeMode = "browser-only"): AppConfig {
  const home = getConfigDir();
  return {
    version: 3,
    releaseVersion: VERSION,
    mode,
    subagentProtocol: "compatibility-v1",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: CHATGPT_CONNECTOR_NAME,
    chromeExecutablePath: defaultChromeExecutable(),
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(home),
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
    experimentalBiggerContext: false,
    composerPredictionsEnabled: true,
    experimentalSkillAttachments: false,
    experimentalFreshConversationPerTurn: false,
    autoApproveToolCalls: false,
    controlToken: randomBytes(32).toString("base64url"),
    runtimeCommand: currentRuntimeCommand(),
  };
}

export function currentRuntimeCommand(): string[] {
  const executableName = basename(process.execPath).toLowerCase();
  const bunExecutable = executableName === "bun" || executableName === "bun.exe"
    ? installedBunExecutable()
    : undefined;
  return runtimeCommandForProcess({
    launcher: process.env.CODEX_CHATGPT_WEB_LAUNCHER,
    executable: process.execPath,
    entry: typeof Bun !== "undefined" ? Bun.main : process.argv[1],
    bunExecutable,
  });
}

export function installedBunExecutable({
  platform = process.platform,
  pathValue = process.env.PATH || process.env.Path || "",
  candidates = [],
}: {
  platform?: NodeJS.Platform;
  pathValue?: string;
  candidates?: Array<string | null | undefined>;
} = {}): string {
  const executableName = platform === "win32" ? "bun.exe" : "bun";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathCandidates = pathValue
    .split(pathDelimiter)
    .map(part => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .map(part => join(part, executableName));
  const discovered = [
    process.env.CODEX_CHATGPT_WEB_BUN,
    process.env.CODEX_WEB_GPT_BUN,
    ...candidates,
    ...pathCandidates,
    typeof Bun !== "undefined" ? Bun.which("bun") : undefined,
    process.execPath,
  ];
  for (const candidate of discovered) {
    if (!candidate?.trim()) continue;
    const executable = resolve(candidate.trim());
    try {
      assertDurableRuntimeCommand([executable]);
      return executable;
    } catch {
      // Candidate discovery is exhaustive; the final error remains explicit.
    }
  }
  throw new Error("A durable installed Bun executable was not found outside temporary directories");
}

export function runtimeCommandForProcess({
  launcher,
  executable,
  entry,
  bunExecutable,
}: {
  launcher?: string;
  executable: string;
  entry?: string;
  bunExecutable?: string | null;
}): string[] {
  launcher = launcher?.trim();
  if (launcher) {
    const command = [resolve(launcher)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  executable = resolve(executable);
  const executableName = basename(executable).toLowerCase();
  if (executableName === "bun" || executableName === "bun.exe") {
    if (!entry || entry.endsWith("/[eval]") || entry === "[eval]") {
      throw new Error("Cannot install a service from an evaluated Bun script");
    }
    const command = [resolve(bunExecutable?.trim() || executable), resolve(entry)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  const command = [executable];
  assertDurableRuntimeCommand(command);
  return command;
}

function inside(path: string, root: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

export function assertDurableRuntimeCommand(command: string[]): void {
  if (command.length === 0) throw new Error("Runtime command is empty");
  const executable = command[0]!;
  if (!isAbsolute(executable)) throw new Error(`Runtime executable must be absolute: ${executable}`);
  const ephemeralRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
  for (const part of command) {
    if (!isAbsolute(part)) continue;
    if (ephemeralRoots.some(root => inside(part, root))) {
      throw new Error(`Runtime command must not reference an ephemeral path: ${part}`);
    }
  }
  if (!existsSync(executable)) throw new Error(`Runtime executable does not exist: ${executable}`);
}

const LINUX_CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
] as const;

export function defaultChromeExecutable(
  platform = process.platform,
  programFiles = process.env.PROGRAMFILES,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (platform === "win32") {
    return win32.join(programFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  }
  return LINUX_CHROME_CANDIDATES.find(candidate => exists(candidate)) ?? LINUX_CHROME_CANDIDATES[0];
}

export function loadConfig(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Configuration is missing: ${path}. Run codex-chatgpt-web setup first.`);
  return parseConfig(JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))), path);
}

export function loadConfigForSetup(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Configuration is missing: ${path}. Run codex-chatgpt-web setup first.`);
  const raw = JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))) as Record<string, unknown>;
  if (raw.version === 1 && raw.mode === "pro-only") {
    raw.version = 2;
    raw.mode = "browser-only";
  }
  if (raw.version === 2) raw.version = 3;
  return parseConfig(migrateRetiredConfig(raw), path);
}

/**
 * Setup adopts a launcher or Zero Risk configuration as a CLI one: the automatic connector
 * and tunnel are kept, while the launcher's browser session must be replaced by a new login.
 */
function migrateRetiredConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...raw };
  if (migrated.browserInteractionMode === "manual") {
    migrated.appName = migrated.automaticAppName ?? CHATGPT_CONNECTOR_NAME;
    if (migrated.automaticTunnel) migrated.tunnel = migrated.automaticTunnel;
    else delete migrated.tunnel;
  } else if (typeof migrated.automaticAppName === "string") {
    migrated.appName = migrated.automaticAppName;
  }
  if (migrated.automaticTunnel && migrated.browserInteractionMode !== "manual") migrated.tunnel = migrated.automaticTunnel;
  if (migrated.mode === "full" && !migrated.tunnel) migrated.mode = "browser-only";
  for (const key of RETIRED_CONFIG_KEYS) delete migrated[key];
  return migrated;
}

function parseConfig(value: unknown, path: string): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid configuration object in ${path}`);
  const parsed = { ...value } as Partial<AppConfig> & Record<string, unknown>;
  // Retire the old chat-mode preference without invalidating existing installations.
  delete parsed.useSavedChats;
  if (parsed.version !== 3) throw new Error(`Unsupported configuration version in ${path}; rerun setup to migrate it`);
  if (parsed.purpose !== undefined || (parsed.browserHost !== undefined && parsed.browserHost !== "managed-chrome")
    || (parsed.browserInteractionMode !== undefined && parsed.browserInteractionMode !== "automatic")) {
    throw new Error(`${path} belongs to the desktop launcher or Zero Risk, which are no longer supported; rerun setup`);
  }
  for (const key of RETIRED_CONFIG_KEYS) delete parsed[key];
  if (typeof parsed.releaseVersion !== "string" || !parsed.releaseVersion.trim()) throw new Error(`Missing releaseVersion in ${path}`);
  if (parsed.mode !== "browser-only" && parsed.mode !== "full") throw new Error(`Invalid runtime mode in ${path}`);
  const subagentProtocol = parsed.subagentProtocol ?? "compatibility-v1";
  if (subagentProtocol !== "compatibility-v1" && subagentProtocol !== "native") {
    throw new Error(`Invalid subagentProtocol in ${path}`);
  }
  if (parsed.host !== "127.0.0.1") throw new Error("The Responses proxy must bind to 127.0.0.1");
  if (!Number.isInteger(parsed.port) || parsed.port! < 1 || parsed.port! > 65_535) throw new Error(`Invalid port in ${path}`);
  if (!Number.isSafeInteger(parsed.contextWindow) || parsed.contextWindow! <= 0) {
    throw new Error(`Invalid contextWindow in ${path}`);
  }
  if (parsed.chromeGpu !== undefined) parseChromeGpuMode(parsed.chromeGpu, `chromeGpu in ${path}`);
  if (typeof parsed.autoApproveToolCalls !== "boolean") {
    throw new Error(`Invalid autoApproveToolCalls in ${path}`);
  }
  const requiredStrings: Array<keyof AppConfig> = [
    "appName", "chromeExecutablePath", "storageStatePath", "brokerSocketPath", "controlToken",
  ];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) throw new Error(`Missing ${key} in ${path}`);
  }
  if (parsed.appName!.length > 80) throw new Error(`appName is too long in ${path}`);
  if (!isLegacyChatGptConnectorName(parsed.appName!)) validateCurrentConnectorName(parsed.appName!);
  const brokerEndpoint = expandUserPath(parsed.brokerSocketPath!);
  if (process.platform === "win32") {
    if (!isWindowsPipeEndpoint(brokerEndpoint)) {
      throw new Error(`Windows brokerSocketPath must be a named pipe in ${path}`);
    }
  } else if (!isAbsolute(brokerEndpoint) || isWindowsPipeEndpoint(brokerEndpoint)) {
    throw new Error(`brokerSocketPath must be an absolute Unix socket path in ${path}`);
  }
  if (!/^[A-Za-z0-9_-]{40,}$/.test(parsed.controlToken!)) throw new Error(`Invalid controlToken in ${path}`);
  const validateTunnel = (tunnel: TunnelConfig | undefined, label: string): void => {
    if (!tunnel || typeof tunnel !== "object") throw new Error(`${label} is missing in ${path}`);
    for (const key of ["binaryPath", "tunnelId", "runtimeKeyFile", "profileDir", "profileName", "alias"] as const) {
      if (typeof tunnel[key] !== "string" || !tunnel[key].trim()) {
        throw new Error(`Missing ${label}.${key} in ${path}`);
      }
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)) {
      throw new Error(`Invalid ${label}.tunnelId in ${path}`);
    }
    for (const key of ["profileName", "alias"] as const) {
      if (!/^[A-Za-z0-9._-]+$/.test(tunnel[key])) {
        throw new Error(`Invalid ${label}.${key} in ${path}`);
      }
    }
    for (const key of ["binaryPath", "runtimeKeyFile", "profileDir"] as const) {
      if (!isAbsolute(expandUserPath(tunnel[key]))) {
        throw new Error(`${label}.${key} must be absolute in ${path}`);
      }
    }
  };
  if (parsed.mode === "full") {
    validateTunnel(parsed.tunnel, "tunnel");
  }
  if (!Array.isArray(parsed.runtimeCommand) || parsed.runtimeCommand.length === 0
    || parsed.runtimeCommand.some(part => typeof part !== "string" || !part.trim())) {
    throw new Error(`Invalid runtimeCommand in ${path}`);
  }
  assertDurableRuntimeCommand(parsed.runtimeCommand as string[]);
  if (parsed.extraHighAvailable !== undefined && typeof parsed.extraHighAvailable !== "boolean") {
    throw new Error(`Invalid extraHighAvailable in ${path}`);
  }
  if (parsed.proAvailable !== undefined && typeof parsed.proAvailable !== "boolean") {
    throw new Error(`Invalid proAvailable in ${path}`);
  }
  if (parsed.solAvailable !== undefined && typeof parsed.solAvailable !== "boolean") {
    throw new Error(`Invalid solAvailable in ${path}`);
  }
  if (parsed.experimentalBiggerContext !== undefined
    && typeof parsed.experimentalBiggerContext !== "boolean") {
    throw new Error(`Invalid experimentalBiggerContext in ${path}`);
  }
  if (parsed.stallTimeoutSec !== undefined
    && (!Number.isFinite(parsed.stallTimeoutSec) || parsed.stallTimeoutSec <= 0)) {
    throw new Error(`Invalid stallTimeoutSec in ${path}`);
  }
  const solAvailable = parsed.solAvailable !== false;
  const proAvailable = parsed.proAvailable === true;
  if (parsed.experimentalSkillAttachments !== undefined && typeof parsed.experimentalSkillAttachments !== "boolean") {
    throw new Error(`Invalid experimentalSkillAttachments in ${path}`);
  }
  const experimentalSkillAttachments = parsed.experimentalSkillAttachments === true;
  if (parsed.composerPredictionsEnabled !== undefined && typeof parsed.composerPredictionsEnabled !== "boolean") {
    throw new Error(`Invalid composerPredictionsEnabled in ${path}`);
  }
  const composerPredictionsEnabled = parsed.composerPredictionsEnabled !== false;
  if (parsed.experimentalFreshConversationPerTurn !== undefined
    && typeof parsed.experimentalFreshConversationPerTurn !== "boolean") {
    throw new Error(`Invalid experimentalFreshConversationPerTurn in ${path}`);
  }
  const experimentalFreshConversationPerTurn = parsed.experimentalFreshConversationPerTurn === true;
  const experimentalBiggerContext = parsed.experimentalBiggerContext === true;
  if (parsed.extraHighAvailable === true && !solAvailable) {
    throw new Error(`Invalid ChatGPT account capabilities in ${path}: Extra High requires Sol`);
  }
  if (proAvailable && !solAvailable) {
    throw new Error(`Invalid ChatGPT account capabilities in ${path}: Pro requires Sol`);
  }
  return {
    ...parsed,
    subagentProtocol,
    solAvailable,
    proAvailable,
    experimentalBiggerContext,
    composerPredictionsEnabled,
    experimentalSkillAttachments,
    experimentalFreshConversationPerTurn,
  } as AppConfig;
}

export function saveConfig(config: AppConfig): void {
  const path = getConfigPath();
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  atomicWriteFile(path, preserveUtf8Bom(`${JSON.stringify(config, null, 2)}\n`, original));
}

export function providerConfig(config: AppConfig): CodexProviderConfig {
  const model = config.solAvailable ? "gpt-5.6-sol" : "gpt-5.6-luna";
  const models = [model];
  const efforts = config.solAvailable
    ? ["low", "medium", "high", ...(config.extraHighAvailable === true ? ["xhigh"] : []), ...(config.proAvailable ? ["max"] : [])]
    : ["low", "medium"];
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    models,
    liveModels: false,
    defaultModel: model,
    contextWindow: config.contextWindow,
    modelInputModalities: Object.fromEntries(models.map(model => [model, ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(models.map(modelId => [modelId, efforts])),
    modelDefaultReasoningEfforts: Object.fromEntries(
      models.map(modelId => [modelId, config.solAvailable ? "high" : "low"]),
    ),
    noReasoningModels: [],
    chatgptWeb: {
      appName: config.appName,
      storageStatePath: config.storageStatePath,
      chromeExecutablePath: config.chromeExecutablePath,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(getConfigDir(), "runtime", "thread-environments.json"),
      lunaCheckpointStatePath: join(getConfigDir(), "runtime", "luna-checkpoints.json"),
      ...(config.chromeGpu ? { chromeGpu: config.chromeGpu } : {}),
      localToolsEnabled: config.mode === "full",
      solAvailable: config.solAvailable,
      extraHighAvailable: config.extraHighAvailable === true,
      proAvailable: config.proAvailable,
      experimentalBiggerContext: config.experimentalBiggerContext,
      experimentalSkillAttachments: config.experimentalSkillAttachments,
      experimentalFreshConversationPerTurn: config.experimentalFreshConversationPerTurn === true,
      ...(config.stallTimeoutSec !== undefined ? { stallTimeoutSec: config.stallTimeoutSec } : {}),
      autoApproveToolCalls: config.autoApproveToolCalls,
    },
  };
}
