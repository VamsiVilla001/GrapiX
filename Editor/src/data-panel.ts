// The Data panel's sources and fields (the new Figma UI, B4 Data; plan rows 11.19, 11.54 and the Data Hub question 19.14).
//
// Figma B4 shows a Data list with a "+ Add data…" button, a row per data source with its health and when it last updated, and "Fields found" with their
// types. Asked of Jev and Laya before it was written (docs/evidence/figma-ui/jev-laya-library-data.json): the panel is built on what a graphic has today,
// which is one JSON object of sample data typed into the graphic (11.19). So:
//   - the one source this graphic has is its sample data, with health "Idle": it was typed in and nothing updates it, and the panel does not say Live;
//   - Fields found are that data's leaves, each with the kind it holds (text, number, yes/no) and the elements already bound to it;
//   - a CSV file is a source of its own (11.153 slice C): the project keeps a copy, the panel says its file name, records and columns, and the
//     record check reads its rows; a published sheet and a live feed are listed dimmed with what they wait for (the Data Hub decision, row 19.14);
//   - the Test records block (11.153, `fit-records.ts`) shows what the engine measured: it is "Not checked yet" until a check is made, and it
//     says FITS, OVERFLOWS, EMPTY or MISSING only from a report the engine gave. Nothing here says FITS that was not measured. Nor is a stale feed drawn:
//     there is no feed.
// It is a `UiNode` tree, so a person and an agent read the same description (invariant 27). The sample-data editor and the bindings stay where they are.

import type { SceneDocument } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";
import { dataFields } from "./bindings";
import { testRecordsNodes, type RecordsState } from "./fit-records";

/** What each way of adding data waits for. */
export const DATA_WAITS = {
  sheet: "A published sheet is a live source: it waits for the Data Hub decision (row 19.14).",
  live: "A live feed waits for the Data Hub decision (row 19.14).",
} as const;

export const DATA_NO_DATA = "This graphic has no data yet. Add sample data, then bind a field to an element's property below.";
export type FieldKind = "text" | "number" | "yes/no" | "empty";

/** What a leaf holds, in the words the panel uses. */
export function fieldKind(value: unknown): FieldKind {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "yes/no";
  return "empty";
}

/** The elements already bound to a data path, as `Element.property`. */
export function boundTo(document: SceneDocument, path: string): string[] {
  const found: string[] = [];
  for (const object of document.objects) {
    for (const [property, bound] of Object.entries(object.bindings ?? {})) {
      if (bound === path) found.push(`${object.name}.${property}`);
    }
  }
  return found;
}

/** The project's CSV for a graphic, as the shell answers `cmd_import_project_csv` (11.153 slice C). */
export interface CsvSource {
  readonly fileName: string;
  readonly contentHash: string;
  readonly delimiter: CsvDelimiter;
  readonly columns: readonly string[];
  readonly rowCount: number;
}
export type CsvDelimiter = "comma" | "semicolon" | "tab";
export const CSV_DELIMITERS: readonly CsvDelimiter[] = ["comma", "semicolon", "tab"];

/** What the delimiter box was typed as, in words: undefined when it is none of the three. */
export function parseDelimiter(text: string): CsvDelimiter | undefined {
  const word = text.trim().toLowerCase();
  const named = CSV_DELIMITERS.find((delimiter) => delimiter === word);
  if (named !== undefined) return named;
  return word === "," ? "comma" : word === ";" ? "semicolon" : word === "\\t" ? "tab" : undefined;
}

export function dataPanel(document: SceneDocument, records: RecordsState = {}, csv?: CsvSource, delimiter: CsvDelimiter = "comma"): UiNode {
  const fields = dataFields(document.dataContext);
  const children: UiNode[] = [];

  if (fields.length === 0 && csv === undefined) {
    children.push({ id: "data/none", role: "status", label: "Data", value: DATA_NO_DATA });
  } else {
    children.push({
      id: "data/sources",
      role: "list",
      label: "Sources",
      children: [
        ...(csv === undefined
          ? []
          : [
              {
                id: "data/source/csv",
                role: "listitem" as const,
                label: "CSV file",
                description: `${csv.fileName} · ${csv.rowCount} record${csv.rowCount === 1 ? "" : "s"} · ${csv.columns.length} column${csv.columns.length === 1 ? "" : "s"}: ${csv.columns.join(", ")}`,
                selected: true,
                children: [{ id: "data/source/csv/health", role: "status" as const, label: "Health", value: "Idle", tone: "neutral" as const }],
              } satisfies UiNode,
            ]),
        ...(fields.length === 0
          ? []
          : [
              {
                id: "data/source/sample",
                role: "listitem" as const,
                label: "Sample data",
                description: `JSON typed into this graphic · ${fields.length} field(s)`,
                selected: csv === undefined,
                children: [{ id: "data/source/sample/health", role: "status" as const, label: "Health", value: "Idle", tone: "neutral" as const }],
              } satisfies UiNode,
            ]),
      ],
    });
    children.push({
      id: "data/fields",
      role: "list",
      label: "Fields found",
      children: fields.map((field): UiNode => {
        const users = boundTo(document, field.path);
        return {
          id: `data/field/${field.path}`,
          role: "listitem",
          label: field.path,
          value: fieldKind(field.value),
          description: users.length === 0 ? "not bound to any element" : `bound to ${users.join(", ")}`,
        };
      }),
    });
  }
  children.push({
    id: "data/csv-delimiter",
    role: "listitem",
    label: "CSV delimiter",
    description: "comma, semicolon or tab: chosen before the file is picked",
    input: { type: "text", value: delimiter },
    // The box is drawn for an `edit` action; without one the row is only its label.
    actions: [{ name: "edit", label: "Set delimiter" }],
  });
  children.push(...testRecordsNodes(document, records));

  return {
    id: "data",
    role: "region",
    label: "Data",
    description:
      csv !== undefined
        ? `${csv.rowCount} record${csv.rowCount === 1 ? "" : "s"} from ${csv.fileName}`
        : fields.length === 0
          ? "no data in this graphic"
          : `${fields.length} field(s) from the graphic's sample data`,
    actions: [
      { name: "addSampleData", label: "+ Add sample data…" },
      { name: "addCsv", label: csv === undefined ? "CSV file…" : "Replace CSV file…" },
      { name: "addSheet", label: "Published sheet…", unavailable: DATA_WAITS.sheet },
      { name: "addLive", label: "Live feed…", unavailable: DATA_WAITS.live },
    ],
    children,
  };
}
