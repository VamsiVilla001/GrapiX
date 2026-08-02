/**
 * Stages the MCP knowledge corpus for packaging.
 *
 * The corpus is normally read straight out of the working tree, which an installed
 * build does not have: `resolveConfig` then fails to locate a repository root and the
 * MCP server throws instead of starting, taking the assistant's tools with it.
 *
 * This copies exactly the files the corpus reads — at exactly the relative paths it
 * expects — into `dist/knowledge/`, which ships as a Tauri resource. The file list is
 * imported from `corpus.js` rather than restated here, so adding a document to the
 * corpus ships it automatically and cannot be forgotten.
 *
 * `docs/architecture.md`, `Shared/` and `Editor/` all land naturally, which is what
 * `isRepositoryRoot` checks, so the staged tree is accepted as a root without needing
 * a marker file.
 */

import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mcpRoot = path.join(repositoryRoot, "Editor", "services", "editor-mcp");
// A directory of its own, not `dist/knowledge/` — that one holds the compiled corpus
// modules, and the packaged resource must contain corpus files and nothing else.
const stageRoot = path.join(mcpRoot, "dist", "knowledge-root");

// A bare Windows path is not a legal ESM specifier, hence the file:// URL.
const corpusModule = path.join(mcpRoot, "dist", "knowledge", "corpus.js");
let corpusRelativePaths;
try {
  ({ corpusRelativePaths } = await import(pathToFileURL(corpusModule).href));
} catch (error) {
  throw new Error(
    `could not load ${path.relative(repositoryRoot, corpusModule)}: ${error.message}\n` +
      "Run `npm run build -w @grapix/editor-mcp` first. The staged corpus is derived from the " +
      "compiled corpus module so the two cannot diverge."
  );
}

// The stage root is exclusively ours, so a clean wipe guarantees a removed document
// stops shipping instead of lingering from an earlier build.
await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });

const relativePaths = await corpusRelativePaths(repositoryRoot);

let copied = 0;
let bytes = 0;
const missing = [];

for (const relativePath of relativePaths) {
  const source = path.join(repositoryRoot, relativePath);
  const destination = path.join(stageRoot, relativePath);

  let size;
  try {
    size = (await stat(source)).size;
  } catch {
    // The corpus treats an absent optional source as normal, so staging does too:
    // a missing `Playout/README.md` must not fail the build. Reported, not fatal.
    missing.push(relativePath);
    continue;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  copied += 1;
  bytes += size;
}

// `isRepositoryRoot` requires a `Shared/` and an `Editor/` directory. Both are created
// by the copies above; assert it rather than trusting the corpus list to keep including
// a file under each, because that would fail at install time, not build time.
for (const required of [path.join("docs", "architecture.md"), "Shared", "Editor"]) {
  try {
    await stat(path.join(stageRoot, required));
  } catch {
    throw new Error(
      `staged corpus is missing ${required}, so an installed MCP server would reject it ` +
        "as not being a GrapiX root"
    );
  }
}

await writeFile(
  path.join(stageRoot, "grapix-knowledge.json"),
  `${JSON.stringify(
    {
      stagedAt: new Date().toISOString(),
      documentCount: copied,
      bytes,
      missing
    },
    null,
    2
  )}\n`
);

process.stdout.write(
  `[knowledge] staged ${copied} files — ${(bytes / 1024).toFixed(0)} KiB into ${path.relative(
    repositoryRoot,
    stageRoot
  )}\n`
);
if (missing.length > 0) {
  process.stdout.write(`[knowledge] absent optional sources: ${missing.join(", ")}\n`);
}
