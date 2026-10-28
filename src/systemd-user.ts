import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./config";
import { runCommand, runChecked } from "./process";

/** Linux background services run as systemd user units next to launchd agents on macOS. */
export interface SystemdUnitStatus {
  supported: boolean;
  installed: boolean;
  active: boolean;
  path: string;
}

export interface SystemdUnitDefinition {
  description: string;
  execStart: string[];
  environment: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

export function systemdUserUnitPath(unit: string): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "systemd", "user", unit);
}

function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("systemd unit values must not contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;
}

export function systemdUnitFile(definition: SystemdUnitDefinition): string {
  const environment = Object.entries(definition.environment)
    .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`);
  return `[Unit]
Description=${definition.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${definition.execStart.map(quote).join(" ")}
${environment.join("\n")}
Restart=always
RestartSec=10
StandardOutput=append:${definition.stdoutPath}
StandardError=append:${definition.stderrPath}

[Install]
WantedBy=default.target
`;
}

/** Runs a probe whose tool may not be installed at all (containers often have no systemd). */
function probe(command: string, args: string[]): { status: number; stdout: string } {
  try {
    return runCommand(command, args);
  } catch {
    return { status: 127, stdout: "" };
  }
}

/** systemctl --user needs a user manager; containers and some SSH sessions have none. */
export function systemdUserAvailable(): boolean {
  if (process.platform !== "linux") return false;
  return probe("systemctl", ["--user", "show-environment"]).status === 0;
}

export function systemdUnitStatus(unit: string): SystemdUnitStatus {
  const path = systemdUserUnitPath(unit);
  if (!systemdUserAvailable()) return { supported: false, installed: existsSync(path), active: false, path };
  const active = probe("systemctl", ["--user", "is-active", "--quiet", unit]).status === 0;
  return { supported: true, installed: existsSync(path), active, path };
}

export function systemdUnitMatches(unit: string, contents: string): boolean {
  const path = systemdUserUnitPath(unit);
  return existsSync(path) && readFileSync(path, "utf8") === contents;
}

function assertAvailable(): void {
  if (!systemdUserAvailable()) {
    throw new Error(
      "systemd user services are unavailable on this host (systemctl --user failed). "
      + "Run the command in the foreground or under your own process supervisor instead.",
    );
  }
}

export function installSystemdUnit(unit: string, contents: string, logDirectory: string): void {
  assertAvailable();
  const path = systemdUserUnitPath(unit);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (!systemdUnitMatches(unit, contents)) atomicWriteFile(path, contents, { protectDirectory: false });
  runChecked("systemctl", ["--user", "daemon-reload"]);
  runChecked("systemctl", ["--user", "enable", "--now", unit]);
}

export function startSystemdUnit(unit: string): void {
  assertAvailable();
  if (!existsSync(systemdUserUnitPath(unit))) throw new Error(`Service is not installed: ${systemdUserUnitPath(unit)}`);
  runChecked("systemctl", ["--user", "start", unit]);
}

export function stopSystemdUnit(unit: string): void {
  assertAvailable();
  runChecked("systemctl", ["--user", "stop", unit]);
}

export function restartSystemdUnit(unit: string): void {
  assertAvailable();
  runChecked("systemctl", ["--user", "restart", unit]);
}

export function uninstallSystemdUnit(unit: string): void {
  assertAvailable();
  runCommand("systemctl", ["--user", "disable", "--now", unit]);
  rmSync(systemdUserUnitPath(unit), { force: true });
  runChecked("systemctl", ["--user", "daemon-reload"]);
}

/** Without lingering, systemd stops user services when the last session of the user ends. */
export function systemdLingerEnabled(user = process.env.USER ?? ""): boolean {
  if (!user) return false;
  const result = probe("loginctl", ["show-user", user, "--property=Linger", "--value"]);
  return result.status === 0 && result.stdout.trim() === "yes";
}
