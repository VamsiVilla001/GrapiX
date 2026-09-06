import type {
  AssetLibraryItem,
  FontDefinition,
  FontFaceDefinition,
  FontLoadStatus
} from "@grapix/shared-types";

import { apiBaseUrl } from "../lib/apiClient";
import { fetchProjectAsset, resolveProjectAssetUrl } from "../lib/projectAssets";

export interface RuntimeFontFaceState {
  faceId: string;
  status: FontLoadStatus;
  errorMessage?: string;
}

export interface RuntimeFontState {
  fontId: string;
  status: FontLoadStatus;
  errorMessage?: string;
  faces: RuntimeFontFaceState[];
}

type Listener = () => void;

/**
 * The one browser-side font loading authority. It registers every local face
 * through FontFace, deduplicates work, and publishes a revision only after
 * loading and browser layout readiness have completed.
 */
export class ProjectFontRegistry {
  private readonly listeners = new Set<Listener>();
  private readonly states = new Map<string, RuntimeFontState>();
  private readonly loadedFaces = new Map<string, FontFace>();
  private readonly faceSignatures = new Map<string, string>();
  private syncGeneration = 0;
  private revision = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.revision;

  get(fontId: string): RuntimeFontState | undefined {
    return this.states.get(fontId);
  }

  all(): RuntimeFontState[] {
    return [...this.states.values()];
  }

  async sync(fonts: FontDefinition[], assets: AssetLibraryItem[]): Promise<void> {
    const generation = ++this.syncGeneration;
    const active = fonts.filter((font) => font.enabled !== false);
    const activeFaceIds = new Set(active.flatMap((font) => font.faces.map((face) => face.faceId)));
    for (const [faceId, face] of this.loadedFaces) {
      if (!activeFaceIds.has(faceId)) {
        document.fonts.delete(face);
        this.loadedFaces.delete(faceId);
        this.faceSignatures.delete(faceId);
      }
    }
    for (const font of fonts) {
      if (font.enabled === false) {
        this.states.set(font.fontId, {
          fontId: font.fontId,
          status: font.status,
          faces: font.faces.map((face) => ({
            faceId: face.faceId,
            status: face.status ?? font.status
          }))
        });
      } else {
        this.states.set(font.fontId, {
          fontId: font.fontId,
          status: "LOADING",
          faces: font.faces.map((face) => ({ faceId: face.faceId, status: "LOADING" }))
        });
      }
    }
    this.publish();

    await Promise.all(active.map(async (font) => {
      const faceStates = await Promise.all(font.faces.map((face) => this.loadFace(face, assets)));
      if (generation !== this.syncGeneration) return;
      const failed = faceStates.filter((face) => face.status !== "READY");
      this.states.set(font.fontId, {
        fontId: font.fontId,
        status: failed.length === faceStates.length
          ? strongestFailure(failed.map((face) => face.status))
          : "READY",
        errorMessage: failed.length ? failed.map((face) => face.errorMessage).filter(Boolean).join("; ") : undefined,
        faces: faceStates
      });
    }));

    if (generation === this.syncGeneration) {
      await document.fonts.ready;
      this.publish();
      window.dispatchEvent(new CustomEvent("grapix-fonts-ready", { detail: { revision: this.revision } }));
    }
  }

  private async loadFace(
    face: FontFaceDefinition,
    assets: AssetLibraryItem[]
  ): Promise<RuntimeFontFaceState> {
    try {
      if (face.source.kind !== "file") {
        return {
          faceId: face.faceId,
          status: "UNVERIFIED",
          errorMessage: "Remote references are not executed in the editor. Resolve this source again to validate and package its font faces."
        };
      }
      const assetId = face.source.assetId;
      const url = resolveAssetUrl(assetId, assets);
      if (!url) {
        return {
          faceId: face.faceId,
          status: "MISSING",
          errorMessage: `Font asset ${assetId} is missing`
        };
      }
      const asset = assets.find((item) => item.assetId === assetId);
      const signature = `${url}:${asset?.checksum ?? ""}:${face.weight}:${face.style}:${face.stretch ?? ""}`;
      let browserFace = this.loadedFaces.get(face.faceId);
      if (browserFace && this.faceSignatures.get(face.faceId) !== signature) {
        document.fonts.delete(browserFace);
        this.loadedFaces.delete(face.faceId);
        browserFace = undefined;
      }
      if (!browserFace) {
        // The content route requires the session bearer; fetchProjectAsset attaches it.
        const response = await fetchProjectAsset(url);
        if (!response.ok) {
          throw new Error(`Font asset ${assetId} returned HTTP ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        browserFace = new FontFace(face.family, bytes, {
          weight: String(face.weight),
          style: face.style,
          stretch: face.stretch,
          unicodeRange: face.unicodeRange,
          display: "block"
        });
        await browserFace.load();
        document.fonts.add(browserFace);
        this.loadedFaces.set(face.faceId, browserFace);
        this.faceSignatures.set(face.faceId, signature);
      }
      await document.fonts.load(fontShorthand(face), fontProbe(face));
      return { faceId: face.faceId, status: "READY" };
    } catch (error) {
      const message = describeLoadError(error);
      return {
        faceId: face.faceId,
        status: /unsupported|format/i.test(message) ? "UNSUPPORTED" : "ERROR",
        errorMessage: message
      };
    }
  }

  private publish(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

export const projectFontRegistry = new ProjectFontRegistry();

function resolveAssetUrl(assetId: string, assets: AssetLibraryItem[]): string | undefined {
  const asset = assets.find((item) => item.assetId === assetId);
  if (!asset) return undefined;
  // A project font is stored like any other asset, so its source resolves the same way: a relative
  // path against the service that owns it, an absolute URL untouched.
  return asset.source
    ? resolveProjectAssetUrl(asset.source)
    : `${apiBaseUrl}/api/assets/${encodeURIComponent(assetId)}/content`;
}

function fontShorthand(face: FontFaceDefinition): string {
  return `${face.style} ${face.weight} 16px "${face.family.replace(/["\\]/g, "\\$&")}"`;
}

function fontProbe(face: FontFaceDefinition): string {
  return face.unicodeRange ? "Ag مرحبا नमस्ते 中文" : "Ag0123";
}

function strongestFailure(statuses: FontLoadStatus[]): FontLoadStatus {
  if (statuses.includes("MISSING")) return "MISSING";
  if (statuses.includes("INVALID")) return "INVALID";
  if (statuses.includes("UNSUPPORTED")) return "UNSUPPORTED";
  if (statuses.includes("UNVERIFIED")) return "UNVERIFIED";
  return "ERROR";
}


function describeLoadError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NetworkError") {
    return "Font file could not be loaded (network or CORS failure)";
  }
  return error instanceof Error ? error.message : "Font could not be loaded";
}
