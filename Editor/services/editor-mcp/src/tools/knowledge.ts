/**
 * Tools that read GrapiX's own knowledge: the architecture, the contracts, the
 * capability map and the accumulated session rules.
 *
 * These are listed first in `server.ts` and their descriptions point at each
 * other, because the useful order for an agent is orientation -> search ->
 * read, and a model that starts by patching a scene it has not understood is
 * the failure this whole layer exists to prevent.
 */

import { z } from "zod";
import { AUTHORITY_BOUNDARY, PORT_MAP } from "../knowledge/index.js";
import { capabilityLists, renderCapabilityList } from "../knowledge/capabilities.js";
import { heading, lines, paginate, table } from "../format.js";
import {
  defineTool,
  limitField,
  offsetField,
  present,
  responseFormatField,
  type RegisteredEditorTool
} from "../toolkit.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

export const knowledgeTools: RegisteredEditorTool[] = [
  defineTool({
    name: "get_primer",
    title: "GrapiX orientation primer",
    description: `Read this first, before any other GrapiX tool.

Returns the single orientation document for the whole application: the three-product split (Editor, Playout, Render Engine), the non-negotiable architecture invariants quoted live from docs/architecture.md, exactly what this Editor server may and may not do, the local port map, and the complete capability map of what a scene can contain — with declared-but-unimplemented values called out.

That last part is the reason to read it. Several GrapiX enums accept values the renderers ignore: authoring one produces a scene that saves, validates as fine, and then renders as something else. The primer names them.

Args:
  - include_capabilities (boolean): include the full capability map (default: true). Set false for a short orientation.

Returns: markdown.

Use when: starting any GrapiX task, or when unsure whether an operation belongs to Editor or Playout.
Don't use when: you need a specific detail — search_knowledge is narrower and cheaper.`,
    inputSchema: z
      .object({
        include_capabilities: z
          .boolean()
          .default(true)
          .describe("Include the full scene capability map. Set false for a shorter primer.")
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ include_capabilities }, { knowledge }) {
      const primer = await knowledge.primer();
      if (include_capabilities) {
        return { text: primer, truncationHint: "Call again with include_capabilities: false." };
      }

      const trimmed = primer.split("## What a scene can contain")[0];
      return {
        text: `${trimmed}\n_Capability map omitted. Call grapix_editor_describe_capabilities for it._\n`,
        truncationHint: "Use search_knowledge for a specific topic instead."
      };
    }
  }),

  defineTool({
    name: "search_knowledge",
    title: "Search GrapiX documentation and contracts",
    description: `Full-text search across everything this server has ingested from the GrapiX repository: every document in docs/, the repository and product READMEs, the durable handoff in memory.md, and the TypeScript contract sources in Shared/.

Results are section-level, not whole documents, and the documentation authority order from docs/README.md biases the ranking, so canonical material surfaces early and near-ties break toward it. The bias is mild by design: a detail document is often the better answer to a detail question. Each hit carries its document's authority rank, and when two hits disagree the lower rank wins.

Args:
  - query (string): search terms, e.g. "premultiplied alpha", "take id stability", "publish preflight".
  - limit (number): maximum sections to return, 1-200 (default: 25).
  - document_ids (string[]): restrict to specific documents, by the ids from list_documents.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { query, total, count, items: [{ document_id, document_title, path, authority, heading, start_line, score, snippet }] }

Examples:
  - "Which blend modes actually render?" -> query="blend mode implemented"
  - "Can the Editor take a scene to air?" -> query="Program authority Editor invariant"
  - "What is in a .gpxpkg?" -> query="scene package manifest checksums"

Error handling: returns "No sections matched" with suggested broader terms when the query finds nothing.`,
    inputSchema: z
      .object({
        query: z
          .string()
          .min(2, "query must be at least 2 characters")
          .max(300, "query must not exceed 300 characters")
          .describe("Search terms."),
        limit: limitField,
        document_ids: z
          .array(z.string())
          .max(40)
          .optional()
          .describe("Restrict the search to these document ids (see list_documents)."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ query, limit, document_ids, response_format }, { knowledge }) {
      const hits = await knowledge.search(query, limit, document_ids);

      if (hits.length === 0) {
        return {
          text:
            `No sections matched "${query}".\n\n` +
            "Try broader terms, drop the document_ids filter, or call " +
            "grapix_editor_list_documents to see what is available."
        };
      }

      const data = {
        query,
        total: hits.length,
        count: hits.length,
        items: hits.map((hit) => ({
          document_id: hit.documentId,
          document_title: hit.documentTitle,
          path: hit.relativePath,
          authority: hit.authority,
          heading: hit.heading,
          start_line: hit.startLine,
          score: Number(hit.score.toFixed(3)),
          snippet: hit.snippet
        }))
      };

      const markdown = [
        heading(1, `Search: "${query}"`),
        "",
        `${hits.length} matching section${hits.length === 1 ? "" : "s"}. Lower authority wins a disagreement.`,
        "",
        ...hits.map((hit) =>
          [
            heading(2, hit.heading),
            `\`${hit.relativePath}:${hit.startLine}\` · authority ${hit.authority} · document id \`${hit.documentId}\``,
            "",
            hit.snippet,
            ""
          ].join("\n")
        )
      ].join("\n");

      return present(
        response_format,
        markdown,
        data,
        `Lower \`limit\` (currently ${limit}) or narrow the query.`
      );
    }
  }),

  defineTool({
    name: "list_documents",
    title: "List ingested GrapiX documents",
    description: `List every document this server has ingested, with its authority rank, category and size.

Authority rank 1 is docs/architecture.md — the canonical product and runtime architecture. When two documents disagree, the lower rank wins; nothing below may justify a decision that contradicts something above it.

Args:
  - category ('architecture' | 'detail' | 'ledger' | 'readme' | 'session-rules' | 'contract'): filter by kind.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { total, items: [{ id, path, title, category, authority, size_bytes, modified_at }] }

Use the returned \`id\` with read_document, or read the whole file through the \`grapix://doc/{id}\` resource.`,
    inputSchema: z
      .object({
        category: z
          .enum(["architecture", "detail", "ledger", "readme", "session-rules", "contract"])
          .optional()
          .describe("Restrict the listing to one kind of document."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ category, response_format }, { knowledge }) {
      const documents = (await knowledge.documents()).filter(
        (document) => !category || document.category === category
      );

      const data = {
        total: documents.length,
        items: documents.map((document) => ({
          id: document.id,
          path: document.relativePath,
          title: document.title,
          category: document.category,
          authority: document.authority,
          size_bytes: document.sizeBytes,
          modified_at: document.modifiedAt
        }))
      };

      const markdown = lines(
        heading(1, "Ingested GrapiX knowledge"),
        "",
        table(documents, [
          { label: "Authority", value: (document) => document.authority },
          { label: "Id", value: (document) => document.id },
          { label: "Title", value: (document) => document.title },
          { label: "Category", value: (document) => document.category },
          { label: "Path", value: (document) => document.relativePath }
        ]),
        "",
        "Lower authority wins a disagreement. Read one with grapix_editor_read_document."
      );

      return present(response_format, markdown, data, "Filter with the `category` parameter.");
    }
  }),

  defineTool({
    name: "read_document",
    title: "Read an ingested document",
    description: `Read one ingested document, whole or by section.

Long documents (memory.md is ~2,500 lines) should be read by section: call with no \`section\` to get the section list, then again with a heading to get its text.

Args:
  - document_id (string): id or repository-relative path from list_documents.
  - section (string): heading to read; matched case-insensitively against the heading trail.
  - offset (number), limit (number): page through sections when listing them.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  Section list: { document_id, path, title, sections: [{ heading, start_line, chars }] }
  Section text: { document_id, path, heading, start_line, text }

Error handling: an unknown document_id returns the available ids; an unmatched section returns the section list so the next call can succeed.`,
    inputSchema: z
      .object({
        document_id: z.string().min(1).describe("Document id or repository-relative path."),
        section: z
          .string()
          .optional()
          .describe("Heading to read. Omit to list the document's sections."),
        offset: offsetField,
        limit: limitField,
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ document_id, section, offset, limit, response_format }, { knowledge }) {
      const document = await knowledge.document(document_id);
      if (!document) {
        const available = (await knowledge.documents()).map((entry) => entry.id);
        return {
          text:
            `No ingested document "${document_id}".\n\nAvailable ids:\n` +
            available.map((id) => `- ${id}`).join("\n")
        };
      }

      const sections = await knowledge.sections(document.id);

      if (section) {
        const needle = section.toLowerCase();
        const match =
          sections.find((entry) => entry.heading.toLowerCase() === needle) ??
          sections.find((entry) => entry.heading.toLowerCase().includes(needle));

        if (!match) {
          return {
            text:
              `"${section}" is not a heading in ${document.relativePath}.\n\nSections:\n` +
              sections.map((entry) => `- ${entry.heading}`).join("\n")
          };
        }

        return present(
          response_format,
          `${heading(1, match.heading)}\n\`${document.relativePath}:${match.startLine}\`\n\n${match.text}`,
          {
            document_id: document.id,
            path: document.relativePath,
            heading: match.heading,
            start_line: match.startLine,
            text: match.text
          },
          "Read a narrower sub-heading."
        );
      }

      const page = paginate(sections, offset, limit);
      const data = {
        document_id: document.id,
        path: document.relativePath,
        title: document.title,
        authority: document.authority,
        total: page.total,
        offset: page.offset,
        has_more: page.has_more,
        next_offset: page.next_offset,
        sections: page.items.map((entry) => ({
          heading: entry.heading,
          start_line: entry.startLine,
          chars: entry.text.length
        }))
      };

      const markdown = lines(
        heading(1, document.title),
        `\`${document.relativePath}\` · authority ${document.authority} · updated ${document.modifiedAt}`,
        "",
        table(page.items, [
          { label: "Heading", value: (entry) => entry.heading },
          { label: "Line", value: (entry) => entry.startLine },
          { label: "Chars", value: (entry) => entry.text.length }
        ]),
        "",
        page.has_more
          ? `Showing ${page.count} of ${page.total} sections. Pass offset: ${page.next_offset}.`
          : `${page.total} sections.`,
        "",
        "Call again with `section` to read one."
      );

      return present(response_format, markdown, data, "Page with `offset`, or read one `section`.");
    }
  }),

  defineTool({
    name: "describe_capabilities",
    title: "What a GrapiX scene can contain",
    description: `The capability map, derived from the contracts in Shared/shared-types rather than from documentation: object types, bindable and animatable properties, mesh primitives, lights, cameras, material types, blend/alpha/cull/depth modes, texture fit/wrap/filtering modes, mask modes, asset kinds, easings, transitions, trigger events, script permissions, project colour spaces and resolution presets.

Where a list distinguishes declared from implemented, both are reported and the difference is named explicitly. Authoring a declared-but-unimplemented value produces a scene that saves and validates cleanly and then renders as something else — this tool is how you avoid that.

Args:
  - topic (string): filter to one list, e.g. "blend", "texture", "material", "animatable".
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { lists: [{ name, declared, implemented?, unimplemented?, note? }], project, materials }

Examples:
  - "Which blend modes are safe?" -> topic="blend"
  - "What can I keyframe?" -> topic="animatable"
  - "What resolutions are presets?" -> topic="project"`,
    inputSchema: z
      .object({
        topic: z
          .string()
          .max(60)
          .optional()
          .describe("Case-insensitive substring of the capability list name, e.g. 'blend'."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ topic, response_format }, { knowledge }) {
      const map = await knowledge.capabilities();
      const needle = topic?.toLowerCase();
      const all = capabilityLists(map);
      const matched = needle
        ? all.filter(
            (entry) =>
              entry.name.toLowerCase().includes(needle) ||
              entry.declared.some((value) => value.toLowerCase().includes(needle))
          )
        : all;

      const includeProject = !needle || "project".includes(needle) || needle.includes("project");
      const includeMaterials =
        !needle || "materials".includes(needle) || needle.includes("material");

      if (matched.length === 0 && !includeProject && !includeMaterials) {
        return {
          text:
            `No capability list matches "${topic}".\n\nAvailable lists: ` +
            all.map((entry) => entry.name).join(", ")
        };
      }

      const data = {
        lists: matched,
        ...(includeProject ? { project: map.project } : {}),
        ...(includeMaterials ? { materials: map.materials } : {})
      };

      const markdown = lines(
        heading(1, "GrapiX scene capabilities"),
        "",
        "Derived from `Shared/shared-types`. **Declared but NOT rendered** values save and",
        "validate cleanly and then draw as something else — do not author them.",
        "",
        ...matched.map(renderCapabilityList),
        includeProject
          ? lines(
              heading(3, "Project"),
              "",
              `- **Colour spaces**: ${map.project.colorSpaces.map((entry) => entry.id).join(", ")}`,
              `- **Resolution presets**: ${map.project.resolutionPresets
                .map((entry) =>
                  entry.width && entry.height ? `${entry.id} (${entry.width}x${entry.height})` : entry.id
                )
                .join(", ")}`,
              `- **Dimension range**: ${map.project.minDimension}-${map.project.maxDimension} px`,
              `- **Pixel aspect ratio**: ${map.project.pixelAspectRatio} (square pixels only)`,
              ""
            )
          : undefined,
        includeMaterials
          ? lines(
              heading(3, "Materials"),
              "",
              `- **Canonical type**: ${map.materials.canonicalType} — one Standard Material model`,
              `- **Accepted wire aliases**: ${map.materials.wireTypes.join(", ")}`,
              `- **Primary slot**: ${map.materials.primarySlot}`,
              ""
            )
          : undefined
      );

      return present(response_format, markdown, data, "Filter with the `topic` parameter.");
    }
  }),

  defineTool({
    name: "describe_authority",
    title: "What the Editor may and may not do",
    description: `The product authority boundary, as verbs.

GrapiX splits authoring from operations the way Viz Artist splits from Trio, or XPression Designer from Sequencer. The Editor — and therefore this MCP server — owns mutable authoring content and durable publishing. It has no Program or output authority at all: Cue, Take, Continue, Clear and output configuration belong to Playout, and the render engine enforces that server-side by authenticated role, so an Editor-role request for one is refused at the engine regardless of what any client offers.

Call this whenever a request sounds operational ("put this on air", "start the output", "cut to the next graphic") to get the precise reason it cannot be done here and what the correct surface is.

Args:
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { editor_may: string[], editor_may_not: string[], invariants: string[], ports: [...] }`,
    inputSchema: z.object({ response_format: responseFormatField }).strict(),
    annotations: READ_ONLY,
    async handler({ response_format }, { knowledge }) {
      const invariants = await knowledge.invariants();
      const data = {
        editor_may: AUTHORITY_BOUNDARY.editorMay,
        editor_may_not: AUTHORITY_BOUNDARY.editorMayNot,
        invariants,
        ports: PORT_MAP
      };

      const markdown = lines(
        heading(1, "Editor authority"),
        "",
        heading(2, "The Editor may"),
        ...AUTHORITY_BOUNDARY.editorMay.map((entry) => `- ${entry}`),
        "",
        heading(2, "The Editor may not"),
        ...AUTHORITY_BOUNDARY.editorMayNot.map((entry) => `- ${entry}`),
        "",
        "The engine authenticates client role and rejects Program/output commands from an Editor",
        "role server-side. Omitting a dangerous verb from a UI is not considered authorization.",
        "",
        heading(2, "Invariants"),
        ...invariants.map((entry) => entry),
        "",
        heading(2, "Ports"),
        table(PORT_MAP, [
          { label: "Port", value: (entry) => entry.port },
          { label: "Owner", value: (entry) => entry.owner },
          { label: "Note", value: (entry) => entry.note }
        ])
      );

      return present(response_format, markdown, data, "Use response_format: 'json'.");
    }
  }),

  defineTool({
    name: "get_session_rules",
    title: "Binding project rules from memory.md",
    description: `The numbered "Rules for the next session" from the repository's durable handoff (memory.md). They are binding, and each one records something that already went wrong in this codebase — a reflected transform that flipped UVs, a texture fit mode that silently drew as stretch, a port probe that proved the wrong process was listening.

Read the relevant ones before changing rendering, transforms, materials, ports, packaging or certification behaviour.

Args:
  - query (string): filter to rules containing this text (case-insensitive).
  - limit (number): maximum rules to return, 1-200 (default: 25).
  - offset (number): rules to skip.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { total, count, offset, has_more, next_offset?, rules: string[] }`,
    inputSchema: z
      .object({
        query: z.string().max(200).optional().describe("Only rules containing this text."),
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ query, limit, offset, response_format }, { knowledge }) {
      const all = await knowledge.sessionRules();
      const needle = query?.toLowerCase();
      const filtered = needle ? all.filter((rule) => rule.toLowerCase().includes(needle)) : all;
      const page = paginate(filtered, offset, limit);

      if (page.total === 0) {
        return {
          text: needle
            ? `No session rule mentions "${query}". ${all.length} rules are loaded; call again without a query.`
            : "No session rules were found in memory.md."
        };
      }

      const data = {
        total: page.total,
        count: page.count,
        offset: page.offset,
        has_more: page.has_more,
        next_offset: page.next_offset,
        rules: page.items
      };

      const markdown = lines(
        heading(1, "Binding session rules"),
        `From \`memory.md\`. ${page.total} rule${page.total === 1 ? "" : "s"}${
          needle ? ` matching "${query}"` : ""
        }.`,
        "",
        ...page.items.map((rule) => `- ${rule}`),
        "",
        page.has_more ? `Pass offset: ${page.next_offset} for more.` : ""
      );

      return present(response_format, markdown, data, `Filter with \`query\`, or lower \`limit\`.`);
    }
  }),

  defineTool({
    name: "list_commands",
    title: "List repository commands",
    description: `Every npm script defined at the GrapiX repository root: dev, build, typecheck, test, the structural boundary guard, and the certification harnesses.

This is read live from the root package.json, so it reflects the working tree rather than documentation.

Args:
  - filter (string): only commands whose name or script contains this text, e.g. "certify".
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { total, items: [{ name, script }] }

Note: this tool lists commands. It does not run them — running builds, tests or certification is the caller's decision, in the caller's own shell.`,
    inputSchema: z
      .object({
        filter: z.string().max(80).optional().describe("Substring filter on name or script."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ filter, response_format }, { knowledge }) {
      const all = await knowledge.commands();
      const needle = filter?.toLowerCase();
      const matched = needle
        ? all.filter(
            (entry) =>
              entry.name.toLowerCase().includes(needle) ||
              entry.script.toLowerCase().includes(needle)
          )
        : all;

      const data = { total: matched.length, items: matched };
      const markdown = lines(
        heading(1, "GrapiX repository commands"),
        "",
        table(matched, [
          { label: "Command", value: (entry) => `npm run ${entry.name}` },
          { label: "Runs", value: (entry) => entry.script }
        ]),
        "",
        "This server lists commands; it does not execute them."
      );

      return present(response_format, markdown, data, "Filter with the `filter` parameter.");
    }
  })
];
