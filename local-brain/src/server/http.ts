import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ignoreClarification, keepIdentityConflictSeparate, mergeEntityAlias, processBrainOutboxEvents, resolveClarification, resolveIdentityConflict } from "../clarifications/service.js";
import { classifyDerivationTextToCandidates, classifyTextToCandidates } from "../classification/service.js";
import { readConfig } from "../config.js";
import { queryRows } from "../db/client.js";
import { attachTextDerivation, deriveArtifactViaProvider } from "../derivations/service.js";
import { getNamespaceSelfProfile, upsertNamespaceSelfProfile } from "../identity/service.js";
import { ingestArtifact } from "../ingest/worker.js";
import { enqueueDerivationJob } from "../jobs/derivation-queue.js";
import { enqueueVectorSyncBackfill } from "../jobs/vector-sync.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runSemanticTemporalSummaryOverlay, runTemporalSummaryScaffold, type TemporalLayer } from "../jobs/temporal-summary.js";
import { ProducerRequestError, ingestDiscordRelayRequest, ingestSlackEventsRequest } from "../producers/live.js";
import { ingestWebhookPayload } from "../producers/webhook.js";
import { getArtifactDetail, getRelationships, searchMemory, timelineMemory } from "../retrieval/service.js";
import { isActiveRelationshipQuery, preferredRelationshipPredicates } from "../retrieval/query-signals.js";
import { getOpsAmbiguityWorkbench, getOpsClarificationInbox, getOpsIdentityConflictHistory, getOpsNamespaceCatalog, getOpsOverview, getOpsRelationshipGraph, getOpsTimelineView } from "../ops/service.js";
import { resolveEmbeddingRuntimeSelection } from "../providers/embedding-config.js";
import { getProviderAdapter } from "../providers/registry.js";
import { createSession, getSessionDetail, getSessionReview, ingestSessionFile, ingestSessionText, listSessions, updateSession } from "../ops/session-service.js";
import {
  createMonitoredSource,
  deleteMonitoredSource,
  getBootstrapState,
  getMonitoredSourcePreview,
  importMonitoredSource,
  listMonitoredSourceFiles,
  listMonitoredSources,
  processScheduledMonitoredSources,
  scanMonitoredSource,
  updateBootstrapState,
  updateMonitoredSource
} from "../ops/source-service.js";
import type { SourceType } from "../types.js";

type SearchResponse = Awaited<ReturnType<typeof searchMemory>>;

interface JsonResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function readTextBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, payload: JsonResponse): void {
  response.writeHead(payload.statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(payload.body, null, 2)}\n`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid ${name}.`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeProvider(value: unknown): "external" | "openrouter" | "gemini" | undefined {
  return value === "external" || value === "openrouter" || value === "gemini" ? value : undefined;
}

function normalizeEmbeddingProvider(value: unknown): "none" | "external" | "openrouter" | "gemini" | undefined {
  return value === "none" || value === "external" || value === "openrouter" || value === "gemini" ? value : undefined;
}

function headerMap(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      result[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value[0]) {
      result[key.toLowerCase()] = value[0];
    }
  }

  return result;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Missing or invalid ${name}.`);
  }

  return value as Record<string, unknown>;
}

function occurredAtValue(result: SearchResponse["results"][number]): number {
  const value = result.occurredAt ? Date.parse(result.occurredAt) : 0;
  return Number.isFinite(value) ? value : 0;
}

function lexicalRawScoreValue(result: SearchResponse["results"][number]): number {
  const retrieval = typeof result.provenance?.retrieval === "object" && result.provenance?.retrieval
    ? (result.provenance.retrieval as Record<string, unknown>)
    : null;
  const value = typeof retrieval?.lexicalRawScore === "number" ? retrieval.lexicalRawScore : 0;
  return Number.isFinite(value) ? value : 0;
}

function memoryTypePriorityForMergedResult(memoryType: string, activeRelationshipFocus: boolean): number {
  if (activeRelationshipFocus) {
    switch (memoryType) {
      case "procedural_memory":
        return 0;
      case "relationship_memory":
        return 1;
      case "relationship_candidate":
        return 2;
      case "semantic_memory":
        return 3;
      case "episodic_memory":
        return 4;
      case "artifact_derivation":
        return 5;
      case "memory_candidate":
        return 6;
      case "temporal_nodes":
        return 7;
      default:
        return 8;
    }
  }

  switch (memoryType) {
    case "procedural_memory":
      return 0;
    case "relationship_memory":
      return 1;
    case "relationship_candidate":
      return 2;
    case "semantic_memory":
      return 3;
    case "episodic_memory":
      return 4;
    case "artifact_derivation":
      return 5;
    case "memory_candidate":
      return 6;
    case "temporal_nodes":
      return 7;
    default:
      return 8;
  }
}

function resultPredicate(result: SearchResponse["results"][number]): string {
  return typeof result.provenance?.predicate === "string" ? result.provenance.predicate : "";
}

function mergeSearchResponses(responses: readonly SearchResponse[], limit: number, queryText?: string): SearchResponse {
  const planner = responses[0]?.meta.planner;
  const lexicalProvider = responses[0]?.meta.lexicalProvider ?? "bm25";
  const retrievalMode = responses[0]?.meta.retrievalMode ?? "lexical";
  const queryEmbeddingSource = responses[0]?.meta.queryEmbeddingSource ?? "none";
  const queryEmbeddingProvider = responses.find((response) => response.meta.queryEmbeddingProvider)?.meta.queryEmbeddingProvider;
  const queryEmbeddingModel = responses.find((response) => response.meta.queryEmbeddingModel)?.meta.queryEmbeddingModel;
  const vectorFallbackReason = responses.find((response) => response.meta.vectorFallbackReason)?.meta.vectorFallbackReason;
  const lexicalFallbackReason = responses.find((response) => response.meta.lexicalFallbackReason)?.meta.lexicalFallbackReason;
  const activeRelationshipFocus = queryText ? isActiveRelationshipQuery(queryText) : false;
  const predicatePriority = new Map(
    (queryText ? preferredRelationshipPredicates(queryText) : []).map((predicate, index) => [predicate, index] as const)
  );

  const results = [...responses.flatMap((response) => response.results)]
    .sort((left, right) => {
      const leftScore = left.score ?? 0;
      const rightScore = right.score ?? 0;

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      const rightLexicalRaw = lexicalRawScoreValue(right);
      const leftLexicalRaw = lexicalRawScoreValue(left);
      if (rightLexicalRaw !== leftLexicalRaw) {
        return rightLexicalRaw - leftLexicalRaw;
      }

      const priorityDelta =
        memoryTypePriorityForMergedResult(left.memoryType, activeRelationshipFocus) -
        memoryTypePriorityForMergedResult(right.memoryType, activeRelationshipFocus);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      if (activeRelationshipFocus) {
        const leftPredicate = resultPredicate(left);
        const rightPredicate = resultPredicate(right);
        const leftPredicatePriority = predicatePriority.get(leftPredicate) ?? Number.MAX_SAFE_INTEGER;
        const rightPredicatePriority = predicatePriority.get(rightPredicate) ?? Number.MAX_SAFE_INTEGER;
        if (leftPredicatePriority !== rightPredicatePriority) {
          return leftPredicatePriority - rightPredicatePriority;
        }
      }

      return occurredAtValue(right) - occurredAtValue(left);
    })
    .slice(0, limit);

  const evidence = [...responses.flatMap((response) => response.evidence)]
    .filter((item, index, items) => {
      const key = `${item.memoryId}|${item.artifactId ?? "none"}|${item.sourceUri ?? "none"}`;
      return items.findIndex((candidate) => `${candidate.memoryId}|${candidate.artifactId ?? "none"}|${candidate.sourceUri ?? "none"}` === key) === index;
    })
    .slice(0, 12);

  const confidenceRank = (value: "confident" | "weak" | "missing"): number => {
    switch (value) {
      case "confident":
        return 2;
      case "weak":
        return 1;
      case "missing":
      default:
        return 0;
    }
  };

  const bestAssessment =
    responses
      .map((response) => response.meta.answerAssessment)
      .filter((assessment): assessment is NonNullable<SearchResponse["meta"]["answerAssessment"]> => Boolean(assessment))
      .sort((left, right) => {
        const confidenceDelta = confidenceRank(right.confidence) - confidenceRank(left.confidence);
        if (confidenceDelta !== 0) {
          return confidenceDelta;
        }
        if (right.directEvidence !== left.directEvidence) {
          return Number(right.directEvidence) - Number(left.directEvidence);
        }
        if (right.evidenceCount !== left.evidenceCount) {
          return right.evidenceCount - left.evidenceCount;
        }
        return right.lexicalCoverage - left.lexicalCoverage;
      })[0];

  const bestDuality =
    responses
      .map((response) => response.duality)
      .filter((duality): duality is NonNullable<SearchResponse["duality"]> => Boolean(duality))
      .sort((left, right) => {
        const confidenceDelta = confidenceRank(right.confidence) - confidenceRank(left.confidence);
        if (confidenceDelta !== 0) {
          return confidenceDelta;
        }
        return right.evidence.length - left.evidence.length;
      })[0];

  const bestProvenanceAnswer = responses.map((response) => response.meta.provenanceAnswer).find((item) => Boolean(item));
  const bestClarificationHint =
    responses
      .map((response) => response.meta.clarificationHint)
      .find((item) => Boolean(item));
  const bestFollowUpAction =
    bestDuality?.followUpAction ??
    responses
      .map((response) => response.meta.followUpAction)
      .find((item) => Boolean(item));

  return {
    results,
    evidence,
    duality: bestDuality,
    meta: {
      contractVersion: "duality_v2",
      retrievalMode,
      lexicalProvider,
      lexicalFallbackUsed: responses.some((response) => response.meta.lexicalFallbackUsed),
      lexicalFallbackReason,
      queryEmbeddingSource,
      queryEmbeddingProvider,
      queryEmbeddingModel,
      vectorFallbackReason,
      lexicalCandidateCount: responses.reduce((sum, response) => sum + response.meta.lexicalCandidateCount, 0),
      vectorCandidateCount: responses.reduce((sum, response) => sum + response.meta.vectorCandidateCount, 0),
      fusedResultCount: results.length,
      temporalAncestorCount: responses.reduce((sum, response) => sum + (response.meta.temporalAncestorCount ?? 0), 0),
      temporalDescendantSupportCount: responses.reduce((sum, response) => sum + (response.meta.temporalDescendantSupportCount ?? 0), 0),
      temporalGateTriggered: responses.some((response) => response.meta.temporalGateTriggered ?? false),
      temporalLayersUsed: responses.find((response) => (response.meta.temporalLayersUsed?.length ?? 0) > 0)?.meta.temporalLayersUsed ?? [],
      temporalSupportTokenCount: responses.reduce((sum, response) => sum + (response.meta.temporalSupportTokenCount ?? 0), 0),
      placeContainmentSupportCount: responses.reduce((sum, response) => sum + (response.meta.placeContainmentSupportCount ?? 0), 0),
      boundedEventSupportCount: responses.reduce((sum, response) => sum + (response.meta.boundedEventSupportCount ?? 0), 0),
      temporalSummarySufficient: responses.some((response) => response.meta.temporalSummarySufficient ?? false),
      answerAssessment: bestAssessment,
      followUpAction: bestFollowUpAction,
      clarificationHint: bestClarificationHint,
      provenanceAnswer: bestProvenanceAnswer,
      planner: planner ?? responses[0]?.meta.planner ?? {
        intent: "simple",
        temporalFocus: false,
        yearHints: [],
        lexicalTerms: [],
        targetLayers: [],
        descendantExpansionOrder: ["day"],
        maxTemporalDepth: 0,
        ancestorLayerBudgets: { session: 0, day: 0, week: 0, month: 0, year: 0, profile: 0 },
        descendantLayerBudgets: { session: 0, day: 0, week: 0, month: 0, year: 0, profile: 0 },
        supportMemberBudget: 0,
        temporalSufficiencyEpisodicThreshold: 0,
        temporalSufficiencyTemporalThreshold: 0,
        temporalSupportMaxTokens: 0,
        branchPreference: "lexical_first",
        candidateLimitMultiplier: 1,
        episodicWeight: 1,
        temporalSummaryWeight: 1
      }
    }
  };
}

async function loadActiveEmbeddingColumnDimensions(): Promise<readonly number[]> {
  const rows = await queryRows<{ formatted_type: string }>(
    `
      SELECT format_type(a.atttypid, a.atttypmod) AS formatted_type
      FROM pg_attribute a
      INNER JOIN pg_class c ON c.oid = a.attrelid
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('semantic_memory', 'artifact_derivations')
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped
    `
  );

  const dimensions = rows
    .map((row) => row.formatted_type.match(/^vector\((\d+)\)$/i)?.[1])
    .map((value) => (value ? Number(value) : undefined))
    .filter((value): value is number => value !== undefined && Number.isFinite(value));

  return [...new Set(dimensions)];
}

async function handleRequest(request: IncomingMessage): Promise<JsonResponse> {
  const url = new URL(request.url ?? "/", "http://local-brain");

  if (request.method === "GET" && url.pathname === "/health") {
    return {
      statusCode: 200,
      body: {
        ok: true
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/sessions") {
    const body = await readJsonBody(request);
    const session = await createSession({
      title: requireString(body.title, "title"),
      namespaceId: optionalString(body.namespace_id),
      notes: optionalString(body.notes),
      tags: Array.isArray(body.tags) ? body.tags.filter((value): value is string => typeof value === "string") : undefined,
      createdBy: optionalString(body.created_by),
      defaultAsrModel: optionalString(body.default_asr_model),
      defaultLlmProvider: normalizeProvider(body.default_llm_provider),
      defaultLlmModel: optionalString(body.default_llm_model),
      defaultLlmPreset: optionalString(body.default_llm_preset),
      defaultEmbeddingProvider: normalizeProvider(body.default_embedding_provider),
      defaultEmbeddingModel: optionalString(body.default_embedding_model),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : undefined
    });

    return {
      statusCode: 200,
      body: {
        session
      }
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/sessions") {
    const sessions = await listSessions(optionalNumber(url.searchParams.get("limit")) ?? 40);

    return {
      statusCode: 200,
      body: {
        sessions
      }
    };
  }

  const sessionDetailMatch = url.pathname.match(/^\/ops\/sessions\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && sessionDetailMatch) {
    const session = await getSessionDetail(sessionDetailMatch[1]!);

    return {
      statusCode: 200,
      body: {
        session
      }
    };
  }

  if (request.method === "PATCH" && sessionDetailMatch) {
    const body = await readJsonBody(request);
    const session = await updateSession(sessionDetailMatch[1]!, {
      title: optionalString(body.title),
      notes: body.notes === null ? "" : optionalString(body.notes),
      tags: Array.isArray(body.tags) ? body.tags.filter((value): value is string => typeof value === "string") : undefined,
      status: optionalString(body.status) as
        | "draft"
        | "intake_in_progress"
        | "awaiting_review"
        | "clarifications_open"
        | "reprocessing"
        | "completed"
        | "failed"
        | "archived"
        | undefined,
      defaultAsrModel: body.default_asr_model === undefined ? undefined : optionalString(body.default_asr_model) ?? null,
      defaultLlmProvider: body.default_llm_provider === undefined ? undefined : normalizeProvider(body.default_llm_provider) ?? null,
      defaultLlmModel: body.default_llm_model === undefined ? undefined : optionalString(body.default_llm_model) ?? null,
      defaultLlmPreset: body.default_llm_preset === undefined ? undefined : optionalString(body.default_llm_preset) ?? null,
      defaultEmbeddingProvider:
        body.default_embedding_provider === undefined ? undefined : normalizeProvider(body.default_embedding_provider) ?? null,
      defaultEmbeddingModel:
        body.default_embedding_model === undefined ? undefined : optionalString(body.default_embedding_model) ?? null,
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : undefined
    });

    return {
      statusCode: 200,
      body: {
        session
      }
    };
  }

  const sessionTextIntakeMatch = url.pathname.match(/^\/ops\/sessions\/([0-9a-f-]+)\/intake\/text$/i);
  if (request.method === "POST" && sessionTextIntakeMatch) {
    const body = await readJsonBody(request);
    const result = await ingestSessionText({
      sessionId: sessionTextIntakeMatch[1]!,
      label: optionalString(body.label),
      text: requireString(body.text, "text"),
      runClassification: Boolean(body.run_classification),
      classification:
        body.classification && typeof body.classification === "object"
          ? {
              provider: normalizeProvider((body.classification as Record<string, unknown>).provider),
              model: optionalString((body.classification as Record<string, unknown>).model),
              presetId: optionalString((body.classification as Record<string, unknown>).preset_id),
              maxOutputTokens: optionalNumber((body.classification as Record<string, unknown>).max_output_tokens)
            }
          : undefined,
      actorId: optionalString(body.actor_id)
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  const sessionFileIntakeMatch = url.pathname.match(/^\/ops\/sessions\/([0-9a-f-]+)\/intake\/file$/i);
  if (request.method === "POST" && sessionFileIntakeMatch) {
    const body = await readJsonBody(request);
    const result = await ingestSessionFile({
      sessionId: sessionFileIntakeMatch[1]!,
      inputUri: requireString(body.input_uri, "input_uri"),
      sourceType: requireString(body.source_type, "source_type") as SourceType,
      label: optionalString(body.label),
      fileName: optionalString(body.file_name),
      mimeType: optionalString(body.mime_type),
      byteSize: optionalNumber(body.byte_size),
      runAsr: Boolean(body.run_asr),
      runClassification: Boolean(body.run_classification),
      asr:
        body.asr && typeof body.asr === "object"
          ? {
              modelId: optionalString((body.asr as Record<string, unknown>).model_id)
            }
          : undefined,
      classification:
        body.classification && typeof body.classification === "object"
          ? {
              provider: normalizeProvider((body.classification as Record<string, unknown>).provider),
              model: optionalString((body.classification as Record<string, unknown>).model),
              presetId: optionalString((body.classification as Record<string, unknown>).preset_id),
              maxOutputTokens: optionalNumber((body.classification as Record<string, unknown>).max_output_tokens)
            }
          : undefined,
      actorId: optionalString(body.actor_id)
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  const sessionReviewMatch = url.pathname.match(/^\/ops\/sessions\/([0-9a-f-]+)\/review$/i);
  if (request.method === "GET" && sessionReviewMatch) {
    const review = await getSessionReview(sessionReviewMatch[1]!);

    return {
      statusCode: 200,
      body: {
        review
      }
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/overview") {
    const result = await getOpsOverview();

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/namespaces") {
    const result = await getOpsNamespaceCatalog(optionalNumber(url.searchParams.get("limit")) ?? 16);

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/timeline") {
    const result = await getOpsTimelineView(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      requireString(url.searchParams.get("time_start"), "time_start"),
      requireString(url.searchParams.get("time_end"), "time_end"),
      optionalNumber(url.searchParams.get("limit")) ?? 40
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/graph") {
    const result = await getOpsRelationshipGraph(requireString(url.searchParams.get("namespace_id"), "namespace_id"), {
      entityName: optionalString(url.searchParams.get("entity_name")),
      timeStart: optionalString(url.searchParams.get("time_start")),
      timeEnd: optionalString(url.searchParams.get("time_end")),
      limit: optionalNumber(url.searchParams.get("limit")) ?? 36
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/inbox") {
    const result = await getOpsClarificationInbox(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      optionalNumber(url.searchParams.get("limit")) ?? 40
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/ambiguities") {
    const result = await getOpsAmbiguityWorkbench(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      optionalNumber(url.searchParams.get("limit")) ?? 40
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/clarifications") {
    const result = await getOpsAmbiguityWorkbench(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      optionalNumber(url.searchParams.get("limit")) ?? 40
    );

    return {
      statusCode: 200,
      body: {
        ...result,
        available_actions: {
          inbox_resolve: "/ops/inbox/resolve",
          inbox_ignore: "/ops/inbox/ignore",
          entity_merge: "/ops/entities/merge",
          identity_resolve: "/ops/identity-conflicts/resolve",
          keep_separate: "/ops/identity-conflicts/keep-separate"
        }
      }
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/identity-conflicts/history") {
    const result = await getOpsIdentityConflictHistory(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      optionalNumber(url.searchParams.get("limit")) ?? 20
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/profile/self") {
    const result = await getNamespaceSelfProfile(requireString(url.searchParams.get("namespace_id"), "namespace_id"));

    return {
      statusCode: result ? 200 : 404,
      body: result ?? { error: "Self profile not found." }
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/bootstrap-state") {
    return {
      statusCode: 200,
      body: {
        bootstrap: await getBootstrapState()
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/embeddings/test") {
    const body = await readJsonBody(request);
    const selection = resolveEmbeddingRuntimeSelection({
      provider: normalizeEmbeddingProvider(body.provider),
      model: optionalString(body.model) ?? null,
      outputDimensionality: optionalNumber(body.dimensions) ?? null,
      normalize: optionalBoolean(body.normalize) ?? null,
      instruction: optionalString(body.instruction) ?? null
    });

    if (!selection.enabled) {
      return {
        statusCode: 200,
        body: {
          ok: true,
          success: true,
          retrievalMode: "lexical",
          provider: "none",
          model: null,
          dimensions: null,
          latencyMs: 0,
          fallbackReason: "provider:none"
        }
      };
    }

    const adapter = getProviderAdapter(selection.provider);
    const started = Date.now();
    const result = await adapter.embedText({
      text: optionalString(body.text) ?? "Embedding smoke test for AI Brain 2.0",
      model: selection.model,
      outputDimensionality: selection.outputDimensionality,
      metadata: {
        normalize: selection.normalize,
        instruction: selection.instruction
      }
    });

    return {
      statusCode: 200,
      body: {
        ok: true,
        success: true,
        retrievalMode: "hybrid",
        provider: result.provider,
        model: result.model,
        dimensions: result.dimensions,
        latencyMs: result.latencyMs ?? Date.now() - started,
        normalized: result.normalized,
        tokenUsage: result.tokenUsage,
        providerMetadata: result.providerMetadata
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/embeddings/rebuild") {
    const body = await readJsonBody(request);
    const selection = resolveEmbeddingRuntimeSelection({
      provider: normalizeEmbeddingProvider(body.provider),
      model: optionalString(body.model) ?? null,
      outputDimensionality: optionalNumber(body.dimensions) ?? null,
      normalize: optionalBoolean(body.normalize) ?? null,
      instruction: optionalString(body.instruction) ?? null
    });

    if (!selection.enabled || !selection.model) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: "Embeddings are disabled. Choose an embedding provider before rebuilding vectors."
        }
      };
    }

    const activeDimensions = await loadActiveEmbeddingColumnDimensions();
    if (
      selection.outputDimensionality &&
      activeDimensions.length > 0 &&
      !activeDimensions.includes(selection.outputDimensionality)
    ) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: `Embedding dimensions ${selection.outputDimensionality} do not match active pgvector columns (${activeDimensions.join(", ")}).`
        }
      };
    }

    const summary = await enqueueVectorSyncBackfill({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      provider: selection.provider,
      model: selection.model,
      outputDimensionality: selection.outputDimensionality
    });

    return {
      statusCode: 200,
      body: {
        ok: true,
        rebuild: summary
      }
    };
  }

  if (request.method === "PATCH" && url.pathname === "/ops/bootstrap-state") {
    const body = await readJsonBody(request);
    const bootstrap = await updateBootstrapState({
      ownerProfileCompleted: optionalBoolean(body.owner_profile_completed),
      sourceImportCompleted: optionalBoolean(body.source_import_completed),
      verificationCompleted: optionalBoolean(body.verification_completed),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : undefined
    });

    return {
      statusCode: 200,
      body: {
        bootstrap
      }
    };
  }

  if (request.method === "GET" && url.pathname === "/ops/sources") {
    return {
      statusCode: 200,
      body: {
        sources: await listMonitoredSources(optionalNumber(url.searchParams.get("limit")) ?? 100)
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/sources") {
    const body = await readJsonBody(request);
    const source = await createMonitoredSource({
      sourceType: requireString(body.source_type, "source_type") as "openclaw" | "folder",
      namespaceId: optionalString(body.namespace_id),
      label: optionalString(body.label),
      rootPath: requireString(body.root_path, "root_path"),
      includeSubfolders: optionalBoolean(body.include_subfolders),
      monitorEnabled: optionalBoolean(body.monitor_enabled),
      scanSchedule: optionalString(body.scan_schedule),
      notes: optionalString(body.notes),
      createdBy: optionalString(body.created_by),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : undefined
    });

    return {
      statusCode: 200,
      body: {
        source
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/sources/process") {
    const body = await readJsonBody(request);
    const monitorRun = await processScheduledMonitoredSources({
      sourceId: optionalString(body.source_id),
      limit: optionalNumber(body.limit),
      importAfterScan: body.scan_only === true ? false : true
    });

    return {
      statusCode: 200,
      body: {
        ok: true,
        monitorRun
      }
    };
  }

  const sourceDetailMatch = url.pathname.match(/^\/ops\/sources\/([0-9a-f-]+)$/i);
  if (request.method === "PATCH" && sourceDetailMatch) {
    const body = await readJsonBody(request);
    const source = await updateMonitoredSource(sourceDetailMatch[1]!, {
      namespaceId: optionalString(body.namespace_id),
      label: optionalString(body.label),
      rootPath: body.root_path === undefined ? undefined : requireString(body.root_path, "root_path"),
      includeSubfolders: optionalBoolean(body.include_subfolders),
      monitorEnabled: optionalBoolean(body.monitor_enabled),
      scanSchedule: optionalString(body.scan_schedule),
      status: optionalString(body.status) as "ready" | "disabled" | "error" | undefined,
      notes: body.notes === null ? null : optionalString(body.notes),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : undefined
    });

    return {
      statusCode: 200,
      body: {
        source
      }
    };
  }

  if (request.method === "DELETE" && sourceDetailMatch) {
    await deleteMonitoredSource(sourceDetailMatch[1]!);
    return {
      statusCode: 200,
      body: {
        ok: true
      }
    };
  }

  const sourceScanMatch = url.pathname.match(/^\/ops\/sources\/([0-9a-f-]+)\/scan$/i);
  if (request.method === "POST" && sourceScanMatch) {
    return {
      statusCode: 200,
      body: {
        preview: await scanMonitoredSource(sourceScanMatch[1]!)
      }
    };
  }

  const sourcePreviewMatch = url.pathname.match(/^\/ops\/sources\/([0-9a-f-]+)\/preview$/i);
  if (request.method === "GET" && sourcePreviewMatch) {
    return {
      statusCode: 200,
      body: {
        preview: await getMonitoredSourcePreview(sourcePreviewMatch[1]!)
      }
    };
  }

  const sourceFilesMatch = url.pathname.match(/^\/ops\/sources\/([0-9a-f-]+)\/files$/i);
  if (request.method === "GET" && sourceFilesMatch) {
    return {
      statusCode: 200,
      body: {
        files: await listMonitoredSourceFiles(sourceFilesMatch[1]!, optionalNumber(url.searchParams.get("limit")) ?? 200)
      }
    };
  }

  const sourceImportMatch = url.pathname.match(/^\/ops\/sources\/([0-9a-f-]+)\/import$/i);
  if (request.method === "POST" && sourceImportMatch) {
    const body = await readJsonBody(request);
    const result = await importMonitoredSource(
      sourceImportMatch[1]!,
      (optionalString(body.trigger_type) as "manual" | "scheduled" | "onboarding" | undefined) ?? "manual"
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/search") {
    const requestedNamespaceId = optionalString(url.searchParams.get("namespace_id"));
    const namespaceCatalog = !requestedNamespaceId ? await getOpsNamespaceCatalog(16) : null;
    const fallbackNamespaceIds = !requestedNamespaceId
      ? (namespaceCatalog?.namespaces ?? [])
          .filter((item) => item.category === "durable")
          .map((item) => item.namespaceId)
      : [];
    const initialNamespaceId = requestedNamespaceId ?? namespaceCatalog?.defaultNamespaceId;
    if (!initialNamespaceId) {
      throw new Error("Missing or invalid namespace_id.");
    }
    const query = requireString(url.searchParams.get("query"), "query");
    const timeStart = optionalString(url.searchParams.get("time_start"));
    const timeEnd = optionalString(url.searchParams.get("time_end"));
    const limit = optionalNumber(url.searchParams.get("limit"));
    const provider = optionalString(url.searchParams.get("provider"));
    const model = optionalString(url.searchParams.get("model"));
    const outputDimensionality = optionalNumber(url.searchParams.get("dimensions"));
    const effectiveLimit = limit ?? 8;

    let resolvedNamespaceId = initialNamespaceId;
    let searchedNamespaceIds = [resolvedNamespaceId];
    let result: SearchResponse;

    if (!requestedNamespaceId) {
      const namespaceIds = [...new Set([initialNamespaceId, ...fallbackNamespaceIds])];
      const responses: SearchResponse[] = [];
      for (const namespaceId of namespaceIds) {
        const response = await searchMemory({
          namespaceId,
          query,
          timeStart,
          timeEnd,
          limit: effectiveLimit,
          provider,
          model,
          outputDimensionality
        });
        responses.push(response);
      }

      result = mergeSearchResponses(responses, effectiveLimit, query);
      searchedNamespaceIds = namespaceIds;
      const firstHitNamespace = result.results[0]?.namespaceId;
      resolvedNamespaceId = firstHitNamespace ?? initialNamespaceId;
    } else {
      result = await searchMemory({
        namespaceId: resolvedNamespaceId,
        query,
        timeStart,
        timeEnd,
        limit,
        provider,
        model,
        outputDimensionality
      });
    }

    return {
      statusCode: 200,
      body: {
        ...result,
        meta: {
          ...result.meta,
          requestedNamespaceId: requestedNamespaceId ?? null,
          resolvedNamespaceId,
          namespaceDefaulted: !requestedNamespaceId,
          namespaceEscalated: !requestedNamespaceId && resolvedNamespaceId !== initialNamespaceId,
          searchedNamespaceIds
        }
      }
    };
  }

  if (request.method === "GET" && url.pathname === "/timeline") {
    const result = await timelineMemory({
      namespaceId: requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      timeStart: requireString(url.searchParams.get("time_start"), "time_start"),
      timeEnd: requireString(url.searchParams.get("time_end"), "time_end"),
      limit: optionalNumber(url.searchParams.get("limit"))
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/relationships") {
    const result = await getRelationships({
      namespaceId: requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      entityName: requireString(url.searchParams.get("entity_name"), "entity_name"),
      predicate: optionalString(url.searchParams.get("predicate")),
      timeStart: optionalString(url.searchParams.get("time_start")),
      timeEnd: optionalString(url.searchParams.get("time_end")),
      limit: optionalNumber(url.searchParams.get("limit"))
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
    const artifactId = url.pathname.replace("/artifacts/", "");
    const result = await getArtifactDetail({
      artifactId
    });

    return {
      statusCode: result ? 200 : 404,
      body: result ?? {
        error: "Artifact not found."
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ingest") {
    const body = await readJsonBody(request);
    const result = await ingestArtifact({
      inputUri: requireString(body.input_uri, "input_uri"),
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      sourceType: requireString(body.source_type, "source_type") as never,
      sourceChannel: optionalString(body.source_channel),
      capturedAt: optionalString(body.captured_at) ?? new Date().toISOString(),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: {
        artifact: result.artifact,
        fragments: result.fragments.length,
        candidateWrites: result.candidateWrites.length,
        episodicInsertCount: result.episodicInsertCount
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/consolidate") {
    const body = await readJsonBody(request);
    const result = await runCandidateConsolidation(
      requireString(body.namespace_id, "namespace_id"),
      optionalNumber(body.limit) ?? 50
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/outbox/process") {
    const body = await readJsonBody(request);
    const outbox = await processBrainOutboxEvents({
      namespaceId: optionalString(body.namespace_id),
      limit: optionalNumber(body.limit) ?? 25
    });

    return {
      statusCode: 200,
      body: {
        ok: true,
        outbox
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/temporal/process") {
    const body = await readJsonBody(request);
    const namespaceId = requireString(body.namespace_id, "namespace_id");
    const lookbackDays = optionalNumber(body.lookback_days) ?? 30;
    const strategy = optionalString(body.strategy) as "deterministic" | "deterministic_plus_llm" | undefined;
    const provider = optionalString(body.provider) as "external" | "openrouter" | "gemini" | undefined;
    const model = optionalString(body.model);
    const presetId = optionalString(body.preset_id);
    const systemPrompt = optionalString(body.system_prompt);
    const layers = Array.isArray(body.layers)
      ? body.layers.filter((value): value is TemporalLayer => value === "day" || value === "week" || value === "month" || value === "year")
      : (["day", "week", "month", "year"] as const);
    const summaries = [];
    for (const layer of layers) {
      const summary = await runTemporalSummaryScaffold(namespaceId, {
        layer,
        lookbackDays
      });
      if (strategy === "deterministic_plus_llm" && provider) {
        await runSemanticTemporalSummaryOverlay(namespaceId, {
          layer,
          lookbackDays,
          provider,
          model: model ?? undefined,
          presetId: presetId ?? undefined,
          systemPrompt: systemPrompt ?? undefined
        });
      }
      summaries.push(summary);
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        summaries
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/inbox/resolve") {
    const body = await readJsonBody(request);
    const result = await resolveClarification({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      candidateId: requireString(body.candidate_id, "candidate_id"),
      canonicalName: requireString(body.canonical_name, "canonical_name"),
      entityType: requireString(body.entity_type, "entity_type"),
      targetRole: optionalString(body.target_role) as "subject" | "object" | undefined,
      aliases: Array.isArray(body.aliases) ? body.aliases.filter((value): value is string => typeof value === "string") : undefined,
      note: optionalString(body.note)
    });
    const outbox = await processBrainOutboxEvents({
      namespaceId: result.namespaceId,
      limit: 25
    });

    return {
      statusCode: 200,
      body: {
        ...result,
        outbox
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/inbox/ignore") {
    const body = await readJsonBody(request);
    const result = await ignoreClarification({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      candidateId: requireString(body.candidate_id, "candidate_id"),
      note: optionalString(body.note)
    });
    const outbox = await processBrainOutboxEvents({
      namespaceId: result.namespaceId,
      limit: 25
    });

    return {
      statusCode: 200,
      body: {
        ...result,
        outbox
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/entities/merge") {
    const body = await readJsonBody(request);
    const result = await mergeEntityAlias({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      sourceEntityId: optionalString(body.source_entity_id),
      sourceName: optionalString(body.source_name),
      canonicalName: requireString(body.canonical_name, "canonical_name"),
      entityType: requireString(body.entity_type, "entity_type"),
      targetEntityId: optionalString(body.target_entity_id),
      aliases: Array.isArray(body.aliases) ? body.aliases.filter((value): value is string => typeof value === "string") : undefined,
      preserveAliases: body.preserve_aliases === undefined ? true : Boolean(body.preserve_aliases),
      note: optionalString(body.note)
    });
    const outbox = await processBrainOutboxEvents({
      namespaceId: result.namespaceId,
      limit: 25
    });

    return {
      statusCode: 200,
      body: {
        ...result,
        outbox
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/identity-conflicts/resolve") {
    const body = await readJsonBody(request);
    const aliases = Array.isArray(body.aliases) ? body.aliases.filter((value): value is string => typeof value === "string") : undefined;
    const result = await resolveIdentityConflict({
      sourceEntityId: requireString(body.source_entity_id, "source_entity_id"),
      targetEntityId: requireString(body.target_entity_id, "target_entity_id"),
      canonicalName: requireString(body.canonical_name, "canonical_name"),
      entityType: requireString(body.entity_type, "entity_type"),
      aliases,
      preserveAliases: body.preserve_aliases === undefined ? true : Boolean(body.preserve_aliases),
      note: optionalString(body.note)
    });

    const touched = new Set<string>(result.touchedNamespaces);
    const outboxResults = [];
    for (const namespaceId of touched) {
      outboxResults.push(
        await processBrainOutboxEvents({
          namespaceId,
          limit: 25
        })
      );
    }

    return {
      statusCode: 200,
      body: {
        ...result,
        outbox: outboxResults
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/identity-conflicts/keep-separate") {
    const body = await readJsonBody(request);
    const result = await keepIdentityConflictSeparate({
      leftEntityId: requireString(body.left_entity_id, "left_entity_id"),
      rightEntityId: requireString(body.right_entity_id, "right_entity_id"),
      note: optionalString(body.note)
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/ops/profile/self") {
    const body = await readJsonBody(request);
    const result = await upsertNamespaceSelfProfile({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      canonicalName: requireString(body.canonical_name, "canonical_name"),
      aliases: Array.isArray(body.aliases) ? body.aliases.filter((value): value is string => typeof value === "string") : undefined,
      note: optionalString(body.note)
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/producer/webhook") {
    const body = await readJsonBody(request);
    const providerRaw = optionalString(body.provider) ?? "generic";

    if (providerRaw !== "generic" && providerRaw !== "slack" && providerRaw !== "discord") {
      throw new Error("provider must be one of generic|slack|discord.");
    }

    const result = await ingestWebhookPayload({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      provider: providerRaw,
      payload: requireObject(body.payload, "payload"),
      sourceChannel: optionalString(body.source_channel),
      capturedAt: optionalString(body.captured_at)
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/producer/slack/events") {
    const rawBody = await readTextBody(request);
    const result = await ingestSlackEventsRequest(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      rawBody,
      headerMap(request),
      optionalString(url.searchParams.get("source_channel")) ?? "slack:events"
    );

    return {
      statusCode: 200,
      body: result.challenge ? { challenge: result.challenge } : result
    };
  }

  if (request.method === "POST" && url.pathname === "/producer/discord/events") {
    const rawBody = await readTextBody(request);
    const result = await ingestDiscordRelayRequest(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      rawBody,
      headerMap(request),
      optionalString(url.searchParams.get("source_channel")) ?? "discord:relay"
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/derive/text") {
    const body = await readJsonBody(request);
    const result = await attachTextDerivation({
      artifactId: requireString(body.artifact_id, "artifact_id"),
      artifactObservationId: optionalString(body.artifact_observation_id),
      sourceChunkId: optionalString(body.source_chunk_id),
      derivationType: optionalString(body.derivation_type) ?? "text_proxy",
      text: requireString(body.text, "text"),
      provider: optionalString(body.provider),
      model: optionalString(body.model),
      outputDimensionality: optionalNumber(body.output_dimensionality),
      embed: Boolean(body.embed),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/classify/text") {
    const body = await readJsonBody(request);
    const result = await classifyTextToCandidates({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      text: requireString(body.text, "text"),
      provider: normalizeProvider(body.provider) ?? normalizeProvider(body.provider_id),
      model: optionalString(body.model) ?? optionalString(body.model_id),
      presetId: optionalString(body.preset_id) ?? optionalString(body.presetId),
      maxOutputTokens: optionalNumber(body.max_output_tokens),
      artifactId: optionalString(body.artifact_id),
      artifactObservationId: optionalString(body.artifact_observation_id),
      sourceChunkId: optionalString(body.source_chunk_id),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/classify/derivation") {
    const body = await readJsonBody(request);
    const result = await classifyDerivationTextToCandidates({
      derivationId: requireString(body.derivation_id, "derivation_id"),
      provider: normalizeProvider(body.provider) ?? normalizeProvider(body.provider_id),
      model: optionalString(body.model) ?? optionalString(body.model_id),
      presetId: optionalString(body.preset_id) ?? optionalString(body.presetId),
      maxOutputTokens: optionalNumber(body.max_output_tokens),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/derive/provider") {
    const body = await readJsonBody(request);
    const result = await deriveArtifactViaProvider({
      artifactId: requireString(body.artifact_id, "artifact_id"),
      artifactObservationId: optionalString(body.artifact_observation_id),
      provider: normalizeProvider(body.provider) ?? normalizeProvider(body.provider_id) ?? "external",
      model: optionalString(body.model) ?? optionalString(body.model_id),
      derivationType: optionalString(body.derivation_type),
      modality: optionalString(body.modality) as never,
      maxOutputTokens: optionalNumber(body.max_output_tokens),
      outputDimensionality: optionalNumber(body.output_dimensionality),
      embed: Boolean(body.embed),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/derive/queue") {
    const body = await readJsonBody(request);
    const result = await enqueueDerivationJob({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      artifactId: requireString(body.artifact_id, "artifact_id"),
      artifactObservationId: optionalString(body.artifact_observation_id),
      sourceChunkId: optionalString(body.source_chunk_id),
      jobKind: optionalString(body.job_kind) as never,
      modality: optionalString(body.modality) as never,
      provider: optionalString(body.provider),
      model: optionalString(body.model),
      outputDimensionality: optionalNumber(body.output_dimensionality),
      maxOutputTokens: optionalNumber(body.max_output_tokens),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  return {
    statusCode: 404,
    body: {
      error: "Not found."
    }
  };
}

export function startHttpServer(): void {
  const config = readConfig();
  const server = createServer(async (request, response) => {
    try {
      const payload = await handleRequest(request);
      writeJson(response, payload);
    } catch (error) {
      const statusCode = error instanceof ProducerRequestError ? error.statusCode : 400;
      writeJson(response, {
        statusCode,
        body: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });

  server.listen(config.httpPort, config.httpHost, () => {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          host: config.httpHost,
          port: config.httpPort
        },
        null,
        2
      )}\n`
    );
  });
}
