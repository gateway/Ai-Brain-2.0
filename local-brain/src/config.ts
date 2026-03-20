export interface BrainConfig {
  readonly databaseUrl: string;
  readonly artifactRoot: string;
  readonly producerInboxRoot: string;
  readonly namespaceDefault: string;
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

export function readConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const artifactRoot = env.BRAIN_ARTIFACT_ROOT ?? "";
  const producerInboxRoot = env.BRAIN_PRODUCER_INBOX_ROOT ?? (artifactRoot ? `${artifactRoot}/producer-inbox` : "producer-inbox");
  const embeddingDimensions =
    typeof env.BRAIN_EMBEDDING_DIMENSIONS === "string" && env.BRAIN_EMBEDDING_DIMENSIONS.trim()
      ? Number(env.BRAIN_EMBEDDING_DIMENSIONS)
      : undefined;
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
    "http://127.0.0.1:8080";

  return {
    databaseUrl: env.BRAIN_DATABASE_URL ?? "postgresql:///ai_brain_local",
    artifactRoot,
    producerInboxRoot,
    namespaceDefault: env.BRAIN_NAMESPACE_DEFAULT ?? "personal",
    lexicalProvider: env.BRAIN_LEXICAL_PROVIDER === "fts" ? "fts" : "bm25",
    lexicalFallbackEnabled: parseBoolean(env.BRAIN_LEXICAL_FALLBACK_ENABLED, true),
    embeddingProvider: env.BRAIN_EMBEDDING_PROVIDER ?? "openrouter",
    embeddingModel: env.BRAIN_EMBEDDING_MODEL ?? "text-embedding-default",
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
    externalAiEmbeddingModel: env.BRAIN_EXTERNAL_AI_EMBEDDING_MODEL ?? env.BRAIN_EMBEDDING_MODEL ?? "text-embedding-default",
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
