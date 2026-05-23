import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLINER_RELEX_MODEL_ID, GLINER_RELEX_SCHEMA_VERSION, RELEX_RELATION_DESCRIPTIONS, RELEX_RELATION_LABELS } from "./relationships/relex-schema.js";

export interface BrainConfig {
  readonly databaseUrl: string;
  readonly artifactRoot: string;
  readonly producerInboxRoot: string;
  readonly namespaceDefault: string;
  readonly relationIeEnabled: boolean;
  readonly relationIeExtractors: readonly string[];
  readonly relationIeGlinerRelexEnabled: boolean;
  readonly relationIeGlinerRelexPromote: boolean;
  readonly relationIeGlinerRelexSchemaVersion: string;
  readonly relationIePythonExecutable: string;
  readonly relationIeScriptPath: string;
  readonly relationIeDevice: "cpu" | "mps";
  readonly relationIeGlinerRelexModel: string;
  readonly relationIeGliner2Model: string;
  readonly relationIeSpacyModel: string;
  readonly relationIeSpanMarkerModel: string;
  readonly relationIeEntityLabels: readonly string[];
  readonly relationIeRelationLabels: readonly string[];
  readonly relationIeEntityDescriptions: Readonly<Record<string, string>>;
  readonly relationIeRelationDescriptions: Readonly<Record<string, string>>;
  readonly relationIeEntityThreshold: number;
  readonly relationIeAdjacencyThreshold: number;
  readonly relationIeRelationThreshold: number;
  readonly relationIeClassificationThreshold: number;
  readonly relationIeStructureThreshold: number;
  readonly extractionUnitMaxChars: number;
  readonly extractionUnitContextChars: number;
  readonly extractionUnitOverlapSentences: number;
  readonly extractionAssistantEnabled: boolean;
  readonly extractionAssistantMode: "off" | "shadow" | "assist" | "strict_review";
  readonly extractionAssistantProvider: "openrouter";
  readonly extractionAssistantModel: string;
  readonly extractionAssistantMaxInputChars: number;
  readonly extractionAssistantMaxOutputTokens: number;
  readonly extractionAssistantTimeoutMs: number;
  readonly localRerankerEnabled: boolean;
  readonly localRerankerVersion: string;
  readonly canonicalAdjudicationEnabled: boolean;
  readonly retrievalFusionVersion: string;
  readonly benchmarkFastScorerVersion: string;
  readonly benchmarkOfficialishScorerVersion: string;
  readonly sqlFusedKernelMode: "shadow" | "preferred" | "required";
  readonly renderPayloadMode: "shadow" | "preferred" | "required";
  readonly pgvectorIterativeScanMode: "off" | "relaxed_order" | "strict_order";
  readonly pgvectorMaxScanTuples?: number;
  readonly lexicalProvider: "fts" | "bm25";
  readonly lexicalFallbackEnabled: boolean;
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions?: number;
  readonly runtimeVectorActivationMode: "off" | "queue_only" | "bounded" | "full";
  readonly runtimeVectorActivationLimit: number;
  readonly runtimeVectorActivationMaxPasses: number;
  readonly benchmarkVectorActivationMode: "off" | "queue_only" | "bounded" | "full";
  readonly benchmarkVectorActivationLimit: number;
  readonly benchmarkVectorActivationMaxPasses: number;
  readonly openRouterApiKey?: string;
  readonly openRouterBaseUrl: string;
  readonly openRouterEmbeddingModel: string;
  readonly openRouterClassifyModel: string;
  readonly openRouterDeriveModel: string;
  readonly geminiApiKey?: string;
  readonly geminiBaseUrl: string;
  readonly geminiEmbeddingModel: string;
  readonly geminiMultimodalModel: string;
  readonly externalAiApiKey?: string;
  readonly externalAiBaseUrl: string;
  readonly externalAiEmbeddingPath: string;
  readonly externalAiDerivePath: string;
  readonly externalAiClassifyPath: string;
  readonly externalAiEmbeddingModel: string;
  readonly externalAiDeriveModel: string;
  readonly externalAiClassifyModel: string;
  readonly externalAiClassifyPresetId?: string;
  readonly modelRuntimeBaseUrl: string;
  readonly modelRuntimeApiKey?: string;
  readonly slackSigningSecret?: string;
  readonly slackBotToken?: string;
  readonly slackAllowedTeams: readonly string[];
  readonly slackAllowedChannels: readonly string[];
  readonly slackAllowedUsers: readonly string[];
  readonly discordBotToken?: string;
  readonly discordAllowedGuilds: readonly string[];
  readonly discordAllowedChannels: readonly string[];
  readonly discordAllowedUsers: readonly string[];
  readonly producerSharedSecret?: string;
  readonly migrationsDir: string;
  readonly httpHost: string;
  readonly httpPort: number;
}

function parseList(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function parseJsonRecord(value: string | undefined): Record<string, string> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
}

function parseThreshold(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(0.99, Math.max(0, parsed));
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  const parsed: Record<string, string> = {};
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!key || key.startsWith("export ")) {
      continue;
    }
    parsed[key] = rawValue.replace(/^['"]|['"]$/gu, "");
  }
  return parsed;
}

function withLocalEnvDefaults(env: NodeJS.ProcessEnv, moduleRoot: string): NodeJS.ProcessEnv {
  return {
    ...parseEnvFile(path.resolve(moduleRoot, ".env")),
    ...parseEnvFile(path.resolve(moduleRoot, "local-brain/.env")),
    ...env
  };
}

function parseVectorActivationMode(
  value: string | undefined,
  fallback: "off" | "queue_only" | "bounded" | "full"
): "off" | "queue_only" | "bounded" | "full" {
  switch ((value ?? "").trim().toLowerCase()) {
    case "off":
      return "off";
    case "queue_only":
    case "queue-only":
      return "queue_only";
    case "full":
      return "full";
    case "bounded":
      return "bounded";
    default:
      return fallback;
  }
}

function parseServingMode(
  value: string | undefined,
  fallback: "shadow" | "preferred" | "required"
): "shadow" | "preferred" | "required" {
  switch ((value ?? "").trim().toLowerCase()) {
    case "shadow":
      return "shadow";
    case "preferred":
      return "preferred";
    case "required":
      return "required";
    default:
      return fallback;
  }
}

function parseExtractionAssistantMode(
  value: string | undefined,
  fallback: "off" | "shadow" | "assist" | "strict_review"
): "off" | "shadow" | "assist" | "strict_review" {
  switch ((value ?? "").trim().toLowerCase()) {
    case "off":
      return "off";
    case "shadow":
      return "shadow";
    case "strict_review":
    case "strict-review":
      return "strict_review";
    case "assist":
      return "assist";
    default:
      return fallback;
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  env = withLocalEnvDefaults(env, moduleRoot);
  const artifactRoot = env.BRAIN_ARTIFACT_ROOT ?? "";
  const producerInboxRoot = env.BRAIN_PRODUCER_INBOX_ROOT ?? (artifactRoot ? `${artifactRoot}/producer-inbox` : "producer-inbox");
  const relationIeRoot = env.BRAIN_RELATION_IE_ROOT ?? moduleRoot;
  const defaultEmbeddingDimensions = 1536;
  const embeddingDimensions =
    typeof env.BRAIN_EMBEDDING_DIMENSIONS === "string" && env.BRAIN_EMBEDDING_DIMENSIONS.trim()
      ? Number(env.BRAIN_EMBEDDING_DIMENSIONS)
      : defaultEmbeddingDimensions;
  const modelRuntimeBaseUrl =
    env.BRAIN_MODEL_RUNTIME_BASE_URL ??
    env.MODEL_RUNTIME_BASE_URL ??
    env.BRAIN_EXTERNAL_AI_BASE_URL ??
    env.EXTERNAL_AI_BASE_URL ??
    "http://100.99.84.124:8000";
  const externalAiBaseUrl =
    env.BRAIN_EXTERNAL_AI_BASE_URL ??
    env.EXTERNAL_AI_BASE_URL ??
    env.BRAIN_MODEL_RUNTIME_BASE_URL ??
    env.MODEL_RUNTIME_BASE_URL ??
    modelRuntimeBaseUrl;
  const defaultEmbeddingProvider = env.OPENROUTER_API_KEY ? "openrouter" : "external";
  const defaultExternalEmbeddingModel = "Qwen/Qwen3-Embedding-4B";
  const embeddingProvider = env.BRAIN_EMBEDDING_PROVIDER ?? defaultEmbeddingProvider;
  const embeddingModel =
    env.BRAIN_EMBEDDING_MODEL ??
    (embeddingProvider === "openrouter"
      ? env.BRAIN_OPENROUTER_EMBEDDING_MODEL ?? "text-embedding-3-small"
      : defaultExternalEmbeddingModel);
  const defaultRelationIeEntityLabels = [
    "person",
    "organization",
    "place",
    "venue",
    "team",
    "institution",
    "project",
    "product",
    "tool",
    "app",
    "initiative",
    "media",
    "book",
    "show",
    "song",
    "other"
  ] as const;
  const defaultRelationIeRelationLabels = [
    "friend of",
    "works with",
    "works at",
    "worked at",
    "works on",
    "lives in",
    "lived in",
    "member of",
    "met through",
    "sibling of",
    "romantic partner of"
  ] as const;
  const defaultRelationIeEntityDescriptions: Record<string, string> = {
    person: "human individual, friend, family member, coworker, or named speaker",
    organization: "company, employer, team, institution, or group",
    place: "location, city, country, venue, or region",
    venue: "specific venue, building, studio, office, theater, restaurant, or event location",
    team: "named team, department, crew, band, working group, or sports side",
    institution: "school, university, nonprofit, hospital, or formal institution",
    project: "project, initiative, product, roadmap item, or named effort",
    product: "named product, app, tool, feature, or service",
    tool: "named software tool, system, platform, or technical product",
    app: "application, website, or software product name",
    initiative: "program, initiative, campaign, or structured effort",
    media: "movie, film, book, song, artwork, or media work",
    book: "book, novel, memoir, or written title",
    show: "show, series, podcast, performance, or episode title",
    song: "song, album, band, or musical work title",
    other: "named entity that matters to a relation even if it does not fit the core schema"
  };
  const defaultRelationIeRelationDescriptions: Record<string, string> = {
    "friend of": "social friendship or close-friend relationship between people",
    "works with": "coworker, collaborator, or regular work relationship between people",
    "works at": "current employer or organization affiliation",
    "worked at": "historical employer or previous organization affiliation",
    "works on": "current project or initiative involvement",
    "lives in": "current residence or base location",
    "lived in": "historical residence or previous location",
    "member of": "membership in a club, org, team, or group",
    "met through": "how two people know each other via a third party or context",
    "sibling of": "brother, sister, or sibling relationship",
    "romantic partner of": "dating, partner, boyfriend, girlfriend, or romantic relationship"
  };
  const relationIeEntityDescriptions = {
    ...defaultRelationIeEntityDescriptions,
    ...parseJsonRecord(env.BRAIN_RELATION_IE_ENTITY_DESCRIPTIONS)
  };
  const relationIeRelationDescriptions = {
    ...defaultRelationIeRelationDescriptions,
    ...parseJsonRecord(env.BRAIN_RELATION_IE_RELATION_DESCRIPTIONS)
  };
  const relationIeGlinerRelexEnabled = parseBoolean(env.BRAIN_RELATION_IE_GLINER_RELEX_ENABLED, false);
  const configuredRelationExtractors = parseList(env.BRAIN_RELATION_IE_EXTRACTORS);
  const baseRelationExtractors = configuredRelationExtractors.length > 0 ? configuredRelationExtractors : ["gliner2", "spacy"];
  const relationIeExtractors =
    relationIeGlinerRelexEnabled && !baseRelationExtractors.includes("gliner_relex_v1")
      ? [...baseRelationExtractors, "gliner_relex_v1"]
      : baseRelationExtractors;
  const configuredRelationLabels = parseList(env.BRAIN_RELATION_IE_RELATION_LABELS);

  return {
    databaseUrl: env.BRAIN_DATABASE_URL ?? "postgresql:///ai_brain_local",
    artifactRoot,
    producerInboxRoot,
    namespaceDefault: env.BRAIN_NAMESPACE_DEFAULT ?? "personal",
    relationIeEnabled: parseBoolean(env.BRAIN_RELATION_IE_ENABLED, false),
    relationIeExtractors,
    relationIeGlinerRelexEnabled,
    relationIeGlinerRelexPromote: parseBoolean(env.BRAIN_RELATION_IE_GLINER_RELEX_PROMOTE, false),
    relationIeGlinerRelexSchemaVersion: env.BRAIN_RELATION_IE_GLINER_RELEX_SCHEMA_VERSION ?? GLINER_RELEX_SCHEMA_VERSION,
    relationIePythonExecutable:
      env.BRAIN_RELATION_IE_PYTHON_EXECUTABLE ?? `${relationIeRoot}/.venv-brain/bin/python`,
    relationIeScriptPath:
      env.BRAIN_RELATION_IE_SCRIPT_PATH ?? `${relationIeRoot}/tools/relation-ie/extract_relations.py`,
    relationIeDevice: env.BRAIN_RELATION_IE_DEVICE === "mps" ? "mps" : "cpu",
    relationIeGlinerRelexModel:
      env.BRAIN_RELATION_IE_GLINER_RELEX_MODEL ?? GLINER_RELEX_MODEL_ID,
    relationIeGliner2Model:
      env.BRAIN_RELATION_IE_GLINER2_MODEL ?? "fastino/gliner2-base-v1",
    relationIeSpacyModel:
      env.BRAIN_RELATION_IE_SPACY_MODEL ?? "en_core_web_sm",
    relationIeSpanMarkerModel:
      env.BRAIN_RELATION_IE_SPAN_MARKER_MODEL ?? "tomaarsen/span-marker-roberta-large-ontonotes5",
    relationIeEntityLabels:
      parseList(env.BRAIN_RELATION_IE_ENTITY_LABELS).length > 0
        ? parseList(env.BRAIN_RELATION_IE_ENTITY_LABELS)
        : defaultRelationIeEntityLabels,
    relationIeRelationLabels:
      configuredRelationLabels.length > 0
        ? configuredRelationLabels
        : relationIeGlinerRelexEnabled
          ? RELEX_RELATION_LABELS
          : defaultRelationIeRelationLabels,
    relationIeEntityDescriptions,
    relationIeRelationDescriptions: relationIeGlinerRelexEnabled
      ? { ...RELEX_RELATION_DESCRIPTIONS, ...relationIeRelationDescriptions }
      : relationIeRelationDescriptions,
    relationIeEntityThreshold: parseThreshold(env.BRAIN_RELATION_IE_ENTITY_THRESHOLD, 0.45),
    relationIeAdjacencyThreshold: parseThreshold(env.BRAIN_RELATION_IE_ADJACENCY_THRESHOLD, 0.35),
    relationIeRelationThreshold: parseThreshold(env.BRAIN_RELATION_IE_RELATION_THRESHOLD, 0.45),
    relationIeClassificationThreshold: parseThreshold(env.BRAIN_RELATION_IE_CLASSIFICATION_THRESHOLD, 0.6),
    relationIeStructureThreshold: parseThreshold(env.BRAIN_RELATION_IE_STRUCTURE_THRESHOLD, 0.65),
    extractionUnitMaxChars: parsePositiveInteger(env.BRAIN_EXTRACTION_UNIT_MAX_CHARS) ?? 1800,
    extractionUnitContextChars: parsePositiveInteger(env.BRAIN_EXTRACTION_UNIT_CONTEXT_CHARS) ?? 500,
    extractionUnitOverlapSentences: parsePositiveInteger(env.BRAIN_EXTRACTION_UNIT_OVERLAP_SENTENCES) ?? 1,
    extractionAssistantEnabled: parseBoolean(env.BRAIN_EXTRACTION_ASSISTANT_ENABLED, true),
    extractionAssistantMode: parseExtractionAssistantMode(env.BRAIN_EXTRACTION_ASSISTANT_MODE, "assist"),
    extractionAssistantProvider: "openrouter",
    extractionAssistantModel: env.BRAIN_EXTRACTION_ASSISTANT_MODEL ?? "openai/gpt-5.4-mini",
    extractionAssistantMaxInputChars: parsePositiveInteger(env.BRAIN_EXTRACTION_ASSISTANT_MAX_INPUT_CHARS) ?? 2600,
    extractionAssistantMaxOutputTokens: parsePositiveInteger(env.BRAIN_EXTRACTION_ASSISTANT_MAX_OUTPUT_TOKENS) ?? 420,
    extractionAssistantTimeoutMs: parsePositiveInteger(env.BRAIN_EXTRACTION_ASSISTANT_TIMEOUT_MS) ?? 45_000,
    localRerankerEnabled: parseBoolean(env.BRAIN_LOCAL_RERANKER_ENABLED, true),
    localRerankerVersion: env.BRAIN_LOCAL_RERANKER_VERSION ?? "local_reasoning_reranker_v3",
    canonicalAdjudicationEnabled: parseBoolean(env.BRAIN_CANONICAL_ADJUDICATION, true),
    retrievalFusionVersion: env.BRAIN_RETRIEVAL_FUSION_VERSION ?? "retrieval_fusion_v3",
    benchmarkFastScorerVersion: env.BRAIN_BENCHMARK_FAST_SCORER_VERSION ?? "benchmark_fast_v1",
    benchmarkOfficialishScorerVersion:
      env.BRAIN_BENCHMARK_OFFICIALISH_SCORER_VERSION ?? "benchmark_officialish_v1",
    sqlFusedKernelMode: parseServingMode(env.BRAIN_SQL_FUSED_KERNEL_MODE, "preferred"),
    renderPayloadMode: parseServingMode(env.BRAIN_RENDER_PAYLOAD_MODE, "preferred"),
    pgvectorIterativeScanMode:
      env.BRAIN_PGVECTOR_ITERATIVE_SCAN_MODE === "relaxed_order"
        ? "relaxed_order"
        : env.BRAIN_PGVECTOR_ITERATIVE_SCAN_MODE === "strict_order"
          ? "strict_order"
          : "off",
    pgvectorMaxScanTuples: parsePositiveInteger(env.BRAIN_PGVECTOR_MAX_SCAN_TUPLES),
    lexicalProvider: env.BRAIN_LEXICAL_PROVIDER === "fts" ? "fts" : "bm25",
    lexicalFallbackEnabled: parseBoolean(env.BRAIN_LEXICAL_FALLBACK_ENABLED, true),
    embeddingProvider,
    embeddingModel,
    embeddingDimensions: Number.isFinite(embeddingDimensions) ? embeddingDimensions : undefined,
    runtimeVectorActivationMode: parseVectorActivationMode(env.BRAIN_RUNTIME_VECTOR_ACTIVATION_MODE, "bounded"),
    runtimeVectorActivationLimit: parsePositiveInteger(env.BRAIN_RUNTIME_VECTOR_ACTIVATION_LIMIT) ?? 256,
    runtimeVectorActivationMaxPasses: parsePositiveInteger(env.BRAIN_RUNTIME_VECTOR_ACTIVATION_MAX_PASSES) ?? 2,
    benchmarkVectorActivationMode: parseVectorActivationMode(env.BRAIN_BENCHMARK_VECTOR_ACTIVATION_MODE, "off"),
    benchmarkVectorActivationLimit: parsePositiveInteger(env.BRAIN_BENCHMARK_VECTOR_ACTIVATION_LIMIT) ?? 400,
    benchmarkVectorActivationMaxPasses: parsePositiveInteger(env.BRAIN_BENCHMARK_VECTOR_ACTIVATION_MAX_PASSES) ?? 4,
    openRouterApiKey: env.OPENROUTER_API_KEY ?? undefined,
    openRouterBaseUrl: env.BRAIN_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    openRouterEmbeddingModel: env.BRAIN_OPENROUTER_EMBEDDING_MODEL ?? env.BRAIN_EMBEDDING_MODEL ?? "text-embedding-3-small",
    openRouterClassifyModel: env.BRAIN_OPENROUTER_CLASSIFY_MODEL ?? "openai/gpt-4.1-mini",
    openRouterDeriveModel: env.BRAIN_OPENROUTER_DERIVE_MODEL ?? env.BRAIN_OPENROUTER_CLASSIFY_MODEL ?? "openai/gpt-4.1-mini",
    geminiApiKey: env.GEMINI_API_KEY ?? undefined,
    geminiBaseUrl: env.BRAIN_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
    geminiEmbeddingModel: env.BRAIN_GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001",
    geminiMultimodalModel: env.BRAIN_GEMINI_MULTIMODAL_MODEL ?? "gemini-2.5-flash",
    externalAiApiKey: env.BRAIN_EXTERNAL_AI_API_KEY ?? env.EXTERNAL_AI_API_KEY ?? undefined,
    externalAiBaseUrl,
    externalAiEmbeddingPath: env.BRAIN_EXTERNAL_AI_EMBEDDING_PATH ?? "/v1/embeddings",
    externalAiDerivePath: env.BRAIN_EXTERNAL_AI_DERIVE_PATH ?? "/v1/artifacts/derive",
    externalAiClassifyPath: env.BRAIN_EXTERNAL_AI_CLASSIFY_PATH ?? "/v1/chat/completions",
    externalAiEmbeddingModel: env.BRAIN_EXTERNAL_AI_EMBEDDING_MODEL ?? env.BRAIN_EMBEDDING_MODEL ?? defaultExternalEmbeddingModel,
    externalAiDeriveModel: env.BRAIN_EXTERNAL_AI_DERIVE_MODEL ?? "artifact-derive-default",
    externalAiClassifyModel:
      env.BRAIN_EXTERNAL_AI_CLASSIFY_MODEL ?? "unsloth/Qwen3.5-35B-A3B-GGUF",
    externalAiClassifyPresetId: env.BRAIN_EXTERNAL_AI_CLASSIFY_PRESET_ID ?? "research-analyst",
    modelRuntimeBaseUrl,
    modelRuntimeApiKey: env.BRAIN_MODEL_RUNTIME_API_KEY ?? env.MODEL_RUNTIME_API_KEY ?? env.BRAIN_EXTERNAL_AI_API_KEY ?? env.EXTERNAL_AI_API_KEY ?? undefined,
    slackSigningSecret: env.SLACK_SIGNING_SECRET ?? undefined,
    slackBotToken: env.SLACK_BOT_TOKEN ?? undefined,
    slackAllowedTeams: parseList(env.BRAIN_SLACK_ALLOWED_TEAMS),
    slackAllowedChannels: parseList(env.BRAIN_SLACK_ALLOWED_CHANNELS),
    slackAllowedUsers: parseList(env.BRAIN_SLACK_ALLOWED_USERS),
    discordBotToken: env.DISCORD_BOT_TOKEN ?? undefined,
    discordAllowedGuilds: parseList(env.BRAIN_DISCORD_ALLOWED_GUILDS),
    discordAllowedChannels: parseList(env.BRAIN_DISCORD_ALLOWED_CHANNELS),
    discordAllowedUsers: parseList(env.BRAIN_DISCORD_ALLOWED_USERS),
    producerSharedSecret: env.BRAIN_PRODUCER_SHARED_SECRET ?? undefined,
    migrationsDir: env.BRAIN_MIGRATIONS_DIR ?? "",
    httpHost: env.BRAIN_HTTP_HOST ?? "127.0.0.1",
    httpPort: Number(env.BRAIN_HTTP_PORT ?? "8787")
  };
}
