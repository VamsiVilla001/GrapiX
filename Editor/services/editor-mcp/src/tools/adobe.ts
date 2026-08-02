/**
 * Adobe gateway import.
 *
 * The gateway owns the local-plugin and cloud transports. This tool only brings
 * its document model into GrapiX; storing the resulting scene remains an
 * explicit Editor action.
 */

import { AdobeClient, AdobeToolError } from "@grapix/adobe-client";
import {
  adobeDocumentToScene,
  type AdobeImportDocument,
  type CompatibilityStatus,
  type ImportWarning
} from "@grapix/adobe-common-schema";
import { z } from "zod";
import { heading, lines } from "../format.js";
import { defineTool, present, responseFormatField, type RegisteredEditorTool } from "../toolkit.js";

const IMPORT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

const COMPATIBILITY_STATUSES = ["Native", "Converted", "Rasterised", "Unsupported"] as const satisfies readonly CompatibilityStatus[];

function compatibilitySummary(warnings: ImportWarning[]): string {
  return lines(
    heading(2, "Compatibility report"),
    ...COMPATIBILITY_STATUSES.map((status) => {
      const matching = warnings.filter((warning) => warning.status === status);
      const detail =
        matching.length === 0
          ? "none"
          : matching
              .map((warning) => {
                const layer = warning.layerName ?? warning.layerId;
                return layer ? `${warning.message} (layer: ${layer})` : warning.message;
              })
              .join("; ");
      return `- **${status}** (${matching.length}): ${detail}`;
    })
  );
}

export const adobeTools: RegisteredEditorTool[] = [
  defineTool({
    name: "import_from_adobe",
    title: "Import a document through the Adobe gateway",
    description: `Import an Adobe document through the local Adobe gateway and convert it into a GrapiX scene, with a compatibility report.

The result is a converted scene — it is not yet a stored scene. Review the report, then store it with grapix_editor_replace_scene. The cloud transport carries document structure only: it has no pixel data or layer effects, and those limits are reported rather than approximated silently.

Args:
  - source (object): { "href": "https://.../design.psd", "storage": "...", "transport": "local" | "cloud", "app": "photoshop" | "after-effects" }. href is required.
  - gateway (object, optional): { "url": "ws://127.0.0.1:4784", "token": "..." }. Defaults to the local gateway and GRAPIX_ADOBE_GATEWAY_TOKEN when set.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { ok: true, result: { scene, report: { converted, warnings } } }

Error handling: gateway and Adobe application errors are returned with the gateway's own reason.`,
    inputSchema: z
      .object({
        source: z
          .object({
            href: z.string().min(1).describe("Adobe document URL or local-plugin document reference."),
            storage: z.string().min(1).optional().describe("Adobe storage identifier for the source document."),
            transport: z.enum(["local", "cloud"]).optional().describe("Adobe gateway transport to use."),
            app: z.enum(["photoshop", "after-effects"]).optional().describe("Adobe application to query.")
          })
          .strict()
          .describe("Adobe document source descriptor."),
        gateway: z
          .object({
            url: z.string().min(1).optional().describe("Adobe gateway WebSocket URL."),
            token: z.string().min(1).optional().describe("Adobe gateway token for this request only.")
          })
          .strict()
          .optional()
          .describe("Optional Adobe gateway connection overrides."),
        response_format: responseFormatField
      })
      .strict(),
    mutates: true,
    annotations: IMPORT,
    async handler(args) {
      const adobe = new AdobeClient({
        url: args.gateway?.url ?? "ws://127.0.0.1:4784",
        token: args.gateway?.token ?? process.env.GRAPIX_ADOBE_GATEWAY_TOKEN ?? "grapix-adobe-token-secret",
        autoReconnect: false
      });

      try {
        try {
          await adobe.connect();
        } catch (error) {
          if (error instanceof AdobeToolError) throw error;
          throw new AdobeToolError(
            "connection_failed",
            error instanceof Error ? error.message : String(error)
          );
        }
        const document = await adobe.call<AdobeImportDocument>(
          "photoshop.getDocumentStructure",
          {
            href: args.source.href,
            ...(args.source.storage ? { storage: args.source.storage } : {})
          },
          {
            ...(args.source.transport ? { transport: args.source.transport } : {}),
            ...(args.source.app ? { app: args.source.app } : {})
          }
        );
        const { scene, report } = adobeDocumentToScene(document);
        const result = { scene, report };

        return present(
          args.response_format,
          lines(
            heading(1, `Imported Adobe document "${document.name}"`),
            "",
            compatibilitySummary(report.warnings),
            "",
            "The converted scene is not stored. Review the report, then store it with grapix_editor_replace_scene."
          ),
          { ok: true, result },
          "Use response_format: 'json' and read `result.report` first."
        );
      } finally {
        adobe.disconnect();
      }
    }
  })
];
