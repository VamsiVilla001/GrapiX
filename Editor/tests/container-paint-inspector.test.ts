import { describe, expect, it } from "vitest";
import type { ColorValue, ObjectBase, SceneDocument, SceneObject } from "@grapix/contracts";
import { agentView, findNode } from "../src/agent-surface";
import { inspectorEdits, inspectorPanel, inspectorSections } from "../src/inspector";

const solid: ColorValue = { type: "solid", color: { r: 1, g: 0, b: 0, a: 1, space: "srgb" } };

function base(id: string): ObjectBase {
  return { id, name: id, visible: true, locked: false, opacity: 1,
    x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "", width: 100, height: 50,
    rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, strokeWidth: 0 };
}

function container(kind: "group" | "layer", paint: Partial<Pick<ObjectBase, "fill" | "stroke" | "strokeWidth">> = {}): SceneObject {
  const common = { ...base(kind), ...paint, childIds: [] };
  return kind === "group" ? { type: "group", ...common } : { type: "layer", layerKind: "object", ...common };
}

function scene(objects: SceneObject[]): SceneDocument {
  return { id: "containers", name: "Containers", version: 3, workingColorSpace: "srgb",
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 100n, channels: [], phases: [] }, dataContext: {},
    assets: [], fonts: [], materials: [], controls: [], textStyles: [], objects };
}

describe("container paint in Properties", () => {
  it.each([
    ["group", "fill"], ["group", "stroke"], ["layer", "fill"], ["layer", "stroke"],
  ] as const)("shows stored %s %s as a named refusal, without editing it", (kind, property) => {
    const document = scene([{ type: "rect", ...base("rect"), radius: 0 }, container(kind, { [property]: solid })]);
    const before = structuredClone(document);
    const panel = inspectorPanel(document, [kind]);
    const notice = findNode(panel, `inspector/refused-paint/${kind}/${property}`)!;
    expect(notice.role).toBe("alert");
    expect(notice.value).toContain("Refused [scenePropertyNotDrawable]");
    expect(notice.value).toContain(`objects[1].${property}`);
    expect(notice.value).toContain(`(${kind})`);
    expect(notice.description).toContain(JSON.stringify(solid));
    expect(notice.input).toBeUndefined();
    expect(notice.actions).toBeUndefined();
    expect(document).toEqual(before);
    expect(findNode(panel, `inspector/${property}`)).toBeUndefined();
    expect(inspectorSections(panel)[0]?.title).toBe("Unsupported container paint");
    const agentNotice = agentView(panel).children.find(node => node.id === notice.id)!;
    expect(agentNotice.value).toBe(notice.value);
    expect(agentNotice.actions).toEqual([]);
  });

  it.each(["group", "layer"] as const)("leaves unpainted %s containers editable without paint controls", kind => {
    for (const paint of [{}, { fill: { type: "none" } as const, stroke: { type: "none" } as const, strokeWidth: 12 }]) {
      const document = scene([container(kind, paint)]);
      const panel = inspectorPanel(document, [kind]);
      expect(panel.children?.filter(node => node.role === "alert")).toEqual([]);
      expect(findNode(panel, "inspector/fill")).toBeUndefined();
      expect(findNode(panel, "inspector/stroke")).toBeUndefined();
      expect(inspectorEdits(document, [kind], "x", 12)).toEqual([
        { edit: "setObjectField", objectIds: [kind], field: { name: "x", value: 12 } },
      ]);
    }
  });

  it("reports all selected container paints while retaining child shape and transform editing", () => {
    const document = scene([
      container("group", { fill: solid, stroke: solid }),
      container("layer", { fill: solid }),
      { type: "rect", ...base("rect"), fill: solid, stroke: solid, radius: 0 },
    ]);
    const panel = inspectorPanel(document, ["group", "layer", "rect"]);
    const notices = panel.children!.filter(node => node.role === "alert");
    expect(notices).toHaveLength(3);
    expect(notices.every(node => !node.id.includes("/rect/"))).toBe(true);
    expect(findNode(panel, "inspector/x")?.actions?.[0]?.unavailable).toBeUndefined();
    const sections = inspectorSections(panel).flatMap(section => section.fields);
    expect(sections).toHaveLength(panel.children!.length);
    expect(new Set(sections.map(node => node.id)).size).toBe(sections.length);
    expect(inspectorPanel(document, ["rect"]).children?.some(node => node.role === "alert")).toBe(false);
  });

  it("preserves the refusal for transparent paints and empty gradients, even on hidden containers", () => {
    const transparent: ColorValue = { type: "solid", color: { r: 1, g: 0, b: 0, a: 0, space: "srgb" } };
    const gradient: ColorValue = { type: "linear-gradient", angle: 0, startX: 0, startY: 0, endX: 1, endY: 0,
      stops: [], spread: "pad", coordinateMode: "object" };
    const object = container("group", { fill: transparent, stroke: gradient });
    object.visible = false;
    const document = scene([object]);
    const before = structuredClone(document);
    const panel = inspectorPanel(document, ["group"]);
    expect(panel.children?.filter(node => node.role === "alert")).toHaveLength(2);
    expect(document).toEqual(before);
  });
});
