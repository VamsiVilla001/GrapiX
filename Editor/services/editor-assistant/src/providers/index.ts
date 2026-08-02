/**
 * Provider factory: map a `ProviderConfig` to a concrete `ModelProvider` adapter.
 */

import type { ProviderConfig } from "../config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createOpenAiProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.id) {
    case "anthropic":
      return createAnthropicProvider(config);
    case "google":
      return createGoogleProvider(config);
    case "openai":
    case "openai-compatible":
      return createOpenAiProvider(config);
    default:
      return createAnthropicProvider(config);
  }
}

export type { ModelProvider } from "./types.js";
