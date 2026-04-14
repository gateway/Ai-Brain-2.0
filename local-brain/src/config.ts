import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BrainConfig {
  readonly databaseUrl: string;
  readonly artifactRoot: string;
  readonly producerInboxRoot: string;
  readonly namespaceDefault: string;
  readonly relationIeEnabled: boolean;
  readonly relationIeExtractors: readonly string[];
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
  readonly localRerankerEnabled: boolean;
  readonly localRerankerVersion: string;
  readonly canonicalAdjudicationEnabled: boolean;
  readonly retrievalFusionVersion: string;
  readonly benchmarkFastScorerVersion: string;
  readonly benchmarkOfficialishScorerVersion: string;
  readonly pgvectorIterativeScanMode: "off" | "relaxed_order" | "strict_order";
  readonly pgvectorMaxScanTuples?: number;
  readonly lexicalProvider: "fts" | "bm25";
  readonly lexicalFallbackEnabled: boolean;
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions?: number;
  readonly openRouterApiKey?: string;
  readonly openRouterBaseUrl: string;
  readonly openRouterEmbeddingModel: string;
  readonly openRouterClassifyModel: string;
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

export function readConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const artifactRoot = env.BRAIN_ARTIFACT_ROOT ?? "";
  const producerInboxRoot = env.BRAIN_PRODUCER_INBOX_ROOT ?? (artifactRoot ? `${artifactRoot}/producer-inbox` : "producer-inbox");
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
  const defaultRelationIeEntityLabels = [
    "person",
    "organization",
    "place",
    "project",
    "media",
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
    project: "project, initiative, product, roadmap item, or named effort",
    media: "movie, film, book, song, artwork, or media work",
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

  return {
    databaseUrl: env.BRAIN_DATABASE_URL ?? "postgresql:///ai_brain_local",
    artifactRoot,
    producerInboxRoot,
    namespaceDefault: env.BRAIN_NAMESPACE_DEFAULT ?? "personal",
    relationIeEnabled: parseBoolean(env.BRAIN_RELATION_IE_ENABLED, false),
    relationIeExtractors:
      parseList(env.BRAIN_RELATION_IE_EXTRACTORS).length > 0
        ? parseList(env.BRAIN_RELATION_IE_EXTRACTORS)
        : ["gliner_relex", "spacy"],
    relationIePythonExecutable:
      env.BRAIN_RELATION_IE_PYTHON_EXECUTABLE ?? `${relationIeRoot}/.venv-brain/bin/python`,
    relationIeScriptPath:
      env.BRAIN_RELATION_IE_SCRIPT_PATH ?? `${relationIeRoot}/tools/relation-ie/extract_relations.py`,
    relationIeDevice: env.BRAIN_RELATION_IE_DEVICE === "mps" ? "mps" : "cpu",
    relationIeGlinerRelexModel:
      env.BRAIN_RELATION_IE_GLINER_RELEX_MODEL ?? "knowledgator/gliner-relex-large-v0.5",
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
      parseList(env.BRAIN_RELATION_IE_RELATION_LABELS).length > 0
        ? parseList(env.BRAIN_RELATION_IE_RELATION_LABELS)
        : defaultRelationIeRelationLabels,
    relationIeEntityDescriptions,
    relationIeRelationDescriptions,
    relationIeEntityThreshold: parseThreshold(env.BRAIN_RELATION_IE_ENTITY_THRESHOLD, 0.45),
    relationIeAdjacencyThreshold: parseThreshold(env.BRAIN_RELATION_IE_ADJACENCY_THRESHOLD, 0.35),
    relationIeRelationThreshold: parseThreshold(env.BRAIN_RELATION_IE_RELATION_THRESHOLD, 0.45),
    localRerankerEnabled: parseBoolean(env.BRAIN_LOCAL_RERANKER_ENABLED, true),
    localRerankerVersion: env.BRAIN_LOCAL_RERANKER_VERSION ?? "local_reasoning_reranker_v3",
    canonicalAdjudicationEnabled: parseBoolean(env.BRAIN_CANONICAL_ADJUDICATION, true),
    retrievalFusionVersion: env.BRAIN_RETRIEVAL_FUSION_VERSION ?? "retrieval_fusion_v3",
    benchmarkFastScorerVersion: env.BRAIN_BENCHMARK_FAST_SCORER_VERSION ?? "benchmark_fast_v1",
    benchmarkOfficialishScorerVersion:
      env.BRAIN_BENCHMARK_OFFICIALISH_SCORER_VERSION ?? "benchmark_officialish_v1",
    pgvectorIterativeScanMode:
      env.BRAIN_PGVECTOR_ITERATIVE_SCAN_MODE === "relaxed_order"
        ? "relaxed_order"
        : env.BRAIN_PGVECTOR_ITERATIVE_SCAN_MODE === "strict_order"
          ? "strict_order"
          : "off",
    pgvectorMaxScanTuples: parsePositiveInteger(env.BRAIN_PGVECTOR_MAX_SCAN_TUPLES),
    lexicalProvider: env.BRAIN_LEXICAL_PROVIDER === "fts" ? "fts" : "bm25",
    lexicalFallbackEnabled: parseBoolean(env.BRAIN_LEXICAL_FALLBACK_ENABLED, true),
    embeddingProvider: env.BRAIN_EMBEDDING_PROVIDER ?? defaultEmbeddingProvider,
    embeddingModel: env.BRAIN_EMBEDDING_MODEL ?? defaultExternalEmbeddingModel,
    embeddingDimensions: Number.isFinite(embeddingDimensions) ? embeddingDimensions : undefined,
    openRouterApiKey: env.OPENROUTER_API_KEY ?? undefined,
    openRouterBaseUrl: env.BRAIN_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    openRouterEmbeddingModel: env.BRAIN_OPENROUTER_EMBEDDING_MODEL ?? env.BRAIN_EMBEDDING_MODEL ?? "text-embedding-3-small",
    openRouterClassifyModel: env.BRAIN_OPENROUTER_CLASSIFY_MODEL ?? "openai/gpt-4.1-mini",
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
