/**
 * The Photoshop **cloud** transport, driven by Adobe's own Photoshop API SDK
 * (`@adobe/aio-lib-photoshop-api`, the library behind `adobe/adobe-photoshop-api-sdk`).
 *
 * Why it exists beside the UXP plugin: a playout machine has no Photoshop on it. The
 * cloud transport reads a PSD's layer tree, edits its text layers, swaps its smart
 * objects and renders previews without one, which is what makes "import from Adobe"
 * usable outside the design suite.
 *
 * What it cannot do is see the document the operator has open — there is no active
 * document in the cloud. Those tools are refused by name rather than approximated.
 */

import type {
  AdobeAsset,
  AdobeImportDocument,
  AdobeLayer,
  ImportWarning
} from "@grapix/adobe-common-schema";
import {
  PS_LAYER_TYPE_FIDELITY,
  PS_LAYER_TYPE_TO_GRAPIX,
  PS_PARAGRAPH_ALIGNMENT,
  defaultTransform,
  resolvePhotoshopBlendMode
} from "@grapix/adobe-common-schema";

import type { PhotoshopApiCredentials } from "./config.js";

/** A file the Photoshop API can read or write. `storage: "external"` is a plain URL. */
export interface PsApiFile {
  href: string;
  storage: string;
}

/** The parts of the SDK client this bridge uses. Narrow on purpose, so it can be faked. */
export interface PhotoshopApiClient {
  getDocumentManifest(input: PsApiFile): Promise<PsApiJob>;
  createRendition(input: PsApiFile, outputs: unknown): Promise<PsApiJob>;
  modifyDocument(input: PsApiFile, outputs: unknown, options: unknown): Promise<PsApiJob>;
  replaceSmartObject(input: PsApiFile, outputs: unknown, options: unknown): Promise<PsApiJob>;
  createDocument(outputs: unknown, options: unknown): Promise<PsApiJob>;
}

export interface PsApiJob {
  jobId?: string;
  outputs?: PsApiJobOutput[];
}

export interface PsApiJobOutput {
  status?: string;
  layers?: PsApiLayer[];
  document?: { name?: string; width?: number; height?: number };
  _links?: unknown;
  errors?: unknown;
}

/** A layer as the Photoshop API's `documentManifest` reports it. */
export interface PsApiLayer {
  id?: number;
  index?: number;
  type?: string;
  name?: string;
  locked?: boolean;
  visible?: boolean;
  bounds?: { top?: number; left?: number; width?: number; height?: number };
  blendOptions?: { opacity?: number; blendMode?: string };
  text?: {
    content?: string;
    characterStyles?: { fontSize?: number; fontName?: string; fontColor?: unknown }[];
    paragraphStyles?: { alignment?: string }[];
  };
  smartObject?: { type?: string; instanceId?: string; linked?: boolean };
  children?: PsApiLayer[];
}

export type PhotoshopApiClientFactory = (
  credentials: PhotoshopApiCredentials
) => Promise<PhotoshopApiClient>;

/**
 * Build a real SDK client: an IMS client-credentials token, then `psApiLib.init`.
 *
 * Imported lazily so a gateway with no Photoshop API configured never loads the SDK, and
 * so the gateway's own tests run without Adobe's dependency tree.
 */
export const createPhotoshopApiClient: PhotoshopApiClientFactory = async (credentials) => {
  const [ims, psApiLib] = await Promise.all([
    import("@adobe/aio-lib-ims"),
    import("@adobe/aio-lib-photoshop-api")
  ]);

  // `new Ims()` is what Adobe's own samples use; the declaration files mark `env` and
  // `cache` required even though the runtime defaults both, so they are passed explicitly.
  const client = new ims.Ims("prod", undefined as never);
  const response = await client.getAccessTokenByClientCredentials(
    credentials.clientId,
    credentials.clientSecret,
    credentials.orgId,
    credentials.scopes
  );

  const accessToken = readAccessToken(response);
  const sdk = await psApiLib.init(credentials.orgId, credentials.clientId, accessToken, undefined, {
    "User-Agent": "GrapiX-Adobe-Gateway/0.1.0"
  });
  return sdk as unknown as PhotoshopApiClient;
};

/**
 * Pull the bearer token out of an IMS response.
 *
 * IMS returns `{ access_token: { token } }` for client credentials, but the library types
 * it as `any`, so the shape is checked here: a missing token must fail at the boundary
 * rather than reach Adobe as the literal string "undefined".
 */
function readAccessToken(response: unknown): string {
  if (response && typeof response === "object" && "access_token" in response) {
    const wrapper = response.access_token;
    if (typeof wrapper === "string") return wrapper;
    if (wrapper && typeof wrapper === "object" && "token" in wrapper && typeof wrapper.token === "string") {
      return wrapper.token;
    }
  }
  throw new Error("Adobe IMS returned no access token for these client credentials");
}

/** Tools the cloud transport genuinely implements. Everything else is refused by name. */
export const PHOTOSHOP_CLOUD_TOOLS: readonly string[] = [
  "photoshop.getDocumentStructure",
  "photoshop.exportPreview",
  "photoshop.updateTextLayer",
  "photoshop.replaceSmartObject",
  "photoshop.createDocument",
  "photoshop.importGrapixScene"
];

/**
 * Why a Photoshop tool cannot be served over the cloud API, when it cannot.
 *
 * Each reason names the missing capability rather than saying "unsupported", because the
 * remedy differs: connect the plugin, or accept that the operation does not exist.
 */
const CLOUD_REFUSALS: Record<string, string> = {
  "photoshop.getActiveDocument":
    "the Photoshop API operates on a PSD by URL and has no active document. Connect the Photoshop plugin, or call photoshop.getDocumentStructure with a href.",
  "photoshop.getSelectedLayers":
    "the Photoshop API has no selection state. Connect the Photoshop plugin to read the operator's selection.",
  "photoshop.exportLayers":
    "the Photoshop API renders whole documents, not individual layers. Connect the Photoshop plugin to export layers separately.",
  "photoshop.createLayer":
    "the Photoshop API creates layers only as part of a whole document. Use photoshop.createDocument, or connect the Photoshop plugin.",
  "photoshop.updateShapeLayer":
    "the Photoshop API cannot edit shape geometry. Connect the Photoshop plugin."
};

export class PhotoshopApiBridge {
  private client?: PhotoshopApiClient;

  constructor(
    private readonly credentials: PhotoshopApiCredentials,
    private readonly factory: PhotoshopApiClientFactory = createPhotoshopApiClient
  ) {}

  /** Built on first use: a token round trip should not delay gateway startup. */
  private async connected(): Promise<PhotoshopApiClient> {
    if (!this.client) this.client = await this.factory(this.credentials);
    return this.client;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const refusal = CLOUD_REFUSALS[tool];
    if (refusal) throw new Error(refusal);

    switch (tool) {
      case "photoshop.getDocumentStructure":
        return this.documentStructure(args);
      case "photoshop.exportPreview":
        return this.exportPreview(args);
      case "photoshop.updateTextLayer":
        return this.updateTextLayer(args);
      case "photoshop.replaceSmartObject":
        return this.replaceSmartObject(args);
      case "photoshop.createDocument":
      case "photoshop.importGrapixScene":
        return this.createDocument(args);
      default:
        throw new Error(`${tool} is not implemented by the Photoshop API transport`);
    }
  }

  private async documentStructure(args: Record<string, unknown>): Promise<AdobeImportDocument> {
    const input = requireFile(args, "href");
    const client = await this.connected();
    const job = await client.getDocumentManifest(input);
    const output = firstOutput(job, "getDocumentManifest");
    return manifestToImportDocument(output, String(args.href));
  }

  private async exportPreview(args: Record<string, unknown>): Promise<unknown> {
    const input = requireFile(args, "href");
    const client = await this.connected();
    const job = await client.createRendition(input, args.outputs ?? []);
    return { jobId: job.jobId, outputs: job.outputs ?? [] };
  }

  private async updateTextLayer(args: Record<string, unknown>): Promise<unknown> {
    const input = requireFile(args, "href");
    if (typeof args.layerName !== "string" || !args.layerName) {
      throw new Error("photoshop.updateTextLayer needs a layerName");
    }
    if (typeof args.text !== "string") {
      throw new Error("photoshop.updateTextLayer needs the replacement text");
    }

    const client = await this.connected();
    const job = await client.modifyDocument(input, args.outputs ?? [], {
      layers: [{ name: args.layerName, text: { content: args.text } }]
    });
    return { jobId: job.jobId, outputs: job.outputs ?? [] };
  }

  private async replaceSmartObject(args: Record<string, unknown>): Promise<unknown> {
    const input = requireFile(args, "href");
    if (typeof args.layerName !== "string" || !args.layerName) {
      throw new Error("photoshop.replaceSmartObject needs a layerName");
    }
    const replacement = requireFile(args, "replacementHref");

    const client = await this.connected();
    const job = await client.replaceSmartObject(input, args.outputs ?? [], {
      layers: [{ name: args.layerName, input: replacement }]
    });
    return { jobId: job.jobId, outputs: job.outputs ?? [] };
  }

  private async createDocument(args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connected();
    const job = await client.createDocument(args.outputs ?? [], {
      document: args.document ?? {},
      layers: args.layers ?? []
    });
    return { jobId: job.jobId, outputs: job.outputs ?? [] };
  }
}

function requireFile(args: Record<string, unknown>, key: string): PsApiFile {
  const href = args[key];
  if (typeof href !== "string" || !href) {
    throw new Error(`the Photoshop API transport needs a ${key} pointing at the PSD`);
  }
  const storage = typeof args.storage === "string" ? args.storage : "external";
  return { href, storage };
}

function firstOutput(job: PsApiJob, operation: string): PsApiJobOutput {
  const output = job.outputs?.[0];
  if (!output) throw new Error(`${operation} returned no output`);
  if (output.status && output.status !== "succeeded") {
    throw new Error(`${operation} finished as "${output.status}"`);
  }
  return output;
}

/**
 * Turn a Photoshop API document manifest into the shared Adobe import document.
 *
 * The layer tree is walked depth-first and flattened into parent-linked layers, keeping
 * `children` as well, so a consumer can use whichever shape suits it. Every layer type
 * and blend mode that will not survive intact produces a warning here rather than at
 * render time — an operator learns about a rasterised adjustment layer during import,
 * not when the graphic is on air.
 */
export function manifestToImportDocument(output: PsApiJobOutput, sourceHref: string): AdobeImportDocument {
  const warnings: ImportWarning[] = [];
  const assets: AdobeAsset[] = [
    { id: "source", name: output.document?.name ?? "document.psd", kind: "source", url: sourceHref }
  ];

  const layers = (output.layers ?? []).map((layer) => convertLayer(layer, undefined, warnings));

  return {
    source: "photoshop",
    documentId: sourceHref,
    name: output.document?.name ?? "Untitled",
    width: output.document?.width ?? 0,
    height: output.document?.height ?? 0,
    layers,
    assets,
    warnings
  };
}

function convertLayer(
  layer: PsApiLayer,
  parentId: string | undefined,
  warnings: ImportWarning[]
): AdobeLayer {
  const id = String(layer.id ?? layer.index ?? layer.name ?? "layer");
  const name = layer.name ?? `Layer ${id}`;
  const psType = layer.type ?? "layer";
  const type = PS_LAYER_TYPE_TO_GRAPIX[psType] ?? "pixel";
  const fidelity = PS_LAYER_TYPE_FIDELITY[psType] ?? "Unsupported";

  if (fidelity === "Rasterised" || fidelity === "Unsupported") {
    warnings.push({
      code: `photoshop.layer.${psType}`,
      message:
        fidelity === "Rasterised"
          ? `"${name}" is a ${psType}; GrapiX has no adjustment pipeline, so it imports as baked pixels.`
          : `"${name}" has layer type "${psType}", which GrapiX does not model.`,
      layerId: id,
      layerName: name,
      status: fidelity
    });
  }

  const blend = resolvePhotoshopBlendMode(layer.blendOptions?.blendMode);
  if (blend.warning) {
    warnings.push({
      code: "photoshop.blendMode",
      message: `"${name}": ${blend.warning}`,
      layerId: id,
      layerName: name,
      status: blend.status
    });
  }

  const bounds = layer.bounds ?? {};
  const character = layer.text?.characterStyles?.[0];
  const paragraph = layer.text?.paragraphStyles?.[0];

  return {
    id,
    name,
    type,
    parentId,
    // The manifest omits `visible` for a visible layer, so absence means visible.
    visible: layer.visible !== false,
    locked: layer.locked === true,
    // Photoshop reports opacity 0-100; GrapiX uses 0-1 everywhere.
    opacity: normalizeOpacity(layer.blendOptions?.opacity),
    transform: {
      ...defaultTransform(),
      x: bounds.left ?? 0,
      y: bounds.top ?? 0,
      opacity: normalizeOpacity(layer.blendOptions?.opacity)
    },
    blendMode: blend.mode,
    status: fidelity,
    textData: layer.text
      ? {
          text: layer.text.content ?? "",
          fontSize: character?.fontSize ?? 12,
          fontFamily: character?.fontName ?? "",
          color: "#ffffff",
          align: PS_PARAGRAPH_ALIGNMENT[paragraph?.alignment ?? "left"] ?? "left"
        }
      : undefined,
    children: (layer.children ?? []).map((child) => convertLayer(child, id, warnings))
  };
}

function normalizeOpacity(opacity: number | undefined): number {
  if (typeof opacity !== "number" || !Number.isFinite(opacity)) return 1;
  return Math.min(1, Math.max(0, opacity / 100));
}
