import { readConfig } from "../config.js";

export type EmbeddingProviderId = "none" | "openrouter" | "external" | "gemini";

export interface EmbeddingRuntimeSelectionInput {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly outputDimensionality?: number | null;
  readonly normalize?: boolean | null;
  readonly instruction?: string | null;
}

export interface EmbeddingRuntimeSelection {
  readonly enabled: boolean;
  readonly provider: EmbeddingProviderId;
  readonly model?: string;
  readonly outputDimensionality?: number;
  readonly normalize?: boolean;
  readonly instruction?: string;
}

function normalizeProvider(provider?: string | null): EmbeddingProviderId {
  switch ((provider ?? "").trim().toLowerCase()) {
    case "none":
      return "none";
    case "openrouter":
      return "openrouter";
    case "external":
      return "external";
    case "gemini":
      return "gemini";
    default:
      return "external";
  }
}

function defaultModelForProvider(provider: Exclude<EmbeddingProviderId, "none">): string | undefined {
  const config = readConfig();
  switch (provider) {
    case "external":
      return config.externalAiEmbeddingModel;
    case "openrouter":
      return config.openRouterEmbeddingModel;
    case "gemini":
      return config.geminiEmbeddingModel;
  }
}

export function resolveEmbeddingRuntimeSelection(
  input: EmbeddingRuntimeSelectionInput = {}
): EmbeddingRuntimeSelection {
  const config = readConfig();
  const provider = normalizeProvider(input.provider ?? config.embeddingProvider);

  if (provider === "none") {
    return {
      enabled: false,
      provider
    };
  }

  const model = (input.model ?? "").trim() || defaultModelForProvider(provider);
  const outputDimensionality =
    typeof input.outputDimensionality === "number" && Number.isFinite(input.outputDimensionality)
      ? input.outputDimensionality
      : config.embeddingDimensions;

  return {
    enabled: true,
    provider,
    model,
    outputDimensionality,
    normalize: input.normalize ?? undefined,
    instruction: (input.instruction ?? "").trim() || undefined
  };
}
