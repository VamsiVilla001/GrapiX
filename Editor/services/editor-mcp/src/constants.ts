/**
 * Fixed values every part of the MCP server agrees on.
 *
 * The tool prefix is `grapix_editor_` rather than `grapix_` on purpose. An agent
 * usually has several MCP servers connected at once, and a future Playout server
 * will own the verbs this one is forbidden to expose (`docs/architecture.md`
 * invariants 3 and 4). Prefixing by product keeps `grapix_editor_publish_scene`
 * and a later `grapix_playout_take` unambiguous to a model reading both lists.
 */

export const SERVER_NAME = "grapix-editor-mcp-server";
export const SERVER_TITLE = "GrapiX Editor";
export const SERVER_VERSION = "0.1.0";

export const TOOL_PREFIX = "grapix_editor_";

/** Default project-api origin. Port 4100 per `docs/architecture.md`. */
export const DEFAULT_PROJECT_API_URL = "http://127.0.0.1:4100";

/** Origin the project API already allow-lists for non-browser callers. */
export const MCP_REQUEST_ORIGIN = "grapix://editor";

/**
 * Largest text payload a single tool result may carry. Beyond this a result is
 * truncated with an explicit message naming the parameter that narrows it, so
 * an agent is never silently handed a partial answer it believes is complete.
 */
export const CHARACTER_LIMIT = 25_000;

/** Read timeout for a project-api call, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Import and package calls move whole files and legitimately take longer. */
export const LONG_REQUEST_TIMEOUT_MS = 180_000;

/** Default page size for list tools. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/** URI scheme for every resource this server publishes. */
export const RESOURCE_SCHEME = "grapix";
