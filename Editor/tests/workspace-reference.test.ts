import { describe, expect, it } from "vitest";
import type { ObjectBase, SceneDocument, SceneObject } from "@grapix/contracts";
import { inspectorPanel, inspectorSections } from "../src/inspector";
import { formatTimecode, formatFrameLine, formatRate } from "../src/timeline/clock";
import { timelineLayers } from "../src/timeline/layers";
import { timelineModel } from "../src/timeline/model";
import { renderTimelinePanel } from "../src/timeline/panel";
import { buildViewportObject } from "../src/viewport";
import * as THREE from "three";

function base(id: string): ObjectBase {
  return { id, name: id, visible: true, locked: false, opacity: 1, x: 0, y: 0,
    zDepth: 0, zIndex: 0, layerId: "", width: 100, height: 50,
    rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, strokeWidth: 0 };
}
function scene(objects: SceneObject[]): SceneDocument {
  return { id: "ui", name: "UI", version: 3, workingColorSpace: "srgb",
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 100001n, channels: [], phases: [] }, dataContext: {},
    assets: [], fonts: [], materials: [], controls: [], textStyles: [], objects };
}

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  width = 0;
  height = 0;
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  append(...children: Element[]): void { this.children.push(...children); }
}
const dom = { createElement: () => new Element() } as unknown as Document;
const count = (node: Element): number => 1 + node.children.reduce((total, child) => total + count(child), 0);

describe("the EffectCraft / After Effects workspace presentation", () => {
  it("labels fractional-rate timecode as NDF and derives both readouts from one frame", () => {
    const rate = { num: 30000, den: 1001 };
    expect(formatTimecode(90, rate)).toBe("0:00:03:00");
    expect(formatFrameLine(90, rate)).toBe("00090 (29.97 fps NDF)");
    expect(formatRate({ num: 50, den: 1 })).toBe("50 fps");
    expect(formatTimecode(180000, { num: 50, den: 1 })).toBe("1:00:00:00");
    expect(formatTimecode(90, { num: 50, den: 0 })).toBe("-:--:--:--");
  });

  it("shows unanimated layers and reveals only the selected object's property tracks", () => {
    const document = scene([ { type: "rect", ...base("a"), radius: 0 }, { type: "rect", ...base("b"), radius: 0 } ]);
    document.timeline.channels = [{ objectId: "a", property: "x", keys: [{ frame: 0n, value: 5, easing: "linear" }] }];
    const model = timelineModel(document, { allObjects: true, selectedIds: ["b"] });
    expect(model.rows.map(row => row.objectId)).toEqual(["a", "b"]);
    expect(model.tracks).toHaveLength(0);
    expect(timelineModel(document, { allObjects: true, selectedIds: ["a"] }).tracks).toHaveLength(1);
  });

  it("preserves every inspector field when grouping Properties into sections", () => {
    const document = scene([{ type: "rect", ...base("a"), radius: 5 }]);
    const panel = inspectorPanel(document, ["a"]);
    const grouped = inspectorSections(panel).flatMap(section => section.fields);
    expect(new Set(grouped.map(field => field.id))).toEqual(new Set(panel.children?.map(field => field.id)));
    expect(grouped).toHaveLength(panel.children!.length);
  });

  it("keeps layer switches and icons flat in node count from 100 to 100000 keys", () => {
    const document = scene([{ type: "rect", ...base("a"), radius: 0 }]);
    const nodes = (keys: number): number => {
      document.timeline.channels = [{ objectId: "a", property: "x", keys: Array.from({ length: keys }, (_, frame) => ({ frame: BigInt(frame), value: frame, easing: "linear" as const })) }];
      const model = timelineModel(document, { allObjects: true });
      const panel = renderTimelinePanel(dom, model, { startFrame: 0, pixelsPerFrame: 6, width: 800, height: 200, scrollTop: 0, rowHeight: 22 }, timelineLayers(document));
      return count(panel.root as unknown as Element);
    };
    expect(nodes(100)).toBe(nodes(100000));
  });

  it("uses the object manager's refusal for a visibility switch under a hidden parent", () => {
    const parent: SceneObject = { type: "group", ...base("parent"), visible: false, childIds: ["child"] };
    const document = scene([parent, { type: "rect", ...base("child"), radius: 0 }]);
    expect(timelineLayers(document).get("child")?.visibility.unavailable).toBeDefined();
  });

  it("places painted rectangle corners at the same top-left coordinates as the selection overlay", () => {
    const object: SceneObject = { type: "rect", ...base("r"), x: 40, y: 60, radius: 0,
      fill: { type: "solid", color: { r: 1, g: 1, b: 1, a: 1, space: "srgb" } } };
    const mesh = buildViewportObject(object, { width: 1920, height: 1080 }, []);
    expect(mesh).not.toBeNull();
    mesh!.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(mesh!);
    expect(box.min.x).toBeCloseTo(40 - 960);
    expect(box.max.x).toBeCloseTo(140 - 960);
    expect(box.max.y).toBeCloseTo(540 - 60);
    expect(box.min.y).toBeCloseTo(540 - 110);
    mesh!.geometry.dispose();
    const anchored = buildViewportObject({ ...object, anchor: { x: 20, y: 10 }, scaleX: 2, rotation: 90 }, { width: 1920, height: 1080 }, []);
    anchored!.updateMatrixWorld();
    const topLeft = new THREE.Vector3(-20, 10, 0).applyMatrix4(anchored!.matrixWorld);
    expect(topLeft.x).toBeCloseTo(50 - 960);
    expect(topLeft.y).toBeCloseTo(540 - 20);
    anchored!.geometry.dispose();
  });

  it("names missing image pixels instead of substituting a grey plane", () => {
    const unsupported: string[] = [];
    const object: SceneObject = { type: "image", ...base("logo"), assetId: "asset", fit: "contain" };
    expect(buildViewportObject(object, { width: 1920, height: 1080 }, unsupported)).toBeNull();
    expect(unsupported).toEqual([expect.stringContaining("logo: image pixels")]);
  });
});
