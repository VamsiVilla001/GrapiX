// Panchayati task 119 / plan row 11.122: the Editor's own asset-usage rule (`projectAssetUsage` in library.ts, `assetUsers` in
// asset-manager.ts) must give what the shared fixture says. `Shared/contracts/src/asset_usage.rs` is tested against the same fixture,
// so the client rule and the backend rule cannot drift apart while the Library still has a client scan. Read-only: this test reads those
// functions and edits nothing.
import { describe, expect, it } from "vitest";

import type { SceneDocument } from "@grapix/contracts";

import fixture from "../../Shared/contracts/fixtures/asset-usage.json";
import { assetUsers } from "../src/asset-manager";
import { projectAssetUsage, usageKey } from "../src/library";

interface FixtureAsset {
  readonly assetId: string;
  readonly checksum?: string;
}
interface FixtureScene {
  readonly sceneId: string;
  readonly document: { readonly name: string; readonly assets: readonly FixtureAsset[] };
}

const scenes = (fixture.scenes as unknown as readonly FixtureScene[]).map((scene) => ({
  sceneId: scene.sceneId,
  name: scene.document.name,
  document: scene.document as unknown as SceneDocument,
}));

describe("the client's asset-usage rule gives what the shared fixture says", () => {
  it("covers the four cases the Library needs: a file shared by two scenes, an unused asset, a model and a bound-material texture", () => {
    const keys = new Set(fixture.expected.entries.map((entry) => entry.key));
    expect(fixture.expected.entries.some((entry) => entry.scenes.length === 2 && entry.assetIds.length > 1)).toBe(true);
    expect(fixture.expected.entries.some((entry) => entry.scenes.length === 0)).toBe(true);
    expect(keys.size).toBe(fixture.expected.entries.length);
    expect(fixture.objectsDrawing.some((use) => use.assetId === "model" && use.objects.length === 1)).toBe(true);
    expect(fixture.objectsDrawing.some((use) => use.assetId === "tex" && use.objects.length === 1)).toBe(true);
  });

  it("keys an asset by its content hash, else id:<assetId>, as the backend does", () => {
    for (const asset of [...(fixture.projectAssets as readonly FixtureAsset[]), ...scenes.flatMap((scene) => scene.document.assets as readonly FixtureAsset[])]) {
      const key = usageKey(asset as unknown as Parameters<typeof usageKey>[0]);
      expect(key).toBe(asset.checksum ?? `id:${asset.assetId}`);
      expect(fixture.expected.entries.some((entry) => entry.key === key)).toBe(true);
    }
  });

  it("projectAssetUsage lists, for each used key, the same scenes in the same order, once each", () => {
    const usage = projectAssetUsage(scenes);
    const used = fixture.expected.entries.filter((entry) => entry.scenes.length > 0);
    expect([...usage.keys()].sort()).toEqual(used.map((entry) => entry.key).sort());
    for (const entry of used) expect(usage.get(entry.key), entry.key).toEqual(entry.scenes);
  });

  it("projectAssetUsage has no entry for an asset nothing draws (the backend's empty list is its absence here)", () => {
    const usage = projectAssetUsage(scenes);
    for (const entry of fixture.expected.entries.filter((candidate) => candidate.scenes.length === 0)) expect(usage.has(entry.key), entry.key).toBe(false);
  });

  it("assetUsers gives the objects that draw each declared asset, in document order", () => {
    expect(fixture.objectsDrawing.length).toBe(5); // scene a declares four assets, scene b one
    for (const use of fixture.objectsDrawing) {
      const scene = scenes.find((candidate) => candidate.sceneId === use.sceneId);
      expect(scene, use.sceneId).toBeDefined();
      expect(assetUsers(scene!.document, use.assetId), `${use.sceneId}/${use.assetId}`).toEqual(use.objects);
    }
  });
});
