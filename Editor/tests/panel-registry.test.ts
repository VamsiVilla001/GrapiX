// The panel registry (11.93): what is refused at registration, and what is unavailable and why.
import { describe, expect, it } from "vitest";
import { createPanelRegistry, isRegistryRefused, unavailableReason, type PanelDefinition } from "../src/panel-registry";
import { DEFINITIONS, registry } from "./dock-fixtures";

const one = (overrides: Partial<PanelDefinition>): PanelDefinition => ({
  type: "thing", title: "Thing", app: "editor", singleton: true, allowClose: true, allowFloat: true, allowMultiple: false, ...overrides,
});

function refusedFor(definitions: readonly PanelDefinition[]): string {
  const made = createPanelRegistry(definitions);
  if (!isRegistryRefused(made)) throw new Error("not refused");
  return made.refused;
}

describe("registering panels", () => {
  it("accepts a good set, keeps its order and finds each by type", () => {
    const made = registry();
    expect(made.definitions.map((definition) => definition.type)).toEqual(DEFINITIONS.map((definition) => definition.type));
    expect(made.get("timeline")?.title).toBe("Timeline");
    expect(made.has("timeline")).toBe(true);
    expect(made.has("nothing")).toBe(false);
    expect(made.get("nothing")).toBeUndefined();
  });

  it("lists the panels an application can show, with those for both in each", () => {
    const made = registry();
    expect(made.forApp("editor").map((d) => d.type)).toContain("anywhere");
    expect(made.forApp("editor").map((d) => d.type)).not.toContain("rundown");
    expect(made.forApp("playout").map((d) => d.type)).toEqual(["rundown", "anywhere"]);
  });

  it("refuses a type registered twice, naming it", () => {
    expect(refusedFor([one({}), one({})])).toBe('panel "thing" cannot be registered: that type is already registered; give one of them another type name');
  });

  it("refuses a type that is not lower-case words joined by hyphens", () => {
    for (const type of ["Thing", "my_thing", "", "thing-", "-thing", "1thing", "a b"]) {
      expect(refusedFor([one({ type })]), type).toContain("lower-case words joined by hyphens");
    }
  });

  it("refuses a panel with no title, or an application it does not know", () => {
    expect(refusedFor([one({ title: "  " })])).toContain("it has no title");
    expect(refusedFor([one({ app: "neither" as never })])).toContain('"neither" is not editor, playout or both');
  });

  it("refuses contradictory capabilities", () => {
    expect(refusedFor([one({ singleton: true, allowMultiple: true })])).toContain("both a singleton and allow more than one");
    expect(refusedFor([one({ singleton: false, allowMultiple: false, supportsContextPin: true })])).toContain("needs to allow more than one");
    expect(createPanelRegistry([one({ singleton: false, allowMultiple: true, supportsContextPin: true })])).not.toHaveProperty("code");
  });

  it("refuses a size, a placement or a capability that cannot be used", () => {
    for (const minSize of [{ width: 0, height: 10 }, { width: 10, height: -1 }, { width: Number.NaN, height: 10 }, { width: 10, height: Infinity }]) {
      expect(refusedFor([one({ minSize })])).toContain("positive width and height");
    }
    expect(refusedFor([one({ defaultPlacement: { groupHint: " " } })])).toContain("names no group");
    expect(refusedFor([one({ defaultPlacement: { groupHint: "left", tabIndex: -1 } })])).toContain("whole number");
    expect(refusedFor([one({ defaultPlacement: { groupHint: "left", tabIndex: 1.5 } })])).toContain("whole number");
    expect(refusedFor([one({ capability: " " })])).toContain("capability is blank");
  });

  it("names the first bad definition and stops there", () => {
    expect(refusedFor([one({ type: "fine" }), one({ type: "bad", title: "" }), one({ type: "Worse" })])).toContain('"bad"');
  });
});

describe("what cannot be shown here, and why", () => {
  const made = registry();
  const none = new Set<string>();

  it("is nothing for a panel this application and build can show", () => {
    expect(unavailableReason(made, "timeline", "editor", none)).toBeUndefined();
    expect(unavailableReason(made, "anywhere", "playout", none)).toBeUndefined();
    expect(unavailableReason(made, "conformance", "editor", new Set(["conformance"]))).toBeUndefined();
  });

  it("names a panel kind this build has never heard of", () => {
    expect(unavailableReason(made, "from-the-future", "editor", none)).toBe("this build does not know a panel called from-the-future");
  });

  it("names the application a panel belongs to", () => {
    expect(unavailableReason(made, "rundown", "editor", none)).toBe("Rundown belongs to the playout application");
    expect(unavailableReason(made, "timeline", "playout", none)).toBe("Timeline belongs to the editor application");
  });

  it("names a missing capability", () => {
    expect(unavailableReason(made, "conformance", "editor", none)).toBe("Conformance needs conformance, which this build does not have");
  });
});
