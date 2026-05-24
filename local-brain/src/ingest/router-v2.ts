import { createHash } from "node:crypto";
import path from "node:path";
import { readConfig } from "../config.js";
import { GLINER_RELEX_EXTRACTOR } from "../relationships/relex-schema.js";
import {
  primaryRetrievalDomainForSourceRoute,
  retrievalDomainsForSourceRoute,
  type RetrievalDomain
} from "../taxonomy/retrieval-domain-registry.js";
import type { SourceType } from "../types.js";
import { buildSourceEnvelopeAdapterOutput, type SourceEnvelope, type SourceEnvelopeAdapterOutput, type SourceEnvelopeType } from "./source-envelope.js";
import { buildSourceCapabilityProfile, type SourceCapabilityProfile } from "./source-capability.js";

export type IngestionRouterV2SourceRoute =
  | SourceEnvelopeType
  | "locomo"
  | "longmem"
  | "watched_source"
  | "transcript_specialized"
  | "unsupported_binary";

export type SourceIntelligenceProfile =
  | "structured"
  | "semi_structured"
  | "dialogue"
  | "transcript"
  | "document"
  | "task_list"
  | "generic_text"
  | "unsupported_binary";

export type TaxonomyProfile =
  | "direct_fact"
  | "relation_event"
  | "temporal_event"
  | "task_ops"
  | "profile_report"
  | "document_summary"
  | "review_only";

export interface SourceIntelligenceRouting {
  readonly sourceIntelligenceProfile: SourceIntelligenceProfile;
  readonly taxonomyProfile: TaxonomyProfile;
  readonly taxonomyProfiles: readonly TaxonomyProfile[];
  readonly extractionPolicy: {
    readonly dialogueAwareSubjectBinding: boolean;
    readonly preserveDocumentStructure: boolean;
    readonly taskFirst: boolean;
    readonly relationEventExtraction: boolean;
    readonly temporalExtraction: boolean;
    readonly assistantAdjudication: "never" | "ambiguous_ingest_only";
    readonly reviewOnly: boolean;
  };
  readonly candidateFamilies: readonly string[];
  readonly candidateBufferKind: "universal_candidate_buffer" | "relationship_candidates" | "review_only" | "none";
  readonly rejectionPolicy: readonly string[];
  readonly reason: string;
}

export interface IngestionRouterV2Input {
  readonly namespaceId: string;
  readonly sourceType: SourceType | string;
  readonly sourceUri: string;
  readonly capturedAt: string | null;
  readonly rawText: string;
  readonly authorHint?: string | null;
  readonly mimeType?: string | null;
  readonly sourceChannel?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface IngestionRouterV2Packet {
  readonly routerVersion: "ingestion_router_v2";
  readonly sourceType: string;
  readonly sourceRoute: IngestionRouterV2SourceRoute;
  readonly envelopeSourceType: SourceEnvelopeType | null;
  readonly sourceUri: string;
  readonly capturedAt: string | null;
  readonly sourceId: string | null;
  readonly sourceHash: string;
  readonly adapter: SourceEnvelopeAdapterOutput | null;
  readonly sourceIntelligenceProfile: SourceIntelligenceProfile;
  readonly taxonomyProfile: TaxonomyProfile;
  readonly primaryRetrievalDomain: RetrievalDomain;
  readonly retrievalDomainCandidates: readonly RetrievalDomain[];
  readonly sourceIntelligence: SourceIntelligenceRouting;
  readonly sourceCapabilityProfile: SourceCapabilityProfile;
  readonly enrichment: {
    readonly packetVersion: "ingestion_enrichment_packet_v1";
    readonly sourceIntelligenceProfile: SourceIntelligenceProfile;
    readonly taxonomyProfile: TaxonomyProfile;
    readonly taxonomyProfiles: readonly TaxonomyProfile[];
    readonly primaryRetrievalDomain: RetrievalDomain;
    readonly retrievalDomainCandidates: readonly RetrievalDomain[];
    readonly assistantAdjudicationStatus: "not_required" | "ingest_only_pending" | "skipped";
    readonly candidateBufferKind: SourceIntelligenceRouting["candidateBufferKind"];
    readonly gliner2CallCount: number;
    readonly relexCallCount: number;
    readonly assistantCallCount: number;
    readonly queryTimeModelCalls: number;
    readonly cacheIdentity: {
      readonly taxonomyVersion: "memory_taxonomy_v1";
      readonly schemaVersion: "ingestion_enrichment_packet_v1";
      readonly promptVersion: "ingestion_router_v2_shadow";
      readonly gliner2ModelId: string;
      readonly relexExtractor: typeof GLINER_RELEX_EXTRACTOR;
      readonly relexModelId: string;
      readonly relexSchemaVersion: string;
      readonly thresholds: {
        readonly entity: number;
        readonly relation: number;
        readonly classification: number;
        readonly structure: number;
      };
      readonly signature: string;
    };
    readonly gliner2SpanCount: number;
    readonly relexTupleCount: number;
    readonly universalCandidateCount: number;
    readonly candidateBufferCount: number;
    readonly extractedEntityCount: number;
    readonly extractedRelationCount: number;
    readonly assistantCandidateCount: number;
    readonly promotedCount: number;
    readonly rejectedCount: number;
    readonly rejectionReasons: readonly string[];
  };
  readonly metrics: {
    readonly chunkCount: number;
    readonly extractionUnitCount: number;
    readonly provenanceComplete: boolean;
    readonly inputTokenP50: number;
    readonly inputTokenP95: number;
    readonly inputTokenMax: number;
    readonly emptyOrBoilerplateChunkCount: number;
    readonly jsonValid: boolean;
    readonly promotionSafetyViolations: readonly string[];
    readonly sourceCapabilityUnsupportedCount: number;
  };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function textIncludes(value: unknown, pattern: RegExp): boolean {
  return pattern.test(String(value ?? ""));
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function classifyIngestionSourceRoute(input: {
  readonly sourceType?: SourceType | string | null;
  readonly sourceUri?: string | null;
  readonly mimeType?: string | null;
  readonly sourceChannel?: string | null;
  readonly metadata?: Record<string, unknown>;
}): {
  readonly sourceRoute: IngestionRouterV2SourceRoute;
  readonly envelopeSourceType: SourceEnvelopeType | null;
} {
  const explicit = normalize(input.sourceType);
  const uri = normalize(input.sourceUri);
  const mime = normalize(input.mimeType);
  const channel = normalize(input.sourceChannel);
  const extension = path.extname(uri).toLowerCase();
  const monitoredSourceType = normalize(metadataString(input.metadata, "monitored_source_type"));
  const benchmarkDataset = normalize(metadataString(input.metadata, "benchmark_dataset"));
  const sourceTypeHint = normalize(metadataString(input.metadata, "source_type_hint"));
  const hasTextProxy = Boolean(metadataString(input.metadata, "extracted_text")) || Boolean(metadataString(input.metadata, "extracted_text_path"));

  if (explicit === "audio" || explicit === "video" || explicit === "image") {
    if (hasTextProxy) {
      return { sourceRoute: "generic_text", envelopeSourceType: "generic_text" };
    }
    return { sourceRoute: "unsupported_binary", envelopeSourceType: null };
  }
  if (explicit === "transcript" || sourceTypeHint === "asr") {
    return { sourceRoute: "asr", envelopeSourceType: "asr" };
  }
  if (textIncludes(channel, /\blocomo\b/u) || benchmarkDataset === "locomo" || textIncludes(uri, /\blocomo\b/u)) {
    return { sourceRoute: "locomo", envelopeSourceType: "chat" };
  }
  if (textIncludes(channel, /\blongmem\b/u) || benchmarkDataset === "longmem" || textIncludes(uri, /\blongmem\b/u)) {
    return { sourceRoute: "longmem", envelopeSourceType: "chat" };
  }
  if (textIncludes(channel, /bootstrap:|watched|monitor/u) || Boolean(input.metadata?.monitored_source)) {
    return { sourceRoute: "watched_source", envelopeSourceType: "markdown" };
  }
  if (explicit === "markdown" || explicit === "markdown_session" || sourceTypeHint === "markdown" || extension === ".md" || mime.includes("markdown")) {
    return { sourceRoute: "markdown", envelopeSourceType: "markdown" };
  }
  if (explicit === "pdf" || sourceTypeHint === "pdf" || extension === ".pdf" || mime.includes("pdf")) {
    return { sourceRoute: "pdf", envelopeSourceType: "pdf" };
  }
  if (explicit === "chat_turn" || sourceTypeHint === "chat" || channel.includes("chat") || uri.startsWith("chat:")) {
    return { sourceRoute: "chat", envelopeSourceType: "chat" };
  }
  if (explicit === "task_list" || uri.startsWith("tasks:") || sourceTypeHint === "task_list") {
    return { sourceRoute: "task_list", envelopeSourceType: "task_list" };
  }
  if (explicit === "calendar_export" || uri.startsWith("calendar:") || sourceTypeHint === "calendar" || sourceTypeHint === "calendar_export" || extension === ".ics") {
    return { sourceRoute: "calendar", envelopeSourceType: "calendar" };
  }
  if (textIncludes(channel, /\bomi\b/u) || textIncludes(uri, /^omi:/u) || monitoredSourceType === "omi" || sourceTypeHint === "omi") {
    return { sourceRoute: "omi", envelopeSourceType: "omi" };
  }
  if (explicit === "project_note") {
    return { sourceRoute: "markdown", envelopeSourceType: "markdown" };
  }
  if (explicit === "text" || mime.startsWith("text/") || extension === ".txt") {
    return { sourceRoute: "generic_text", envelopeSourceType: "generic_text" };
  }
  return { sourceRoute: "generic_text", envelopeSourceType: "generic_text" };
}

export function buildSourceIntelligenceRouting(sourceRoute: IngestionRouterV2SourceRoute): SourceIntelligenceRouting {
  const baseRejectionPolicy = [
    "missing_source_quote",
    "subject_binding_missing",
    "object_binding_missing",
    "unknown_taxonomy",
    "mixed_owner",
    "co_mention_only",
    "value_shape_mismatch",
    "source_provenance_missing"
  ] as const;
  switch (sourceRoute) {
    case "omi":
      return {
        sourceIntelligenceProfile: "semi_structured",
        taxonomyProfile: "direct_fact",
        taxonomyProfiles: ["direct_fact", "temporal_event", "relation_event"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: false,
          preserveDocumentStructure: false,
          taskFirst: false,
          relationEventExtraction: true,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["personal_observation", "direct_fact", "preference", "health_status", "project_goal", "date_activity"],
        candidateBufferKind: "universal_candidate_buffer",
        rejectionPolicy: baseRejectionPolicy,
        reason: "omi concise personal observations prefer direct facts with temporal/relation support"
      };
    case "markdown":
      return {
        sourceIntelligenceProfile: "document",
        taxonomyProfile: "document_summary",
        taxonomyProfiles: ["document_summary", "direct_fact", "task_ops"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: false,
          preserveDocumentStructure: true,
          taskFirst: false,
          relationEventExtraction: true,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["document_fact", "section_fact", "direct_fact", "task_item"],
        candidateBufferKind: "universal_candidate_buffer",
        rejectionPolicy: baseRejectionPolicy,
        reason: "markdown keeps section structure and document facts before direct observations"
      };
    case "pdf":
      return {
        sourceIntelligenceProfile: "document",
        taxonomyProfile: "document_summary",
        taxonomyProfiles: ["document_summary", "direct_fact", "temporal_event"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: false,
          preserveDocumentStructure: true,
          taskFirst: false,
          relationEventExtraction: true,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["document_fact", "page_fact", "direct_fact", "temporal_event"],
        candidateBufferKind: "universal_candidate_buffer",
        rejectionPolicy: baseRejectionPolicy,
        reason: "pdf text preserves page/section evidence and bounded document facts"
      };
    case "asr":
    case "transcript_specialized":
      return {
        sourceIntelligenceProfile: "transcript",
        taxonomyProfile: "relation_event",
        taxonomyProfiles: ["relation_event", "direct_fact", "temporal_event", "profile_report"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: true,
          preserveDocumentStructure: false,
          taskFirst: false,
          relationEventExtraction: true,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["speaker_fact", "relation_event", "direct_fact", "temporal_event", "profile_report"],
        candidateBufferKind: "relationship_candidates",
        rejectionPolicy: baseRejectionPolicy,
        reason: "transcripts need speaker-bound dialogue extraction and relation/event candidates"
      };
    case "chat":
      return {
        sourceIntelligenceProfile: "dialogue",
        taxonomyProfile: "relation_event",
        taxonomyProfiles: ["relation_event", "direct_fact", "temporal_event", "profile_report"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: true,
          preserveDocumentStructure: false,
          taskFirst: false,
          relationEventExtraction: true,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["dialogue_fact", "relation_event", "direct_fact", "temporal_event", "profile_report"],
        candidateBufferKind: "relationship_candidates",
        rejectionPolicy: baseRejectionPolicy,
        reason: "chat requires subject/speaker binding before relation or direct-fact promotion"
      };
    case "task_list":
      return {
        sourceIntelligenceProfile: "task_list",
        taxonomyProfile: "task_ops",
        taxonomyProfiles: ["task_ops", "direct_fact", "temporal_event"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: false,
          preserveDocumentStructure: true,
          taskFirst: true,
          relationEventExtraction: false,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["task_item", "task_status", "task_due_date", "direct_fact"],
        candidateBufferKind: "universal_candidate_buffer",
        rejectionPolicy: baseRejectionPolicy,
        reason: "task lists use task taxonomy first and only promote source-bound side facts"
      };
    case "calendar":
      return {
        sourceIntelligenceProfile: "structured",
        taxonomyProfile: "temporal_event",
        taxonomyProfiles: ["temporal_event", "direct_fact", "task_ops"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: false,
          preserveDocumentStructure: true,
          taskFirst: false,
          relationEventExtraction: false,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["calendar_event", "temporal_event", "commitment", "task_due_date"],
        candidateBufferKind: "universal_candidate_buffer",
        rejectionPolicy: baseRejectionPolicy,
        reason: "calendar exports are structured temporal sources and must preserve event-time provenance"
      };
    case "locomo":
      return {
        sourceIntelligenceProfile: "dialogue",
        taxonomyProfile: "direct_fact",
        taxonomyProfiles: ["direct_fact", "relation_event", "temporal_event", "profile_report"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: true,
          preserveDocumentStructure: false,
          taskFirst: false,
          relationEventExtraction: true,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["direct_fact", "relation_event", "profile_report", "temporal_event", "causal_reason"],
        candidateBufferKind: "relationship_candidates",
        rejectionPolicy: baseRejectionPolicy,
        reason: "locomo dialogue prioritizes source-bound direct facts with relation/profile support"
      };
    case "longmem":
      return {
        sourceIntelligenceProfile: "dialogue",
        taxonomyProfile: "direct_fact",
        taxonomyProfiles: ["direct_fact", "relation_event", "temporal_event"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: true,
          preserveDocumentStructure: false,
          taskFirst: false,
          relationEventExtraction: true,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["direct_fact", "relation_event", "temporal_event", "goal_or_project"],
        candidateBufferKind: "relationship_candidates",
        rejectionPolicy: baseRejectionPolicy,
        reason: "longmem sessions need dialogue-aware direct facts and temporal relation events"
      };
    case "watched_source":
      return {
        sourceIntelligenceProfile: "document",
        taxonomyProfile: "document_summary",
        taxonomyProfiles: ["document_summary", "direct_fact", "task_ops", "profile_report"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: false,
          preserveDocumentStructure: true,
          taskFirst: false,
          relationEventExtraction: true,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: false
        },
        candidateFamilies: ["document_fact", "direct_fact", "profile_report", "task_item"],
        candidateBufferKind: "universal_candidate_buffer",
        rejectionPolicy: baseRejectionPolicy,
        reason: "watched sources preserve document context and monitored-source provenance"
      };
    case "generic_text":
      return {
        sourceIntelligenceProfile: "generic_text",
        taxonomyProfile: "review_only",
        taxonomyProfiles: ["review_only", "direct_fact"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: false,
          preserveDocumentStructure: false,
          taskFirst: false,
          relationEventExtraction: false,
          temporalExtraction: true,
          assistantAdjudication: "ambiguous_ingest_only",
          reviewOnly: true
        },
        candidateFamilies: ["review_only", "direct_fact_candidate"],
        candidateBufferKind: "review_only",
        rejectionPolicy: [...baseRejectionPolicy, "review_only_taxonomy_profile"],
        reason: "generic text defaults to review-only unless later deterministic gates prove a source-bound fact"
      };
    case "unsupported_binary":
      return {
        sourceIntelligenceProfile: "unsupported_binary",
        taxonomyProfile: "review_only",
        taxonomyProfiles: ["review_only"],
        extractionPolicy: {
          dialogueAwareSubjectBinding: false,
          preserveDocumentStructure: false,
          taskFirst: false,
          relationEventExtraction: false,
          temporalExtraction: false,
          assistantAdjudication: "never",
          reviewOnly: true
        },
        candidateFamilies: ["unsupported_binary"],
        candidateBufferKind: "none",
        rejectionPolicy: ["unsupported_binary_source"],
        reason: "binary sources must preprocess to text before Router v2 enrichment"
      };
  }
}

function buildCacheIdentity(
  sourceHash: string,
  sourceRoute: IngestionRouterV2SourceRoute,
  sourceIntelligence: SourceIntelligenceRouting
): IngestionRouterV2Packet["enrichment"]["cacheIdentity"] {
  const config = readConfig();
  const identity = {
    taxonomyVersion: "memory_taxonomy_v1" as const,
    schemaVersion: "ingestion_enrichment_packet_v1" as const,
    promptVersion: "ingestion_router_v2_shadow" as const,
    gliner2ModelId: config.relationIeGliner2Model,
    relexExtractor: GLINER_RELEX_EXTRACTOR as typeof GLINER_RELEX_EXTRACTOR,
    relexModelId: config.relationIeGlinerRelexModel,
    relexSchemaVersion: config.relationIeGlinerRelexSchemaVersion,
    thresholds: {
      entity: config.relationIeEntityThreshold,
      relation: config.relationIeRelationThreshold,
      classification: config.relationIeClassificationThreshold,
      structure: config.relationIeStructureThreshold
    },
    signature: ""
  };
  const signature = stableHash(
    JSON.stringify({
      ...identity,
      signature: undefined,
      sourceHash,
      sourceRoute,
      sourceIntelligenceProfile: sourceIntelligence.sourceIntelligenceProfile,
      taxonomyProfiles: sourceIntelligence.taxonomyProfiles
    })
  ).slice(0, 32);
  return { ...identity, signature };
}

export function buildIngestionRouterV2Packet(input: IngestionRouterV2Input): IngestionRouterV2Packet {
  const classification = classifyIngestionSourceRoute(input);
  const sourceIntelligence = buildSourceIntelligenceRouting(classification.sourceRoute);
  const retrievalDomainCandidates = retrievalDomainsForSourceRoute(classification.sourceRoute, sourceIntelligence.taxonomyProfile);
  const primaryRetrievalDomain = primaryRetrievalDomainForSourceRoute(classification.sourceRoute, sourceIntelligence.taxonomyProfile);
  const sourceHash = stableHash(input.rawText);
  const envelope: SourceEnvelope | null = classification.envelopeSourceType
    ? {
        namespaceId: input.namespaceId,
        sourceType: classification.envelopeSourceType,
        sourceUri: input.sourceUri,
        capturedAt: input.capturedAt,
        authorHint: input.authorHint ?? metadataString(input.metadata, "author_hint"),
        formatMetadata: {
          ...(input.metadata ?? {}),
          original_source_type: input.sourceType,
          source_route: classification.sourceRoute,
          mime_type: input.mimeType ?? null,
          source_channel: input.sourceChannel ?? null
        },
        rawText: input.rawText
      }
    : null;
  const adapter = envelope ? buildSourceEnvelopeAdapterOutput(envelope) : null;
  const sourceCapabilityProfile = buildSourceCapabilityProfile({
    sourceType: input.sourceType,
    sourceRoute: classification.sourceRoute,
    envelopeSourceType: classification.envelopeSourceType,
    sourceIntelligence,
    adapter,
    metadata: input.metadata
  });
  const tokenEstimates = adapter?.extractionUnits.map((unit) => unit.tokenEstimate) ?? [];
  const promotionSafetyViolations: string[] = [];
  if (adapter && !adapter.metrics.provenanceComplete) {
    promotionSafetyViolations.push("source_provenance_incomplete");
  }
  return {
    routerVersion: "ingestion_router_v2",
    sourceType: input.sourceType,
    sourceRoute: classification.sourceRoute,
    envelopeSourceType: classification.envelopeSourceType,
    sourceUri: input.sourceUri,
    capturedAt: input.capturedAt,
    sourceId: adapter?.sourceId ?? null,
    sourceHash,
    adapter,
    sourceIntelligenceProfile: sourceIntelligence.sourceIntelligenceProfile,
    taxonomyProfile: sourceIntelligence.taxonomyProfile,
    primaryRetrievalDomain,
    retrievalDomainCandidates,
    sourceIntelligence,
    sourceCapabilityProfile,
    enrichment: {
      packetVersion: "ingestion_enrichment_packet_v1",
      sourceIntelligenceProfile: sourceIntelligence.sourceIntelligenceProfile,
      taxonomyProfile: sourceIntelligence.taxonomyProfile,
      taxonomyProfiles: sourceIntelligence.taxonomyProfiles,
      primaryRetrievalDomain,
      retrievalDomainCandidates,
      assistantAdjudicationStatus:
        sourceIntelligence.extractionPolicy.assistantAdjudication === "never" ? "not_required" : "ingest_only_pending",
      candidateBufferKind: sourceIntelligence.candidateBufferKind,
      gliner2CallCount: 0,
      relexCallCount: 0,
      assistantCallCount: 0,
      queryTimeModelCalls: 0,
      cacheIdentity: buildCacheIdentity(sourceHash, classification.sourceRoute, sourceIntelligence),
      gliner2SpanCount: 0,
      relexTupleCount: 0,
      universalCandidateCount: 0,
      candidateBufferCount: 0,
      extractedEntityCount: 0,
      extractedRelationCount: 0,
      assistantCandidateCount: 0,
      promotedCount: 0,
      rejectedCount: 0,
      rejectionReasons: sourceIntelligence.extractionPolicy.reviewOnly ? sourceIntelligence.rejectionPolicy : []
    },
    metrics: {
      chunkCount: adapter?.metrics.chunkCount ?? 0,
      extractionUnitCount: adapter?.metrics.extractionUnitCount ?? 0,
      provenanceComplete: adapter?.metrics.provenanceComplete ?? false,
      inputTokenP50: percentile(tokenEstimates, 50),
      inputTokenP95: adapter?.metrics.inputTokenP95 ?? 0,
      inputTokenMax: adapter?.metrics.inputTokenMax ?? 0,
      emptyOrBoilerplateChunkCount: adapter?.metrics.emptyOrBoilerplateChunkCount ?? 0,
      jsonValid: true,
      promotionSafetyViolations,
      sourceCapabilityUnsupportedCount: sourceCapabilityProfile.unsupportedCapabilities.length
    }
  };
}

export function ingestionRouterV2Metadata(packet: IngestionRouterV2Packet): Record<string, unknown> {
  return {
    router_version: packet.routerVersion,
    packet_version: packet.enrichment.packetVersion,
    source_route: packet.sourceRoute,
    source_type: packet.sourceType,
    envelope_source_type: packet.envelopeSourceType,
    source_uri: packet.sourceUri,
    source_id: packet.sourceId,
    source_hash: packet.sourceHash,
    captured_at: packet.capturedAt,
    source_intelligence_profile: packet.sourceIntelligenceProfile,
    taxonomy_profile: packet.taxonomyProfile,
    taxonomy_profiles: packet.sourceIntelligence.taxonomyProfiles,
    primary_retrieval_domain: packet.primaryRetrievalDomain,
    retrieval_domain_candidates: packet.retrievalDomainCandidates,
    source_intelligence_reason: packet.sourceIntelligence.reason,
    source_intelligence_policy: packet.sourceIntelligence.extractionPolicy,
    source_capability_profile: packet.sourceCapabilityProfile,
    source_capability_kind: packet.sourceCapabilityProfile.sourceKind,
    source_capability_authoritative_for: packet.sourceCapabilityProfile.authoritativeFor,
    source_capability_expected_read_models: packet.sourceCapabilityProfile.expectedReadModels,
    source_capability_unsupported: packet.sourceCapabilityProfile.unsupportedCapabilities,
    candidate_families: packet.sourceIntelligence.candidateFamilies,
    candidate_buffer_kind: packet.sourceIntelligence.candidateBufferKind,
    chunk_count: packet.metrics.chunkCount,
    extraction_unit_count: packet.metrics.extractionUnitCount,
    provenance_complete: packet.metrics.provenanceComplete,
    input_token_p50: packet.metrics.inputTokenP50,
    input_token_p95: packet.metrics.inputTokenP95,
    input_token_max: packet.metrics.inputTokenMax,
    empty_or_boilerplate_chunk_count: packet.metrics.emptyOrBoilerplateChunkCount,
    json_valid: packet.metrics.jsonValid,
    gliner2_call_count: packet.enrichment.gliner2CallCount,
    relex_call_count: packet.enrichment.relexCallCount,
    assistant_call_count: packet.enrichment.assistantCallCount,
    query_time_model_calls: packet.enrichment.queryTimeModelCalls,
    gliner2_span_count: packet.enrichment.gliner2SpanCount,
    relex_tuple_count: packet.enrichment.relexTupleCount,
    assistant_adjudication_status: packet.enrichment.assistantAdjudicationStatus,
    universal_candidate_count: packet.enrichment.universalCandidateCount,
    candidate_buffer_count: packet.enrichment.candidateBufferCount,
    extracted_entity_count: packet.enrichment.extractedEntityCount,
    extracted_relation_count: packet.enrichment.extractedRelationCount,
    assistant_candidate_count: packet.enrichment.assistantCandidateCount,
    promoted_count: packet.enrichment.promotedCount,
    rejected_count: packet.enrichment.rejectedCount,
    rejection_reasons: packet.enrichment.rejectionReasons,
    enrichment_cache_signature: packet.enrichment.cacheIdentity.signature,
    enrichment_cache_identity: packet.enrichment.cacheIdentity,
    promotion_safety_violations: packet.metrics.promotionSafetyViolations,
    source_capability_unsupported_count: packet.metrics.sourceCapabilityUnsupportedCount
  };
}
