// Registers the two MCP servers an agent needs to bring a Figma frame into GrapiX.
//
// Row 18.2 is agent-brokered: the user's own agent reads the frame through a Figma MCP
// and hands it to GrapiX through GrapiX's Editor MCP. This writes both servers into one
// agent MCP config (the project's `.mcp.json` by default, which Claude Code reads), so
// the agent has them side by side without hand-editing:
//
//   grapix         the Editor MCP over stdio (`gx-editor-mcp --root <store>`); the parent
//                  process is the trust boundary, so no secret is written anywhere.
//   figma-desktop  the Figma desktop app's local MCP server (http://127.0.0.1:3845/mcp).
//                  It is the user's open Figma session on this machine: no OAuth, so it
//                  is not behind the remote server's client allowlist, and no token is
//                  stored here either.
//
// It never overwrites an entry that says something different unless `--force`, leaves
// every other server and key in the file alone, and `--dry-run` shows the result without
// writing. `--remove` takes both entries out again.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GRAPIX = "grapix";
export const FIGMA = "figma-desktop";
export const FIGMA_URL = "http://127.0.0.1:3845/mcp";

/** The two server entries. `binary` and `root` must be absolute: an agent starts from any folder. */
export function buildEntries({ binary, root, figmaUrl = FIGMA_URL }) {
  for (const [name, value] of [["binary", binary], ["root", root]]) {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error(`${name} must be an absolute path, got ${JSON.stringify(value)}`);
    }
  }
  const url = new URL(figmaUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`the Figma desktop server is local; refusing ${figmaUrl}`);
  }
  return {
    [GRAPIX]: { command: binary, args: ["--root", root] },
    [FIGMA]: { type: "http", url: figmaUrl },
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge entries into a config. Returns the new config and what happened to each entry:
 * `added`, `unchanged`, `replaced` (with force) or `conflict` (an existing entry that
 * differs, left as it was).
 */
export function mergeServers(config, entries, { force = false } = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("the config is not a JSON object");
  }
  const servers = config.mcpServers ?? {};
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("`mcpServers` is not an object");
  }
  const next = { ...servers };
  const outcome = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (!(name in servers)) {
      next[name] = entry;
      outcome[name] = "added";
    } else if (same(servers[name], entry)) {
      outcome[name] = "unchanged";
    } else if (force) {
      next[name] = entry;
      outcome[name] = "replaced";
    } else {
      outcome[name] = "conflict";
    }
  }
  return { config: { ...config, mcpServers: next }, outcome };
}

/** Take the two entries out. Other servers stay. */
export function removeServers(config) {
  const servers = { ...(config.mcpServers ?? {}) };
  const outcome = {};
  for (const name of [GRAPIX, FIGMA]) {
    outcome[name] = name in servers ? "removed" : "absent";
    delete servers[name];
  }
  return { config: { ...config, mcpServers: servers }, outcome };
}

/** Does something answer MCP at the Figma desktop address? Never throws; never sends data. */
export async function probeFigma(url = FIGMA_URL, timeoutMs = 2000) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "grapix-register", version: "0" },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const name = /"serverInfo":\{"name":"([^"]+)"/.exec(text)?.[1];
    return response.ok && name ? { up: true, name } : { up: false, why: `HTTP ${response.status}` };
  } catch (error) {
    return { up: false, why: error?.cause?.code ?? error?.name ?? "unreachable" };
  }
}

const tomlLiteral = (text) => {
  if (text.includes("'")) throw new Error(`cannot write ${text} as a TOML literal string`);
  return `'${text}'`;
};

/** The Codex `config.toml` table for the GrapiX server. Literal strings, so Windows paths need no escaping. */
export function codexBlock(entry, name = GRAPIX) {
  const body = entry.url
    ? [`url = ${tomlLiteral(entry.url)}`]
    : [`command = ${tomlLiteral(entry.command)}`, `args = [${entry.args.map(tomlLiteral).join(", ")}]`];
  return [`[mcp_servers.${name}]`, ...body, ""].join("\n");
}

/** Add one server table to a Codex config text. Never rewrites an existing one, even a different one. */
export function mergeCodex(text, entry, name = GRAPIX) {
  const header = new RegExp(String.raw`^\[mcp_servers\.${name}(\.[^\]]*)?\]\s*$`, "m");
  if (header.test(text)) {
    return { text, outcome: text.includes(codexBlock(entry, name)) ? "unchanged" : "conflict" };
  }
  const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${text}${gap}${codexBlock(entry, name)}`, outcome: "added" };
}

/** Where each client keeps its MCP servers. `claude-code` is this project's file; the rest are user-level. */
export function clientFiles(repo, env = process.env) {
  return {
    "claude-code": { file: resolve(repo, ".mcp.json"), format: "json" },
    "claude-desktop": { file: join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json"), format: "json" },
    gemini: { file: join(homedir(), ".gemini", "settings.json"), format: "json" },
    codex: { file: join(homedir(), ".codex", "config.toml"), format: "toml" },
  };
}

/** Keep a copy of a file before changing it, outside the repo. */
function backup(file) {
  if (!existsSync(file)) return;
  const dir = join(tmpdir(), "grapix-mcp-backups");
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, join(dir, `${Date.now()}-${file.replace(/[^\w.]+/g, "_")}`));
}

function registerClient(name, spec, entries, { force, dryRun }) {
  const entry = entries[GRAPIX];
  const exists = existsSync(spec.file);
  let next;
  let outcome;
  if (spec.format === "toml") {
    // Claude -> Figma -> GrapiX: every client that can reach Figma's local server gets both.
    const first = mergeCodex(exists ? readFileSync(spec.file, "utf8") : "", entry);
    const second = mergeCodex(first.text, entries[FIGMA], FIGMA);
    next = second.text;
    const both = [first.outcome, second.outcome];
    outcome = both.includes("conflict") ? "conflict" : both.every((o) => o === "unchanged") ? "unchanged" : "added";
  } else {
    const config = exists ? JSON.parse(readFileSync(spec.file, "utf8")) : {};
    // Claude Desktop's file takes stdio servers only (Figma comes to it as a connector); Gemini names the field `httpUrl`.
    const wanted =
      name === "claude-code"
        ? entries
        : name === "gemini"
          ? { [GRAPIX]: entry, [FIGMA]: { httpUrl: entries[FIGMA].url } }
          : { [GRAPIX]: entry };
    const merged = mergeServers(config, wanted, { force });
    outcome = Object.values(merged.outcome).includes("conflict") ? "conflict" : Object.values(merged.outcome).every((o) => o === "unchanged") ? "unchanged" : "added";
    next = `${JSON.stringify(merged.config, null, 2)}\n`;
  }
  if (outcome === "added" && !dryRun) {
    backup(spec.file);
    mkdirSync(dirname(spec.file), { recursive: true });
    writeFileSync(spec.file, next);
  }
  console.log(`${name}: ${outcome}${outcome === "added" ? (dryRun ? " (dry run)" : "") : ""} ${spec.file}`);
  return outcome;
}

function parseArgs(argv) {
  const options = { force: false, dryRun: false, remove: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--force") options.force = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--remove") options.remove = true;
    else if (["--root", "--file", "--binary", "--figma-url", "--client"].includes(flag) && argv[i + 1]) {
      options[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[(i += 1)];
    } else throw new Error(`unknown or incomplete argument ${flag}`);
  }
  return options;
}

const USAGE =
  "usage: node tools/register-mcp.mjs --root <project-store-folder> [--file <mcp.json>] " +
  "[--client claude-code,claude-desktop,gemini,codex|all] [--binary <gx-editor-mcp.exe>] [--figma-url <local url>] [--dry-run] [--force] | --remove [--file <mcp.json>]";

async function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseArgs(process.argv.slice(2));
  if (options.client) {
    if (!options.root) throw new Error(`--root is required. ${USAGE}`);
    const binary = resolve(options.binary ?? resolve(repo, "target", "debug", process.platform === "win32" ? "gx-editor-mcp.exe" : "gx-editor-mcp"));
    if (!existsSync(binary)) throw new Error(`no Editor MCP at ${binary}; build it (cargo build -p gx-editor-mcp) or pass --binary`);
    const root = resolve(options.root);
    if (!options.dryRun) mkdirSync(root, { recursive: true });
    const entries = buildEntries({ binary, root, figmaUrl: options.figmaUrl });
    const files = clientFiles(repo);
    const names = options.client === "all" ? Object.keys(files) : options.client.split(",");
    for (const name of names) if (!files[name]) throw new Error(`unknown client ${name}; one of ${Object.keys(files).join(", ")}, all`);
    const outcomes = names.map((name) => registerClient(name, files[name], entries, options));
    if (outcomes.includes("conflict")) {
      console.error("an existing grapix entry differs and was left alone; pass --force (JSON clients) or edit the Codex table by hand");
      process.exitCode = 1;
    }
    return;
  }
  const file = resolve(options.file ?? resolve(repo, ".mcp.json"));
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

  let result;
  if (options.remove) {
    result = removeServers(config);
  } else {
    if (!options.root) throw new Error(`--root is required. ${USAGE}`);
    const binary = resolve(
      options.binary ?? resolve(repo, "target", "debug", process.platform === "win32" ? "gx-editor-mcp.exe" : "gx-editor-mcp"),
    );
    if (!existsSync(binary)) throw new Error(`no Editor MCP at ${binary}; build it (cargo build -p gx-editor-mcp) or pass --binary`);
    const entries = buildEntries({ binary, root: resolve(options.root), figmaUrl: options.figmaUrl });
    result = mergeServers(config, entries, { force: options.force });
  }
  for (const [name, what] of Object.entries(result.outcome)) console.log(`${name}: ${what}`);
  if (Object.values(result.outcome).includes("conflict")) {
    console.error("an existing entry differs and was left alone; pass --force to replace it");
    process.exitCode = 1;
    return;
  }
  if (options.dryRun) {
    console.log(`dry run, nothing written to ${file}`);
    console.log(JSON.stringify(result.config, null, 2));
  } else {
    writeFileSync(file, `${JSON.stringify(result.config, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
  if (!options.remove) {
    const figma = await probeFigma(options.figmaUrl);
    console.log(
      figma.up
        ? `Figma desktop answers: ${figma.name}`
        : `Figma desktop is not answering (${figma.why}): open Figma and turn on Dev Mode's MCP server`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
