/**
 * Stages the Node runtime as a Tauri sidecar for both desktop shells.
 *
 * The supervisors run the service bundles with Node. Resolving it from `PATH` is fine in a
 * checkout and wrong in a product: a broadcast machine has no reason to have Node
 * installed, and without it every service fails to spawn — the app opens to a window with
 * no project service, no assistant and no gateway.
 *
 * Tauri's `externalBin` requires the target triple in the filename and strips it on
 * install, so the shipped file lands as plain `node.exe` beside the executable, which is
 * where `adjacent_binary("node")` looks.
 *
 * The runtime copied is the one running this script, so the shipped Node is the same
 * version the bundles were built and tested against.
 */

import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Rust's host triple, which is what Tauri matches sidecar filenames against. */
function hostTriple() {
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (!arch) throw new Error(`unsupported architecture for a Node sidecar: ${process.arch}`);
  switch (process.platform) {
    case "win32":
      return `${arch}-pc-windows-msvc`;
    case "darwin":
      return `${arch}-apple-darwin`;
    case "linux":
      return `${arch}-unknown-linux-gnu`;
    default:
      throw new Error(`unsupported platform for a Node sidecar: ${process.platform}`);
  }
}

const triple = hostTriple();
const extension = process.platform === "win32" ? ".exe" : "";
const source = process.execPath;
const { size } = await stat(source);

const destinations = [
  path.join(repositoryRoot, "Editor", "apps", "desktop-tauri", "src-tauri", "binaries"),
  path.join(repositoryRoot, "Playout", "apps", "desktop-tauri", "src-tauri", "binaries")
];

for (const directory of destinations) {
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `node-${triple}${extension}`);
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
  process.stdout.write(
    `[node] staged ${path.relative(repositoryRoot, destination)} — ${(size / 1024 / 1024).toFixed(1)} MiB\n`
  );
}

process.stdout.write(`[node] runtime ${process.version} (${triple})\n`);
