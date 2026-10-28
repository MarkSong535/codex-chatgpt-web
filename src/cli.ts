#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import {
  loginWithAccount,
  type AccountLoginInput,
  type AccountLoginProgress,
  type VerificationCodeKind,
} from "./account-login";
import { checkBrowserEngine, importBrowserLogin } from "./browser-login";
import { parseChromeGpuMode } from "./chrome-launch";
import {
  defaultChromeExecutable,
  getConfigDir,
  getConfigPath,
  loadConfig,
  loadConfigForSetup,
  playwrightChromiumExecutable,
} from "./config";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  inspectCodexIntegration,
  readCodexSubagentProtocol,
  setCodexSubagentProtocol,
  uninstallCodexIntegration,
} from "./codex-integration";
import { formatDoctorReport, runDoctor } from "./doctor";
import { runChatGptMcpMain } from "./adapters/chatgpt-web/mcp-main";
import { runCommand } from "./process";
import { startServer } from "./server";
import { assertServiceIdle, cancelActiveTurns, getServiceStatus, installService, interruptActiveTurn, restartService, startService, stopService, uninstallService } from "./service";
import { existingFullSetupCredentials, preflightSetup, setup, type SetupOptions } from "./setup";
import { installRuntimeKeyBytes, managedRuntimeKeyPath, stopTunnel, tunnelStatus, waitForTunnelReady } from "./tunnel";
import { systemdLingerEnabled } from "./systemd-user";
import {
  getTunnelServiceStatus,
  restartTunnelService,
  startTunnelService,
  stopTunnelService,
  tunnelForegroundCommand,
  uninstallTunnelService,
} from "./tunnel-service";
import { VERSION } from "./version";

const HELP = `codex-chatgpt-web ${VERSION}

Focused ChatGPT web-backed models for the native Codex harness, driven by Chrome (on Linux on a
private Xvfb display, so no monitor is needed).

Usage:
  codex-chatgpt-web setup --browser-only [options]
  codex-chatgpt-web setup --full --tunnel-id ID --runtime-key-file PATH [options]
  codex-chatgpt-web login [--email EMAIL] [--password-file PATH] [--totp-secret-file PATH]
  codex-chatgpt-web login --import-login PATH
  codex-chatgpt-web doctor [--json]
  codex-chatgpt-web route <status|connect|disconnect>
  codex-chatgpt-web subagents <status|compatibility-v1|native>
  codex-chatgpt-web browser check
  codex-chatgpt-web browser install [--with-deps]
  codex-chatgpt-web serve
  codex-chatgpt-web mcp [--broker-socket PATH]
  codex-chatgpt-web service <status|install|start|restart|stop|cancel-turns>
  codex-chatgpt-web tunnel <status|start|restart|stop|run|key-import>
  codex-chatgpt-web open <tunnels|runtime-keys|connectors>
  codex-chatgpt-web uninstall --yes

Sign-in (setup and login):
  --email EMAIL                ChatGPT account email (or CODEX_CHATGPT_WEB_EMAIL; prompted if unset)
  --password-file PATH         File holding the password (or CODEX_CHATGPT_WEB_PASSWORD; prompted
                               without echo if unset). Passwords are never accepted as arguments.
  --totp-secret-file PATH      Authenticator secret or otpauth:// URI (or CODEX_CHATGPT_WEB_TOTP_SECRET)
                               to fill authenticator codes automatically; otherwise you are asked
                               for each code (authenticator, email, or SMS)
  --import-login PATH          Use a saved Playwright storage state instead of signing in

Setup options:
  --browser-only               Account-eligible Web models, full context/images, no local tools or tunnel
  --full                       Account-eligible Web models with tools through the configured connector
  --port NUMBER                Loopback Responses port (default: 17841)
  --chrome PATH                Google Chrome/Chromium executable
  --chrome-gpu MODE            auto (default), hardware, or software (SwiftShader, no GPU needed)
  --refresh-account-capabilities
                               Re-read the authenticated account's available Web models
  --tunnel-id ID               Existing OpenAI tunnel id (full mode)
  --runtime-key-file PATH      File containing a Tunnels Read+Use runtime key
  --replace-codex-route        Reversibly replace existing Responses or Voice route settings
  --subagent-protocol MODE     compatibility-v1 (default) or native (advanced)
  --restart-service            Explicitly restart this project's daemon after an update
  --login                      Sign in again even if a stored ChatGPT login exists
  --auto-approve-tool-calls    Opt in to per-call browser clicks on "Allow once" prompts
  --bigger-context             Enable experimental adaptive 1/2/6-message context
  --fresh-conversation         Start each automatic turn in a fresh browser chat
  --retained-conversation      Reuse the browser chat between turns (default)
  --composer-predictions       Enable next-message suggestions using GPT-6 Sol Medium (default)
  --no-composer-predictions    Disable next-message suggestions for Web models
  --skill-attachments         Experimental selected skills as text attachments
  --inline-skills             Keep selected skills inline (default)
  --standard-context           Disable experimental multi-message context
  --acknowledge-unofficial     Accept the one-time unofficial-browser-automation notice

Global:
  --home PATH                  Override ~/.codex-chatgpt-web
  -h, --help
  -v, --version
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await reader.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

async function prompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  const reader = createInterface({ input: stdin, output: stdout });
  try { return (await reader.question(question)).trim(); }
  finally { reader.close(); }
}

async function secretPrompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  stdout.write(question);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: stdin, output: muted, terminal: true });
  try { return (await reader.question("")).trim(); }
  finally {
    reader.close();
    stdout.write("\n");
  }
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
}

function readSecretFile(path: string, label: string): string {
  const absolute = resolve(path);
  if (process.platform !== "win32" && (statSync(absolute).mode & 0o077) !== 0) {
    process.stderr.write(`Warning: ${absolute} is readable by other users; restrict it with chmod 600.\n`);
  }
  const value = readFileSync(absolute, "utf8").replace(/\r?\n$/, "");
  if (!value) throw new Error(`The ${label} file is empty: ${absolute}`);
  return value;
}

function codeKindLabel(kind: VerificationCodeKind): string {
  return kind === "authenticator" ? "authenticator app"
    : kind === "email" ? "email"
      : kind === "sms" ? "text message"
        : "verification";
}

function printLoginProgress(event: AccountLoginProgress): void {
  stdout.write(`[${event.step}/${event.total}] ${event.title}${event.detail ? `: ${event.detail}` : ""}\n`);
}

/** Reads sign-in flags now; credentials are gathered only if a sign-in is actually needed. */
function takeAccountLoginOptions(args: string[]): () => Promise<AccountLoginInput> {
  const emailOption = takeOption(args, "--email");
  const passwordFile = takeOption(args, "--password-file");
  const totpSecretFile = takeOption(args, "--totp-secret-file");
  if (takeOption(args, "--password") !== undefined) {
    throw new Error("Passwords are not accepted as arguments; use --password-file, CODEX_CHATGPT_WEB_PASSWORD, or the prompt");
  }
  return async () => {
    const interactive = Boolean(stdin.isTTY && stdout.isTTY);
    const email = emailOption?.trim()
      || process.env.CODEX_CHATGPT_WEB_EMAIL?.trim()
      || await prompt("ChatGPT account email: ");
    if (!email) throw new Error("A ChatGPT account email is required: pass --email or set CODEX_CHATGPT_WEB_EMAIL");
    const password = passwordFile
      ? readSecretFile(passwordFile, "password")
      : process.env.CODEX_CHATGPT_WEB_PASSWORD || await secretPrompt("ChatGPT password (hidden): ");
    if (!password) {
      throw new Error("A ChatGPT password is required: use --password-file, CODEX_CHATGPT_WEB_PASSWORD, or run in a terminal");
    }
    const totpSecret = totpSecretFile
      ? readSecretFile(totpSecretFile, "TOTP secret")
      : process.env.CODEX_CHATGPT_WEB_TOTP_SECRET?.trim() || undefined;
    return {
      email,
      password,
      ...(totpSecret ? { totpSecret } : {}),
      ...(interactive ? {
        requestCode: async ({ kind, attempt }) => {
          const label = codeKindLabel(kind);
          const where = kind === "email" ? "check your inbox for the code OpenAI just sent"
            : kind === "sms" ? "check your phone for the code OpenAI just sent"
              : "open your authenticator app";
          if (attempt === 1) stdout.write(`      Two-factor verification: ${where}.\n`);
          return await prompt(`      Enter the ${label} code${attempt > 1 ? " (previous code was rejected)" : ""}: `);
        },
      } : {}),
      progress: printLoginProgress,
    };
  };
}

async function loginCommand(args: string[]): Promise<void> {
  const importPath = takeOption(args, "--import-login");
  const accountLogin = takeAccountLoginOptions(args);
  assertNoArgs(args);
  const config = loadConfig();
  const result = importPath
    ? await importBrowserLogin(config, resolve(importPath))
    : await loginWithAccount(config, await accountLogin());
  stdout.write(`ChatGPT login stored at ${result.storageStatePath}\n`);
  if (getServiceStatus().loaded) stdout.write("Restart the daemon to use it: codex-chatgpt-web service restart\n");
}

/**
 * Downloads Playwright's Chromium build for the bundled Playwright version, for hosts without a usable
 * system Chrome (Linux arm64 has no Google Chrome, and Ubuntu's chromium is a confined snap).
 */
async function browserInstallCommand(args: string[]): Promise<void> {
  const withDeps = takeFlag(args, "--with-deps");
  assertNoArgs(args);
  // playwright-core exports its package.json but not cli.js, so locate the installer beside it.
  const installer = join(dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "cli.js");
  const child = spawn(process.execPath, [installer, "install", "--no-shell", ...(withDeps ? ["--with-deps"] : []), "chromium"], {
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Chromium installation failed (exit ${exitCode})`);
  const executable = playwrightChromiumExecutable();
  if (!executable) throw new Error("The installer finished, but no Playwright Chromium was found");
  stdout.write(`Chromium is installed at ${executable}.\n`);
  stdout.write(defaultChromeExecutable() === executable
    ? "Rerun setup with your usual flags to use it.\n"
    : `Another browser is preferred automatically; to use this one, rerun setup with --chrome ${executable}\n`);
}

async function setupCommand(args: string[]): Promise<void> {
  const preflightOnly = takeFlag(args, "--preflight-only");
  const browserOnly = takeFlag(args, "--browser-only");
  const full = takeFlag(args, "--full");
  if (browserOnly === full) throw new Error("Choose exactly one setup mode: --browser-only or --full");
  const portRaw = takeOption(args, "--port");
  let acknowledged = takeFlag(args, "--acknowledge-unofficial");
  const options: SetupOptions = {
    mode: full ? "full" : "browser-only",
    ...(portRaw ? { port: Number(portRaw) } : {}),
  };
  const connectorNameSuffix = takeOption(args, "--connector-name-suffix");
  if (connectorNameSuffix !== undefined) options.connectorNameSuffix = connectorNameSuffix;
  const subagentProtocol = takeOption(args, "--subagent-protocol");
  if (subagentProtocol !== undefined) {
    if (subagentProtocol !== "compatibility-v1" && subagentProtocol !== "native") {
      throw new Error("--subagent-protocol must be compatibility-v1 or native");
    }
    options.subagentProtocol = subagentProtocol;
  }
  const tunnelId = takeOption(args, "--tunnel-id");
  const runtimeKeyFile = takeOption(args, "--runtime-key-file");
  const chrome = takeOption(args, "--chrome");
  if (chrome) options.chromeExecutablePath = resolve(chrome);
  const chromeGpu = takeOption(args, "--chrome-gpu");
  if (chromeGpu !== undefined) options.chromeGpu = parseChromeGpuMode(chromeGpu, "--chrome-gpu");
  const importLogin = takeOption(args, "--import-login");
  if (importLogin) options.importLoginPath = resolve(importLogin);
  options.accountLogin = takeAccountLoginOptions(args);
  options.refreshAccountCapabilities = takeFlag(args, "--refresh-account-capabilities");
  if (tunnelId) options.tunnelId = tunnelId;
  if (runtimeKeyFile) options.runtimeKeyFile = runtimeKeyFile;
  options.forceLogin = takeFlag(args, "--login");
  options.autoApproveToolCalls = takeFlag(args, "--auto-approve-tool-calls");
  const predictions = takeFlag(args, "--composer-predictions");
  const noPredictions = takeFlag(args, "--no-composer-predictions");
  if (predictions && noPredictions) throw new Error("Choose --composer-predictions or --no-composer-predictions");
  if (predictions || noPredictions) options.composerPredictionsEnabled = predictions;
  const skillAttachments = takeFlag(args, "--skill-attachments");
  const inlineSkills = takeFlag(args, "--inline-skills");
  if (skillAttachments && inlineSkills) throw new Error("Choose --skill-attachments or --inline-skills");
  const freshConversation = takeFlag(args, "--fresh-conversation");
  const retainedConversation = takeFlag(args, "--retained-conversation");
  if (freshConversation && retainedConversation) {
    throw new Error("Choose --fresh-conversation or --retained-conversation");
  }
  if (freshConversation || retainedConversation) options.experimentalFreshConversationPerTurn = freshConversation;
  const biggerContext = takeFlag(args, "--bigger-context");
  const standardContext = takeFlag(args, "--standard-context");
  if (biggerContext && standardContext) {
    throw new Error("Choose at most one context mode: --bigger-context or --standard-context");
  }
  if (biggerContext || standardContext) options.experimentalBiggerContext = biggerContext;
  if (skillAttachments || inlineSkills) options.experimentalSkillAttachments = skillAttachments;
  options.replaceCodexRoute = takeFlag(args, "--replace-codex-route");
  options.preserveDisconnectedRoute = takeFlag(args, "--preserve-disconnected-route");
  options.restartService = takeFlag(args, "--restart-service");
  assertNoArgs(args);

  if (!acknowledged) {
    stdout.write(
      "This is independent, unofficial software. It automates your ChatGPT web session, can break when the UI changes, "
      + "and must not be used to evade usage limits or access controls.\n",
    );
    acknowledged = await confirm("Continue and store this acknowledgement?");
  }
  if (!acknowledged) throw new Error("Setup cancelled: acknowledgement was not provided");
  options.acknowledgedUnofficial = true;

  if (preflightOnly) {
    preflightSetup(options);
    stdout.write("Setup preflight complete.\n");
    return;
  }

  const existing = existsSync(getConfigPath()) ? loadConfigForSetup() : undefined;
  const reusableCredentials = existingFullSetupCredentials(existing);
  const needsTunnelId = !options.tunnelId && !reusableCredentials.tunnelId;
  const needsRuntimeKey = !options.runtimeKeyFile
    && !reusableCredentials.runtimeKey
    && !existsSync(managedRuntimeKeyPath());

  if (full && (needsTunnelId || needsRuntimeKey) && stdin.isTTY) {
    stdout.write("Full mode needs an OpenAI tunnel and a runtime key with Tunnels Read + Use.\n");
    stdout.write("Tunnels: https://platform.openai.com/settings/organization/tunnels\n");
    stdout.write("Runtime keys: https://platform.openai.com/settings/organization/api-keys\n");
    if (needsTunnelId) options.tunnelId = await prompt("Tunnel id: ");
    if (needsRuntimeKey) {
      options.runtimeKeyValue = await secretPrompt("Runtime key (hidden): ");
    }
  }

  const result = await setup(options);
  stdout.write(`Setup complete: ${result.mode}\n`);
  stdout.write(`Config: ${result.configPath}\n`);
  if (!result.serviceSupported) {
    stdout.write("No service manager (launchd or systemd --user) is available, so nothing runs in the background.\n");
    stdout.write("Keep these running yourself, for example under your container's process supervisor:\n");
    stdout.write("  codex-chatgpt-web serve\n");
    if (result.mode === "full") stdout.write("  codex-chatgpt-web tunnel run\n");
  } else if (process.platform === "linux" && !systemdLingerEnabled()) {
    stdout.write("systemd stops user services when you log out. To keep them running, enable lingering once:\n");
    stdout.write("  sudo loginctl enable-linger \"$USER\"\n");
  }
  if (result.connectorSetupRequired) {
    stdout.write("One account-level step remains: attach the tunnel to the ChatGPT connector named in config.\n");
    stdout.write("Open: https://chatgpt.com/#settings/Plugins\n");
  }
  stdout.write("Restart the Codex app once so its native model catalog refreshes through the installed route.\n");
}

async function doctorCommand(args: string[]): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const report = await runDoctor();
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function routeCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  const forRuntimeRecovery = action === "disconnect" && takeFlag(args, "--for-runtime-recovery");
  assertNoArgs(args);
  const result = action === "status"
    ? (() => {
        const status = inspectCodexIntegration();
        return {
          installed: status.installed,
          active: status.active,
          ...(status.journal && "reconnectOnStartup" in status.journal && status.journal.reconnectOnStartup
            ? { reconnectOnStartup: true } : {}),
          ...(status.routeUrl ? { routeUrl: status.routeUrl } : {}),
          errors: status.errors,
        };
      })()
    : action === "connect" || action === "recover"
      ? activateCodexIntegration({ recoveryOnly: action === "recover" })
      : action === "disconnect"
        ? deactivateCodexIntegration({ forRuntimeRecovery })
        : undefined;
  if (!result) throw new Error(`Unknown route action: ${action}`);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if ("changed" in result && result.changed) {
    process.stderr.write("Fully restart Codex to apply the route change.\n");
  }
}

async function subagentsCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const config = loadConfig();
  if (action === "status") {
    const integration = inspectCodexIntegration();
    stdout.write(`${JSON.stringify({
      protocol: readCodexSubagentProtocol(config.subagentProtocol),
      installed: integration.installed,
      active: integration.active,
    }, null, 2)}\n`);
    return;
  }
  if (action !== "compatibility-v1" && action !== "native") {
    throw new Error("Subagent protocol must be one of: status, compatibility-v1, native");
  }
  const journal = setCodexSubagentProtocol(config, action);
  stdout.write(`${JSON.stringify({
    protocol: journal.installed.subagent_protocol,
    codexRestartRequired: true,
  }, null, 2)}\n`);
}

async function serviceCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const config = action === "status" ? undefined : loadConfig();
  if (action === "cancel-turns") {
    stdout.write(`${JSON.stringify(await cancelActiveTurns(config!), null, 2)}\n`);
    return;
  }
  const status = action === "status" ? getServiceStatus()
    : action === "install" ? installService(config!)
      : action === "start" ? startService()
        : action === "restart" ? await restartService(config!)
          : action === "stop" ? await stopService(config!)
            : undefined;
  if (!status) throw new Error(`Unknown service action: ${action}`);
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function interruptHookCommand(args: string[]): Promise<void> {
  assertNoArgs(args);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 32 * 1024) throw new Error("Codex Interrupt hook payload is too large");
    chunks.push(buffer);
  }
  let payload: { hook_event_name?: unknown; session_id?: unknown; turn_id?: unknown };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Codex Interrupt hook payload is not valid JSON");
  }
  const threadId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
  if (payload.hook_event_name !== "Interrupt"
    || !/^[A-Za-z0-9_-]{6,128}$/.test(threadId)
    || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
    throw new Error("Codex Interrupt hook payload has no valid session_id or turn_id");
  }
  await interruptActiveTurn(loadConfig(), { threadId, turnId });
}

async function tunnelCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  if (action === "key-import") {
    const key = await secretPrompt("Runtime key (hidden): ");
    if (!key) throw new Error("A non-empty runtime key is required");
    installRuntimeKeyBytes(key);
    stdout.write(`Runtime key stored privately at ${managedRuntimeKeyPath()}\n`);
    return;
  }
  const config = loadConfig();
  if (action === "run") {
    // Foreground runtime for hosts without a service manager; exits with the tunnel client.
    const [command, ...commandArgs] = tunnelForegroundCommand(config);
    const child = spawn(command!, commandArgs, {
      stdio: "inherit",
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: getConfigDir(), MCP_STDIO_SEND_INITIALIZED_NOTIFICATION: "true" },
    });
    const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    process.exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit(signal ? 1 : code ?? 1));
    });
    return;
  }
  if (action === "start") startTunnelService();
  else if (action === "restart") {
    await assertServiceIdle(config);
    await restartTunnelService();
  }
  else if (action === "stop") {
    await assertServiceIdle(config);
    await stopTunnelService();
    stopTunnel(config);
  }
  else if (action !== "status") throw new Error(`Unknown tunnel action: ${action}`);
  const status = action === "start" || action === "restart"
    ? await waitForTunnelReady(config)
    : tunnelStatus(config);
  const service = getTunnelServiceStatus();
  stdout.write(`${JSON.stringify({ service, runtime: status }, null, 2)}\n`);
  if (action !== "stop" && (!service.running || !status.ok)) process.exitCode = 1;
}

async function openCommand(args: string[]): Promise<void> {
  const target = args.shift();
  assertNoArgs(args);
  const urls: Record<string, string> = {
    tunnels: "https://platform.openai.com/settings/organization/tunnels",
    "runtime-keys": "https://platform.openai.com/settings/organization/api-keys",
    connectors: "https://chatgpt.com/#settings/Plugins",
  };
  const url = target ? urls[target] : undefined;
  if (!url) throw new Error("Choose one of: tunnels, runtime-keys, connectors");
  if (process.platform === "darwin") {
    const result = runCommand("open", [url]);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
  } else {
    stdout.write(`${url}\n`);
  }
}

async function uninstallCommand(args: string[]): Promise<void> {
  const yes = takeFlag(args, "--yes");
  const keepData = takeFlag(args, "--keep-data");
  assertNoArgs(args);
  if (!yes && !await confirm("Restore Codex config, stop services, and remove this installation?")) {
    throw new Error("Uninstall cancelled");
  }
  const config = existsSync(getConfigPath()) ? loadConfig() : undefined;
  const service = getServiceStatus();
  if (!config && service.installed) {
    throw new Error("Service exists but configuration is missing; refusing an unverifiable uninstall");
  }
  if (config && service.supported) await assertServiceIdle(config);
  if (config?.mode === "full") {
    if (getTunnelServiceStatus().supported) await uninstallTunnelService();
    stopTunnel(config);
  }
  if (config && service.supported) await uninstallService(config);
  uninstallCodexIntegration();
  if (!keepData) rmSync(getConfigDir(), { recursive: true, force: true });
  stdout.write(keepData ? "Uninstalled; private application data was preserved.\n" : "Uninstalled and removed private application data.\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = takeOption(args, "--home");
  if (home) process.env.CODEX_CHATGPT_WEB_HOME = home;
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    stdout.write(HELP);
    return;
  }
  if (takeFlag(args, "--version") || takeFlag(args, "-v")) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.shift() ?? "help";
  if (command === "help") stdout.write(HELP);
  else if (command === "setup") await setupCommand(args);
  else if (command === "login") await loginCommand(args);
  else if (command === "doctor" || command === "status") await doctorCommand(args);
  else if (command === "route") await routeCommand(args);
  else if (command === "subagents") await subagentsCommand(args);
  else if (command === "browser") {
    const action = args.shift();
    if (action === "install") await browserInstallCommand(args);
    else {
      assertNoArgs(args);
      if (action !== "check") throw new Error("Browser command must be: browser check or browser install");
      const config = loadConfig();
      await checkBrowserEngine(config);
      stdout.write("Playwright can launch the configured Chrome executable.\n");
    }
  } else if (command === "serve") {
    assertNoArgs(args);
    const config = loadConfig();
    const server = startServer(config);
    stdout.write(`codex-chatgpt-web ${VERSION} listening on http://${config.host}:${server.port}/v1 (${config.mode})\n`);
    await new Promise<void>(() => {});
  } else if (command === "mcp") await runChatGptMcpMain(args);
  else if (command === "service") await serviceCommand(args);
  else if (command === "hook") {
    const action = args.shift();
    if (action !== "interrupt") throw new Error("Hook command must be: hook interrupt");
    await interruptHookCommand(args);
  }
  else if (command === "tunnel") await tunnelCommand(args);
  else if (command === "open") await openCommand(args);
  else if (command === "uninstall") await uninstallCommand(args);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`codex-chatgpt-web: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
