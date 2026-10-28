import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

/** Validates a relocatable runtime bundle against its manifest of sorted, checksummed files. */

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface RuntimeBundleIdentity {
  version: string;
  platform: NodeJS.Platform | string;
  arch: string;
}

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bundleIdFor(files: readonly ManifestFile[]): string {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function validateManifestPath(relativePath: unknown): string {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath === "manifest.json"
    || relativePath.includes("\\")
    || posix.isAbsolute(relativePath)
    || posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Runtime manifest contains an unsafe file path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

function readRuntimeManifest(runtimeRoot: string, { version, platform, arch }: RuntimeBundleIdentity) {
  const manifestPath = join(runtimeRoot, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & { files?: unknown };
  const expectedLauncher = `bin/${platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`;
  if (manifest?.schemaVersion !== 2
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || manifest.launcher !== expectedLauncher
    || manifest.entrypoint !== "app/cli.js"
    || typeof manifest.bunVersion !== "string"
    || typeof manifest.playwright !== "string"
    || !SHA256_PATTERN.test(String(manifest.bundleId))
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0) {
    throw new Error(`Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}`);
  }
  let previousPath: string | undefined;
  const files = (manifest.files as unknown[]).map((file, index) => {
    const record = file as Partial<ManifestFile> | null;
    if (!record || typeof record !== "object"
      || !Number.isSafeInteger(record.size) || record.size! < 0
      || !SHA256_PATTERN.test(String(record.sha256))) {
      throw new Error(`Runtime manifest contains an invalid file record at index ${index}`);
    }
    const relativePath = validateManifestPath(record.path);
    if (previousPath !== undefined && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error(`Runtime manifest file paths are not unique and sorted: ${relativePath}`);
    }
    previousPath = relativePath;
    return { path: relativePath, size: record.size!, sha256: record.sha256! };
  });
  if (bundleIdFor(files) !== manifest.bundleId) {
    throw new Error(`Runtime manifest bundleId does not match its file records: ${manifestPath}`);
  }
  return { launcher: manifest.launcher as string, files };
}

function runtimeFilePaths(runtimeRoot: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(runtimeRoot, absolutePath).split(sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) visit(absolutePath);
      else paths.push(relativePath);
    }
  };
  visit(runtimeRoot);
  return paths.sort(comparePaths);
}

export function validateRuntimeBundle(runtimeRoot: string, identity: RuntimeBundleIdentity): string {
  const manifest = readRuntimeManifest(runtimeRoot, identity);
  const expectedPaths = manifest.files.map(file => file.path);
  const expected = new Set(expectedPaths);
  const executable = join(runtimeRoot, "runtime", identity.platform === "win32" ? "bun.exe" : "bun");
  for (const required of [executable, join(runtimeRoot, "app", "cli.js"), join(runtimeRoot, ...manifest.launcher.split("/"))]) {
    if (!expected.has(relative(runtimeRoot, required).split(sep).join("/"))) {
      throw new Error(`Runtime manifest does not declare required file: ${required}`);
    }
  }
  const actualPaths = runtimeFilePaths(runtimeRoot);
  const actual = new Set(actualPaths);
  const missing = expectedPaths.find(path => !actual.has(path));
  if (missing) throw new Error(`Runtime bundle file is missing: ${join(runtimeRoot, ...missing.split("/"))}`);
  const unexpected = actualPaths.find(path => !expected.has(path));
  if (unexpected) throw new Error(`Runtime bundle contains an unmanifested file: ${join(runtimeRoot, ...unexpected.split("/"))}`);

  const canonicalRoot = realpathSync(runtimeRoot);
  for (const file of manifest.files) {
    const absolutePath = join(runtimeRoot, ...file.path.split("/"));
    const metadata = statSync(absolutePath);
    if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
    if (lstatSync(absolutePath).isSymbolicLink()) {
      const target = realpathSync(absolutePath);
      if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`)) {
        throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
      }
    }
    if (metadata.size !== file.size) throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
    if (createHash("sha256").update(readFileSync(absolutePath)).digest("hex") !== file.sha256) {
      throw new Error(`Runtime bundle file checksum mismatch: ${absolutePath}`);
    }
  }
  if (identity.platform !== "win32" && (statSync(executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${executable}`);
  }
  return runtimeRoot;
}
