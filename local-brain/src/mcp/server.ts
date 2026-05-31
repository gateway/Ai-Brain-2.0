import { stdin, stdout } from "node:process";
import { performance } from "node:perf_hooks";
import { queryRows, withTransaction } from "../db/client.js";
import { keepIdentityConflictSeparate, mergeEntityAlias, mergeEntityRoleCorrection, processBrainOutboxEvents } from "../clarifications/service.js";
import { loadEntityRoleConflictProjection, rebuildEntityRoleConflictProjection } from "../identity/entity-role-resolution.js";
import { getOpsClarificationInbox, getOpsOverview, getOpsRelationshipGraph } from "../ops/service.js";
import { getBootstrapState, listMonitoredSources } from "../ops/source-service.js";
import { getRuntimeWorkerStatus } from "../ops/runtime-worker-service.js";
import {
  applySourcePrivacyOverlay,
  evaluateSourcePrivacyEnforcement,
  getSourcePrivacyStatus,
  revertSourcePrivacyOverlay,
  type SourcePrivacyActionType
} from "../privacy/source-privacy.js";
import {
  explainRecap,
  extractCalendarMemory,
  extractTaskMemory,
  getArtifactDetail,
  getRelationships,
  recapMemory,
  searchMemory,
  timelineMemory
} from "../retrieval/service.js";
import { attachStableQueryContractEnvelope } from "./query-contract-envelope.js";
import { presentHumanReadableQueryResult } from "./query-presenter.js";
import { toolDescriptors } from "./tool-contracts.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorBody;
}

interface ToolCallArgs {
  [key: string]: unknown;
}

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface McpResultPayload {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: unknown;
}

interface SessionClaimRegistryEntry {
  readonly id: string;
  readonly query: string;
  readonly claimText: string;
  readonly claimFamily: string;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrail: readonly Record<string, unknown>[];
  readonly sourceQuotes: readonly string[];
  readonly answerSectionId?: string | null;
  readonly recordedAt: string;
}

const sessionClaimRegistry = new Map<string, SessionClaimRegistryEntry[]>();

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid ${name}.`);
  }

  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalSessionId(args: ToolCallArgs): string | undefined {
  return optionalString(args.session_id) ?? optionalString(args.conversation_id);
}

function optionalDetailMode(value: unknown): "compact" | "full" | undefined {
  return value === "compact" || value === "full" ? value : undefined;
}

function optionalFocusMode(value: unknown): "timeline" | "employers_only" | "advisory_only" | "ventures_only" | "roles_and_dates" | "source_audit" | undefined {
  return value === "timeline" ||
    value === "employers_only" ||
    value === "advisory_only" ||
    value === "ventures_only" ||
    value === "roles_and_dates" ||
    value === "source_audit"
    ? value
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return normalized.length > 0 ? normalized : undefined;
}

function requireSourcePrivacyActionType(value: unknown): SourcePrivacyActionType {
  if (value === "logical_delete" || value === "redact" || value === "access_label" || value === "retention_policy") {
    return value;
  }
  throw new Error("Missing or invalid action_type.");
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function applySourcePrivacyGuard(input: {
  readonly namespaceId: string;
  readonly query: string;
  readonly payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const enforcement = await evaluateSourcePrivacyEnforcement({
    namespaceId: input.namespaceId,
    queryText: input.query,
    payload: input.payload
  });
  if (!enforcement.blocked) return input.payload;
  return {
    namespaceId: input.namespaceId,
    answer: "I can’t return that source content because an active source privacy overlay blocks it.",
    queryContract: "privacy_guard",
    retrievalDomain: "source_privacy",
    answerShape: "typed_abstention",
    finalClaimSource: null,
    evidenceCount: 0,
    sourceTrail: [],
    sourceQuotes: [],
    answerSections: [],
    claimAudit: [
      {
        id: "privacy:source_overlay",
        claimText: "Source content withheld by active privacy overlay.",
        claimFamily: "abstention",
        supportKind: "abstention",
        finalClaimSource: null,
        evidenceCount: 0,
        sourceTrail: [],
        sourceQuotes: [],
        supportStatus: "abstained",
        faithfulnessStatus: "verified"
      }
    ],
    selectionTrace: [
      {
        stage: "source_privacy_guard",
        decision: "abstained",
        reason: enforcement.reason
      }
    ],
    abstentionReason: enforcement.reason,
    sourcePrivacy: {
      blocked: true,
      reason: enforcement.reason,
      overlays: enforcement.overlays.map((overlay) => ({
        id: overlay.id,
        actionType: overlay.actionType,
        status: overlay.status,
        reason: overlay.reason,
        createdAt: overlay.createdAt
      })),
      rawSourcePolicy: "Raw source truth is retained; privacy operations are overlay decisions with audit and rollback visibility."
    },
    meta: {
      finalClaimSource: null,
      queryTimeModelCalls: 0,
      selectedReader: "source_privacy_guard",
      dominantStage: "source_privacy_guard"
    }
  };
}

function writeFrame(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
  const body = JSON.stringify(message);
  stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function ok(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function toolSchema(name: string): Record<string, unknown> {
  switch (name) {
    case "memory.recap":
    case "memory.extract_tasks":
    case "memory.extract_calendar":
    case "memory.explain_recap":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          namespace_id: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          reference_now: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          participants: { type: "array", items: { type: "string" } },
          topics: { type: "array", items: { type: "string" } },
          projects: { type: "array", items: { type: "string" } },
          provider: { type: "string", enum: ["none", "local", "openrouter"] },
          model: { type: "string" },
          session_id: { type: "string" },
          conversation_id: { type: "string" },
          detail_mode: { type: "string", enum: ["compact", "full"] },
          focus_mode: { type: "string", enum: ["timeline", "employers_only", "advisory_only", "ventures_only", "roles_and_dates", "source_audit"] }
        },
        required: ["query", "namespace_id"]
      };
    case "memory.search":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          namespace_id: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          reference_now: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          session_id: { type: "string" },
          conversation_id: { type: "string" },
          detail_mode: { type: "string", enum: ["compact", "full"] },
          focus_mode: { type: "string", enum: ["timeline", "employers_only", "advisory_only", "ventures_only", "roles_and_dates", "source_audit"] }
        },
        required: ["query", "namespace_id"]
      };
    case "memory.timeline":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["namespace_id", "time_start", "time_end"]
      };
    case "memory.get_artifact":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          artifact_id: { type: "string" }
        },
        required: ["artifact_id"]
      };
    case "memory.get_relationships":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_name: { type: "string" },
          namespace_id: { type: "string" },
          predicate: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          include_historical: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["entity_name", "namespace_id"]
      };
    case "memory.get_graph":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_name: { type: "string" },
          namespace_id: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        },
        required: ["namespace_id"]
      };
    case "memory.get_clarifications":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["namespace_id"]
      };
    case "memory.list_corrections":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["namespace_id"]
      };
    case "memory.apply_correction":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          source_name: { type: "string" },
          canonical_name: { type: "string" },
          entity_type: { type: "string" },
          target_entity_id: { type: "string" },
          source_entity_type: { type: "string" },
          canonical_entity_type: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          preserve_aliases: { type: "boolean" },
          note: { type: "string" }
        },
        required: ["namespace_id", "source_name", "canonical_name", "entity_type"]
      };
    case "memory.keep_correction_separate":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          left_name: { type: "string" },
          right_name: { type: "string" },
          entity_type: { type: "string" },
          left_entity_id: { type: "string" },
          right_entity_id: { type: "string" },
          note: { type: "string" }
        },
        required: ["namespace_id", "left_name", "right_name", "entity_type"]
      };
    case "memory.get_correction_status":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          source_name: { type: "string" },
          canonical_name: { type: "string" },
          entity_type: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["namespace_id", "canonical_name"]
      };
    case "memory.apply_source_privacy":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          action_type: { type: "string", enum: ["logical_delete", "redact", "access_label", "retention_policy"] },
          target_artifact_id: { type: "string" },
          target_source_uri: { type: "string" },
          target_chunk_id: { type: "string" },
          redaction_text: { type: "string" },
          access_label: { type: "string" },
          retention_policy: { type: "string" },
          reason: { type: "string" },
          actor: { type: "string" }
        },
        required: ["namespace_id", "action_type"]
      };
    case "memory.revert_source_privacy":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          overlay_id: { type: "string" },
          reason: { type: "string" },
          actor: { type: "string" }
        },
        required: ["namespace_id", "overlay_id"]
      };
    case "memory.get_source_privacy_status":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          target_artifact_id: { type: "string" },
          target_source_uri: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        },
        required: ["namespace_id"]
      };
    case "memory.get_stats":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          source_limit: { type: "integer", minimum: 1, maximum: 100 }
        },
        required: []
      };
    case "memory.get_protocols":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["namespace_id"]
      };
    case "memory.save_candidate":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          content: { type: "string" },
          candidate_type: { type: "string" },
          source_memory_id: { type: "string" },
          source_chunk_id: { type: "string" },
          confidence: { type: "number" },
          metadata: { type: "object" }
        },
        required: ["namespace_id", "content", "candidate_type"]
      };
    case "memory.upsert_state":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          state_type: { type: "string" },
          state_key: { type: "string" },
          state_value: {},
          metadata: { type: "object" }
        },
        required: ["namespace_id", "state_type", "state_key", "state_value"]
      };
    default:
      return {
        type: "object",
        additionalProperties: true
      };
  }
}

function listTools(): McpToolDefinition[] {
  return toolDescriptors.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolSchema(tool.name)
  }));
}

function wrapResult(payload: unknown): McpResultPayload {
  return {
    content: [
      {
        type: "text",
        text: jsonText(payload)
      }
    ],
    structuredContent: payload
  };
}

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(2));
}

function withMcpStageTelemetry(payload: Record<string, unknown>, timings: Record<string, number>): Record<string, unknown> {
  const meta = payload.meta && typeof payload.meta === "object" ? { ...(payload.meta as Record<string, unknown>) } : {};
  const existingStageTimings = meta.stageTimingsMs && typeof meta.stageTimingsMs === "object" ? (meta.stageTimingsMs as Record<string, unknown>) : {};
  const stageTimingsMs: Record<string, number> = {};
  for (const [key, value] of Object.entries(existingStageTimings)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      stageTimingsMs[key] = Number(value.toFixed(2));
    }
  }
  for (const [key, value] of Object.entries(timings)) {
    if (Number.isFinite(value)) {
      stageTimingsMs[key] = Number(value.toFixed(2));
    }
  }
  const total = Object.entries(stageTimingsMs)
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);
  stageTimingsMs.total = Number(total.toFixed(2));
  const dominant = Object.entries(stageTimingsMs)
    .filter(([key]) => key !== "total")
    .sort((left, right) => right[1] - left[1])[0] ?? null;
  return {
    ...payload,
    meta: {
      ...meta,
      stageTimingsMs,
      topStageMs: typeof meta.topStageMs === "number" && meta.topStageMs > 0 ? meta.topStageMs : dominant?.[1] ?? null,
      dominantStage: typeof meta.dominantStage === "string" && meta.dominantStage.trim() ? meta.dominantStage : dominant?.[0] ?? null
    }
  };
}

function compactText(value: unknown, max = 320): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function compactSourceTrail(value: unknown, maxItems = 4): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .slice(0, maxItems)
    .map((item) => ({
      sourceUri: typeof item.sourceUri === "string" ? item.sourceUri : null,
      artifactId: typeof item.artifactId === "string" ? item.artifactId : null,
      occurredAt: typeof item.occurredAt === "string" ? item.occurredAt : null,
      sourceMemoryIds: Array.isArray(item.sourceMemoryIds) ? item.sourceMemoryIds.filter((id): id is string => typeof id === "string").slice(0, 4) : [],
      sourceChunkIds: Array.isArray(item.sourceChunkIds) ? item.sourceChunkIds.filter((id): id is string => typeof id === "string").slice(0, 4) : [],
      sourceSceneIds: Array.isArray(item.sourceSceneIds) ? item.sourceSceneIds.filter((id): id is string => typeof id === "string").slice(0, 4) : [],
      sourceTable: typeof item.sourceTable === "string" ? item.sourceTable : null,
      sourceRowId: typeof item.sourceRowId === "string" ? item.sourceRowId : null,
      quote: compactText(item.quote, 240)
    }));
}

function compactClaimAudit(value: unknown, maxItems = 6): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .slice(0, maxItems)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      claimText: compactText(item.claimText, 320) ?? "",
      claimFamily: typeof item.claimFamily === "string" ? item.claimFamily : "unknown",
      supportKind: typeof item.supportKind === "string" ? item.supportKind : "answer_section",
      finalClaimSource: typeof item.finalClaimSource === "string" ? item.finalClaimSource : null,
      evidenceCount: typeof item.evidenceCount === "number" ? item.evidenceCount : 0,
      sourceTrail: compactSourceTrail(item.sourceTrail, 2),
      sourceQuotes: Array.isArray(item.sourceQuotes) ? item.sourceQuotes.map((quote) => compactText(quote, 220)).filter(Boolean).slice(0, 2) : [],
      supportStatus: typeof item.supportStatus === "string" ? item.supportStatus : "supported",
      faithfulnessStatus: typeof item.faithfulnessStatus === "string" ? item.faithfulnessStatus : "verified"
    }));
}

function compactAnswerSections(value: unknown, maxItems = 4): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .slice(0, maxItems)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      title: typeof item.title === "string" ? item.title : "",
      text: compactText(item.text, 700) ?? "",
      evidenceCount: typeof item.evidenceCount === "number" ? item.evidenceCount : 0,
      sourceTrail: compactSourceTrail(item.sourceTrail, 2),
      claimAudit: compactClaimAudit(item.claimAudit, 2),
      focusModes: Array.isArray(item.focusModes) ? item.focusModes.filter((mode): mode is string => typeof mode === "string").slice(0, 4) : []
    }));
}

function compactInsightItems(value: unknown, maxItems: number, textMax = 520): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .slice(0, maxItems)
    .map((item) => {
      const output: Record<string, unknown> = {};
      for (const [key, itemValue] of Object.entries(item)) {
        if (typeof itemValue === "string") {
          output[key] = compactText(itemValue, key === "quote" ? 260 : textMax);
        } else if (Array.isArray(itemValue)) {
          output[key] = itemValue.filter((entry): entry is string => typeof entry === "string").map((entry) => compactText(entry, 180)).filter(Boolean).slice(0, 6);
        } else if (typeof itemValue === "number" || typeof itemValue === "boolean" || itemValue === null) {
          output[key] = itemValue;
        }
      }
      return output;
    });
}

function compactInsightReport(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const report = value as Record<string, unknown>;
  return {
    insightType: typeof report.insightType === "string" ? report.insightType : null,
    answer: compactText(report.answer, 900) ?? "",
    observations: compactInsightItems(report.observations, 4),
    examples: compactInsightItems(report.examples, 4, 360),
    suggestions: compactInsightItems(report.suggestions, 4),
    uncertainty: Array.isArray(report.uncertainty) ? report.uncertainty.map((item) => compactText(item, 300)).filter(Boolean).slice(0, 4) : [],
    verification: report.verification && typeof report.verification === "object" ? report.verification : null
  };
}

function compactHumanReadable(value: unknown): Record<string, unknown> | string | null {
  if (typeof value === "string") {
    return compactText(value, 1200);
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    answer: compactText(record.answer, 1200) ?? "",
    whyThisAnswer: compactText(record.whyThisAnswer, 360) ?? "",
    evidenceSummary: Array.isArray(record.evidenceSummary) ? record.evidenceSummary.map((item) => compactText(item, 220)).filter(Boolean).slice(0, 1) : [],
    answerSections: compactAnswerSections(record.answerSections, 2),
    sourceTrail: Array.isArray(record.sourceTrail) ? record.sourceTrail.map((item) => compactText(item, 260)).filter(Boolean).slice(0, 1) : [],
    uncertainty: compactText(record.uncertainty, 300),
    suggestedNextQuery: compactText(record.suggestedNextQuery, 240)
  };
}

function estimatePayloadTokens(value: unknown): number {
  const text = JSON.stringify(value);
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function compactPayloadForDetailMode(payload: Record<string, unknown>, detailMode: "compact" | "full"): Record<string, unknown> {
  if (detailMode !== "compact") {
    return payload;
  }
  const compact: Record<string, unknown> = { ...payload };
  const originalMeta = payload.meta && typeof payload.meta === "object" ? (payload.meta as Record<string, unknown>) : {};
  const removedDiagnosticKeys = ["meta", "results", "duality", "evidence"] as const;
  for (const key of removedDiagnosticKeys) {
    delete compact[key];
  }
  compact.meta = {
    finalClaimSource: typeof originalMeta.finalClaimSource === "string" ? originalMeta.finalClaimSource : compact.finalClaimSource ?? null,
    queryTimeModelCalls: typeof originalMeta.queryTimeModelCalls === "number" ? originalMeta.queryTimeModelCalls : 0,
    queryTimeGLiNEROrLLMUsed: originalMeta.queryTimeGLiNEROrLLMUsed === true,
    selectedReader: typeof originalMeta.selectedReader === "string" ? originalMeta.selectedReader : compact.selectedReader ?? null,
    dominantStage: typeof originalMeta.dominantStage === "string" ? originalMeta.dominantStage : null,
    topStageMs: typeof originalMeta.topStageMs === "number" ? originalMeta.topStageMs : null,
    stageTimingsMs: originalMeta.stageTimingsMs && typeof originalMeta.stageTimingsMs === "object" ? originalMeta.stageTimingsMs : null,
    memoryQueryPlanIntent: typeof originalMeta.memoryQueryPlanIntent === "string" ? originalMeta.memoryQueryPlanIntent : null,
    selectedCorpusCapability: typeof originalMeta.selectedCorpusCapability === "string" ? originalMeta.selectedCorpusCapability : null,
    queryContractName: typeof originalMeta.queryContractName === "string" ? originalMeta.queryContractName : compact.queryContract ?? null,
    queryContractRetrievalDomain: typeof originalMeta.queryContractRetrievalDomain === "string" ? originalMeta.queryContractRetrievalDomain : compact.retrievalDomain ?? null
  };
  compact.sourceTrail = compactSourceTrail(compact.sourceTrail, 4);
  compact.primarySource = Array.isArray(compact.sourceTrail) ? compact.sourceTrail[0] ?? null : null;
  compact.sourceQuotes = Array.isArray(payload.sourceQuotes)
    ? payload.sourceQuotes.map((quote) => compactText(quote, 240)).filter(Boolean).slice(0, 4)
    : compactSourceTrail(compact.sourceTrail, 4).map((item) => item.quote).filter(Boolean);
  compact.claimAudit = compactClaimAudit(compact.claimAudit, 6);
  compact.answerSections = compactAnswerSections(compact.answerSections, 4);
  compact.insightReport = compactInsightReport(compact.insightReport);
  compact.observations = compactInsightItems(compact.observations, 4);
  compact.examples = compactInsightItems(compact.examples, 4, 360);
  compact.suggestions = compactInsightItems(compact.suggestions, 4);
  compact.humanReadable = compactHumanReadable(compact.humanReadable);
  compact.expansionTrace = Array.isArray(compact.expansionTrace)
    ? compact.expansionTrace.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").slice(0, 4)
    : [];
  compact.mcpPayloadBudget = {
    mode: "compact",
    removedDiagnosticKeys,
    approximateTokenEstimate: estimatePayloadTokens(compact)
  };
  return compact;
}

function normalizeCorrectionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function correctionNameTokens(value: string): readonly string[] {
  return normalizeCorrectionName(value).split(/\s+/u).filter((token) => token.length >= 3);
}

async function buildCorrectionPreflight(input: {
  readonly namespaceId: string;
  readonly sourceName: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly sourceEntityType: string;
  readonly canonicalEntityType: string;
}): Promise<Record<string, unknown>> {
  const normalizedSource = normalizeCorrectionName(input.sourceName);
  const normalizedCanonical = normalizeCorrectionName(input.canonicalName);
  const tokens = [...new Set([...correctionNameTokens(input.sourceName), ...correctionNameTokens(input.canonicalName)])];
  const rows = await queryRows<{
    readonly entity_id: string;
    readonly canonical_name: string;
    readonly entity_type: string;
    readonly normalized_name: string;
    readonly merged_into_entity_id: string | null;
    readonly alias: string | null;
    readonly alias_type: string | null;
    readonly is_user_verified: boolean | null;
    readonly score: number;
  }>(
    `
      WITH candidates AS (
        SELECT
          e.id,
          e.canonical_name,
          e.entity_type,
          e.normalized_name,
          e.merged_into_entity_id::text,
          NULL::text AS alias,
          NULL::text AS alias_type,
          NULL::boolean AS is_user_verified,
          CASE
            WHEN e.normalized_name = $3 THEN 100
            WHEN e.normalized_name = $2 THEN 95
            WHEN $4::text[] && regexp_split_to_array(e.normalized_name, '\\s+') THEN 35
            ELSE 0
          END AS score
        FROM entities e
        WHERE e.namespace_id = $1
          AND e.entity_type IN ($5, $6)
          AND (
            e.normalized_name IN ($2, $3)
            OR $4::text[] && regexp_split_to_array(e.normalized_name, '\\s+')
          )
        UNION ALL
        SELECT
          e.id,
          e.canonical_name,
          e.entity_type,
          e.normalized_name,
          e.merged_into_entity_id::text,
          ea.alias,
          ea.alias_type,
          ea.is_user_verified,
          CASE
            WHEN ea.normalized_alias = $3 AND ea.is_user_verified THEN 98
            WHEN ea.normalized_alias = $2 AND ea.is_user_verified THEN 96
            WHEN ea.normalized_alias = $3 THEN 80
            WHEN ea.normalized_alias = $2 THEN 75
            WHEN $4::text[] && regexp_split_to_array(ea.normalized_alias, '\\s+') THEN
              CASE WHEN ea.is_user_verified THEN 45 ELSE 25 END
            ELSE 0
          END AS score
        FROM entity_aliases ea
        JOIN entities e ON e.id = ea.entity_id
        WHERE e.namespace_id = $1
          AND e.entity_type IN ($5, $6)
          AND (
            ea.normalized_alias IN ($2, $3)
            OR $4::text[] && regexp_split_to_array(ea.normalized_alias, '\\s+')
          )
      )
      SELECT
        id::text AS entity_id,
        canonical_name,
        entity_type,
        normalized_name,
        merged_into_entity_id,
        alias,
        alias_type,
        is_user_verified,
        max(score)::float8 AS score
      FROM candidates
      WHERE score > 0
      GROUP BY id, canonical_name, entity_type, normalized_name, merged_into_entity_id, alias, alias_type, is_user_verified
      ORDER BY
        CASE WHEN merged_into_entity_id IS NULL THEN 0 ELSE 1 END,
        score DESC,
        coalesce(is_user_verified, false) DESC,
        canonical_name ASC
      LIMIT 12
    `,
    [input.namespaceId, normalizedSource, normalizedCanonical, tokens, input.sourceEntityType, input.canonicalEntityType]
  );
  const uniqueTargets = new Map<string, {
    readonly entityId: string;
    readonly canonicalName: string;
    readonly entityType: string;
    readonly active: boolean;
    readonly aliases: string[];
    score: number;
    verifiedAlias: boolean;
  }>();
  for (const row of rows) {
    const existing = uniqueTargets.get(row.entity_id) ?? {
      entityId: row.entity_id,
      canonicalName: row.canonical_name,
      entityType: row.entity_type,
      active: row.merged_into_entity_id === null,
      aliases: [],
      score: row.score,
      verifiedAlias: false
    };
    if (row.alias) existing.aliases.push(row.alias);
    existing.score = Math.max(existing.score, row.score);
    existing.verifiedAlias = existing.verifiedAlias || row.is_user_verified === true;
    uniqueTargets.set(row.entity_id, existing);
  }
  const candidates = [...uniqueTargets.values()]
    .map((candidate) => ({
      ...candidate,
      aliases: [...new Set(candidate.aliases)].slice(0, 6)
    }))
    .sort((left, right) =>
      Number(right.active) - Number(left.active) ||
      right.score - left.score ||
      Number(right.verifiedAlias) - Number(left.verifiedAlias) ||
      left.canonicalName.localeCompare(right.canonicalName)
    );
  const activeCandidates = candidates.filter((candidate) => candidate.active);
  const exactCanonical = activeCandidates.filter((candidate) => normalizeCorrectionName(candidate.canonicalName) === normalizedCanonical);
  const exactSource = activeCandidates.filter((candidate) => normalizeCorrectionName(candidate.canonicalName) === normalizedSource);
  const ambiguous =
    input.sourceEntityType === input.canonicalEntityType &&
    activeCandidates.length > 1 &&
    exactSource.length === 0;
  return {
    sourceName: input.sourceName,
    canonicalName: input.canonicalName,
    entityType: input.canonicalEntityType,
    candidates,
    selectedCandidate: exactCanonical[0] ?? null,
    sourceCandidates: exactSource,
    ambiguous,
    requiresUserChoice: ambiguous,
    guidance: ambiguous
      ? "Multiple plausible active entities match this correction. Ask the user which canonical entity to merge into, or use keep-separate if they are different people."
      : "A single canonical target was selected or the operation can proceed as an alias-only correction."
  };
}

async function resolveCorrectionEntityId(input: {
  readonly namespaceId: string;
  readonly entityId?: string | null;
  readonly entityName: string;
  readonly entityType: string;
  readonly fieldName: string;
}): Promise<string> {
  if (input.entityId?.trim()) {
    return input.entityId.trim();
  }
  const rows = await queryRows<{ readonly id: string }>(
    `
      SELECT id::text
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = $2
        AND normalized_name = $3
        AND merged_into_entity_id IS NULL
      ORDER BY last_seen_at DESC
      LIMIT 1
    `,
    [input.namespaceId, input.entityType, normalizeCorrectionName(input.entityName)]
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`Could not resolve ${input.fieldName} (${input.entityName}) as ${input.entityType}.`);
  }
  return id;
}

async function listCorrections(args: ToolCallArgs): Promise<unknown> {
  const namespaceId = requireString(args.namespace_id, "namespace_id");
  const query = optionalString(args.query);
  const limit = optionalNumber(args.limit) ?? 10;
  const normalizedQuery = query ? normalizeCorrectionName(query) : null;
  const inbox = await getOpsClarificationInbox(namespaceId, limit);
  const roleConflicts = await loadEntityRoleConflictProjection(namespaceId);
  const recentDecisions = await queryRows<{
    readonly kind: string;
    readonly source_name: string | null;
    readonly canonical_name: string | null;
    readonly action: string;
    readonly created_at: string;
    readonly metadata: Record<string, unknown>;
  }>(
    `
      SELECT
        'entity_role_resolution' AS kind,
        surface_name AS source_name,
        canonical_name,
        action,
        decided_at::text AS created_at,
        metadata
      FROM entity_role_resolution_decisions
      WHERE namespace_id = $1
      UNION ALL
      SELECT
        'clarification_resolution' AS kind,
        raw_text AS source_name,
        canonical_name,
        resolution_state AS action,
        updated_at::text AS created_at,
        metadata
      FROM clarification_resolutions
      WHERE namespace_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [namespaceId, limit]
  );
  const matchesQuery = (value: unknown): boolean => {
    if (!normalizedQuery) {
      return true;
    }
    return normalizeCorrectionName(JSON.stringify(value ?? "")).includes(normalizedQuery);
  };
  const correctionItems = [
    ...inbox.items.map((item) => ({ kind: "clarification", item })).filter(matchesQuery),
    ...roleConflicts.map((item) => ({ kind: "role_conflict_projection", item })).filter(matchesQuery),
    ...recentDecisions.map((item) => ({ kind: item.kind, item })).filter(matchesQuery)
  ].slice(0, limit);

  return {
    namespaceId,
    query: query ?? null,
    summary: {
      clarificationOpenCount: inbox.summary.total,
      roleConflictProjectionCount: roleConflicts.length,
      returnedCount: correctionItems.length
    },
    items: correctionItems,
    guidance: {
      applyCorrectionTool: "memory.apply_correction",
      keepSeparateTool: "memory.keep_correction_separate",
      statusTool: "memory.get_correction_status",
      examples: [
        {
          source_name: "Omi Gummi",
          canonical_name: "Gummi",
          entity_type: "person",
          aliases: ["Omi Gummi"]
        },
        {
          source_name: "Steven",
          canonical_name: "Stephen",
          entity_type: "person",
          aliases: ["Steven"]
        },
        {
          source_name: "Chiang Mai",
          canonical_name: "Chiang Mai",
          source_entity_type: "person",
          canonical_entity_type: "place",
          entity_type: "place",
          aliases: ["Chiang Mai"]
        }
      ]
    }
  };
}

async function applyCorrection(args: ToolCallArgs): Promise<unknown> {
  const namespaceId = requireString(args.namespace_id, "namespace_id");
  const sourceName = requireString(args.source_name, "source_name");
  const canonicalName = requireString(args.canonical_name, "canonical_name");
  const entityType = requireString(args.entity_type, "entity_type");
  const sourceEntityType = optionalString(args.source_entity_type) ?? entityType;
  const canonicalEntityType = optionalString(args.canonical_entity_type) ?? entityType;
  const aliases = optionalStringArray(args.aliases) ?? [sourceName];
  const preserveAliases = typeof args.preserve_aliases === "boolean" ? args.preserve_aliases : true;
  const note = optionalString(args.note) ?? `MCP correction: ${sourceName} -> ${canonicalName}`;
  const preflight = await buildCorrectionPreflight({
    namespaceId,
    sourceName,
    canonicalName,
    entityType,
    sourceEntityType,
    canonicalEntityType
  });
  if ((preflight as { readonly requiresUserChoice?: unknown }).requiresUserChoice === true && optionalString(args.target_entity_id) === undefined) {
    return {
      namespaceId,
      correctionType: "entity_alias_or_spelling",
      sourceName,
      canonicalName,
      entityType: canonicalEntityType,
      sourceEntityType,
      canonicalEntityType,
      applied: false,
      requiresUserChoice: true,
      correctionPreflight: preflight,
      guidance: {
        message: "Multiple plausible entities matched this correction. Do not silently merge. Ask the user which target to merge into, or keep them separate.",
        nextTool: "memory.apply_correction",
        optionalTargetField: "target_entity_id",
        keepSeparateTool: "memory.keep_correction_separate"
      },
      propagation: {
        rawEvidenceDeleted: false,
        durableDecisionWritten: false,
        outboxProcessed: false,
        correctionStatusTool: "memory.get_correction_status"
      }
    };
  }
  const result =
    sourceEntityType === canonicalEntityType
      ? await mergeEntityAlias({
          namespaceId,
          sourceName,
          canonicalName,
          entityType,
          targetEntityId: optionalString(args.target_entity_id),
          aliases,
          preserveAliases,
          note
        })
      : await mergeEntityRoleCorrection({
          namespaceId,
          sourceName,
          sourceEntityType,
          canonicalName,
          canonicalEntityType,
          aliases,
          preserveAliases,
          note
        });
  const outbox = await processBrainOutboxEvents({ namespaceId, limit: 25 });
  const roleProjection = await rebuildEntityRoleConflictProjection(namespaceId);
  const status = await getCorrectionStatus({
    namespace_id: namespaceId,
    source_name: sourceName,
    canonical_name: canonicalName,
    entity_type: sourceEntityType === canonicalEntityType ? canonicalEntityType : undefined,
    limit: 10
  });

  return {
    namespaceId,
    correctionType: "entity_alias_or_spelling",
    sourceName,
    canonicalName,
    entityType: canonicalEntityType,
    sourceEntityType,
    canonicalEntityType,
    aliases,
    preserveAliases,
    correctionPreflight: preflight,
    result,
    outbox,
    roleProjectionCount: roleProjection.length,
    status,
    propagation: {
      rawEvidenceDeleted: false,
      durableDecisionWritten: Boolean(result.outboxEventId),
      outboxProcessed: outbox.processed > 0,
      correctionStatusTool: "memory.get_correction_status"
    }
  };
}

async function keepCorrectionSeparate(args: ToolCallArgs): Promise<unknown> {
  const namespaceId = requireString(args.namespace_id, "namespace_id");
  const leftName = requireString(args.left_name, "left_name");
  const rightName = requireString(args.right_name, "right_name");
  const entityType = requireString(args.entity_type, "entity_type");
  const leftEntityId = await resolveCorrectionEntityId({
    namespaceId,
    entityId: optionalString(args.left_entity_id),
    entityName: leftName,
    entityType,
    fieldName: "left_name"
  });
  const rightEntityId = await resolveCorrectionEntityId({
    namespaceId,
    entityId: optionalString(args.right_entity_id),
    entityName: rightName,
    entityType,
    fieldName: "right_name"
  });
  const note = optionalString(args.note) ?? `MCP keep separate: ${leftName} != ${rightName}`;
  const result = await keepIdentityConflictSeparate({ leftEntityId, rightEntityId, note });

  return {
    namespaceId,
    correctionType: "identity_keep_separate",
    leftName,
    rightName,
    entityType,
    result,
    propagation: {
      rawEvidenceDeleted: false,
      durableDecisionWritten: result.decision === "keep_separate",
      outboxProcessed: false,
      correctionStatusTool: "memory.get_correction_status"
    }
  };
}

async function getCorrectionStatus(args: ToolCallArgs): Promise<unknown> {
  const namespaceId = requireString(args.namespace_id, "namespace_id");
  const canonicalName = requireString(args.canonical_name, "canonical_name");
  const sourceName = optionalString(args.source_name);
  const entityType = optionalString(args.entity_type);
  const limit = optionalNumber(args.limit) ?? 10;
  const names = [...new Set([canonicalName, sourceName].filter((value): value is string => Boolean(value?.trim())))];
  const normalizedNames = names.map(normalizeCorrectionName);
  const entities = await queryRows<{
    readonly id: string;
    readonly namespace_id: string;
    readonly entity_type: string;
    readonly canonical_name: string;
    readonly normalized_name: string;
    readonly merged_into_entity_id: string | null;
    readonly metadata: Record<string, unknown>;
  }>(
    `
      SELECT
        id::text,
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        merged_into_entity_id::text,
        metadata
      FROM entities
      WHERE namespace_id = $1
        AND ($2::text IS NULL OR entity_type = $2)
        AND (
          normalized_name = ANY($3::text[])
          OR id IN (
            SELECT entity_id
            FROM entity_aliases
            WHERE normalized_alias = ANY($3::text[])
          )
        )
      ORDER BY merged_into_entity_id NULLS FIRST, canonical_name
      LIMIT $4
    `,
    [namespaceId, entityType ?? null, normalizedNames, limit]
  );
  const aliases = await queryRows<{
    readonly entity_id: string;
    readonly canonical_name: string;
    readonly alias: string;
    readonly alias_type: string;
    readonly is_user_verified: boolean;
    readonly metadata: Record<string, unknown>;
  }>(
    `
      SELECT
        ea.entity_id::text,
        e.canonical_name,
        ea.alias,
        ea.alias_type,
        ea.is_user_verified,
        ea.metadata
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.namespace_id = $1
        AND (
          e.normalized_name = ANY($2::text[])
          OR ea.normalized_alias = ANY($2::text[])
        )
      ORDER BY e.canonical_name, ea.alias
      LIMIT $3
    `,
    [namespaceId, normalizedNames, limit * 4]
  );
  const outboxEvents = await queryRows<{
    readonly id: string;
    readonly event_type: string;
    readonly status: string;
    readonly payload: Record<string, unknown>;
    readonly created_at: string;
    readonly processed_at: string | null;
  }>(
    `
      SELECT id::text, event_type, status, payload, created_at::text, processed_at::text
      FROM brain_outbox_events
      WHERE namespace_id = $1
        AND (
          payload->>'canonical_name' = $2
          OR payload->>'source_name' = $3
          OR payload::text ILIKE '%' || $2 || '%'
          OR ($3::text IS NOT NULL AND payload::text ILIKE '%' || $3 || '%')
        )
      ORDER BY created_at DESC
      LIMIT $4
    `,
    [namespaceId, canonicalName, sourceName ?? null, limit]
  );
  const identityDecisions = await queryRows<{
    readonly decision: string;
    readonly canonical_name: string | null;
    readonly note: string | null;
    readonly metadata: Record<string, unknown>;
    readonly updated_at: string;
    readonly entity_a_name: string | null;
    readonly entity_b_name: string | null;
  }>(
    `
      SELECT
        icd.decision,
        icd.canonical_name,
        icd.note,
        icd.metadata,
        icd.updated_at::text,
        ea.canonical_name AS entity_a_name,
        eb.canonical_name AS entity_b_name
      FROM identity_conflict_decisions icd
      JOIN entities ea ON ea.id = icd.entity_a_id
      JOIN entities eb ON eb.id = icd.entity_b_id
      WHERE (
          ea.namespace_id = $1
          OR eb.namespace_id = $1
        )
        AND (
          ea.normalized_name = ANY($2::text[])
          OR eb.normalized_name = ANY($2::text[])
          OR icd.canonical_name = $3
          OR ($4::text IS NOT NULL AND icd.note ILIKE '%' || $4 || '%')
        )
      ORDER BY icd.updated_at DESC
      LIMIT $5
    `,
    [namespaceId, normalizedNames, canonicalName, sourceName ?? null, limit]
  );
  const correctionSourceEnvelopes = await queryRows<{
    readonly id: string;
    readonly correction_kind: string;
    readonly source_name: string;
    readonly canonical_name: string | null;
    readonly source_entity_type: string | null;
    readonly canonical_entity_type: string | null;
    readonly action: string;
    readonly source_trail: readonly unknown[];
    readonly payload: Record<string, unknown>;
    readonly created_at: string;
  }>(
    `
      SELECT
        id::text,
        correction_kind,
        source_name,
        canonical_name,
        source_entity_type,
        canonical_entity_type,
        action,
        source_trail,
        payload,
        created_at::text
      FROM correction_source_envelopes
      WHERE namespace_id = $1
        AND (
          lower(source_name) = ANY($2::text[])
          OR lower(coalesce(canonical_name, '')) = ANY($2::text[])
          OR payload::text ILIKE '%' || $3 || '%'
          OR ($4::text IS NOT NULL AND payload::text ILIKE '%' || $4 || '%')
        )
      ORDER BY created_at DESC
      LIMIT $5
    `,
    [namespaceId, normalizedNames, canonicalName, sourceName ?? null, limit]
  );
  const correctionEnvelopeIds = correctionSourceEnvelopes.map((row) => row.id);
  const classConstraints = await queryRows<{
    readonly id: string;
    readonly surface_name: string;
    readonly canonical_name: string;
    readonly corrected_role: string;
    readonly forbidden_roles: readonly string[];
    readonly allowed_roles: readonly string[];
    readonly decision_reason: string | null;
    readonly updated_at: string;
  }>(
    `
      SELECT
        id::text,
        surface_name,
        canonical_name,
        corrected_role,
        forbidden_roles,
        allowed_roles,
        decision_reason,
        updated_at::text
      FROM correction_class_constraints
      WHERE namespace_id = $1
        AND (
          normalized_name = ANY($2::text[])
          OR lower(canonical_name) = ANY($2::text[])
        )
      ORDER BY updated_at DESC
      LIMIT $3
    `,
    [namespaceId, normalizedNames, limit]
  );
  const referenceAudits = await queryRows<{
    readonly id: string;
    readonly audit_kind: string;
    readonly source_reference_count: number;
    readonly intentionally_retained_count: number;
    readonly relationship_source_ref_count: number;
    readonly self_binding_source_ref_count: number;
    readonly relationship_prior_source_ref_count: number;
    readonly passed: boolean;
    readonly metadata: Record<string, unknown>;
    readonly created_at: string;
  }>(
    `
      SELECT
        id::text,
        audit_kind,
        source_reference_count,
        intentionally_retained_count,
        relationship_source_ref_count,
        self_binding_source_ref_count,
        relationship_prior_source_ref_count,
        passed,
        metadata,
        created_at::text
      FROM correction_reference_audits
      WHERE namespace_id = $1
        AND (
          correction_envelope_id = ANY($2::uuid[])
          OR source_entity_id IN (SELECT id FROM entities WHERE namespace_id = $1 AND normalized_name = ANY($3::text[]))
          OR target_entity_id IN (SELECT id FROM entities WHERE namespace_id = $1 AND normalized_name = ANY($3::text[]))
        )
      ORDER BY created_at DESC
      LIMIT $4
    `,
    [namespaceId, correctionEnvelopeIds, normalizedNames, limit]
  );
  const writeLocks = await queryRows<{
    readonly id: string;
    readonly entity_name: string;
    readonly entity_type: string | null;
    readonly lock_reason: string;
    readonly status: string;
    readonly acquired_at: string;
    readonly released_at: string | null;
    readonly metadata: Record<string, unknown>;
  }>(
    `
      SELECT
        id::text,
        entity_name,
        entity_type,
        lock_reason,
        status,
        acquired_at::text,
        released_at::text,
        metadata
      FROM correction_write_locks
      WHERE namespace_id = $1
        AND normalized_name = ANY($2::text[])
      ORDER BY acquired_at DESC
      LIMIT $3
    `,
    [namespaceId, normalizedNames, limit]
  );
  const roleProjection = (await loadEntityRoleConflictProjection(namespaceId)).filter((row) =>
    normalizedNames.includes(row.normalizedName)
  );
  const activeCanonicalEntities = entities.filter((entity) => entity.merged_into_entity_id === null && normalizeCorrectionName(entity.canonical_name) === normalizeCorrectionName(canonicalName));
  const staleActiveSourceEntities = sourceName
    ? entities.filter((entity) => entity.merged_into_entity_id === null && normalizeCorrectionName(entity.canonical_name) === normalizeCorrectionName(sourceName) && normalizeCorrectionName(sourceName) !== normalizeCorrectionName(canonicalName))
    : [];

  return {
    namespaceId,
    sourceName: sourceName ?? null,
    canonicalName,
    entityType: entityType ?? null,
    propagated: activeCanonicalEntities.length > 0 && staleActiveSourceEntities.length === 0,
    rawEvidenceDeleted: false,
    activeCanonicalEntities,
    staleActiveSourceEntities,
    aliases,
    outboxEvents,
    identityDecisions,
    correctionSourceEnvelopes,
    classConstraints,
    referenceAudits,
    writeLocks,
    roleProjection,
    guidance: {
      propagatedMeans: "A canonical active entity exists and the old source spelling/name is no longer an active separate entity for this type.",
      rawEvidencePolicy: "Raw source text is immutable; corrections are represented as aliases, merged entity references, replayable correction envelopes, class constraints, reference audits, and outbox/reprojection records."
    }
  };
}

async function saveCandidate(args: ToolCallArgs): Promise<unknown> {
  const result = await withTransaction(async (client) => {
    const insertResult = await client.query(
      `
        INSERT INTO memory_candidates (
          namespace_id,
          source_memory_id,
          source_chunk_id,
          candidate_type,
          content,
          confidence,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT ON CONSTRAINT memory_candidates_namespace_source_memory_id_source_chunk_key
        DO UPDATE SET
          confidence = COALESCE(EXCLUDED.confidence, memory_candidates.confidence),
          metadata = memory_candidates.metadata || EXCLUDED.metadata,
          status = 'pending'
        RETURNING
          id,
          namespace_id,
          source_memory_id,
          source_chunk_id,
          candidate_type,
          content,
          confidence,
          status,
          created_at,
          metadata
      `,
      [
        requireString(args.namespace_id, "namespace_id"),
        optionalString(args.source_memory_id) ?? null,
        optionalString(args.source_chunk_id) ?? null,
        requireString(args.candidate_type, "candidate_type"),
        requireString(args.content, "content"),
        optionalNumber(args.confidence) ?? null,
        JSON.stringify(optionalObject(args.metadata) ?? {})
      ]
    );

    const row = insertResult.rows[0];
    if (!row) {
      throw new Error("Failed to save candidate.");
    }

    return row;
  });

  return {
    content: [
      {
        type: "text",
        text: jsonText(result)
      }
    ],
    structuredContent: result
  };
}

async function upsertState(args: ToolCallArgs): Promise<unknown> {
  const result = await withTransaction(async (client) => {
    const activeState = await client.query<{ id: string; version: number }>(
      `
        SELECT id, version
        FROM procedural_memory
        WHERE namespace_id = $1
          AND state_type = $2
          AND state_key = $3
          AND valid_until IS NULL
        ORDER BY version DESC
        LIMIT 1
      `,
      [requireString(args.namespace_id, "namespace_id"), requireString(args.state_type, "state_type"), requireString(args.state_key, "state_key")]
    );

    const activeRow = activeState.rows[0];
    const occurredAt = new Date().toISOString();

    if (activeRow) {
      await client.query(
        `
          UPDATE procedural_memory
          SET valid_until = $2
          WHERE id = $1
        `,
        [activeRow.id, occurredAt]
      );
    }

    const nextVersion = (activeRow?.version ?? 0) + 1;
    const insertResult = await client.query(
      `
        INSERT INTO procedural_memory (
          namespace_id,
          state_type,
          state_key,
          state_value,
          version,
          updated_at,
          valid_from,
          valid_until,
          supersedes_id,
          metadata
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6, NULL, $7, $8::jsonb)
        RETURNING id, namespace_id, state_type, state_key, state_value, version, updated_at, valid_from, valid_until, supersedes_id, metadata
      `,
      [
        requireString(args.namespace_id, "namespace_id"),
        requireString(args.state_type, "state_type"),
        requireString(args.state_key, "state_key"),
        JSON.stringify(args.state_value ?? {}),
        nextVersion,
        occurredAt,
        activeRow?.id ?? null,
        JSON.stringify(optionalObject(args.metadata) ?? {})
      ]
    );

    const row = insertResult.rows[0];
    if (!row) {
      throw new Error("Failed to upsert procedural state.");
    }

    return row;
  });

  return {
    content: [
      {
        type: "text",
        text: jsonText(result)
      }
    ],
    structuredContent: result
  };
}

async function getStats(args: ToolCallArgs): Promise<unknown> {
  const sourceLimit = optionalNumber(args.source_limit) ?? 12;
  const [overview, runtimeWorkers, bootstrap, monitoredSources] = await Promise.all([
    getOpsOverview(),
    getRuntimeWorkerStatus(),
    getBootstrapState(),
    listMonitoredSources(sourceLimit)
  ]);

  return wrapResult({
    overview,
    runtimeWorkers,
    bootstrap,
    monitoredSources
  });
}

async function getProtocols(args: ToolCallArgs): Promise<unknown> {
  const namespaceId = requireString(args.namespace_id, "namespace_id");
  const query = optionalString(args.query)?.toLowerCase();
  const queryTokens = query ? query.split(/\s+/u).filter((token) => token.length >= 3) : [];
  const limit = optionalNumber(args.limit) ?? 20;
  const rows = await queryRows<{
    readonly id: string;
    readonly state_type: string;
    readonly state_key: string;
    readonly state_value: Record<string, unknown>;
    readonly valid_from: string;
    readonly metadata: Record<string, unknown>;
  }>(
    `
      SELECT
        id::text,
        state_type,
        state_key,
        state_value,
        valid_from::text,
        metadata
      FROM procedural_memory
      WHERE namespace_id = $1
        AND valid_until IS NULL
        AND state_type IN ('constraint', 'style_spec')
      ORDER BY
        CASE state_type WHEN 'constraint' THEN 0 ELSE 1 END,
        valid_from DESC
      LIMIT 200
    `,
    [namespaceId]
  );

  const scoredRows = rows
    .map((row) => {
      const haystack = [
        row.state_type,
        row.state_key,
        JSON.stringify(row.state_value ?? {}),
        JSON.stringify(row.metadata ?? {})
      ].join(" ").toLowerCase();
      const matchedTokens = queryTokens.filter((token) => haystack.includes(token));
      return {
        row,
        haystack,
        matchedTokens,
        matchedCount: matchedTokens.length
      };
    })
    .filter((entry) => (queryTokens.length === 0 ? true : entry.matchedCount > 0))
    .sort((left, right) => {
      if (right.matchedCount !== left.matchedCount) {
        return right.matchedCount - left.matchedCount;
      }

      if (left.row.state_type !== right.row.state_type) {
        return left.row.state_type.localeCompare(right.row.state_type);
      }

      return right.row.valid_from.localeCompare(left.row.valid_from);
    });

  const returnedRows = scoredRows.slice(0, limit);
  const matchedTokens = Array.from(new Set(returnedRows.flatMap((entry) => entry.matchedTokens))).sort();

  return wrapResult({
    namespaceId,
    query: query ?? null,
    matchedTokens,
    total: scoredRows.length,
    items: returnedRows.map(({ row, matchedTokens: rowMatchedTokens, matchedCount }) => ({
      id: row.id,
      stateType: row.state_type,
      stateKey: row.state_key,
      stateValue: row.state_value,
      validFrom: row.valid_from,
      metadata: row.metadata,
      match: {
        matchedTokens: rowMatchedTokens,
        matchedCount
      }
    }))
  });
}

function registryKey(namespaceId: string, sessionId: string): string {
  return `${namespaceId}::${sessionId}`;
}

function isSessionSourceAuditFollowup(query: string): boolean {
  return /\bwhere\s+did\s+(?:that|this|the)\s+(?:answer|claim|response|result)?\s*(?:come\s+from|source|sources|evidence)\b/iu.test(query) ||
    /\b(?:show|give|list)\s+(?:me\s+)?(?:the\s+)?sources?\s+for\s+(?:that|this|the)\s+(?:answer|claim|response|result)\b/iu.test(query);
}

function isSupportedPayload(payload: Record<string, unknown>): boolean {
  const evidenceCount = typeof payload.evidenceCount === "number" && Number.isFinite(payload.evidenceCount) ? payload.evidenceCount : 0;
  const sourceTrail = Array.isArray(payload.sourceTrail) ? payload.sourceTrail : [];
  return evidenceCount > 0 && sourceTrail.length > 0;
}

function recordSessionClaims(input: {
  readonly namespaceId: string;
  readonly sessionId?: string;
  readonly query: string;
  readonly payload: Record<string, unknown>;
}): void {
  if (!input.sessionId || !isSupportedPayload(input.payload) || input.payload.queryContract === "source_audit") {
    return;
  }
  const claimAudit = Array.isArray(input.payload.claimAudit) ? input.payload.claimAudit : [];
  const fallbackSourceTrail = Array.isArray(input.payload.sourceTrail)
    ? input.payload.sourceTrail.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  const fallbackQuotes = Array.isArray(input.payload.sourceQuotes)
    ? input.payload.sourceQuotes.filter((quote): quote is string => typeof quote === "string")
    : [];
  const entries = claimAudit
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry, index) => {
      const sourceTrail = Array.isArray(entry.sourceTrail)
        ? entry.sourceTrail.filter((trail): trail is Record<string, unknown> => Boolean(trail) && typeof trail === "object")
        : fallbackSourceTrail;
      return {
        id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `claim:${index}`,
        query: input.query,
        claimText:
          typeof entry.claimText === "string" && entry.claimText.trim()
            ? entry.claimText.trim()
            : typeof input.payload.answer === "string"
              ? input.payload.answer.slice(0, 500)
              : input.query,
        claimFamily: typeof entry.claimFamily === "string" ? entry.claimFamily : "unknown",
        finalClaimSource: typeof entry.finalClaimSource === "string" ? entry.finalClaimSource : typeof input.payload.finalClaimSource === "string" ? input.payload.finalClaimSource : null,
        evidenceCount: typeof entry.evidenceCount === "number" && Number.isFinite(entry.evidenceCount) ? entry.evidenceCount : sourceTrail.length,
        sourceTrail,
        sourceQuotes: Array.isArray(entry.sourceQuotes)
          ? entry.sourceQuotes.filter((quote): quote is string => typeof quote === "string")
          : fallbackQuotes,
        answerSectionId: typeof entry.answerSectionId === "string" ? entry.answerSectionId : null,
        recordedAt: new Date().toISOString()
      };
    })
    .filter((entry) => entry.sourceTrail.length > 0);

  if (entries.length === 0 && fallbackSourceTrail.length > 0) {
    entries.push({
      id: "answer",
      query: input.query,
      claimText: typeof input.payload.answer === "string" && input.payload.answer.trim() ? input.payload.answer.trim().slice(0, 500) : input.query,
      claimFamily: "unknown",
      finalClaimSource: typeof input.payload.finalClaimSource === "string" ? input.payload.finalClaimSource : null,
      evidenceCount: typeof input.payload.evidenceCount === "number" && Number.isFinite(input.payload.evidenceCount) ? input.payload.evidenceCount : fallbackSourceTrail.length,
      sourceTrail: fallbackSourceTrail,
      sourceQuotes: fallbackQuotes,
      answerSectionId: null,
      recordedAt: new Date().toISOString()
    });
  }

  if (entries.length === 0) {
    return;
  }

  const key = registryKey(input.namespaceId, input.sessionId);
  const existing = sessionClaimRegistry.get(key) ?? [];
  sessionClaimRegistry.set(key, [...entries, ...existing].slice(0, 40));
}

function buildSessionSourceAuditPayload(input: {
  readonly namespaceId: string;
  readonly sessionId: string;
  readonly query: string;
}): Record<string, unknown> | null {
  const claims = sessionClaimRegistry.get(registryKey(input.namespaceId, input.sessionId)) ?? [];
  const latestClaims = claims.slice(0, 8);
  if (latestClaims.length === 0) {
    return null;
  }
  const sourceTrail = latestClaims.flatMap((claim) => claim.sourceTrail).slice(0, 12);
  const sourceQuotes = [...new Set(latestClaims.flatMap((claim) => claim.sourceQuotes))].slice(0, 8);
  const evidenceCount = sourceTrail.length;
  return {
    answer: "This source audit is bound to the prior answer in the current MCP session.",
    queryContract: "source_audit",
    retrievalDomain: "source_audit",
    finalClaimSource: "source_audit",
    evidenceCount,
    sourceTrail,
    primarySource: sourceTrail[0] ?? null,
    sourceQuotes,
    claimAudit: latestClaims.map((claim) => ({
      id: `session:${claim.id}`,
      claimText: claim.claimText,
      claimFamily: claim.claimFamily,
      supportKind: "answer_section",
      finalClaimSource: claim.finalClaimSource,
      evidenceCount: claim.evidenceCount,
      sourceTrail: claim.sourceTrail,
      sourceQuotes: claim.sourceQuotes,
      supportStatus: "supported",
      faithfulnessStatus: "verified"
    })),
    selectionTrace: [
      {
        stage: "mcp_session_claim_registry",
        decision: "selected",
        reason: "The source-audit follow-up was bound to the prior answer claim registry for this MCP session."
      }
    ],
    sessionClaimRegistry: {
      sessionId: input.sessionId,
      priorClaimCount: latestClaims.length,
      boundQuery: latestClaims[0]?.query ?? null
    },
    meta: {
      finalClaimSource: "source_audit",
      queryTimeModelCalls: 0,
      selectedReader: "mcp_session_claim_registry",
      dominantStage: "mcp_session_claim_registry"
    }
  };
}

export async function executeMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "memory.recap": {
      const query = requireString(args.query, "query");
      const namespaceId = requireString(args.namespace_id, "namespace_id");
      const detailMode = optionalDetailMode(args.detail_mode) ?? "full";
      const focusMode = optionalFocusMode(args.focus_mode);
      const rawPayload = await attachStableQueryContractEnvelope({
          toolName: "memory.recap",
          queryText: query,
          namespaceId,
          payload: await recapMemory({
            query,
            namespaceId,
            timeStart: optionalString(args.time_start),
            timeEnd: optionalString(args.time_end),
            referenceNow: optionalString(args.reference_now),
            limit: optionalNumber(args.limit),
            participants: optionalStringArray(args.participants),
            topics: optionalStringArray(args.topics),
            projects: optionalStringArray(args.projects),
            provider: optionalString(args.provider) as "none" | "local" | "openrouter" | undefined,
            model: optionalString(args.model)
          })
        });
      const payload = await applySourcePrivacyGuard({ namespaceId, query, payload: rawPayload as Record<string, unknown> });
      return wrapResult(compactPayloadForDetailMode({
        ...payload,
        detailModeUsed: detailMode,
        focusModeUsed: focusMode ?? null,
        humanReadable: presentHumanReadableQueryResult({ query, payload, detailMode, focusMode })
      }, detailMode));
    }
    case "memory.extract_tasks": {
      const query = requireString(args.query, "query");
      const namespaceId = requireString(args.namespace_id, "namespace_id");
      const detailMode = optionalDetailMode(args.detail_mode) ?? "full";
      const focusMode = optionalFocusMode(args.focus_mode);
      const extractionStartedAt = performance.now();
      const extractedPayload = await extractTaskMemory({
        query,
        namespaceId,
        timeStart: optionalString(args.time_start),
        timeEnd: optionalString(args.time_end),
        referenceNow: optionalString(args.reference_now),
        limit: optionalNumber(args.limit),
        participants: optionalStringArray(args.participants),
        topics: optionalStringArray(args.topics),
        projects: optionalStringArray(args.projects),
        provider: optionalString(args.provider) as "none" | "local" | "openrouter" | undefined,
        model: optionalString(args.model)
      });
      const extractionMs = elapsedMs(extractionStartedAt);
      const envelopeStartedAt = performance.now();
      const rawPayload = await attachStableQueryContractEnvelope({
          toolName: "memory.extract_tasks",
          queryText: query,
          namespaceId,
          payload: extractedPayload
        });
      const envelopeMs = elapsedMs(envelopeStartedAt);
      const privacyStartedAt = performance.now();
      const privacyPayload = await applySourcePrivacyGuard({ namespaceId, query, payload: rawPayload as Record<string, unknown> });
      const privacyMs = elapsedMs(privacyStartedAt);
      const presenterStartedAt = performance.now();
      const humanReadable = presentHumanReadableQueryResult({ query, payload: privacyPayload, detailMode, focusMode });
      const presenterMs = elapsedMs(presenterStartedAt);
      const payload = withMcpStageTelemetry(privacyPayload as Record<string, unknown>, {
        mcp_extract_tasks: extractionMs,
        mcp_envelope: envelopeMs,
        mcp_source_privacy: privacyMs,
        mcp_presenter: presenterMs
      });
      return wrapResult(compactPayloadForDetailMode({
        ...payload,
        detailModeUsed: detailMode,
        focusModeUsed: focusMode ?? null,
        humanReadable
      }, detailMode));
    }
    case "memory.extract_calendar":
    {
      const query = requireString(args.query, "query");
      const namespaceId = requireString(args.namespace_id, "namespace_id");
      const detailMode = optionalDetailMode(args.detail_mode) ?? "full";
      const focusMode = optionalFocusMode(args.focus_mode);
      const extractionStartedAt = performance.now();
      const extractedPayload = await extractCalendarMemory({
        query,
        namespaceId,
        timeStart: optionalString(args.time_start),
        timeEnd: optionalString(args.time_end),
        referenceNow: optionalString(args.reference_now),
        limit: optionalNumber(args.limit),
        participants: optionalStringArray(args.participants),
        topics: optionalStringArray(args.topics),
        projects: optionalStringArray(args.projects),
        provider: optionalString(args.provider) as "none" | "local" | "openrouter" | undefined,
        model: optionalString(args.model)
      });
      const extractionMs = elapsedMs(extractionStartedAt);
      const envelopeStartedAt = performance.now();
      const rawPayload = await attachStableQueryContractEnvelope({
          toolName: "memory.extract_calendar",
          queryText: query,
          namespaceId,
          payload: extractedPayload
        });
      const envelopeMs = elapsedMs(envelopeStartedAt);
      const privacyStartedAt = performance.now();
      const privacyPayload = await applySourcePrivacyGuard({ namespaceId, query, payload: rawPayload as Record<string, unknown> });
      const privacyMs = elapsedMs(privacyStartedAt);
      const presenterStartedAt = performance.now();
      const humanReadable = presentHumanReadableQueryResult({ query, payload: privacyPayload, detailMode, focusMode });
      const presenterMs = elapsedMs(presenterStartedAt);
      const payload = withMcpStageTelemetry(privacyPayload as Record<string, unknown>, {
        mcp_extract_calendar: extractionMs,
        mcp_envelope: envelopeMs,
        mcp_source_privacy: privacyMs,
        mcp_presenter: presenterMs
      });
      return wrapResult(compactPayloadForDetailMode({
        ...payload,
        detailModeUsed: detailMode,
        focusModeUsed: focusMode ?? null,
        humanReadable
      }, detailMode));
    }
    case "memory.explain_recap":
      return wrapResult(
        await explainRecap({
          query: requireString(args.query, "query"),
          namespaceId: requireString(args.namespace_id, "namespace_id"),
          timeStart: optionalString(args.time_start),
          timeEnd: optionalString(args.time_end),
          referenceNow: optionalString(args.reference_now),
          limit: optionalNumber(args.limit),
          participants: optionalStringArray(args.participants),
          topics: optionalStringArray(args.topics),
          projects: optionalStringArray(args.projects)
        })
      );
    case "memory.search": {
      const query = requireString(args.query, "query");
      const namespaceId = requireString(args.namespace_id, "namespace_id");
      const detailMode = optionalDetailMode(args.detail_mode) ?? "full";
      const focusMode = optionalFocusMode(args.focus_mode);
      const sessionId = optionalSessionId(args);
      const sessionAuditPayload = sessionId && isSessionSourceAuditFollowup(query)
        ? buildSessionSourceAuditPayload({ namespaceId, sessionId, query })
        : null;
      const rawPayload = sessionAuditPayload ?? await attachStableQueryContractEnvelope({
          toolName: "memory.search",
          queryText: query,
          namespaceId,
          payload: await searchMemory({
            query,
            namespaceId,
            timeStart: optionalString(args.time_start),
            timeEnd: optionalString(args.time_end),
            referenceNow: optionalString(args.reference_now),
            limit: optionalNumber(args.limit)
          })
        });
      const payload = await applySourcePrivacyGuard({ namespaceId, query, payload: rawPayload as Record<string, unknown> });
      recordSessionClaims({ namespaceId, sessionId, query, payload: payload as Record<string, unknown> });
      return wrapResult(compactPayloadForDetailMode({
        ...payload,
        sessionIdUsed: sessionId ?? null,
        detailModeUsed: detailMode,
        focusModeUsed: focusMode ?? null,
        humanReadable: presentHumanReadableQueryResult({ query, payload, detailMode, focusMode })
      }, detailMode));
    }
    case "memory.timeline":
      return wrapResult(
        await timelineMemory({
          namespaceId: requireString(args.namespace_id, "namespace_id"),
          timeStart: requireString(args.time_start, "time_start"),
          timeEnd: requireString(args.time_end, "time_end"),
          limit: optionalNumber(args.limit)
        })
      );
    case "memory.get_artifact":
      return wrapResult(await getArtifactDetail({ artifactId: requireString(args.artifact_id, "artifact_id") }));
    case "memory.get_relationships":
      return wrapResult(
        await getRelationships({
          namespaceId: requireString(args.namespace_id, "namespace_id"),
          entityName: requireString(args.entity_name, "entity_name"),
          predicate: optionalString(args.predicate),
          timeStart: optionalString(args.time_start),
          timeEnd: optionalString(args.time_end),
          includeHistorical: typeof args.include_historical === "boolean" ? args.include_historical : undefined,
          limit: optionalNumber(args.limit)
        })
      );
    case "memory.get_graph":
      return wrapResult(
        await getOpsRelationshipGraph(requireString(args.namespace_id, "namespace_id"), {
          entityName: optionalString(args.entity_name),
          timeStart: optionalString(args.time_start),
          timeEnd: optionalString(args.time_end),
          limit: optionalNumber(args.limit)
        })
      );
    case "memory.get_clarifications": {
      const namespaceId = requireString(args.namespace_id, "namespace_id");
      const rawQuery = optionalString(args.query)?.toLowerCase() ?? null;
      const inbox = await getOpsClarificationInbox(namespaceId, optionalNumber(args.limit) ?? 10);
      const items = rawQuery
        ? inbox.items.filter((item) => {
            const haystacks = [
              item.rawText,
              item.claimType,
              item.predicate,
              item.ambiguityType,
              item.ambiguityReason ?? "",
              item.sceneText ?? "",
              ...(item.suggestedMatches ?? [])
            ].join(" ").toLowerCase();
            return rawQuery.split(/\s+/u).every((token) => token.length < 2 || haystacks.includes(token));
          })
        : inbox.items;
      const suggestedMatches = [...new Set(items.flatMap((item) => item.suggestedMatches ?? []).filter(Boolean))].slice(0, 8);

      return wrapResult({
        namespaceId,
        summary: inbox.summary,
        items,
        guidance: {
          suggestedPrompt:
            items.length > 0
              ? `The brain needs clarification before it can answer confidently about: ${optionalString(args.query) ?? "the requested topic"}`
              : `No open clarification items matched ${optionalString(args.query) ?? "the requested topic"}.`,
          suggestedMatches
        }
      });
    }
    case "memory.list_corrections":
      return wrapResult(await listCorrections(args));
    case "memory.apply_correction":
      return wrapResult(await applyCorrection(args));
    case "memory.keep_correction_separate":
      return wrapResult(await keepCorrectionSeparate(args));
    case "memory.get_correction_status":
      return wrapResult(await getCorrectionStatus(args));
    case "memory.apply_source_privacy": {
      const namespaceId = requireString(args.namespace_id, "namespace_id");
      const overlay = await applySourcePrivacyOverlay({
        namespaceId,
        actionType: requireSourcePrivacyActionType(args.action_type),
        targetArtifactId: optionalString(args.target_artifact_id),
        targetSourceUri: optionalString(args.target_source_uri),
        targetChunkId: optionalString(args.target_chunk_id),
        redactionText: optionalString(args.redaction_text),
        accessLabel: optionalString(args.access_label),
        retentionPolicy: optionalString(args.retention_policy),
        reason: optionalString(args.reason),
        actor: optionalString(args.actor),
        payload: { mcpTool: "memory.apply_source_privacy" }
      });
      return wrapResult({
        namespaceId,
        overlay,
        sourceTruthPolicy: "Raw source truth is retained; this operation adds an active privacy overlay and audit trail.",
        statusTool: "memory.get_source_privacy_status",
        revertTool: "memory.revert_source_privacy"
      });
    }
    case "memory.revert_source_privacy": {
      const namespaceId = requireString(args.namespace_id, "namespace_id");
      const overlay = await revertSourcePrivacyOverlay({
        namespaceId,
        overlayId: requireString(args.overlay_id, "overlay_id"),
        actor: optionalString(args.actor),
        reason: optionalString(args.reason)
      });
      return wrapResult({
        namespaceId,
        overlay,
        reverted: Boolean(overlay),
        sourceTruthPolicy: "Raw source truth was never deleted; the privacy overlay status changed to reverted."
      });
    }
    case "memory.get_source_privacy_status":
      return wrapResult(await getSourcePrivacyStatus({
        namespaceId: requireString(args.namespace_id, "namespace_id"),
        targetArtifactId: optionalString(args.target_artifact_id),
        targetSourceUri: optionalString(args.target_source_uri),
        limit: optionalNumber(args.limit)
      }));
    case "memory.get_stats":
      return getStats(args);
    case "memory.get_protocols":
      return getProtocols(args);
    case "memory.save_candidate":
      return saveCandidate(args);
    case "memory.upsert_state":
      return upsertState(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function parseToolArgs(params: unknown): ToolCallArgs {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }

  const record = params as Record<string, unknown>;
  const argumentsValue = optionalObject(record.arguments);
  const directArgs = optionalObject(record.args);
  return {
    ...(directArgs ?? {}),
    ...(argumentsValue ?? {}),
    ...(record.arguments && !argumentsValue ? { arguments: record.arguments } : {}),
    ...(record.args && !directArgs ? { args: record.args } : {})
  };
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse | null> {
  if (request.method === "initialize") {
    return ok(request.id ?? null, {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "ai-brain-local-mcp",
        version: "0.1.0"
      },
      capabilities: {
        tools: {}
      }
    });
  }

  if (request.method === "tools/list") {
    return ok(request.id ?? null, {
      tools: listTools()
    });
  }

  if (request.method === "tools/call") {
    const params = optionalObject(request.params) ?? {};
    const toolName = requireString(params.name, "name");
    const toolArgs = parseToolArgs(params);
    const result = await executeMcpTool(toolName, toolArgs);
    return ok(request.id ?? null, result);
  }

  if (request.id === undefined) {
    return null;
  }

  return fail(request.id ?? null, -32601, `Method not found: ${request.method}`);
}

export async function startMcpStdioServer(): Promise<void> {
  stdin.setEncoding("utf8");

  let buffer = "";

  const drain = async (): Promise<void> => {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headerBlock = buffer.slice(0, headerEnd);
      const contentLengthLine = headerBlock
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));

      if (!contentLengthLine) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(contentLengthLine.split(":")[1]?.trim());
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) {
        return;
      }

      const body = buffer.slice(bodyStart, bodyEnd);
      buffer = buffer.slice(bodyEnd);

      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(body) as JsonRpcRequest;
      } catch (error) {
        writeFrame(fail(null, -32700, "Parse error", error instanceof Error ? error.message : String(error)));
        continue;
      }

      if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
        writeFrame(fail(parsed.id ?? null, -32600, "Invalid Request"));
        continue;
      }

      try {
        const response = await handleRequest(parsed);
        if (response) {
          writeFrame(response);
        }
      } catch (error) {
        writeFrame(
          fail(
            parsed.id ?? null,
            -32000,
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? { name: error.name } : undefined
          )
        );
      }
    }
  };

  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    void drain();
  });

  stdin.on("end", () => {
    process.exit(0);
  });

  process.on("SIGINT", () => {
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.exit(0);
  });
}
