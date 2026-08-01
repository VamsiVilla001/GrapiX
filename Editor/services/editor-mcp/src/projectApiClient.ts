/**
 * The only path from this MCP server to GrapiX state.
 *
 * Nothing here touches `data/` directly. Going through `project-api` on 4100 is
 * what keeps an agent inside the same rules a human author works under: the
 * origin allow-list, the bearer token, read-only show mode, the operator audit
 * hook, the per-scene write lock, scene backups and the revision counter all
 * live in that service. A file-system shortcut would bypass every one of them
 * and would be the fastest way to corrupt a scene during a show.
 */

import {
  LONG_REQUEST_TIMEOUT_MS,
  MCP_REQUEST_ORIGIN,
  REQUEST_TIMEOUT_MS
} from "./constants.js";
import type { EditorMcpConfig } from "./config.js";

export class ProjectApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
    readonly body: unknown
  ) {
    super(message);
    this.name = "ProjectApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  binary?: { bytes: Uint8Array; contentType?: string };
  /** Import and package routes move whole files and need the longer budget. */
  long?: boolean;
  /** Return the raw bytes instead of parsing JSON (asset content). */
  raw?: boolean;
}

export interface RawResponse {
  bytes: Uint8Array;
  contentType: string;
}

export class ProjectApiClient {
  constructor(private readonly config: EditorMcpConfig) {}

  get baseUrl(): string {
    return this.config.projectApiUrl;
  }

  async request<T>(routePath: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(routePath, options);
    const text = await response.text();
    const parsed = text ? safeJsonParse(text) : undefined;

    if (!response.ok) {
      throw new ProjectApiError(
        describeFailure(response.status, parsed, routePath),
        response.status,
        readCode(parsed),
        parsed ?? text
      );
    }

    return parsed as T;
  }

  async requestRaw(routePath: string, options: RequestOptions = {}): Promise<RawResponse> {
    const response = await this.send(routePath, options);

    if (!response.ok) {
      const text = await response.text();
      const parsed = text ? safeJsonParse(text) : undefined;
      throw new ProjectApiError(
        describeFailure(response.status, parsed, routePath),
        response.status,
        readCode(parsed),
        parsed ?? text
      );
    }

    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream"
    };
  }

  /** `GET /health`, used by the status tool and by the HTTP transport's readiness check. */
  async health(): Promise<{
    ok: boolean;
    service: string;
    time: string;
    showMode: "read-only" | "edit";
    authenticationRequired: boolean;
  }> {
    return this.request("/health");
  }

  private async send(routePath: string, options: RequestOptions): Promise<Response> {
    const url = new URL(`${this.config.projectApiUrl}${routePath}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      // The project API allow-lists this origin for non-browser callers; sending
      // it keeps the MCP server on the same code path as the desktop shell
      // rather than relying on the "no origin header" exemption.
      origin: MCP_REQUEST_ORIGIN
    };
    if (this.config.apiToken) headers.authorization = `Bearer ${this.config.apiToken}`;

    // `RequestInit["body"]` rather than the global `BodyInit`, which is a DOM
    // type this package's ES2022/node lib set does not include.
    let body: NonNullable<RequestInit["body"]> | undefined;
    if (options.binary) {
      headers["content-type"] = options.binary.contentType ?? "application/octet-stream";
      body = options.binary.bytes;
    } else if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.long ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    );

    try {
      return await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body,
        signal: controller.signal
      });
    } catch (error) {
      throw this.describeTransportFailure(error, url);
    } finally {
      clearTimeout(timeout);
    }
  }

  private describeTransportFailure(error: unknown, url: URL): ProjectApiError {
    if (error instanceof Error && error.name === "AbortError") {
      return new ProjectApiError(
        `The GrapiX project service did not answer ${url.pathname} in time. Large imports ` +
          "can exceed the timeout; retry, or import the file through the Editor UI.",
        undefined,
        "TIMEOUT",
        undefined
      );
    }

    return new ProjectApiError(
      `Could not reach the GrapiX project service at ${this.config.projectApiUrl}. Start it ` +
        "with `npm run dev` (the Editor desktop shell) or `npm run dev:api` (the service " +
        "alone), or set GRAPIX_API_URL if it listens elsewhere. " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      "UNREACHABLE",
      undefined
    );
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "code" in body) {
    const code = (body as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function readMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error: unknown }).error;
    if (typeof message === "string") return message;
  }
  return undefined;
}

/**
 * Turns a project-api status into something an agent can act on. Every branch
 * names the next step, because "403 Forbidden" tells a model nothing about
 * which of several unrelated causes it hit.
 */
function describeFailure(status: number, body: unknown, routePath: string): string {
  const detail = readMessage(body);
  const code = readCode(body);

  switch (status) {
    case 400:
      return `The project service rejected the request to ${routePath} as malformed${
        detail ? `: ${detail}` : "."
      }`;
    case 401:
      return (
        "The project service requires authentication. Set GRAPIX_API_TOKEN in this MCP " +
        "server's environment to the same value the project service was started with."
      );
    case 403:
      return (
        "The project service refused this origin. The MCP server must be allow-listed: add " +
        "its origin to GRAPIX_API_ALLOWED_ORIGINS on the project service."
      );
    case 404:
      return `Not found: ${routePath}. List the available scenes or rundowns first — an id from a different project or a deleted scene produces this.`;
    case 409:
      return (
        `A concurrent edit changed the scene: ${detail ?? "revision mismatch"}. Re-read the ` +
        "scene to get its current revision, then reapply the change."
      );
    case 415:
      return `The file was rejected by import validation${detail ? `: ${detail}` : ""}${
        code ? ` (${code})` : ""
      }. Check the file type against the documented accepted formats.`;
    case 422:
      return (
        `The content is structurally valid but failed GrapiX validation${
          detail ? `: ${detail}` : ""
        }${code ? ` (${code})` : ""}. The response body lists the specific issues.`
      );
    case 423:
      return (
        "Read-only show mode is active on the project service, so authoring mutations are " +
        "locked. Only live-data patches and automation events are accepted while a show is " +
        "on air. Clear GRAPIX_SHOW_MODE on the project service to author again."
      );
    case 429:
      return (
        "Live-data patch rate limit exceeded (120 patches per scene per second). Batch the " +
        "values into a single data-context update instead of one patch per field."
      );
    default:
      return `The project service returned ${status} for ${routePath}${detail ? `: ${detail}` : "."}`;
  }
}
