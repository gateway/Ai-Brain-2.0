const modelRuntimeBaseUrl =
  process.env.BRAIN_MODEL_RUNTIME_BASE_URL ??
  process.env.MODEL_RUNTIME_BASE_URL ??
  process.env.BRAIN_EXTERNAL_AI_BASE_URL ??
  process.env.EXTERNAL_AI_BASE_URL ??
  "http://100.99.84.124:8000";

const modelRuntimeApiKey =
  process.env.BRAIN_MODEL_RUNTIME_API_KEY ??
  process.env.MODEL_RUNTIME_API_KEY ??
  process.env.BRAIN_EXTERNAL_AI_API_KEY ??
  process.env.EXTERNAL_AI_API_KEY;

type JsonRecord = Record<string, unknown>;

export interface ModelRuntimeFamilyCatalog {
  readonly family: string;
  readonly supportedModels: readonly string[];
  readonly loaded: boolean;
  readonly activeModel?: string;
  readonly contextLength?: number;
  readonly runtimeStrategy?: string;
  readonly lastMetrics?: Record<string, unknown>;
}

export interface ModelRuntimePreset {
  readonly presetId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly source?: string;
  readonly tags: readonly string[];
  readonly maxTokens?: number;
  readonly enableThinking?: boolean;
  readonly temperature?: number;
  readonly systemPrompt?: string;
}

export interface ModelRuntimeRegistryFamily {
  readonly family: string;
  readonly modelCount: number;
  readonly integratedCount: number;
  readonly validatedCount: number;
  readonly previewModels: readonly string[];
}

export interface ModelRuntimeOverview {
  readonly baseUrl: string;
  readonly reachable: boolean;
  readonly provider?: string;
  readonly families: readonly ModelRuntimeFamilyCatalog[];
  readonly loadedFamilyCount: number;
  readonly registryFamilies: readonly ModelRuntimeRegistryFamily[];
  readonly presetsModel?: string;
  readonly presets: readonly ModelRuntimePreset[];
  readonly errors: readonly string[];
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function getHeaders(init?: HeadersInit): HeadersInit {
  const headers = new Headers(init);
  if (modelRuntimeApiKey) {
    headers.set("Authorization", `Bearer ${modelRuntimeApiKey}`);
    headers.set("x-api-key", modelRuntimeApiKey);
  }
  return headers;
}

async function fetchModelRuntimeJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(pathname, modelRuntimeBaseUrl), {
    ...init,
    cache: "no-store",
    headers: getHeaders(init?.headers)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `${pathname} returned ${response.status}`);
  }

  return JSON.parse(raw) as T;
}

function familyStatusFromLoaded(
  family: string,
  loaded: JsonRecord | undefined
): Pick<ModelRuntimeFamilyCatalog, "loaded" | "activeModel" | "contextLength" | "runtimeStrategy" | "lastMetrics"> {
  if (!loaded) {
    return { loaded: false };
  }

  if (family === "asr") {
    return {
      loaded: asBoolean(loaded.asr_loaded) ?? false,
      activeModel: asString(loaded.active_asr_model) ?? asString(loaded.active_runtime_asr_model)
    };
  }

  if (family === "llm") {
    return {
      loaded: asBoolean(loaded.llm_loaded) ?? false,
      activeModel: asString(loaded.active_llm_model),
      contextLength: asNumber(loaded.llm_context_length),
      runtimeStrategy: asString(loaded.llm_runtime_strategy),
      lastMetrics: asRecord(loaded.llm_last_metrics)
    };
  }

  if (family === "embedding") {
    return {
      loaded: asBoolean(loaded.embedding_loaded) ?? false,
      activeModel: asString(loaded.active_embedding_model),
      runtimeStrategy: asString(loaded.embedding_runtime_strategy),
      lastMetrics: asRecord(loaded.embedding_last_metrics)
    };
  }

  if (family === "aligner") {
    return {
      loaded: asBoolean(loaded.forced_aligner_loaded) ?? false,
      activeModel: asString(loaded.forced_aligner_model)
    };
  }

  if (family === "tts") {
    const activeModel = asString(loaded.tts_active_model);
    const loadedModels = asString(loaded.tts_loaded_models);
    return {
      loaded: Boolean(activeModel || loadedModels),
      activeModel: activeModel ?? loadedModels,
      runtimeStrategy: asString(loaded.tts_runtime_strategy)
    };
  }

  return { loaded: false };
}

function normalizeFamilies(discovery: JsonRecord | undefined): readonly ModelRuntimeFamilyCatalog[] {
  const supported = asRecord(discovery?.supported);
  const loaded = asRecord(discovery?.loaded);
  if (!supported) {
    return [];
  }

  return Object.entries(supported)
    .map(([family, value]) => {
      const status = familyStatusFromLoaded(family, loaded);
      return {
        family,
        supportedModels: asStringArray(value),
        loaded: status.loaded,
        activeModel: status.activeModel,
        contextLength: status.contextLength,
        runtimeStrategy: status.runtimeStrategy,
        lastMetrics: status.lastMetrics
      };
    })
    .sort((left, right) => left.family.localeCompare(right.family));
}

function normalizeRegistryFamilies(registry: JsonRecord | undefined): readonly ModelRuntimeRegistryFamily[] {
  if (!registry) {
    return [];
  }

  return Object.entries(registry)
    .map(([family, value]) => {
      const familyRecord = asRecord(value);
      const modelEntries = familyRecord ? Object.entries(familyRecord) : [];
      let integratedCount = 0;
      let validatedCount = 0;
      for (const [, modelValue] of modelEntries) {
        const modelRecord = asRecord(modelValue);
        const status = asString(modelRecord?.integration_status);
        if (status === "integrated") {
          integratedCount += 1;
        }
        if (status === "validated") {
          validatedCount += 1;
        }
      }
      return {
        family,
        modelCount: modelEntries.length,
        integratedCount,
        validatedCount,
        previewModels: modelEntries.slice(0, 3).map(([modelId]) => modelId)
      };
    })
    .sort((left, right) => left.family.localeCompare(right.family));
}

function normalizePresets(presetsPayload: JsonRecord | undefined): {
  readonly model?: string;
  readonly items: readonly ModelRuntimePreset[];
} {
  const items = Array.isArray(presetsPayload?.items) ? presetsPayload.items : [];
  const normalizedItems = items
    .map((item): ModelRuntimePreset | undefined => {
      const record = asRecord(item);
      if (!record) {
        return undefined;
      }
      const presetId = asString(record.preset_id);
      const displayName = asString(record.display_name);
      if (!presetId || !displayName) {
        return undefined;
      }
      const settings = asRecord(record.settings);
      return {
        presetId,
        displayName,
        description: asString(record.description),
        source: asString(record.source),
        tags: asStringArray(record.tags),
        maxTokens: asNumber(settings?.max_tokens),
        enableThinking: asBoolean(settings?.enable_thinking),
        temperature: asNumber(settings?.temperature),
        systemPrompt: asString(record.system_prompt)
      };
    })
    .filter((item): item is ModelRuntimePreset => item !== undefined);

  return {
    model: asString(presetsPayload?.model),
    items: normalizedItems
  };
}

export function getModelRuntimeBaseUrl(): string {
  return modelRuntimeBaseUrl;
}

export async function getModelRuntimeOverview(): Promise<ModelRuntimeOverview> {
  const [discoveryResult, registryResult, presetsResult] = await Promise.allSettled([
    fetchModelRuntimeJson<JsonRecord>("/v1/models"),
    fetchModelRuntimeJson<JsonRecord>("/api/model-registry"),
    fetchModelRuntimeJson<JsonRecord>("/v1/llm/presets")
  ]);

  const errors: string[] = [];
  const discovery = discoveryResult.status === "fulfilled" ? discoveryResult.value : undefined;
  if (discoveryResult.status === "rejected") {
    errors.push(`Model discovery failed: ${discoveryResult.reason instanceof Error ? discoveryResult.reason.message : String(discoveryResult.reason)}`);
  }

  const registry = registryResult.status === "fulfilled" ? registryResult.value : undefined;
  if (registryResult.status === "rejected") {
    errors.push(`Model registry failed: ${registryResult.reason instanceof Error ? registryResult.reason.message : String(registryResult.reason)}`);
  }

  const presetsPayload = presetsResult.status === "fulfilled" ? presetsResult.value : undefined;
  if (presetsResult.status === "rejected") {
    errors.push(`Preset lookup failed: ${presetsResult.reason instanceof Error ? presetsResult.reason.message : String(presetsResult.reason)}`);
  }

  const families = normalizeFamilies(discovery);
  const presets = normalizePresets(presetsPayload);
  const registryFamilies = normalizeRegistryFamilies(registry);

  return {
    baseUrl: modelRuntimeBaseUrl,
    reachable: Boolean(discovery || registry || presetsPayload),
    provider: asString(discovery?.provider),
    families,
    loadedFamilyCount: families.filter((family) => family.loaded).length,
    registryFamilies,
    presetsModel: presets.model,
    presets: presets.items,
    errors
  };
}

export async function loadModelRuntimeModel(input: {
  readonly family: string;
  readonly model: string;
  readonly contextLength?: number;
}): Promise<unknown> {
  return fetchModelRuntimeJson<unknown>("/v1/models/load", {
    method: "POST",
    headers: getHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      family: input.family,
      model: input.model,
      context_length: input.contextLength
    })
  });
}

export async function unloadModelRuntimeModel(input: {
  readonly family: string;
  readonly model?: string;
}): Promise<unknown> {
  return fetchModelRuntimeJson<unknown>("/v1/models/unload", {
    method: "POST",
    headers: getHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      family: input.family,
      model: input.model
    })
  });
}
