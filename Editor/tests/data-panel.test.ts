// The Data panel (Figma B4; rows 11.19, 11.54, 19.14): what it says about the graphic's data, and what it shows as waiting.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { RECORDS_NOT_CHECKED } from "../src/fit-records";
import { agentView, findNode, renderNode, type AgentNode } from "../src/agent-surface";
import { DATA_NO_DATA, DATA_WAITS, boundTo, dataPanel, fieldKind, parseDelimiter, type CsvSource } from "../src/data-panel";

const text = (id: string, name: string, bindings?: Record<string, string>): SceneObject =>
  ({
    id,
    name,
    type: "text",
    visible: true,
    locked: false,
    opacity: 1,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...(bindings === undefined ? {} : { bindings }),
  }) as unknown as SceneObject;

const scene = (dataContext: unknown, objects: SceneObject[] = []): SceneDocument =>
  ({ id: "s", name: "Data test", version: 1, dataContext, objects, assets: [], fonts: [], materials: [] }) as unknown as SceneDocument;

const data = { player: { display_name: "ARJUN RAO", role: "COMMENTATOR" }, score: { team_a: 7, live: true }, empty: null };

describe("what a field holds", () => {
  it("says text, number, yes/no, or empty", () => {
    expect(fieldKind("x")).toBe("text");
    expect(fieldKind(4)).toBe("number");
    expect(fieldKind(false)).toBe("yes/no");
    expect(fieldKind(null)).toBe("empty");
    expect(fieldKind(undefined)).toBe("empty");
  });
});

describe("the elements bound to a path", () => {
  const document = scene(data, [
    text("a", "Name plate", { text: "player.display_name" }),
    text("b", "Caption", { text: "player.display_name", fill: "player.role" }),
    text("c", "Unbound"),
  ]);

  it("lists every element property that reads it, in document order", () => {
    expect(boundTo(document, "player.display_name")).toEqual(["Name plate.text", "Caption.text"]);
    expect(boundTo(document, "player.role")).toEqual(["Caption.fill"]);
    expect(boundTo(document, "score.team_a")).toEqual([]);
  });
});

describe("a graphic with no data", () => {
  const panel = dataPanel(scene({}));

  it("says so and lists no source and no field", () => {
    expect(findNode(panel, "data/none")!.value).toBe(DATA_NO_DATA);
    expect(findNode(panel, "data/sources")).toBeUndefined();
    expect(findNode(panel, "data/fields")).toBeUndefined();
    expect(panel.description).toBe("no data in this graphic");
  });

  it("still offers sample data and still says what records wait for", () => {
    expect(panel.actions![0]).toEqual({ name: "addSampleData", label: "+ Add sample data…" });
    expect(findNode(panel, "data/records")!.value).toBe(RECORDS_NOT_CHECKED);
  });
});

describe("a graphic with sample data", () => {
  const document = scene(data, [text("a", "Name plate", { text: "player.display_name" })]);
  const panel = dataPanel(document);

  it("shows the one source it has: its own sample data, Idle, never Live or Stale", () => {
    const sources = findNode(panel, "data/sources")!;
    expect(sources.children!.map((c) => c.label)).toEqual(["Sample data"]);
    expect(sources.children![0]!.description).toBe("JSON typed into this graphic · 5 field(s)");
    const health = findNode(panel, "data/source/sample/health")!;
    expect(health.value).toBe("Idle");
    expect(health.tone).toBe("neutral");
    const words = JSON.stringify(panel);
    expect(words).not.toMatch(/"value":"(Live|Stale|Fits|Overflows)/i);
  });

  it("lists the fields found, in order, with what each holds", () => {
    const fields = findNode(panel, "data/fields")!.children!;
    expect(fields.map((f) => [f.label, f.value])).toEqual([
      ["player.display_name", "text"],
      ["player.role", "text"],
      ["score.team_a", "number"],
      ["score.live", "yes/no"],
      ["empty", "empty"],
    ]);
  });

  it("says which elements read a field, and when none does", () => {
    expect(findNode(panel, "data/field/player.display_name")!.description).toBe("bound to Name plate.text");
    expect(findNode(panel, "data/field/player.role")!.description).toBe("not bound to any element");
  });

  it("describes itself by how many fields it found", () => {
    expect(panel.description).toBe("5 field(s) from the graphic's sample data");
  });
});

const csv: CsvSource = { fileName: "players.csv", contentHash: "abc", delimiter: "comma", columns: ["name", "team"], rowCount: 48 };

describe("a graphic with a CSV file", () => {
  const document = scene(data, [text("a", "Name plate", { text: "player.display_name" })]);
  const panel = dataPanel(document, {}, csv);

  it("lists the CSV as the selected source, with its file, records and columns, and the sample data after it", () => {
    const sources = findNode(panel, "data/sources")!;
    expect(sources.children!.map((c) => [c.label, c.selected])).toEqual([["CSV file", true], ["Sample data", false]]);
    expect(sources.children![0]!.description).toBe("players.csv · 48 records · 2 columns: name, team");
    expect(findNode(panel, "data/source/csv/health")!.value).toBe("Idle");
    expect(panel.description).toBe("48 records from players.csv");
  });

  it("says one record and one column in the singular", () => {
    const one = dataPanel(document, {}, { ...csv, columns: ["name"], rowCount: 1 });
    expect(findNode(one, "data/source/csv")!.description).toBe("players.csv · 1 record · 1 column: name");
    expect(one.description).toBe("1 record from players.csv");
  });

  it("is a source even when the graphic has no sample data, and offers to replace it", () => {
    const bare = dataPanel(scene({}), {}, csv);
    expect(findNode(bare, "data/none")).toBeUndefined();
    expect(findNode(bare, "data/sources")!.children!.map((c) => c.label)).toEqual(["CSV file"]);
    expect(bare.actions!.find((a) => a.name === "addCsv")!.label).toBe("Replace CSV file…");
  });

  it("asks for the delimiter before the file is picked, comma until it is changed", () => {
    expect(findNode(panel, "data/csv-delimiter")!.input).toEqual({ type: "text", value: "comma" });
    expect(findNode(dataPanel(document, {}, csv, "tab"), "data/csv-delimiter")!.input).toEqual({ type: "text", value: "tab" });
  });

  it("draws the delimiter as a box a person can type in, tied to its node", () => {
    const tag = (name: string) => {
      const attributes = new Map<string, string>();
      const children: unknown[] = [];
      const element = {
        setAttribute: (key: string, value: string) => void attributes.set(key, value),
        appendChild: (child: unknown) => void children.push(child),
        textContent: "",
        attributes,
        children,
        name,
      };
      return element;
    };
    const drawn = renderNode({ createElement: (name: string) => tag(name) } as never, findNode(panel, "data/csv-delimiter")!) as unknown as ReturnType<typeof tag>;
    const input = drawn.children[0] as ReturnType<typeof tag>;
    expect([input.name, input.attributes.get("type"), input.attributes.get("data-for"), input.attributes.get("value")]).toEqual(["input", "text", "data/csv-delimiter", "comma"]);
    expect(input.attributes.has("disabled")).toBe(false);
  });

  it("reads the delimiter in words or as the character, and refuses the rest", () => {
    expect(["comma", " Semicolon ", "TAB", ",", ";", "\\t"].map(parseDelimiter)).toEqual(["comma", "semicolon", "tab", "comma", "semicolon", "tab"]);
    expect(["", "pipe", "|", "::"].map(parseDelimiter)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("the other ways of adding data wait, and say for what", () => {
  const panel = dataPanel(scene(data));
  const action = (name: string) => panel.actions!.find((a) => a.name === name)!;

  it("offers sample data and a CSV file now, and dims a published sheet and a live feed", () => {
    expect(action("addSampleData").unavailable).toBeUndefined();
    expect(action("addCsv")).toEqual({ name: "addCsv", label: "CSV file…" });
    expect(action("addSheet").unavailable).toBe(DATA_WAITS.sheet);
    expect(action("addLive").unavailable).toBe(DATA_WAITS.live);
  });

  it("names the row each one waits for", () => {
    expect(DATA_WAITS.sheet).toContain("19.14");
    expect(DATA_WAITS.live).toContain("19.14");
  });

  it("gives an agent the same reasons a person sees", () => {
    const find = (node: AgentNode, id: string): AgentNode | undefined => (node.id === id ? node : node.children.map((c) => find(c, id)).find(Boolean));
    const view = find(agentView(panel), "data")!;
    expect(view.actions.find((a) => a.name === "addSheet")).toMatchObject({ available: false, unavailableReason: DATA_WAITS.sheet });
    expect(view.actions.find((a) => a.name === "addCsv")).toMatchObject({ available: true });
    expect(view.actions.find((a) => a.name === "addSampleData")).toMatchObject({ available: true });
  });

  it("draws no Test records table and no result that was not measured", () => {
    const ids: string[] = [];
    const walk = (node: { id: string; children?: readonly unknown[] }): void => {
      ids.push(node.id);
      for (const child of node.children ?? []) walk(child as never);
    };
    walk(panel);
    // The block is there and says it is not checked; no record row, no check and no result exists until the engine has measured.
    expect(ids.filter((id) => /record|result|fit|check/i.test(id))).toEqual(["data/records"]);
  });
});
