import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { queryRows, withTransaction } from "../db/client.js";
import { readConfig } from "../config.js";
import { classifyDerivationTextToCandidates, classifyTextToCandidates } from "../classification/service.js";
import { attachTextDerivation } from "../derivations/service.js";
import { ingestArtifact } from "../ingest/worker.js";
import type { SourceType } from "../types.js";
import { transcribeAudioFile } from "./model-runtime.js";

type ModelProviderId = "external" | "openrouter" | "gemini";
type SessionStatus =
  | "draft"
  | "intake_in_progress"
  | "awaiting_review"
  | "clarifications_open"
  | "reprocessing"
  | "completed"
  | "failed"
  | "archived";

interface SessionRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly title: string;
  readonly notes: string | null;
  readonly tags: unknown;
  readonly status: SessionStatus;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly default_asr_model: string | null;
  readonly default_llm_provider: ModelProviderId | null;
  readonly default_llm_model: string | null;
  readonly default_llm_preset: string | null;
  readonly default_embedding_provider: ModelProviderId | null;
  readonly default_embedding_model: string | null;
  readonly metadata: Record<string, unknown>;
}

interface CountRow {
  readonly total: string;
}

interface SessionInputRow {
  readonly id: string;
  readonly session_id: string;
  readonly input_type: string;
  readonly label: string | null;
  readonly raw_text: string | null;
  readonly file_name: string | null;
  readonly mime_type: string | null;
  readonly byte_size: string | number | null;
  readonly duration_seconds: string | number | null;
  readonly artifact_id: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly metadata: Record<string, unknown>;
}

interface SessionArtifactRow {
  readonly artifact_id: string;
  readonly role: string;
  readonly status: string;
  readonly derive_status: string | null;
  readonly classify_status: string | null;
  readonly created_at: string;
  readonly metadata: Record<string, unknown>;
  readonly source_type: string;
  readonly uri: string;
  readonly mime_type: string | null;
}

interface SessionModelRunRow {
  readonly id: string;
  readonly family: string;
  readonly endpoint: string;
  readonly provider_id: ModelProviderId | null;
  readonly model: string;
  readonly preset_id: string | null;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly error_text: string | null;
  readonly metrics_json: Record<string, unknown>;
}

interface ArtifactChunkRow {
  readonly id: string;
  readonly text_content: string;
  readonly chunk_index: number;
}

interface ReviewEntityRow {
  readonly entity_id: string;
  readonly display_label: string;
  readonly entity_type: string;
  readonly evidence_count: string;
  readonly confidence: number | null;
  readonly aliases: readonly string[] | null;
}

interface ReviewRelationshipRow {
  readonly relationship_id: string;
  readonly subject_label: string;
  readonly predicate: string;
  readonly object_label: string;
  readonly confidence: number | null;
  readonly status: string;
  readonly evidence_count: string;
  readonly source_ref: string | null;
  readonly metadata: Record<string, unknown>;
}

interface ReviewClaimRow {
  readonly claim_id: string;
  readonly normalized_text: string;
  readonly claim_type: string;
  readonly confidence: number | null;
  readonly status: string;
  readonly ambiguity_state: string;
  readonly ambiguity_type: string | null;
  readonly ambiguity_reason: string | null;
  readonly source_ref: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface OpsSession {
  readonly id: string;
  readonly namespaceId: string;
  readonly title: string;
  readonly notes?: string;
  readonly tags: readonly string[];
  readonly status: SessionStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly defaultAsrModel?: string;
  readonly defaultLlmProvider?: ModelProviderId;
  readonly defaultLlmModel?: string;
  readonly defaultLlmPreset?: string;
  readonly defaultEmbeddingProvider?: ModelProviderId;
  readonly defaultEmbeddingModel?: string;
  readonly metadata: Record<string, unknown>;
}

export interface OpsSessionSummary extends OpsSession {
  readonly counts: {
    readonly inputs: number;
    readonly artifacts: number;
    readonly modelRuns: number;
    readonly openClarifications: number;
  };
}

export interface OpsSessionDetail extends OpsSessionSummary {
  readonly recentInputs: readonly OpsSessionInput[];
  readonly artifacts: readonly OpsSessionArtifact[];
  readonly recentRuns: readonly OpsSessionModelRun[];
}

export interface OpsSessionInput {
  readonly id: string;
  readonly inputType: string;
  readonly label?: string;
  readonly rawText?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly durationSeconds?: number;
  readonly artifactId?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface OpsSessionArtifact {
  readonly artifactId: string;
  readonly role: string;
  readonly status: string;
  readonly deriveStatus?: string;
  readonly classifyStatus?: string;
  readonly createdAt: string;
  readonly sourceType: string;
  readonly uri: string;
  readonly mimeType?: string;
  readonly metadata: Record<string, unknown>;
}

export interface OpsSessionModelRun {
  readonly id: string;
  readonly family: string;
  readonly endpoint: string;
  readonly providerId?: ModelProviderId;
  readonly model: string;
  readonly presetId?: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly errorText?: string;
  readonly metrics: Record<string, unknown>;
}

export interface OpsSessionReview {
  readonly session: OpsSession;
  readonly sources: readonly OpsSessionInput[];
  readonly entities: readonly {
    readonly entityId: string;
    readonly displayLabel: string;
    readonly entityType: string;
    readonly evidenceCount: number;
    readonly confidence?: number;
    readonly aliases: readonly string[];
  }[];
  readonly relationships: readonly {
    readonly relationshipId: string;
    readonly subject: string;
    readonly predicate: string;
    readonly object: string;
    readonly confidence?: number;
    readonly status: string;
    readonly evidenceCount: number;
    readonly sourceRef?: string;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly claims: readonly {
    readonly claimId: string;
    readonly normalizedText: string;
    readonly claimType: string;
    readonly confidence?: number;
    readonly status: string;
    readonly ambiguityState: string;
    readonly ambiguityType?: string;
    readonly ambiguityReason?: string;
    readonly sourceRef?: string;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly unresolvedItems: readonly {
    readonly claimId: string;
    readonly title: string;
    readonly description: string;
    readonly ambiguityType?: string;
    readonly confidence?: number;
    readonly sourceRef?: string;
    readonly suggestions: readonly string[];
  }[];
  readonly summary: {
    readonly entityCount: number;
    readonly relationshipCount: number;
    readonly claimCount: number;
    readonly unresolvedCount: number;
  };
}

export interface CreateSessionRequest {
  readonly title: string;
  readonly namespaceId?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  readonly createdBy?: string;
  readonly defaultAsrModel?: string;
  readonly defaultLlmProvider?: ModelProviderId;
  readonly defaultLlmModel?: string;
  readonly defaultLlmPreset?: string;
  readonly defaultEmbeddingProvider?: ModelProviderId;
  readonly defaultEmbeddingModel?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateSessionRequest {
  readonly title?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  readonly status?: SessionStatus;
  readonly defaultAsrModel?: string | null;
  readonly defaultLlmProvider?: ModelProviderId | null;
  readonly defaultLlmModel?: string | null;
  readonly defaultLlmPreset?: string | null;
  readonly defaultEmbeddingProvider?: ModelProviderId | null;
  readonly defaultEmbeddingModel?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface IntakeTextRequest {
  readonly sessionId: string;
  readonly label?: string;
  readonly text: string;
  readonly runClassification: boolean;
  readonly classification?: {
    readonly provider?: ModelProviderId;
    readonly model?: string;
    readonly presetId?: string;
    readonly maxOutputTokens?: number;
  };
  readonly actorId?: string;
}

export interface IntakeFileRequest {
  readonly sessionId: string;
  readonly inputUri: string;
  readonly sourceType: SourceType;
  readonly label?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly runAsr?: boolean;
  readonly runClassification?: boolean;
  readonly asr?: {
    readonly modelId?: string;
  };
  readonly classification?: {
    readonly provider?: ModelProviderId;
    readonly model?: string;
    readonly presetId?: string;
    readonly maxOutputTokens?: number;
  };
  readonly actorId?: string;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function toNumber(value: string | number | null): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapSession(row: SessionRow): OpsSession {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    title: row.title,
    notes: row.notes ?? undefined,
    tags: asStringArray(row.tags),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    defaultAsrModel: row.default_asr_model ?? undefined,
    defaultLlmProvider: row.default_llm_provider ?? undefined,
    defaultLlmModel: row.default_llm_model ?? undefined,
    defaultLlmPreset: row.default_llm_preset ?? undefined,
    defaultEmbeddingProvider: row.default_embedding_provider ?? undefined,
    defaultEmbeddingModel: row.default_embedding_model ?? undefined,
    metadata: row.metadata ?? {}
  };
}

function mapSessionInput(row: SessionInputRow): OpsSessionInput {
  return {
    id: row.id,
    inputType: row.input_type,
    label: row.label ?? undefined,
    rawText: row.raw_text ?? undefined,
    fileName: row.file_name ?? undefined,
    mimeType: row.mime_type ?? undefined,
    byteSize: toNumber(row.byte_size),
    durationSeconds: toNumber(row.duration_seconds),
    artifactId: row.artifact_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    metadata: row.metadata ?? {}
  };
}

function mapSessionArtifact(row: SessionArtifactRow): OpsSessionArtifact {
  return {
    artifactId: row.artifact_id,
    role: row.role,
    status: row.status,
    deriveStatus: row.derive_status ?? undefined,
    classifyStatus: row.classify_status ?? undefined,
    createdAt: row.created_at,
    sourceType: row.source_type,
    uri: row.uri,
    mimeType: row.mime_type ?? undefined,
    metadata: row.metadata ?? {}
  };
}

function mapSessionModelRun(row: SessionModelRunRow): OpsSessionModelRun {
  return {
    id: row.id,
    family: row.family,
    endpoint: row.endpoint,
    providerId: row.provider_id ?? undefined,
    model: row.model,
    presetId: row.preset_id ?? undefined,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    errorText: row.error_text ?? undefined,
    metrics: row.metrics_json ?? {}
  };
}

function requireNonEmpty(value: string, name: string): string {
  if (!value.trim()) {
    throw new Error(`${name} is required.`);
  }

  return value.trim();
}

function defaultOperatorArtifactRoot(): string {
  const config = readConfig();
  return config.artifactRoot || path.resolve(process.cwd(), "../artifacts/operator-workbench");
}

function normalizeModelProvider(value?: string | null): ModelProviderId | undefined {
  if (value === "external" || value === "openrouter" || value === "gemini") {
    return value;
  }
  return undefined;
}

function resolveModelProvider(override?: string | null, sessionDefault?: string | null): ModelProviderId {
  return normalizeModelProvider(override) ?? normalizeModelProvider(sessionDefault) ?? "external";
}

function providerBaseUrlFor(provider: ModelProviderId): string {
  const config = readConfig();
  if (provider === "openrouter") {
    return config.openRouterBaseUrl;
  }
  if (provider === "gemini") {
    return config.geminiBaseUrl;
  }
  return config.modelRuntimeBaseUrl;
}

async function materializeSessionTextInput(sessionId: string, inputId: string, text: string): Promise<string> {
  const root = defaultOperatorArtifactRoot();
  const sessionDir = path.join(root, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${inputId}.txt`);
  await writeFile(filePath, `${text.trim()}\n`, "utf8");
  return filePath;
}

async function materializeSessionFileInput(sessionId: string, inputId: string, inputUri: string, fileName?: string): Promise<string> {
  const root = defaultOperatorArtifactRoot();
  const sessionDir = path.join(root, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const extension = path.extname(fileName ?? inputUri);
  const targetPath = path.join(sessionDir, `${inputId}${extension}`);
  await copyFile(path.resolve(inputUri), targetPath);
  return targetPath;
}

function sessionInputTypeForSource(sourceType: SourceType): string {
  switch (sourceType) {
    case "audio":
      return "audio_upload";
    case "pdf":
      return "pdf";
    case "image":
      return "image";
    default:
      return "file_upload";
  }
}

async function recordModelRun(input: {
  readonly sessionId: string;
  readonly inputId: string;
  readonly artifactId: string;
  readonly family: string;
  readonly endpoint: string;
  readonly providerId: ModelProviderId;
  readonly providerBaseUrl: string;
  readonly model: string;
  readonly presetId?: string;
  readonly requestJson: Record<string, unknown>;
  readonly responseJson?: Record<string, unknown>;
  readonly status: "succeeded" | "failed";
  readonly startedAt: string;
  readonly metricsJson?: Record<string, unknown>;
  readonly errorText?: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO ops.session_model_runs (
          session_id,
          input_id,
          artifact_id,
          family,
          endpoint,
          provider_id,
          provider_base_url,
          model,
          preset_id,
          request_json,
          response_json,
          status,
          started_at,
          finished_at,
          metrics_json,
          error_text
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb,
          $11::jsonb,
          $12,
          $13::timestamptz,
          now(),
          $14::jsonb,
          $15
        )
      `,
      [
        input.sessionId,
        input.inputId,
        input.artifactId,
        input.family,
        input.endpoint,
        input.providerId,
        input.providerBaseUrl,
        input.model,
        input.presetId ?? null,
        JSON.stringify(input.requestJson),
        JSON.stringify(input.responseJson ?? {}),
        input.status,
        input.startedAt,
        JSON.stringify(input.metricsJson ?? {}),
        input.errorText ?? null
      ]
    );
  });
}

async function loadLatestObservationId(artifactId: string): Promise<string | undefined> {
  const rows = await queryRows<{ readonly observation_id: string }>(
    `
      SELECT id::text AS observation_id
      FROM artifact_observations
      WHERE artifact_id = $1::uuid
      ORDER BY version DESC
      LIMIT 1
    `,
    [artifactId]
  );

  return rows[0]?.observation_id;
}

async function getSessionRow(sessionId: string): Promise<SessionRow> {
  const rows = await queryRows<SessionRow>(
    `
      SELECT
        id,
        namespace_id,
        title,
        notes,
        tags,
        status,
        created_by,
        created_at,
        updated_at,
        default_asr_model,
        default_llm_provider,
        default_llm_model,
        default_llm_preset,
        default_embedding_provider,
        default_embedding_model,
        metadata
      FROM ops.ingestion_sessions
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [sessionId]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`Session ${sessionId} not found.`);
  }

  return row;
}

async function countForSession(sessionId: string, tableName: string): Promise<number> {
  const rows = await queryRows<CountRow>(`SELECT COUNT(*)::text AS total FROM ${tableName} WHERE session_id = $1::uuid`, [sessionId]);
  return Number(rows[0]?.total ?? 0);
}

async function countOpenClarifications(sessionId: string): Promise<number> {
  const rows = await queryRows<CountRow>(
    `
      WITH session_chunks AS (
        SELECT ac.id
        FROM ops.session_artifacts sa
        JOIN artifact_observations ao ON ao.artifact_id = sa.artifact_id
        JOIN artifact_chunks ac ON ac.artifact_observation_id = ao.id
        WHERE sa.session_id = $1::uuid
      )
      SELECT COUNT(*)::text AS total
      FROM claim_candidates cc
      WHERE cc.source_chunk_id IN (SELECT id FROM session_chunks)
        AND (
          cc.ambiguity_state = 'requires_clarification'
          OR cc.ambiguity_type IS NOT NULL
        )
    `,
    [sessionId]
  );

  return Number(rows[0]?.total ?? 0);
}

async function loadSessionInputs(sessionId: string, limit = 12): Promise<OpsSessionInput[]> {
  const rows = await queryRows<SessionInputRow>(
    `
      SELECT
        id,
        session_id,
        input_type,
        label,
        raw_text,
        file_name,
        mime_type,
        byte_size,
        duration_seconds,
        artifact_id,
        status,
        created_at,
        metadata
      FROM ops.session_inputs
      WHERE session_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [sessionId, limit]
  );

  return rows.map(mapSessionInput);
}

async function loadSessionArtifacts(sessionId: string): Promise<OpsSessionArtifact[]> {
  const rows = await queryRows<SessionArtifactRow>(
    `
      SELECT
        sa.artifact_id::text,
        sa.role,
        sa.status,
        sa.derive_status,
        sa.classify_status,
        sa.created_at,
        sa.metadata,
        a.artifact_type AS source_type,
        a.uri,
        a.mime_type
      FROM ops.session_artifacts sa
      JOIN artifacts a ON a.id = sa.artifact_id
      WHERE sa.session_id = $1::uuid
      ORDER BY sa.created_at DESC
    `,
    [sessionId]
  );

  return rows.map(mapSessionArtifact);
}

async function loadSessionModelRuns(sessionId: string, limit = 24): Promise<OpsSessionModelRun[]> {
  const rows = await queryRows<SessionModelRunRow>(
    `
      SELECT
        id,
        family,
        endpoint,
        provider_id,
        model,
        preset_id,
        status,
        started_at,
        finished_at,
        error_text,
        metrics_json
      FROM ops.session_model_runs
      WHERE session_id = $1::uuid
      ORDER BY started_at DESC
      LIMIT $2
    `,
    [sessionId, limit]
  );

  return rows.map(mapSessionModelRun);
}

async function loadArtifactChunks(artifactId: string, observationId?: string): Promise<ArtifactChunkRow[]> {
  return queryRows<ArtifactChunkRow>(
    `
      SELECT
        ac.id::text,
        ac.text_content,
        ac.chunk_index
      FROM artifact_chunks ac
      JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      WHERE ao.artifact_id = $1::uuid
        AND ($2::uuid IS NULL OR ao.id = $2::uuid)
      ORDER BY ac.chunk_index ASC
    `,
    [artifactId, observationId ?? null]
  );
}

async function appendSessionAction(
  sessionId: string,
  actionType: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
  result?: Record<string, unknown>,
  actorId = "operator"
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO ops.session_actions (
          session_id,
          actor_id,
          action_type,
          target_type,
          target_id,
          payload_json,
          result_json
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
      `,
      [sessionId, actorId, actionType, targetType, targetId, JSON.stringify(payload), JSON.stringify(result ?? {})]
    );
  });
}

export async function createSession(request: CreateSessionRequest): Promise<OpsSession> {
  const title = requireNonEmpty(request.title, "title");
  const namespaceId = request.namespaceId?.trim() || readConfig().namespaceDefault;
  const tags = request.tags?.filter((value) => value.trim().length > 0) ?? [];

  const rows = await queryRows<SessionRow>(
    `
      INSERT INTO ops.ingestion_sessions (
        namespace_id,
        title,
        notes,
        tags,
        status,
        created_by,
        default_asr_model,
        default_llm_provider,
        default_llm_model,
        default_llm_preset,
        default_embedding_provider,
        default_embedding_model,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, 'draft', $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      RETURNING
        id,
        namespace_id,
        title,
        notes,
        tags,
        status,
        created_by,
        created_at,
        updated_at,
        default_asr_model,
        default_llm_provider,
        default_llm_model,
        default_llm_preset,
        default_embedding_provider,
        default_embedding_model,
        metadata
    `,
    [
      namespaceId,
      title,
      request.notes?.trim() || null,
      JSON.stringify(tags),
      request.createdBy ?? "operator",
      request.defaultAsrModel ?? null,
      request.defaultLlmProvider ?? "external",
      request.defaultLlmModel ?? null,
      request.defaultLlmPreset ?? null,
      request.defaultEmbeddingProvider ?? "external",
      request.defaultEmbeddingModel ?? null,
      JSON.stringify(request.metadata ?? {})
    ]
  );

  const session = mapSession(rows[0]!);
  await appendSessionAction(session.id, "session.created", "session", session.id, {
    title: session.title,
    namespace_id: session.namespaceId,
    tags: session.tags
  });

  return session;
}

export async function listSessions(limit = 40): Promise<OpsSessionSummary[]> {
  const rows = await queryRows<SessionRow>(
    `
      SELECT
        id,
        namespace_id,
        title,
        notes,
        tags,
        status,
        created_by,
        created_at,
        updated_at,
        default_asr_model,
        default_llm_provider,
        default_llm_model,
        default_llm_preset,
        default_embedding_provider,
        default_embedding_model,
        metadata
      FROM ops.ingestion_sessions
      ORDER BY updated_at DESC, created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  const summaries = await Promise.all(
    rows.map(async (row) => {
      const session = mapSession(row);
      const [inputs, artifacts, modelRuns, openClarifications] = await Promise.all([
        countForSession(session.id, "ops.session_inputs"),
        countForSession(session.id, "ops.session_artifacts"),
        countForSession(session.id, "ops.session_model_runs"),
        countOpenClarifications(session.id)
      ]);

      return {
        ...session,
        counts: {
          inputs,
          artifacts,
          modelRuns,
          openClarifications
        }
      } satisfies OpsSessionSummary;
    })
  );

  return summaries;
}

export async function getSessionDetail(sessionId: string): Promise<OpsSessionDetail> {
  const row = await getSessionRow(sessionId);
  const session = mapSession(row);
  const [inputs, artifacts, modelRuns, openClarifications, recentInputs, linkedArtifacts, recentRuns] = await Promise.all([
    countForSession(session.id, "ops.session_inputs"),
    countForSession(session.id, "ops.session_artifacts"),
    countForSession(session.id, "ops.session_model_runs"),
    countOpenClarifications(session.id),
    loadSessionInputs(session.id),
    loadSessionArtifacts(session.id),
    loadSessionModelRuns(session.id)
  ]);

  return {
    ...session,
    counts: {
      inputs,
      artifacts,
      modelRuns,
      openClarifications
    },
    recentInputs,
    artifacts: linkedArtifacts,
    recentRuns
  };
}

export async function updateSession(sessionId: string, request: UpdateSessionRequest): Promise<OpsSession> {
  const existing = await getSessionRow(sessionId);
  const nextTags = request.tags ? request.tags.filter((value) => value.trim().length > 0) : asStringArray(existing.tags);
  const mergedMetadata = {
    ...(existing.metadata ?? {}),
    ...(request.metadata ?? {})
  };

  const rows = await queryRows<SessionRow>(
    `
      UPDATE ops.ingestion_sessions
      SET
        title = $2,
        notes = $3,
        tags = $4::jsonb,
        status = $5,
        updated_at = now(),
        default_asr_model = $6,
        default_llm_provider = $7,
        default_llm_model = $8,
        default_llm_preset = $9,
        default_embedding_provider = $10,
        default_embedding_model = $11,
        metadata = $12::jsonb
      WHERE id = $1::uuid
      RETURNING
        id,
        namespace_id,
        title,
        notes,
        tags,
        status,
        created_by,
        created_at,
        updated_at,
        default_asr_model,
        default_llm_provider,
        default_llm_model,
        default_llm_preset,
        default_embedding_provider,
        default_embedding_model,
        metadata
    `,
    [
      sessionId,
      request.title?.trim() || existing.title,
      request.notes === undefined ? existing.notes : request.notes?.trim() || null,
      JSON.stringify(nextTags),
      request.status ?? existing.status,
      request.defaultAsrModel === undefined ? existing.default_asr_model : request.defaultAsrModel,
      request.defaultLlmProvider === undefined ? existing.default_llm_provider : request.defaultLlmProvider,
      request.defaultLlmModel === undefined ? existing.default_llm_model : request.defaultLlmModel,
      request.defaultLlmPreset === undefined ? existing.default_llm_preset : request.defaultLlmPreset,
      request.defaultEmbeddingProvider === undefined ? existing.default_embedding_provider : request.defaultEmbeddingProvider,
      request.defaultEmbeddingModel === undefined ? existing.default_embedding_model : request.defaultEmbeddingModel,
      JSON.stringify(mergedMetadata)
    ]
  );

  const session = mapSession(rows[0]!);
  await appendSessionAction(session.id, "session.updated", "session", session.id, request.metadata ?? {});

  return session;
}

export async function ingestSessionText(request: IntakeTextRequest): Promise<{
  readonly session: OpsSession;
  readonly input: OpsSessionInput;
  readonly artifactId: string;
  readonly classifiedChunks: number;
}> {
  const text = requireNonEmpty(request.text, "text");
  const sessionRow = await getSessionRow(request.sessionId);
  const session = mapSession(sessionRow);
  const label = request.label?.trim() || "Pasted text";

  const inputRow = await queryRows<SessionInputRow>(
    `
      INSERT INTO ops.session_inputs (
        session_id,
        input_type,
        label,
        raw_text,
        file_name,
        mime_type,
        byte_size,
        status,
        metadata
      )
      VALUES ($1::uuid, 'text', $2, $3, $4, 'text/plain', $5, 'queued', $6::jsonb)
      RETURNING
        id,
        session_id,
        input_type,
        label,
        raw_text,
        file_name,
        mime_type,
        byte_size,
        duration_seconds,
        artifact_id,
        status,
        created_at,
        metadata
    `,
    [
      session.id,
      label,
      text,
      `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "input"}.txt`,
      Buffer.byteLength(text, "utf8"),
      JSON.stringify({
        source: "operator_workbench"
      })
    ]
  );

  const input = mapSessionInput(inputRow[0]!);
  const capturedAt = new Date().toISOString();

  await updateSession(session.id, {
    status: "intake_in_progress",
    metadata: {
      last_input_id: input.id
    }
  });

  const inputPath = await materializeSessionTextInput(session.id, input.id, text);
  const ingestResult = await ingestArtifact({
    inputUri: inputPath,
    namespaceId: session.namespaceId,
    sessionId: session.id,
    sourceType: "text",
    capturedAt,
    sourceChannel: "operator_workbench:text",
    metadata: {
      session_id: session.id,
      session_input_id: input.id,
      session_title: session.title,
      input_label: label
    }
  });

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE ops.session_inputs
        SET
          artifact_id = $2::uuid,
          status = $3,
          metadata = metadata || $4::jsonb
        WHERE id = $1::uuid
      `,
      [
        input.id,
        ingestResult.artifact.artifactId,
        request.runClassification ? "ingested" : "review_ready",
        JSON.stringify({
          observation_id: ingestResult.artifact.observationId ?? null,
          fragment_count: ingestResult.fragments.length,
          episodic_insert_count: ingestResult.episodicInsertCount
        })
      ]
    );

    await client.query(
      `
        INSERT INTO ops.session_artifacts (
          session_id,
          artifact_id,
          role,
          status,
          classify_status,
          metadata
        )
        VALUES ($1::uuid, $2::uuid, 'raw_source', $3, $4, $5::jsonb)
        ON CONFLICT (session_id, artifact_id, role)
        DO UPDATE SET
          status = EXCLUDED.status,
          classify_status = EXCLUDED.classify_status,
          metadata = ops.session_artifacts.metadata || EXCLUDED.metadata
      `,
      [
        session.id,
        ingestResult.artifact.artifactId,
        request.runClassification ? "derived" : "review_ready",
        request.runClassification ? "queued" : null,
        JSON.stringify({
          observation_id: ingestResult.artifact.observationId ?? null,
          source_type: ingestResult.artifact.sourceType
        })
      ]
    );
  });

  let classifiedChunks = 0;
  const classificationProvider = resolveModelProvider(request.classification?.provider, session.defaultLlmProvider);
  const classificationProviderBaseUrl = providerBaseUrlFor(classificationProvider);
  if (request.runClassification) {
    const chunks = await loadArtifactChunks(ingestResult.artifact.artifactId, ingestResult.artifact.observationId);

    for (const chunk of chunks) {
      const startedAt = new Date().toISOString();
      try {
        const classification = await classifyTextToCandidates({
          namespaceId: session.namespaceId,
          text: chunk.text_content,
          provider: classificationProvider,
          sourceChunkId: chunk.id,
          artifactId: ingestResult.artifact.artifactId,
          artifactObservationId: ingestResult.artifact.observationId,
          model: request.classification?.model ?? session.defaultLlmModel,
          presetId: request.classification?.presetId ?? session.defaultLlmPreset,
          maxOutputTokens: request.classification?.maxOutputTokens,
          metadata: {
            session_id: session.id,
            session_input_id: input.id,
            artifact_id: ingestResult.artifact.artifactId,
            chunk_index: chunk.chunk_index
          }
        });

        classifiedChunks += 1;
        await recordModelRun({
          sessionId: session.id,
          inputId: input.id,
          artifactId: ingestResult.artifact.artifactId,
          family: "llm",
          endpoint: "/classify/text",
          providerId: normalizeModelProvider(classification.provider) ?? classificationProvider,
          providerBaseUrl: classificationProviderBaseUrl,
          model: classification.model,
          presetId: request.classification?.presetId ?? session.defaultLlmPreset,
          requestJson: {
            chunk_id: chunk.id,
            chunk_index: chunk.chunk_index,
            chars: chunk.text_content.length
          },
          responseJson: {
            inserted: classification.inserted,
            provider: classification.provider,
            raw_text: classification.rawText
          },
          status: "succeeded",
          startedAt,
          metricsJson: {
            inserted: classification.inserted,
            token_usage: classification.tokenUsage ?? {},
            provider_metadata: classification.providerMetadata ?? {},
            latency_ms: classification.latencyMs
          }
        });
      } catch (error) {
        await recordModelRun({
          sessionId: session.id,
          inputId: input.id,
          artifactId: ingestResult.artifact.artifactId,
          family: "llm",
          endpoint: "/classify/text",
          providerId: classificationProvider,
          providerBaseUrl: classificationProviderBaseUrl,
          model: request.classification?.model ?? session.defaultLlmModel ?? "unknown",
          presetId: request.classification?.presetId ?? session.defaultLlmPreset,
          requestJson: {
            chunk_id: chunk.id,
            chunk_index: chunk.chunk_index,
            chars: chunk.text_content.length
          },
          status: "failed",
          startedAt,
          errorText: error instanceof Error ? error.message : String(error)
        });

        await withTransaction(async (client) => {
          await client.query(
            `
              UPDATE ops.session_inputs
              SET status = 'failed'
              WHERE id = $1::uuid
            `,
            [input.id]
          );

          await client.query(
            `
              UPDATE ops.session_artifacts
              SET classify_status = 'failed'
              WHERE session_id = $1::uuid
                AND artifact_id = $2::uuid
            `,
            [session.id, ingestResult.artifact.artifactId]
          );
        });

        await updateSession(session.id, { status: "failed" });
        throw error;
      }
    }
  }

  const unresolvedCount = await countOpenClarifications(session.id);
  const nextStatus: SessionStatus = unresolvedCount > 0 ? "clarifications_open" : "awaiting_review";

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE ops.session_inputs
        SET status = $2
        WHERE id = $1::uuid
      `,
      [input.id, request.runClassification ? "classified" : "review_ready"]
    );

    await client.query(
      `
        UPDATE ops.session_artifacts
        SET
          status = $3,
          classify_status = $4
        WHERE session_id = $1::uuid
          AND artifact_id = $2::uuid
      `,
      [
        session.id,
        ingestResult.artifact.artifactId,
        request.runClassification ? "classified" : "review_ready",
        request.runClassification ? "succeeded" : null
      ]
    );
  });

  await updateSession(session.id, {
    status: nextStatus,
    metadata: {
      last_ingest_at: capturedAt,
      last_artifact_id: ingestResult.artifact.artifactId
    }
  });

  await appendSessionAction(
    session.id,
    "session.intake.text",
    "session_input",
    input.id,
    {
      label,
      run_classification: request.runClassification
    },
    {
      artifact_id: ingestResult.artifact.artifactId,
      fragment_count: ingestResult.fragments.length,
      classified_chunks: classifiedChunks
    },
    request.actorId ?? "operator"
  );

  return {
    session: mapSession(await getSessionRow(session.id)),
    input: {
      ...input,
      artifactId: ingestResult.artifact.artifactId,
      status: request.runClassification ? "classified" : "review_ready"
    },
    artifactId: ingestResult.artifact.artifactId,
    classifiedChunks
  };
}

export async function ingestSessionFile(request: IntakeFileRequest): Promise<{
  readonly session: OpsSession;
  readonly input: OpsSessionInput;
  readonly artifactId: string;
  readonly derivationId?: string;
}> {
  const sessionRow = await getSessionRow(request.sessionId);
  const session = mapSession(sessionRow);
  const inputPath = path.resolve(request.inputUri);
  const fileName = request.fileName?.trim() || path.basename(inputPath);
  const classificationProvider = resolveModelProvider(request.classification?.provider, session.defaultLlmProvider);
  const classificationProviderBaseUrl = providerBaseUrlFor(classificationProvider);

  const inputRows = await queryRows<SessionInputRow>(
    `
      INSERT INTO ops.session_inputs (
        session_id,
        input_type,
        label,
        file_name,
        mime_type,
        byte_size,
        status,
        metadata
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, 'queued', $7::jsonb)
      RETURNING
        id,
        session_id,
        input_type,
        label,
        raw_text,
        file_name,
        mime_type,
        byte_size,
        duration_seconds,
        artifact_id,
        status,
        created_at,
        metadata
    `,
    [
      session.id,
      sessionInputTypeForSource(request.sourceType),
      request.label?.trim() || fileName,
      fileName,
      request.mimeType ?? null,
      request.byteSize ?? null,
      JSON.stringify({
        source: "operator_workbench",
        source_type: request.sourceType
      })
    ]
  );

  const input = mapSessionInput(inputRows[0]!);
  const capturedAt = new Date().toISOString();

  await updateSession(session.id, {
    status: "intake_in_progress",
    metadata: {
      last_input_id: input.id
    }
  });

  const storedPath = await materializeSessionFileInput(session.id, input.id, inputPath, fileName);
  const ingestResult = await ingestArtifact({
    inputUri: storedPath,
    namespaceId: session.namespaceId,
    sessionId: session.id,
    sourceType: request.sourceType,
    capturedAt,
    sourceChannel: `operator_workbench:${request.sourceType}`,
    metadata: {
      session_id: session.id,
      session_input_id: input.id,
      session_title: session.title,
      input_label: request.label?.trim() || fileName
    }
  });

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE ops.session_inputs
        SET
          artifact_id = $2::uuid,
          status = 'ingested',
          metadata = metadata || $3::jsonb
        WHERE id = $1::uuid
      `,
      [
        input.id,
        ingestResult.artifact.artifactId,
        JSON.stringify({
          observation_id: ingestResult.artifact.observationId ?? null,
          fragment_count: ingestResult.fragments.length,
          episodic_insert_count: ingestResult.episodicInsertCount
        })
      ]
    );

    await client.query(
      `
        INSERT INTO ops.session_artifacts (
          session_id,
          input_id,
          artifact_id,
          role,
          status,
          derive_status,
          classify_status,
          metadata
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, 'raw_source', $4, $5, $6, $7::jsonb)
        ON CONFLICT (session_id, artifact_id, role)
        DO UPDATE SET
          status = EXCLUDED.status,
          derive_status = EXCLUDED.derive_status,
          classify_status = EXCLUDED.classify_status,
          metadata = ops.session_artifacts.metadata || EXCLUDED.metadata
      `,
      [
        session.id,
        input.id,
        ingestResult.artifact.artifactId,
        request.sourceType === "audio" ? "uploaded" : "review_ready",
        request.sourceType === "audio" && request.runAsr ? "queued" : request.sourceType === "audio" ? "pending_asr" : null,
        request.runClassification ? "queued" : null,
        JSON.stringify({
          observation_id: ingestResult.artifact.observationId ?? null,
          source_type: ingestResult.artifact.sourceType
        })
      ]
    );
  });

  if (request.sourceType === "pdf" || request.sourceType === "image") {
    await withTransaction(async (client) => {
      await client.query(`UPDATE ops.session_inputs SET status = 'awaiting_adapter' WHERE id = $1::uuid`, [input.id]);
      await client.query(
        `
          UPDATE ops.session_artifacts
          SET
            status = 'awaiting_adapter',
            derive_status = 'awaiting_adapter',
            classify_status = null
          WHERE session_id = $1::uuid
            AND artifact_id = $2::uuid
        `,
        [session.id, ingestResult.artifact.artifactId]
      );
    });

    await appendSessionAction(
      session.id,
      "session.intake.file",
      "session_input",
      input.id,
      {
        file_name: fileName,
        source_type: request.sourceType
      },
      {
        artifact_id: ingestResult.artifact.artifactId,
        status: "awaiting_adapter"
      },
      request.actorId ?? "operator"
    );

    return {
      session: mapSession(await getSessionRow(session.id)),
      input: {
        ...input,
        artifactId: ingestResult.artifact.artifactId,
        status: "awaiting_adapter"
      },
      artifactId: ingestResult.artifact.artifactId
    };
  }

  let derivationId: string | undefined;

  if (request.sourceType === "text" && request.runClassification) {
    const chunks = await loadArtifactChunks(ingestResult.artifact.artifactId, ingestResult.artifact.observationId);

    for (const chunk of chunks) {
      const startedAt = new Date().toISOString();
      try {
        const classification = await classifyTextToCandidates({
          namespaceId: session.namespaceId,
          text: chunk.text_content,
          provider: classificationProvider,
          sourceChunkId: chunk.id,
          artifactId: ingestResult.artifact.artifactId,
          artifactObservationId: ingestResult.artifact.observationId,
          model: request.classification?.model ?? session.defaultLlmModel,
          presetId: request.classification?.presetId ?? session.defaultLlmPreset,
          maxOutputTokens: request.classification?.maxOutputTokens,
          metadata: {
            session_id: session.id,
            session_input_id: input.id,
            artifact_id: ingestResult.artifact.artifactId,
            chunk_index: chunk.chunk_index
          }
        });

        await recordModelRun({
          sessionId: session.id,
          inputId: input.id,
          artifactId: ingestResult.artifact.artifactId,
          family: "llm",
          endpoint: "/classify/text",
          providerId: normalizeModelProvider(classification.provider) ?? classificationProvider,
          providerBaseUrl: classificationProviderBaseUrl,
          model: classification.model,
          presetId: request.classification?.presetId ?? session.defaultLlmPreset,
          requestJson: {
            chunk_id: chunk.id,
            chunk_index: chunk.chunk_index,
            chars: chunk.text_content.length
          },
          responseJson: {
            inserted: classification.inserted,
            provider: classification.provider,
            raw_text: classification.rawText
          },
          status: "succeeded",
          startedAt,
          metricsJson: {
            inserted: classification.inserted,
            token_usage: classification.tokenUsage ?? {},
            provider_metadata: classification.providerMetadata ?? {},
            latency_ms: classification.latencyMs
          }
        });
      } catch (error) {
        await recordModelRun({
          sessionId: session.id,
          inputId: input.id,
          artifactId: ingestResult.artifact.artifactId,
          family: "llm",
          endpoint: "/classify/text",
          providerId: classificationProvider,
          providerBaseUrl: classificationProviderBaseUrl,
          model: request.classification?.model ?? session.defaultLlmModel ?? "unknown",
          presetId: request.classification?.presetId ?? session.defaultLlmPreset,
          requestJson: {
            chars: chunk.text_content.length,
            chunk_id: chunk.id,
            chunk_index: chunk.chunk_index
          },
          status: "failed",
          startedAt,
          errorText: error instanceof Error ? error.message : String(error)
        });
        await updateSession(session.id, { status: "failed" });
        throw error;
      }
    }

    await withTransaction(async (client) => {
      await client.query(`UPDATE ops.session_inputs SET status = 'classified' WHERE id = $1::uuid`, [input.id]);
      await client.query(
        `
          UPDATE ops.session_artifacts
          SET
            status = 'classified',
            classify_status = 'succeeded'
          WHERE session_id = $1::uuid
            AND artifact_id = $2::uuid
        `,
        [session.id, ingestResult.artifact.artifactId]
      );
    });
  }

  if (request.sourceType === "audio" && request.runAsr) {
    const startedAt = new Date().toISOString();
    try {
      const transcript = await transcribeAudioFile({
        filePath: storedPath,
        mimeType: request.mimeType,
        modelId: request.asr?.modelId ?? session.defaultAsrModel
      });

      const observationId = (await loadLatestObservationId(ingestResult.artifact.artifactId)) ?? ingestResult.artifact.observationId;
      const derivation = await attachTextDerivation({
        artifactId: ingestResult.artifact.artifactId,
        artifactObservationId: observationId,
        derivationType: "transcript",
        text: transcript.text,
        metadata: {
          language: transcript.language ?? null,
          duration_seconds: transcript.durationSeconds ?? null,
          segments: transcript.segments,
          words: transcript.words,
          source: "model_runtime_asr"
        }
      });
      derivationId = derivation.derivationId;

      await recordModelRun({
        sessionId: session.id,
        inputId: input.id,
        artifactId: ingestResult.artifact.artifactId,
        family: "asr",
        endpoint: "/asr/transcribe",
        providerId: "external",
        providerBaseUrl: readConfig().modelRuntimeBaseUrl,
        model: transcript.model,
        requestJson: {
          file_name: fileName,
          model_id: request.asr?.modelId ?? session.defaultAsrModel ?? null,
          response_format: "json"
        },
        responseJson: transcript.rawResponse,
        status: "succeeded",
        startedAt,
        metricsJson: {
          duration_seconds: transcript.durationSeconds ?? null,
          language: transcript.language ?? null,
          segment_count: transcript.segments.length,
          word_count: transcript.words.length
        }
      });

      await withTransaction(async (client) => {
        await client.query(
          `
            UPDATE ops.session_inputs
            SET
              status = $2,
              duration_seconds = $3
            WHERE id = $1::uuid
          `,
          [input.id, request.runClassification ? "processing" : "classified", transcript.durationSeconds ?? null]
        );

        await client.query(
          `
            INSERT INTO ops.session_artifacts (
              session_id,
              input_id,
              artifact_id,
              role,
              status,
              derive_status,
              classify_status,
              metadata
            )
            VALUES ($1::uuid, $2::uuid, $3::uuid, 'transcript', 'derived', 'succeeded', $4, $5::jsonb)
            ON CONFLICT (session_id, artifact_id, role)
            DO UPDATE SET
              status = EXCLUDED.status,
              derive_status = EXCLUDED.derive_status,
              classify_status = EXCLUDED.classify_status,
              metadata = ops.session_artifacts.metadata || EXCLUDED.metadata
          `,
          [
            session.id,
            input.id,
            ingestResult.artifact.artifactId,
            request.runClassification ? "queued" : null,
            JSON.stringify({
              derivation_id: derivationId,
              language: transcript.language ?? null,
              duration_seconds: transcript.durationSeconds ?? null
            })
          ]
        );

        await client.query(
          `
            UPDATE ops.session_artifacts
            SET
              status = 'derived',
              derive_status = 'succeeded'
            WHERE session_id = $1::uuid
              AND artifact_id = $2::uuid
              AND role = 'raw_source'
          `,
          [session.id, ingestResult.artifact.artifactId]
        );
      });

      if (request.runClassification && derivationId) {
        const classifyStartedAt = new Date().toISOString();
        try {
          const classification = await classifyDerivationTextToCandidates({
            derivationId,
            provider: classificationProvider,
            model: request.classification?.model ?? session.defaultLlmModel,
            presetId: request.classification?.presetId ?? session.defaultLlmPreset,
            maxOutputTokens: request.classification?.maxOutputTokens,
            metadata: {
              session_id: session.id,
              session_input_id: input.id,
              artifact_id: ingestResult.artifact.artifactId
            }
          });

          await recordModelRun({
            sessionId: session.id,
            inputId: input.id,
            artifactId: ingestResult.artifact.artifactId,
            family: "llm",
            endpoint: "/classify/derivation",
            providerId: normalizeModelProvider(classification.provider) ?? classificationProvider,
            providerBaseUrl: classificationProviderBaseUrl,
            model: classification.model,
            presetId: request.classification?.presetId ?? session.defaultLlmPreset,
            requestJson: {
              derivation_id: derivationId
            },
            responseJson: {
              inserted: classification.inserted,
              provider: classification.provider,
              raw_text: classification.rawText
            },
            status: "succeeded",
            startedAt: classifyStartedAt,
            metricsJson: {
              inserted: classification.inserted,
              token_usage: classification.tokenUsage ?? {},
              provider_metadata: classification.providerMetadata ?? {},
              latency_ms: classification.latencyMs
            }
          });

          await withTransaction(async (client) => {
            await client.query(`UPDATE ops.session_inputs SET status = 'classified' WHERE id = $1::uuid`, [input.id]);
            await client.query(
              `
                UPDATE ops.session_artifacts
                SET
                  status = 'classified',
                  classify_status = 'succeeded'
                WHERE session_id = $1::uuid
                  AND artifact_id = $2::uuid
                  AND role = 'transcript'
              `,
              [session.id, ingestResult.artifact.artifactId]
            );
          });
        } catch (error) {
          await recordModelRun({
            sessionId: session.id,
            inputId: input.id,
            artifactId: ingestResult.artifact.artifactId,
            family: "llm",
            endpoint: "/classify/derivation",
            providerId: classificationProvider,
            providerBaseUrl: classificationProviderBaseUrl,
            model: request.classification?.model ?? session.defaultLlmModel ?? "unknown",
            presetId: request.classification?.presetId ?? session.defaultLlmPreset,
            requestJson: {
              derivation_id: derivationId
            },
            status: "failed",
            startedAt: classifyStartedAt,
            errorText: error instanceof Error ? error.message : String(error)
          });
          await updateSession(session.id, { status: "failed" });
          throw error;
        }
      }
    } catch (error) {
      await recordModelRun({
        sessionId: session.id,
        inputId: input.id,
        artifactId: ingestResult.artifact.artifactId,
        family: "asr",
        endpoint: "/asr/transcribe",
        providerId: "external",
        providerBaseUrl: readConfig().modelRuntimeBaseUrl,
        model: request.asr?.modelId ?? session.defaultAsrModel ?? "unknown",
        requestJson: {
          file_name: fileName
        },
        status: "failed",
        startedAt,
        errorText: error instanceof Error ? error.message : String(error)
      });
      await updateSession(session.id, { status: "failed" });
      throw error;
    }
  }

  const unresolvedCount = await countOpenClarifications(session.id);
  await updateSession(session.id, {
    status: unresolvedCount > 0 ? "clarifications_open" : "awaiting_review",
    metadata: {
      last_ingest_at: capturedAt,
      last_artifact_id: ingestResult.artifact.artifactId
    }
  });

  await appendSessionAction(
    session.id,
    "session.intake.file",
    "session_input",
    input.id,
    {
      file_name: fileName,
      source_type: request.sourceType,
      run_asr: Boolean(request.runAsr),
      run_classification: Boolean(request.runClassification)
    },
    {
      artifact_id: ingestResult.artifact.artifactId,
      derivation_id: derivationId ?? null
    },
    request.actorId ?? "operator"
  );

  return {
    session: mapSession(await getSessionRow(session.id)),
    input: {
      ...input,
      artifactId: ingestResult.artifact.artifactId,
      status: request.runClassification || (request.sourceType === "audio" && request.runAsr) ? "classified" : "ingested"
    },
    artifactId: ingestResult.artifact.artifactId,
    derivationId
  };
}

export async function getSessionReview(sessionId: string): Promise<OpsSessionReview> {
  const session = mapSession(await getSessionRow(sessionId));
  const sources = await loadSessionInputs(session.id, 24);

  const [entityRows, relationshipRows, claimRows] = await Promise.all([
    queryRows<ReviewEntityRow>(
      `
        WITH session_chunks AS (
          SELECT ac.id
          FROM ops.session_artifacts sa
          JOIN artifact_observations ao ON ao.artifact_id = sa.artifact_id
          JOIN artifact_chunks ac ON ac.artifact_observation_id = ao.id
          WHERE sa.session_id = $1::uuid
        )
        SELECT
          mem.entity_id::text,
          e.canonical_name AS display_label,
          e.entity_type,
          COUNT(*)::text AS evidence_count,
          MAX(mem.confidence) AS confidence,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT ea.alias), NULL) AS aliases
        FROM memory_entity_mentions mem
        JOIN entities e ON e.id = mem.entity_id
        LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
        WHERE mem.source_chunk_id IN (SELECT id FROM session_chunks)
        GROUP BY mem.entity_id, e.canonical_name, e.entity_type
        ORDER BY COUNT(*) DESC, MAX(mem.confidence) DESC NULLS LAST, e.canonical_name ASC
        LIMIT 32
      `,
      [session.id]
    ),
    queryRows<ReviewRelationshipRow>(
      `
        WITH session_chunks AS (
          SELECT ac.id
          FROM ops.session_artifacts sa
          JOIN artifact_observations ao ON ao.artifact_id = sa.artifact_id
          JOIN artifact_chunks ac ON ac.artifact_observation_id = ao.id
          WHERE sa.session_id = $1::uuid
        )
        SELECT
          rc.id::text AS relationship_id,
          subject_entity.canonical_name AS subject_label,
          rc.predicate,
          object_entity.canonical_name AS object_label,
          rc.confidence,
          rc.status,
          1::text AS evidence_count,
          rc.source_chunk_id::text AS source_ref,
          rc.metadata
        FROM relationship_candidates rc
        JOIN entities subject_entity ON subject_entity.id = rc.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rc.object_entity_id
        WHERE rc.source_chunk_id IN (SELECT id FROM session_chunks)
        ORDER BY rc.created_at DESC, rc.confidence DESC NULLS LAST
        LIMIT 64
      `,
      [session.id]
    ),
    queryRows<ReviewClaimRow>(
      `
        WITH session_chunks AS (
          SELECT ac.id
          FROM ops.session_artifacts sa
          JOIN artifact_observations ao ON ao.artifact_id = sa.artifact_id
          JOIN artifact_chunks ac ON ac.artifact_observation_id = ao.id
          WHERE sa.session_id = $1::uuid
        )
        SELECT
          cc.id::text AS claim_id,
          cc.normalized_text,
          cc.claim_type,
          cc.confidence,
          cc.status,
          cc.ambiguity_state,
          cc.ambiguity_type,
          cc.ambiguity_reason,
          cc.source_chunk_id::text AS source_ref,
          cc.metadata
        FROM claim_candidates cc
        WHERE cc.source_chunk_id IN (SELECT id FROM session_chunks)
        ORDER BY cc.created_at DESC, cc.confidence DESC NULLS LAST
        LIMIT 96
      `,
      [session.id]
    )
  ]);

  const claims = claimRows.map((row) => ({
    claimId: row.claim_id,
    normalizedText: row.normalized_text,
    claimType: row.claim_type,
    confidence: row.confidence ?? undefined,
    status: row.status,
    ambiguityState: row.ambiguity_state,
    ambiguityType: row.ambiguity_type ?? undefined,
    ambiguityReason: row.ambiguity_reason ?? undefined,
    sourceRef: row.source_ref ?? undefined,
    metadata: row.metadata ?? {}
  }));

  const unresolvedItems = claimRows
    .filter((row) => row.ambiguity_state === "requires_clarification" || row.ambiguity_type !== null)
    .map((row) => ({
      claimId: row.claim_id,
      title: row.ambiguity_type?.replace(/_/g, " ") ?? "Needs operator confirmation",
      description: row.ambiguity_reason ?? "The system marked this claim as needing review.",
      ambiguityType: row.ambiguity_type ?? undefined,
      confidence: row.confidence ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      suggestions: asStringArray(row.metadata?.suggestions)
    }));

  return {
    session,
    sources,
    entities: entityRows.map((row) => ({
      entityId: row.entity_id,
      displayLabel: row.display_label,
      entityType: row.entity_type,
      evidenceCount: Number(row.evidence_count),
      confidence: row.confidence ?? undefined,
      aliases: row.aliases ?? []
    })),
    relationships: relationshipRows.map((row) => ({
      relationshipId: row.relationship_id,
      subject: row.subject_label,
      predicate: row.predicate,
      object: row.object_label,
      confidence: row.confidence ?? undefined,
      status: row.status,
      evidenceCount: Number(row.evidence_count),
      sourceRef: row.source_ref ?? undefined,
      metadata: row.metadata ?? {}
    })),
    claims,
    unresolvedItems,
    summary: {
      entityCount: entityRows.length,
      relationshipCount: relationshipRows.length,
      claimCount: claims.length,
      unresolvedCount: unresolvedItems.length
    }
  };
}
