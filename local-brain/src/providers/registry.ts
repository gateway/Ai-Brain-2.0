import { readConfig } from "../config.js";
import { createExternalAdapter } from "./external.js";
import { createGeminiAdapter } from "./gemini.js";
import { createOpenRouterAdapter } from "./openrouter.js";
import type { ProviderAdapter, ProviderId } from "./types.js";

export function getProviderAdapter(provider?: string): ProviderAdapter {
  const config = readConfig();
  const selected = (provider ?? config.embeddingProvider).toLowerCase() as ProviderId;

  if (selected === "openrouter") {
    return createOpenRouterAdapter();
  }
  if (selected === "gemini") {
    return createGeminiAdapter();
  }
  if (selected === "external") {
    return createExternalAdapter();
  }

  throw new Error(`Unsupported provider "${provider ?? config.embeddingProvider}". Supported: openrouter, gemini, external`);
}
