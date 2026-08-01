/**
 * One registration path for every tool.
 *
 * Tools are declared as data and type-erased by `defineTool`, so a tool file
 * keeps full inference inside its handler while `server.ts` can hold every tool
 * in one array. Everything a tool would otherwise repeat — the name prefix, the
 * `response_format` switch, error translation, the character budget,
 * `structuredContent` — happens here exactly once.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { EditorMcpConfig } from "./config.js";
import { TOOL_PREFIX } from "./constants.js";
import { ProjectApiError, type ProjectApiClient } from "./projectApiClient.js";
import { truncate, type ResponseFormat } from "./format.js";
import type { KnowledgeBase } from "./knowledge/index.js";

export interface ToolContext {
  client: ProjectApiClient;
  config: EditorMcpConfig;
  knowledge: KnowledgeBase;
}

export interface ToolOutcome {
  /** Text shown to the model. Markdown or JSON, chosen by the tool. */
  text: string;
  /** Machine-readable mirror, sent as `structuredContent`. */
  data?: Record<string, unknown>;
  /**
   * Names the concrete parameter that would return less. Required whenever a
   * result can grow without bound.
   */
  truncationHint?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the erased array needs a top type
type AnyZodObject = z.ZodObject<any, any, any>;

export interface EditorToolDefinition<Schema extends AnyZodObject> {
  /** Tool name without the `grapix_editor_` prefix. */
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  outputSchema?: AnyZodObject;
  annotations: ToolAnnotations;
  /**
   * True when the tool changes GrapiX state. Mutating tools are not registered
   * at all when the server runs read-only, because an omitted verb is the only
   * honest way to tell an agent it cannot write.
   */
  mutates?: boolean;
  handler: (args: z.infer<Schema>, context: ToolContext) => Promise<ToolOutcome>;
}

export interface RegisteredEditorTool {
  name: string;
  title: string;
  mutates: boolean;
  register(server: McpServer, context: ToolContext): void;
}

/** The shared `response_format` field. Markdown reads better; JSON composes better. */
export const responseFormatField = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "Output format: 'markdown' for a human-readable summary, 'json' for the complete structured record."
  );

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(200)
  .default(25)
  .describe("Maximum number of records to return (1-200).");

export const offsetField = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Number of records to skip, for paging through a long list.");

/** Renders an outcome in the requested format without each tool repeating it. */
export function present(
  format: ResponseFormat,
  markdown: string,
  data: Record<string, unknown>,
  truncationHint: string
): ToolOutcome {
  return {
    text: format === "json" ? JSON.stringify(data, null, 2) : markdown,
    data,
    truncationHint
  };
}

export function defineTool<Schema extends AnyZodObject>(
  definition: EditorToolDefinition<Schema>
): RegisteredEditorTool {
  const qualifiedName = `${TOOL_PREFIX}${definition.name}`;

  return {
    name: qualifiedName,
    title: definition.title,
    mutates: definition.mutates ?? false,
    register(server, context) {
      server.registerTool(
        qualifiedName,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
          ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
          annotations: { title: definition.title, ...definition.annotations }
        },
        (async (args: z.infer<Schema>): Promise<CallToolResult> => {
          try {
            const outcome = await definition.handler(args, context);
            const { text } = truncate(
              outcome.text,
              outcome.truncationHint ??
                "Request a narrower slice of this record, or use response_format: 'markdown'."
            );

            return {
              content: [{ type: "text", text }],
              ...(outcome.data ? { structuredContent: outcome.data } : {})
            };
          } catch (error) {
            return toolError(error);
          }
          // The SDK's ToolCallback generic resolves through a conditional type
          // that TypeScript cannot narrow from the erased `AnyZodObject`; the
          // handler signature above is the one it actually invokes.
        }) as Parameters<McpServer["registerTool"]>[2]
      );
    }
  };
}

/**
 * Tool failures are reported inside the result, never as JSON-RPC errors, so
 * the model sees them and can correct itself. A protocol error would surface to
 * the user as a broken server instead.
 */
export function toolError(error: unknown): CallToolResult {
  if (error instanceof ProjectApiError) {
    const detail =
      error.body && typeof error.body === "object"
        ? `\n\nProject service response:\n${JSON.stringify(error.body, null, 2).slice(0, 4000)}`
        : "";
    return {
      isError: true,
      content: [{ type: "text", text: `${error.message}${detail}` }]
    };
  }

  if (error instanceof z.ZodError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "Invalid arguments:\n" +
            error.issues.map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")
        }
      ]
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Unexpected failure: ${error instanceof Error ? error.message : String(error)}`
      }
    ]
  };
}
