/**
 * Environment resolution for the MCP server.
 *
 * Every value an MCP client can influence is resolved once, here, and validated
 * before a transport is opened. A stdio server that discovers a bad repository
 * root on the first tool call reports it as a tool failure, which reads to an
 * agent as "GrapiX has no documentation" rather than "you launched me from the
 * wrong directory".
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT_API_URL } from "./constants.js";

export interface EditorMcpConfig {
  /** Repository root: the directory holding `docs/`, `Shared/` and `memory.md`. */
  repositoryRoot: string;
  /** Base URL of `Editor/services/project-api`. */
  projectApiUrl: string;
  /** Bearer token, when the project API was started with `GRAPIX_API_TOKEN`. */
  apiToken?: string;
  /** `stdio` for a local client subprocess, `http` for streamable HTTP. */
  transport: "stdio" | "http";
  /** Port for the HTTP transport. */
  httpPort: number;
  /** Host for the HTTP transport. Loopback unless deliberately overridden. */
  httpHost: string;
  /**
   * Whether write tools are registered at all. A read-only server is the right
   * default for an agent pointed at a live authoring station.
   */
  readOnly: boolean;
}

export class ConfigurationError extends Error {}

/**
 * Walks up from this file looking for the repository root. Works from `src`
 * under tsx and from `dist` after a build, and both are four levels deep:
 * src|dist -> editor-mcp -> services -> Editor -> repository root.
 */
function findRepositoryRoot(startDirectory: string): string | undefined {
  let directory = startDirectory;

  for (let depth = 0; depth < 8; depth += 1) {
    if (isRepositoryRoot(directory)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return undefined;
}

/**
 * A directory is the GrapiX root when it carries the three things this server
 * ingests. Checking all three rejects a partial checkout instead of serving an
 * empty knowledge base that looks like a working one.
 */
function isRepositoryRoot(directory: string): boolean {
  return (
    existsSync(path.join(directory, "docs", "architecture.md")) &&
    existsSync(path.join(directory, "Shared")) &&
    existsSync(path.join(directory, "Editor"))
  );
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError(
      `GRAPIX_MCP_PORT must be an integer between 1 and 65535, received "${value}"`
    );
  }
  return port;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): EditorMcpConfig {
  const explicitRoot = env.GRAPIX_REPOSITORY_ROOT?.trim();
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = explicitRoot
    ? path.resolve(explicitRoot)
    : findRepositoryRoot(moduleDirectory) ?? findRepositoryRoot(process.cwd());

  if (!repositoryRoot) {
    throw new ConfigurationError(
      "Could not locate the GrapiX repository root. Set GRAPIX_REPOSITORY_ROOT to the " +
        "directory that contains docs/, Shared/ and Editor/, or launch this server with " +
        "that directory as its working directory.\n" +
        "Installed from npm, this is expected and not a packaging fault: the architecture, " +
        "contract and capability knowledge is read from a real checkout so it can never serve a " +
        "stale snapshot, so this server needs to be pointed at one."
    );
  }
  if (explicitRoot && !isRepositoryRoot(repositoryRoot)) {
    throw new ConfigurationError(
      `GRAPIX_REPOSITORY_ROOT="${repositoryRoot}" does not contain docs/architecture.md, ` +
        "Shared/ and Editor/, so it is not a GrapiX checkout."
    );
  }

  const transport = (env.GRAPIX_MCP_TRANSPORT?.trim().toLowerCase() ?? "stdio") as
    | "stdio"
    | "http";
  if (transport !== "stdio" && transport !== "http") {
    throw new ConfigurationError(
      `GRAPIX_MCP_TRANSPORT must be "stdio" or "http", received "${env.GRAPIX_MCP_TRANSPORT}"`
    );
  }

  const projectApiUrl = (env.GRAPIX_API_URL?.trim() || DEFAULT_PROJECT_API_URL).replace(/\/+$/, "");
  try {
    new URL(projectApiUrl);
  } catch {
    throw new ConfigurationError(`GRAPIX_API_URL is not a valid URL: "${projectApiUrl}"`);
  }

  const httpHost = env.GRAPIX_MCP_HOST?.trim() || "127.0.0.1";
  const apiToken = env.GRAPIX_API_TOKEN?.trim() || undefined;

  return {
    repositoryRoot,
    projectApiUrl,
    apiToken,
    transport,
    httpPort: readPort(env.GRAPIX_MCP_PORT, 4150),
    httpHost,
    readOnly: readBoolean(env.GRAPIX_MCP_READ_ONLY, false)
  };
}
