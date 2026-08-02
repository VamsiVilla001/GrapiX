/**
 * Read vs mutating classification for MCP tools.
 *
 * The agent auto-executes read tools and *stages* mutating ones for operator Apply/Skip. The
 * editor-mcp server already declares `readOnlyHint` annotations; this trusts that first and
 * falls back to a name heuristic only when an annotation is absent, so a new tool without an
 * annotation is treated as mutating (fail safe) unless its name is unambiguously a read.
 */

import type { McpToolInfo } from "./mcpClient.js";

const READ_PREFIXES = [
  "list_",
  "get_",
  "describe_",
  "search_",
  "read_",
  "analyze_",
  "evaluate_",
  "preflight_",
  "inspect_"
];

/** True when a tool only reads. Prefers the server's annotation; heuristic is the fallback. */
export function isReadTool(tool: McpToolInfo): boolean {
  if (tool.readOnly) return true;
  // Strip the `grapix_editor_` prefix before matching so the heuristic sees the verb.
  const verb = tool.name.replace(/^grapix_editor_/, "");
  return READ_PREFIXES.some((prefix) => verb.startsWith(prefix));
}
