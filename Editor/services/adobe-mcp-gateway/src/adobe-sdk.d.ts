/**
 * Ambient types for `@adobe/aio-lib-photoshop-api`, which ships no declarations.
 *
 * Only the surface `photoshopApi.ts` actually calls is declared. Declaring the whole
 * library would be a second, unverified copy of Adobe's API drifting against theirs;
 * this narrow slice is checked against the runtime by the gateway's own tests.
 */
declare module "@adobe/aio-lib-photoshop-api" {
  interface PhotoshopApiFile {
    href: string;
    storage: string;
  }

  interface PhotoshopApiJob {
    jobId?: string;
    outputs?: unknown[];
  }

  interface PhotoshopApiSdkClient {
    getDocumentManifest(input: PhotoshopApiFile): Promise<PhotoshopApiJob>;
    createRendition(input: PhotoshopApiFile, outputs: unknown): Promise<PhotoshopApiJob>;
    modifyDocument(input: PhotoshopApiFile, outputs: unknown, options: unknown): Promise<PhotoshopApiJob>;
    replaceSmartObject(input: PhotoshopApiFile, outputs: unknown, options: unknown): Promise<PhotoshopApiJob>;
    createDocument(outputs: unknown, options: unknown): Promise<PhotoshopApiJob>;
  }

  export function init(
    orgId: string,
    apiKey: string,
    accessToken: string,
    files?: unknown,
    options?: Record<string, string>
  ): Promise<PhotoshopApiSdkClient>;

  export const Storage: Record<string, string>;
  export const MimeType: Record<string, string>;
  export const LayerType: Record<string, string>;
  export const BlendMode: Record<string, string>;
  export const JobOutputStatus: Record<string, string>;
  export const ParagraphAlignment: Record<string, string>;
  export const ManageMissingFonts: Record<string, string>;
  export const TextOrientation: Record<string, string>;
}
