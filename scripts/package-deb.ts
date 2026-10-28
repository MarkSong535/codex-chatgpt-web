import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "../src/version";
import { validateRuntimeBundle } from "./runtime-bundle";

/**
 * Wraps a built runtime bundle (scripts/build-runtime-bundle.ts) in a Debian package:
 * the runtime under /opt/codex-chatgpt-web and the command at /usr/bin/codex-chatgpt-web.
 * Usage: bun run scripts/package-deb.ts [runtime-dir] [output-dir]
 */

if (process.platform !== "linux") throw new Error("Debian packages are built on Linux, from a Linux runtime bundle");
const debianArch = { x64: "amd64", arm64: "arm64" }[process.arch as "x64" | "arm64"];
if (!debianArch) throw new Error(`Unsupported Debian architecture: ${process.arch}`);

const root = resolve(import.meta.dir, "..");
const runtime = resolve(process.argv[2] ?? join(root, "dist", "runtime"));
const output = resolve(process.argv[3] ?? join(root, "dist"));
validateRuntimeBundle(runtime, { version: VERSION, platform: "linux", arch: process.arch });

const maintainer = process.env.DEB_MAINTAINER?.trim()
  || "codex-chatgpt-web maintainers <https://github.com/miuuyy/codex-chatgpt-web/issues>";

function sizeKiB(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) return Math.ceil(stats.size / 1024);
  return readdirSync(path).reduce((sum, name) => sum + sizeKiB(join(path, name)), 0);
}

const staging = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-deb-"));
try {
  const installRoot = join(staging, "opt", "codex-chatgpt-web");
  cpSync(runtime, installRoot, { recursive: true, verbatimSymlinks: true });

  mkdirSync(join(staging, "usr", "bin"), { recursive: true });
  symlinkSync("../../opt/codex-chatgpt-web/bin/codex-chatgpt-web", join(staging, "usr", "bin", "codex-chatgpt-web"));

  const docs = join(staging, "usr", "share", "doc", "codex-chatgpt-web");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "copyright"), [
    "codex-chatgpt-web is distributed under the MIT license below. The package also embeds the Bun",
    "runtime and the JavaScript packages listed in THIRD_PARTY_NOTICES.txt under their own licenses.",
    "",
    readFileSync(join(root, "LICENSE"), "utf8").trim(),
    "",
    readFileSync(join(root, "LICENSES", "Bun-1.4.0.md"), "utf8").trim(),
    "",
  ].join("\n"));
  cpSync(join(runtime, "THIRD_PARTY_NOTICES.txt"), join(docs, "THIRD_PARTY_NOTICES.txt"));

  const debian = join(staging, "DEBIAN");
  mkdirSync(debian, { mode: 0o755 });
  writeFileSync(join(debian, "control"), [
    "Package: codex-chatgpt-web",
    `Version: ${VERSION}`,
    `Architecture: ${debianArch}`,
    `Maintainer: ${maintainer}`,
    `Installed-Size: ${sizeKiB(installRoot) + sizeKiB(docs)}`,
    // Chrome runs on a private Xvfb display. No browser is pulled in automatically: Ubuntu's
    // chromium-browser is a confined snap that cannot reach that display, and Google Chrome has no
    // Linux arm64 build. `codex-chatgpt-web browser install` works everywhere.
    "Depends: xvfb",
    "Suggests: chromium | google-chrome-stable",
    "Section: devel",
    "Priority: optional",
    "Homepage: https://github.com/miuuyy/codex-chatgpt-web",
    "Description: ChatGPT Web models for the native Codex harness",
    " Runs Codex tasks through your ChatGPT web session in Chrome on a private",
    " virtual display, so no monitor or GPU is needed. Without Google Chrome or",
    " Debian's chromium, run `codex-chatgpt-web browser install --with-deps`, then",
    " `codex-chatgpt-web setup --browser-only --email you@example.com` to sign in.",
    "",
  ].join("\n"));
  // Background services belong to the user who ran setup; an upgrade only replaces files.
  writeFileSync(join(debian, "postinst"), `#!/bin/sh
set -e
if [ "$1" = "configure" ] && [ -n "$2" ]; then
  echo "codex-chatgpt-web was upgraded. Each user with a running daemon should run:"
  echo "  codex-chatgpt-web setup <their usual flags> --restart-service"
fi
exit 0
`);
  chmodSync(join(debian, "postinst"), 0o755);
  mkdirSync(output, { recursive: true });
  const packagePath = join(output, `codex-chatgpt-web_${VERSION}_${debianArch}.deb`);
  const build = Bun.spawnSync(["dpkg-deb", "--root-owner-group", "--build", staging, packagePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`dpkg-deb failed: ${build.stderr.toString() || build.stdout.toString()}`);
  process.stdout.write(`${packagePath}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
