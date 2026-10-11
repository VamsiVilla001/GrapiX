/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the local GrapiX API origin. See lib/apiClient.ts. */
  readonly VITE_GRAPIX_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
