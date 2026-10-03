// Browser font registration (11.13): fonts are registered before text is
// measured, and a face that cannot load is named rather than substituted.
//
// The environment below stands in for `document.fonts`. It behaves like the
// CSS Font Loading API in the ways registration depends on: a face decodes
// asynchronously, decoding fails for bytes that are not a font container, and
// `load()` on the set answers only with faces that were added to it.

import { describe, expect, it } from "vitest";

import type { AssetLibraryItem, FontDefinition } from "@grapix/contracts";
import {
  FontRegistry,
  registrationFailureSummary,
  type FontRegistrationEnvironment,
  type RegisteredFace,
} from "../src/font-registration";

const MAGICS = ["wOF2", "wOFF", "OTTO", "\u0000\u0001\u0000\u0000"];

class FakeFace implements RegisteredFace {
  status = "unloaded";

  constructor(
    readonly family: string,
    readonly bytes: ArrayBuffer,
    readonly descriptors: FontFaceDescriptors,
    private readonly decoded: Promise<void>,
    private readonly events: string[],
  ) {}

  async load(): Promise<unknown> {
    this.status = "loading";
    await this.decoded;
    const magic = String.fromCharCode(...new Uint8Array(this.bytes.slice(0, 4)));
    if (!MAGICS.includes(magic)) {
      this.status = "error";
      this.events.push(`decode-failed:${this.family}`);
      throw new Error("SyntaxError: the font data could not be decoded");
    }
    this.status = "loaded";
    this.events.push(`loaded:${this.family}`);
    return this;
  }
}

class FakeFontSet implements FontRegistrationEnvironment {
  readonly faces = new Set<FakeFace>();
  readonly events: string[] = [];
  answerEmpty = false;
  private release: () => void = () => undefined;
  private decoded: Promise<void> = Promise.resolve();
  private created = 0;
  private createdWaiters: { count: number; resolve: () => void }[] = [];

  /// Hold every decode until `finishDecoding` is called. (Executor form: the
  /// repo's ES2022 lib does not type `Promise.withResolvers`.)
  holdDecoding(): void {
    this.decoded = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  finishDecoding(): void {
    this.release();
  }

  /// Resolves once `count` faces have been constructed from loaded bytes.
  facesCreated(count: number): Promise<void> {
    if (this.created >= count) return Promise.resolve();
    return new Promise((resolve) => this.createdWaiters.push({ count, resolve }));
  }

  createFace(family: string, bytes: ArrayBuffer, descriptors: FontFaceDescriptors): RegisteredFace {
    this.created += 1;
    for (const waiter of this.createdWaiters.filter((w) => w.count <= this.created)) waiter.resolve();
    this.createdWaiters = this.createdWaiters.filter((w) => w.count > this.created);
    return new FakeFace(family, bytes, descriptors, this.decoded, this.events);
  }

  add(face: RegisteredFace): void {
    this.faces.add(face as FakeFace);
    this.events.push(`added:${(face as FakeFace).family}`);
  }

  delete(face: RegisteredFace): void {
    this.faces.delete(face as FakeFace);
    this.events.push(`deleted:${(face as FakeFace).family}`);
  }

  async match(font: string): Promise<readonly RegisteredFace[]> {
    if (this.answerEmpty) return [];
    const [, style, weight, family] = /^(\S+) (\S+) 16px "(.*)"$/.exec(font) ?? [];
    return [...this.faces].filter(
      (face) =>
        face.family === family &&
        face.descriptors.style === style &&
        face.descriptors.weight === weight,
    );
  }
}

function bytesOf(magic: string): ArrayBuffer {
  return new Uint8Array([...magic].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0])).buffer;
}

function fileFont(fontId: string, displayName: string, assetId: string, weight = 400): FontDefinition {
  return {
    fontId,
    family: displayName,
    displayName,
    faces: [
      {
        faceId: `face-${fontId}`,
        family: displayName,
        weight,
        style: "normal",
        source: { kind: "file", assetId, format: "woff2" },
      },
    ],
    fallbackFamilies: [],
    embeddingPolicy: "package",
    license: "SIL Open Font License 1.1",
    enabled: true,
    status: "Ready",
  };
}

const asset = (assetId: string): AssetLibraryItem => ({
  assetId,
  name: `${assetId}.woff2`,
  kind: "font",
  path: `assets/fonts/${assetId}.woff2`,
  checksum: assetId.padEnd(64, "0"),
  status: "ready",
});

function loaderFor(bytes: Record<string, ArrayBuffer>, calls: string[]) {
  return async (item: AssetLibraryItem): Promise<ArrayBuffer> => {
    calls.push(item.assetId);
    const found = bytes[item.assetId];
    if (!found) throw new Error(`cache has no bytes for ${item.assetId}`);
    return found;
  };
}

describe("registration completes before text may be measured", () => {
  it("does not resolve until every face has decoded, been added and matched", async () => {
    const set = new FakeFontSet();
    const calls: string[] = [];
    const registry = new FontRegistry(
      set,
      loaderFor({ inter: bytesOf("wOF2"), lato: bytesOf("OTTO") }, calls),
    );
    set.holdDecoding();

    let settled = false;
    const pending = registry
      .register(
        [fileFont("font-inter", "Inter", "inter"), fileFont("font-lato", "Lato", "lato", 700)],
        [asset("inter"), asset("lato")],
      )
      .then((report) => {
        settled = true;
        return report;
      });

    // Both faces exist from their bytes, but decoding is held: nothing may
    // measure yet, so the registration must still be pending.
    await set.facesCreated(2);
    expect(calls).toEqual(["inter", "lato"]);
    expect(settled).toBe(false);
    expect(set.faces.size).toBe(0);

    set.finishDecoding();
    const report = await pending;
    expect(report.ready).toEqual(["font-inter", "font-lato"]);
    expect(report.failures).toEqual([]);
    expect(report.unresolvedFontIds).toEqual([]);
    expect([...set.faces].map((face) => [face.family, face.descriptors.weight])).toEqual([
      ["Inter", "400"],
      ["Lato", "700"],
    ]);
    // Each face loaded before it joined the set; the report came last.
    expect(set.events.indexOf("loaded:Inter")).toBeLessThan(set.events.indexOf("added:Inter"));
    expect(registrationFailureSummary(report)).toBeUndefined();
  });

  it("re-registering the same fonts reuses loaded faces; dropped fonts leave the set", async () => {
    const set = new FakeFontSet();
    const calls: string[] = [];
    const registry = new FontRegistry(set, loaderFor({ inter: bytesOf("wOF2") }, calls));
    const fonts = [fileFont("font-inter", "Inter", "inter")];
    await registry.register(fonts, [asset("inter")]);
    await registry.register(fonts, [asset("inter")]);
    expect(calls).toEqual(["inter"]);
    expect(set.faces.size).toBe(1);

    await registry.register([], []);
    expect(set.faces.size).toBe(0);
    expect(set.events).toContain("deleted:Inter");
  });
});

describe("a font that cannot load is named, never substituted", () => {
  it("a face the browser cannot decode fails by font name and blocks", async () => {
    const set = new FakeFontSet();
    const registry = new FontRegistry(
      set,
      loaderFor({ inter: bytesOf("wOF2"), broken: bytesOf("<htm") }, []),
    );
    const report = await registry.register(
      [fileFont("font-inter", "Inter", "inter"), fileFont("font-broken", "Broken Sans", "broken")],
      [asset("inter"), asset("broken")],
    );
    expect(report.ready).toEqual(["font-inter"]);
    expect(report.unresolvedFontIds).toEqual(["font-broken"]);
    expect(report.failures).toEqual([
      {
        fontId: "font-broken",
        displayName: "Broken Sans",
        faceId: "face-font-broken",
        status: "Invalid",
        reason: "the browser could not decode broken.woff2: SyntaxError: the font data could not be decoded",
      },
    ]);
    expect([...set.faces].map((face) => face.family)).toEqual(["Inter"]);
    expect(registrationFailureSummary(report)).toContain("Broken Sans (face-font-broken)");
  });

  it("missing assets, unreadable bytes and remote links are reported, not fetched", async () => {
    const set = new FakeFontSet();
    const calls: string[] = [];
    const registry = new FontRegistry(set, loaderFor({}, calls));
    const linked: FontDefinition = {
      ...fileFont("font-linked", "Roboto", "unused"),
      faces: [
        {
          faceId: "face-linked",
          family: "Roboto",
          weight: 400,
          style: "normal",
          source: { kind: "cssUrl", url: "https://fonts.googleapis.com/css2?family=Roboto" },
        },
      ],
    };
    const report = await registry.register(
      [
        fileFont("font-gone", "Gone", "gone"),
        fileFont("font-uncached", "Uncached", "uncached"),
        linked,
      ],
      [asset("uncached")],
    );
    expect(calls).toEqual(["uncached"]);
    expect(report.ready).toEqual([]);
    expect(report.failures.map((failure) => [failure.displayName, failure.status])).toEqual([
      ["Gone", "Missing"],
      ["Uncached", "Error"],
      ["Roboto", "Unverified"],
    ]);
    expect(report.failures[1]!.reason).toBe(
      "font asset uncached could not be read: cache has no bytes for uncached",
    );
    expect(set.faces.size).toBe(0);
  });

  it("a face the font set does not resolve fails rather than render a substitute", async () => {
    const set = new FakeFontSet();
    set.answerEmpty = true;
    const registry = new FontRegistry(set, loaderFor({ inter: bytesOf("wOF2") }, []));
    const report = await registry.register([fileFont("font-inter", "Inter", "inter")], [asset("inter")]);
    expect(report.unresolvedFontIds).toEqual(["font-inter"]);
    expect(report.failures[0]!.reason).toBe("Inter 400 normal does not resolve to a registered face");
  });
});
