import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";

setDefaultTimeout(30_000);

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("doctor distinguishes a healthy local proxy from failed, pending and recovered model loading", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-doctor-catalog-"));
  const appHome = join(root, "app");
  const config = { ...defaultConfig("browser-only"), browserHost: "managed-chrome" as const };
  let result: Record<string, unknown> | null = {
    request: 2, at: "2026-10-22T07:53:53.739Z", status: 502,
    failure: { stage: "transport", code: "ConnectionRefused", message: "PRIVATE_PROXY_URL" },
  };
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    paths.push(new URL(req.url).pathname);
    return Response.json({
      status: "ok", service: "codex-chatgpt-web", version: config.releaseVersion,
      mode: config.mode, accepting_turns: true, pid: process.pid,
      successful_model_catalog_requests: result ? 1 : 0,
      last_model_catalog_result: result,
    });
  } });
  config.port = server.port!;
  mkdirSync(appHome, { recursive: true });
  writeFileSync(join(appHome, "config.json"), JSON.stringify(config));
  const env = { ...process.env, CODEX_CHATGPT_WEB_HOME: appHome, CODEX_HOME: join(root, "codex") };
  try {
    const check = async () => {
      const report = JSON.parse((await runCli(["doctor", "--json"], env)).stdout);
      expect(report.checks.find((c: any) => c.id === "proxy").status).toBe("ok");
      return report.checks.find((c: any) => c.id === "model-catalog");
    };
    expect(await check()).toMatchObject({ status: "error", detail: "HTTP 502; transport; ConnectionRefused" });
    result = null;
    expect(await check()).toMatchObject({ status: "warning" });
    result = { request: 3, at: "2026-10-22T07:54:00Z", status: 200 };
    expect(await check()).toMatchObject({ status: "ok" });
    expect(paths).toEqual(["/healthz", "/healthz", "/healthz"]);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("setup rejects retired options before configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-fixed-connector-"));
  try {
    const env = {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    };
    for (const command of [["setup"]]) {
      for (const option of [
        ["--app-name", "Other Connector"], ["--saved-chats"], ["--temporary-chats"],
        ["--headed"], ["--headless"], ["--browser-host-descriptor", join(root, "launcher-browser.json")],
        ["--zero-risk-browser-interaction"], ["--automatic-browser-interaction"], ["--zero-risk-pro"],
      ]) {
        const result = await runCli([
          ...command, "--browser-only", ...option, "--acknowledge-unofficial",
        ], env);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/Unknown.*arguments:/);
        expect(result.stderr).toContain(option.join(" "));
      }
    }
    expect(existsSync(join(root, "app", "config.json"))).toBeFalse();
    const help = await runCli(["--help"], env);
    for (const retired of ["--app-name", "--saved-chats", "--temporary-chats", "--headed", "--zero-risk", "dev ", "launcher"]) {
      expect(help.stdout).not.toContain(retired);
    }
    for (const current of ["--email", "--password-file", "--totp-secret-file", "--import-login", "--chrome-gpu", "tunnel <status|start|restart|stop|run|key-import>"]) {
      expect(help.stdout).toContain(current);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup rejects conflicting conversation modes before configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-conversation-flags-"));
  try {
    for (const command of [["setup"]]) {
      const result = await runCli([
        ...command, "--browser-only", "--fresh-conversation", "--retained-conversation",
      ], {
        ...process.env,
        CODEX_HOME: join(root, "codex"),
        CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Choose --fresh-conversation or --retained-conversation");
    }
    expect(existsSync(join(root, "app", "config.json"))).toBeFalse();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup parses prediction options before attempting runtime changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-prediction-flags-"));
  try {
    for (const command of [["setup"]]) {
      const env = { ...process.env, CODEX_HOME: join(root, "codex"), CODEX_CHATGPT_WEB_HOME: join(root, "app") };
      const conflict = await runCli([...command, "--browser-only", "--composer-predictions", "--no-composer-predictions"], env);
      expect(conflict.exitCode).toBe(1);
      expect(conflict.stderr).toContain("Choose --composer-predictions or --no-composer-predictions");
      for (const flag of ["--composer-predictions", "--no-composer-predictions"]) {
        const result = await runCli([...command, "--browser-only", flag, "--prediction-probe-stop"], env);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/Unknown.*arguments: --prediction-probe-stop/);
        expect(result.stderr).not.toContain(flag);
      }
    }
    expect(existsSync(join(root, "app", "config.json"))).toBeFalse();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup validates the port before performing runtime work", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-"));
  try {
    const result = await runCli([
      "setup",
      "--browser-only",
      "--chrome",
      process.execPath,
      "--port",
      "0",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    const { stderr } = result;
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--port must be an integer from 1 to 65535");
    expect(stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passwords are never accepted as command-line arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-password-arg-"));
  try {
    for (const command of [["login"], ["setup", "--browser-only", "--acknowledge-unofficial"]]) {
      const result = await runCli([...command, "--email", "user@example.com", "--password", "hunter2"], {
        ...process.env,
        CODEX_HOME: join(root, "codex"),
        CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Passwords are not accepted as arguments");
      expect(result.stderr).not.toContain("hunter2");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unattended login explains each missing credential before starting Chrome", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-login-inputs-"));
  try {
    const appHome = join(root, "app");
    mkdirSync(appHome, { recursive: true });
    const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
    process.env.CODEX_CHATGPT_WEB_HOME = appHome;
    try {
      const config = defaultConfig("browser-only");
      config.chromeExecutablePath = process.execPath;
      writeFileSync(join(appHome, "config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
      CODEX_CHATGPT_WEB_EMAIL: undefined,
      CODEX_CHATGPT_WEB_PASSWORD: undefined,
      CODEX_CHATGPT_WEB_TOTP_SECRET: undefined,
    };
    const noEmail = await runCli(["login"], env);
    expect(noEmail.exitCode).toBe(1);
    expect(noEmail.stderr).toContain("A ChatGPT account email is required");

    const noPassword = await runCli(["login", "--email", "user@example.com"], env);
    expect(noPassword.exitCode).toBe(1);
    expect(noPassword.stderr).toContain("A ChatGPT password is required");

    const passwordFile = join(root, "password");
    writeFileSync(passwordFile, "fixture-password\n", { mode: 0o600 });
    const totpFile = join(root, "totp");
    writeFileSync(totpFile, "not base32!\n", { mode: 0o600 });
    const badTotp = await runCli([
      "login", "--email", "user@example.com", "--password-file", passwordFile, "--totp-secret-file", totpFile,
    ], env);
    expect(badTotp.exitCode).toBe(1);
    expect(badTotp.stderr).toContain("The TOTP secret must be base32");
    expect(badTotp.stdout).not.toContain("[1/7]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
