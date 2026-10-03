// Browser font registration (build plan 11.13), ported from the 1.x
// `ProjectFontRegistry` on the archive branch.
//
// **Registered before anything is measured.** `FontRegistry.register` resolves
// only after every enabled file face has been decoded by the browser
// (`FontFace.load()`), added to the document's font set, and confirmed by
// `document.fonts.load()` to match a registered face. A caller awaits it, then
// measures or renders text; text measured earlier would be measured in
// whatever face the browser substituted, and the layout would be wrong in a
// way no check sees.
//
// **Failures are named, never substituted.** A face whose asset is missing,
// whose bytes cannot be read or decoded, or that the font set does not resolve
// is reported with its font's name and the reason. The font is then not
// ready: `unresolvedFontIds` feeds the font manager's take-blocking alert. A
// font that still points at the network (a pre-download CSS or Adobe link) is
// reported as unverified rather than fetched from a CDN — templates and the
// Editor load project bytes only. Nothing here names a system font.
//
// The browser surface is injected (`FontRegistrationEnvironment`) so the
// ordering and failure rules are tested without a DOM; `browserFontEnvironment`
// is the real one over `document.fonts`.

import type {
  AssetLibraryItem,
  FontDefinition,
  FontFaceDefinition,
  FontLoadStatus,
} from "@grapix/contracts";

/// The part of a `FontFace` registration needs.
export interface RegisteredFace {
  readonly status: string;
  load(): Promise<unknown>;
}

/// The part of the CSS Font Loading API registration needs.
export interface FontRegistrationEnvironment {
  createFace(family: string, bytes: ArrayBuffer, descriptors: FontFaceDescriptors): RegisteredFace;
  add(face: RegisteredFace): void;
  delete(face: RegisteredFace): void;
  /// `FontFaceSet.load`: the registered faces that match a CSS font shorthand
  /// for `text`, once they have loaded.
  match(font: string, text: string): Promise<readonly RegisteredFace[]>;
}

export function browserFontEnvironment(
  fonts: FontFaceSet = document.fonts,
): FontRegistrationEnvironment {
  return {
    createFace: (family, bytes, descriptors) => new FontFace(family, bytes, descriptors),
    add: (face) => {
      fonts.add(face as FontFace);
    },
    delete: (face) => {
      fonts.delete(face as FontFace);
    },
    match: (font, text) => fonts.load(font, text),
  };
}

/// Reads a project font asset's bytes (the shell's content-addressed cache).
export type FontBytesLoader = (asset: AssetLibraryItem) => Promise<ArrayBuffer>;

export interface FontRegistrationFailure {
  readonly fontId: string;
  readonly displayName: string;
  readonly faceId: string;
  readonly status: FontLoadStatus;
  readonly reason: string;
}

export interface FontRegistrationReport {
  /// Enabled fonts whose every face is registered and resolves.
  readonly ready: readonly string[];
  readonly failures: readonly FontRegistrationFailure[];
  /// Fonts with at least one failed face, in scene order: take blockers.
  readonly unresolvedFontIds: readonly string[];
}

/// One sentence naming every failed font and why, or `undefined`.
export function registrationFailureSummary(report: FontRegistrationReport): string | undefined {
  if (report.failures.length === 0) return undefined;
  return `font(s) failed to load: ${report.failures
    .map((failure) => `${failure.displayName} (${failure.faceId}): ${failure.reason}`)
    .join("; ")}`;
}

interface LoadedFace {
  readonly face: RegisteredFace;
  readonly signature: string;
}

export class FontRegistry {
  private readonly loaded = new Map<string, LoadedFace>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly environment: FontRegistrationEnvironment,
    private readonly loadBytes: FontBytesLoader,
  ) {}

  /// Make the browser's font set match `fonts`: register new or changed file
  /// faces, drop faces no enabled font declares, and report each font. Calls
  /// are serialised, so an overlapping call never registers a face twice.
  register(
    fonts: readonly FontDefinition[],
    assets: readonly AssetLibraryItem[],
  ): Promise<FontRegistrationReport> {
    const run = this.tail.then(() => this.sync(fonts, assets));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async sync(
    fonts: readonly FontDefinition[],
    assets: readonly AssetLibraryItem[],
  ): Promise<FontRegistrationReport> {
    const enabled = fonts.filter((font) => font.enabled);
    const declared = new Set(enabled.flatMap((font) => font.faces.map((face) => face.faceId)));
    for (const [faceId, entry] of this.loaded) {
      if (declared.has(faceId)) continue;
      this.environment.delete(entry.face);
      this.loaded.delete(faceId);
    }

    const perFont = await Promise.all(
      enabled.map(async (font) => {
        if (font.faces.length === 0) {
          return [failure(font, "", "Missing", "the font declares no faces")];
        }
        const outcomes = await Promise.all(
          font.faces.map((face) => this.registerFace(font, face, assets)),
        );
        return outcomes.filter((outcome): outcome is FontRegistrationFailure => outcome !== undefined);
      }),
    );

    const failures = perFont.flat();
    return {
      ready: enabled.filter((_, index) => perFont[index]!.length === 0).map((font) => font.fontId),
      failures,
      unresolvedFontIds: enabled
        .filter((_, index) => perFont[index]!.length > 0)
        .map((font) => font.fontId),
    };
  }

  private async registerFace(
    font: FontDefinition,
    face: FontFaceDefinition,
    assets: readonly AssetLibraryItem[],
  ): Promise<FontRegistrationFailure | undefined> {
    const source = face.source;
    if (source.kind !== "file") {
      return failure(
        font,
        face.faceId,
        "Unverified",
        `${source.kind} source ${source.url} is not in the project; ingest the link to download its faces`,
      );
    }
    const asset = assets.find((candidate) => candidate.assetId === source.assetId);
    if (!asset) {
      return failure(font, face.faceId, "Missing", `font asset ${source.assetId} is not in the scene library`);
    }
    if (asset.status !== undefined && asset.status !== "ready") {
      return failure(font, face.faceId, "Missing", `font asset ${asset.assetId} is ${asset.status}`);
    }

    const signature = [
      asset.assetId,
      asset.checksum ?? "",
      face.family,
      face.weight,
      face.style,
      face.stretch ?? "",
      face.unicodeRange ?? "",
    ].join("|");
    const existing = this.loaded.get(face.faceId);
    if (existing && existing.signature !== signature) {
      this.environment.delete(existing.face);
      this.loaded.delete(face.faceId);
    }

    if (!this.loaded.has(face.faceId)) {
      let bytes: ArrayBuffer;
      try {
        bytes = await this.loadBytes(asset);
      } catch (error) {
        return failure(
          font,
          face.faceId,
          "Error",
          `font asset ${asset.assetId} could not be read: ${describe(error)}`,
        );
      }
      const created = this.environment.createFace(face.family, bytes, {
        weight: String(face.weight),
        style: face.style,
        // A template must not paint a substitute while its own face loads.
        display: "block",
        ...(face.stretch === undefined ? {} : { stretch: face.stretch }),
        ...(face.unicodeRange === undefined ? {} : { unicodeRange: face.unicodeRange }),
      });
      try {
        await created.load();
      } catch (error) {
        return failure(
          font,
          face.faceId,
          "Invalid",
          `the browser could not decode ${asset.name}: ${describe(error)}`,
        );
      }
      this.environment.add(created);
      this.loaded.set(face.faceId, { face: created, signature });
    }

    // The set itself must answer for this family, weight and style; an
    // empty answer means text would fall through to a substitute.
    let matched: readonly RegisteredFace[];
    try {
      matched = await this.environment.match(cssFontShorthand(face), probeText(face));
    } catch (error) {
      return failure(font, face.faceId, "Error", `the font set could not load it: ${describe(error)}`);
    }
    if (matched.length === 0 || matched.some((candidate) => candidate.status !== "loaded")) {
      return failure(
        font,
        face.faceId,
        "Error",
        `${face.family} ${face.weight} ${face.style} does not resolve to a registered face`,
      );
    }
    return undefined;
  }
}

function failure(
  font: FontDefinition,
  faceId: string,
  status: FontLoadStatus,
  reason: string,
): FontRegistrationFailure {
  return { fontId: font.fontId, displayName: font.displayName, faceId, status, reason };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/// The CSS `font` shorthand that selects exactly this face (1.x shorthand).
export function cssFontShorthand(face: FontFaceDefinition): string {
  return `${face.style} ${face.weight} 16px "${face.family.replace(/["\\]/g, "\\$&")}"`;
}

/// Text inside the face's `unicode-range`, so the set's match considers this
/// face rather than skipping it for a range it does not cover. Without a range
/// the face covers everything and Latin suffices.
function probeText(face: FontFaceDefinition): string {
  const first = face.unicodeRange?.split(",")[0]?.trim().replace(/^u\+/i, "");
  if (!first) return "Ag0123";
  // `U+0400-04FF`, `U+0131` or wildcard `U+4??` (= U+0400-04FF).
  const [lowText = "", highText = lowText.replace(/\?/g, "f")] = first.split("-");
  const low = Number.parseInt(lowText.replace(/\?/g, "0"), 16);
  const high = Number.parseInt(highText, 16);
  if (!Number.isFinite(low)) return "Ag0123";
  // Skip the C0 controls a Latin range starts with: probe "A" when covered.
  return String.fromCodePoint(low < 0x20 && high >= 0x41 ? 0x41 : low);
}
