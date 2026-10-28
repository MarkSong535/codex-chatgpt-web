import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../src/config";
import * as integration from "../src/codex-integration";
import * as service from "../src/service";
import * as tunnel from "../src/tunnel";
import * as tunnelService from "../src/tunnel-service";
import * as accountLogin from "../src/account-login";
import * as browserLogin from "../src/browser-login";
import { portBindFailureMessage, setup, setupProxyIsReady } from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

// #712: after a restart Windows can reserve the bridge port; Node reports that as EACCES.
test("Windows EACCES suggests checks without claiming a port reservation is proven", () => {
  const reserved = Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:17841"), { code: "EACCES" });
  const busy = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:17841"), { code: "EADDRINUSE" });
  const plain = "Cannot bind 127.0.0.1:17841: listen EACCES: permission denied 127.0.0.1:17841";

  const explained = portBindFailureMessage("127.0.0.1", 17841, reserved, "win32");
  expect(explained.startsWith(`${plain}. Windows may have reserved this port`)).toBeTrue();
  expect(explained).toContain("another service may hold it exclusively");
  expect(explained).toContain("TROUBLESHOOTING.md");
  // Elsewhere EACCES is a real permission error, and a busy port has its own owner to find.
  expect(portBindFailureMessage("127.0.0.1", 17841, reserved, "linux")).toBe(plain);
  expect(portBindFailureMessage("127.0.0.1", 17841, busy, "win32"))
    .toBe("Cannot bind 127.0.0.1:17841: listen EADDRINUSE: address already in use 127.0.0.1:17841");
});

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test.skipIf(process.platform === "win32")("external service setup retains validation cleanup on success and failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-external-setup-"));
  const configPath = join(root, "config.json");
  const key = join(root, "runtime.key");
  writeFileSync(key, "fixture-runtime-key");
  writeFileSync(configPath, "{}");
  const existing = {
    ...configModule.defaultConfig("full"),
    subagentProtocol: "native" as const,
    acknowledgedUnofficialAt: new Date().toISOString(),
  };
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({
    service: "codex-chatgpt-web", status: "ok", mode: "full", version: existing.releaseVersion, accepting_turns: true,
  }) });
  existing.port = proxy.port!;
  const calls: string[] = [];
  let ready = true;
  let stopFails = false;
  const mocks = [
    spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
    spyOn(configModule, "loadConfigForSetup").mockReturnValue(existing),
    spyOn(configModule, "saveConfig").mockImplementation(() => {}),
    spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
    spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
    spyOn(browserLogin, "browserLoginStateExists").mockReturnValue(true),
    spyOn(browserLogin, "storedBrowserLoginCapabilities").mockReturnValue({ solAvailable: true, extraHighAvailable: false, proAvailable: false } as never),
    spyOn(service, "getServiceStatus").mockReturnValue({ supported: true, installed: true, loaded: true } as never),
    spyOn(service, "assertServiceIdle").mockResolvedValue(undefined),
    spyOn(service, "installService").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "restartService").mockResolvedValue({ installed: true, loaded: true } as never),
    spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
    spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ supported: true, installed: false, loaded: false } as never),
    spyOn(tunnelService, "installTunnelService").mockImplementation(() => { calls.push("service"); return { installed: true, loaded: true } as never; }),
    spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
    spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
    spyOn(tunnel, "connectTunnel").mockImplementation(() => { calls.push("connect"); }),
    spyOn(tunnel, "waitForTunnelReady").mockImplementation(async () => { calls.push("ready"); return { ok: ready, detail: "fixture readiness" } as never; }),
    spyOn(tunnel, "stopTunnel").mockImplementation(() => {
      calls.push("stop");
      if (stopFails) throw new Error("fixture stop failure");
    }),
  ];
  try {
    const options = { mode: "full" as const, subagentProtocol: "native" as const, tunnelId: `tunnel_${"b".repeat(32)}`, restartService: true };
    expect((await setup(options)).tunnelReady).toBe(true);
    expect(calls).toEqual(["connect", "ready", "stop", "service", "ready"]);
    ready = false;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("did not become healthy and ready");
    expect(calls).toEqual(["connect", "ready", "stop"]);
    stopFails = true;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("fixture readiness; temporary tunnel cleanup also failed: fixture stop failure");
    expect(calls).toEqual(["connect", "ready", "stop"]);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    await proxy.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

/** No service manager, so setup commits config and integration without starting or probing a daemon. */
async function browserOnlySetupMocks(root: string, overrides: { loginState?: boolean } = {}) {
  const configPath = join(root, "config.json");
  const calls: string[] = [];
  const existing = {
    ...configModule.defaultConfig("browser-only"),
    storageStatePath: join(root, "browser", "storage-state.json"),
    acknowledgedUnofficialAt: new Date().toISOString(),
  };
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  existing.port = probe.port!;
  await probe.stop(true);
  writeFileSync(configPath, "{}");
  const mocks = [
    spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
    spyOn(configModule, "loadConfigForSetup").mockReturnValue(existing),
    spyOn(configModule, "saveConfig").mockImplementation(() => { calls.push("save"); }),
    spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
    spyOn(integration, "installCodexIntegration").mockImplementation(() => { calls.push("integration"); return {} as never; }),
    spyOn(browserLogin, "browserLoginStateExists").mockReturnValue(overrides.loginState ?? false),
    spyOn(browserLogin, "storedBrowserLoginCapabilities").mockReturnValue({}),
    spyOn(service, "getServiceStatus").mockReturnValue({ supported: false, installed: false, loaded: false } as never),
    spyOn(service, "installService").mockImplementation(() => { calls.push("service"); return {} as never; }),
    spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
  ];
  return {
    calls,
    restore() {
      for (const mock of mocks.reverse()) mock.mockRestore();
    },
  };
}

test.skipIf(process.platform === "win32")("setup signs in with the account only when a login is needed", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-account-setup-"));
  const fixture = await browserOnlySetupMocks(root);
  const credentials = { email: "user@example.com", password: "fixture-password" };
  const provider = { calls: 0 };
  const login = spyOn(accountLogin, "loginWithAccount").mockResolvedValue({
    storageStatePath: join(root, "browser", "storage-state.json"), accountSurfaceUrl: "https://chatgpt.com/",
    solAvailable: true, extraHighAvailable: false, proAvailable: true,
  });
  try {
    const result = await setup({
      mode: "browser-only",
      accountLogin: async () => { provider.calls += 1; return credentials; },
    });
    expect(result.loginCreated).toBe(true);
    expect(provider.calls).toBe(1);
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0]![1]).toBe(credentials);
    await expect(setup({ mode: "browser-only" })).rejects.toThrow("pass --email (and a password) or --import-login");
  } finally {
    login.mockRestore();
    fixture.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("setup without a service manager saves everything and starts nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-unsupervised-setup-"));
  const fixture = await browserOnlySetupMocks(root, { loginState: true });
  const capabilities = spyOn(browserLogin, "inspectBrowserLoginCapabilities").mockResolvedValue({
    solAvailable: true, extraHighAvailable: false, proAvailable: false,
  });
  try {
    const result = await setup({ mode: "browser-only", accountLogin: async () => { throw new Error("not needed"); } });
    expect(result).toMatchObject({ serviceSupported: false, serviceLoaded: false, loginCreated: false });
    expect(fixture.calls).toEqual(["save", "integration"]);
  } finally {
    capabilities.mockRestore();
    fixture.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
