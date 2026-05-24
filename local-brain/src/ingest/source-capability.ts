import type { SourceType } from "../types.js";
import type { IngestionRouterV2SourceRoute, SourceIntelligenceRouting } from "./router-v2.js";
import type { SourceEnvelopeAdapterOutput, SourceEnvelopeType } from "./source-envelope.js";

export type SourceCapabilityKind =
  | "personal_note"
  | "document"
  | "pdf_document"
  | "image_ocr"
  | "audio_transcript"
  | "video_transcript"
  | "task_export"
  | "calendar_export"
  | "dialogue"
  | "generic_text"
  | "unsupported_binary";

export interface SourceCapabilityProfile {
  readonly version: "source_capability_profile_v1";
  readonly sourceKind: SourceCapabilityKind;
  readonly sourceRoute: IngestionRouterV2SourceRoute;
  readonly envelopeSourceType: SourceEnvelopeType | null;
  readonly originalSourceType: string;
  readonly authoritativeFor: readonly (
    | "personal_fact"
    | "relationship_context"
    | "document_fact"
    | "procedure"
    | "task_lifecycle"
    | "calendar_event"
    | "temporal_event"
    | "source_topic"
    | "media_observation"
  )[];
  readonly structuralUnits: readonly ("document" | "section" | "page" | "paragraph" | "record" | "turn" | "task" | "calendar_event" | "ocr_block")[];
  readonly temporalAnchorSupport: {
    readonly capturedAt: boolean;
    readonly occurredAtCandidates: boolean;
    readonly eventWindowCandidates: boolean;
    readonly relativeTemporalPhrases: boolean;
  };
  readonly identityAnchorSupport: {
    readonly speakerHints: boolean;
    readonly namedEntities: boolean;
    readonly sourceOwner: boolean;
    readonly roleCandidates: boolean;
  };
  readonly taskEventSupport: {
    readonly taskCandidates: boolean;
    readonly taskStatusCandidates: boolean;
    readonly dueDateCandidates: boolean;
    readonly calendarEventCandidates: boolean;
  };
  readonly provenanceSupport: {
    readonly sourceUri: boolean;
    readonly sourceHash: boolean;
    readonly chunkIds: boolean;
    readonly characterOffsets: boolean;
    readonly pageNumbers: boolean;
    readonly extractionProvider: string | null;
  };
  readonly privacyDefaultLabel: "personal" | "work" | "public" | "private" | "unknown";
  readonly expectedReadModels: readonly string[];
  readonly unsupportedCapabilities: readonly string[];
  readonly quality: {
    readonly hasTextContent: boolean;
    readonly chunkCount: number;
    readonly extractionUnitCount: number;
    readonly provenanceComplete: boolean;
    readonly structurePreserved: boolean;
    readonly needsProviderExtraction: boolean;
  };
}

function sourceKindFor(params: {
  readonly sourceType: string;
  readonly sourceRoute: IngestionRouterV2SourceRoute;
  readonly metadata?: Record<string, unknown>;
}): SourceCapabilityKind {
  const explicit = params.sourceType.toLowerCase();
  const sourceKindFamily = String(params.metadata?.source_kind_family ?? "").toLowerCase();
  if (params.sourceRoute === "unsupported_binary") return "unsupported_binary";
  if (params.sourceRoute === "omi") return "personal_note";
  if (params.sourceRoute === "pdf") return "pdf_document";
  if (explicit === "image") return "image_ocr";
  if (explicit === "audio") return "audio_transcript";
  if (explicit === "video") return "video_transcript";
  if (params.sourceRoute === "task_list") return "task_export";
  if (params.sourceRoute === "calendar") return "calendar_export";
  if (params.sourceRoute === "chat" || params.sourceRoute === "asr" || params.sourceRoute === "locomo" || params.sourceRoute === "longmem") return "dialogue";
  if (sourceKindFamily.includes("email") || sourceKindFamily.includes("thread")) return "document";
  if (params.sourceRoute === "markdown" || params.sourceRoute === "watched_source") return "document";
  return "generic_text";
}

function authoritativeFor(kind: SourceCapabilityKind): SourceCapabilityProfile["authoritativeFor"] {
  switch (kind) {
    case "personal_note":
      return ["personal_fact", "relationship_context", "temporal_event", "source_topic"];
    case "pdf_document":
    case "document":
      return ["document_fact", "procedure", "source_topic", "temporal_event"];
    case "image_ocr":
      return ["media_observation", "document_fact", "source_topic"];
    case "audio_transcript":
    case "video_transcript":
    case "dialogue":
      return ["personal_fact", "relationship_context", "temporal_event", "source_topic"];
    case "task_export":
      return ["task_lifecycle", "temporal_event"];
    case "calendar_export":
      return ["calendar_event", "temporal_event"];
    case "generic_text":
      return ["source_topic"];
    case "unsupported_binary":
      return [];
  }
}

function structuralUnits(kind: SourceCapabilityKind, envelopeSourceType: SourceEnvelopeType | null): SourceCapabilityProfile["structuralUnits"] {
  if (kind === "pdf_document") return ["document", "page", "paragraph"];
  if (kind === "image_ocr") return ["document", "ocr_block"];
  if (kind === "task_export") return ["record", "task"];
  if (kind === "calendar_export") return ["record", "calendar_event"];
  if (kind === "dialogue" || envelopeSourceType === "chat" || envelopeSourceType === "asr") return ["turn", "paragraph"];
  if (kind === "document") return ["document", "section", "paragraph"];
  return envelopeSourceType ? ["paragraph"] : [];
}

function expectedReadModels(kind: SourceCapabilityKind, sourceIntelligence: SourceIntelligenceRouting): readonly string[] {
  const base = [...sourceIntelligence.taxonomyProfiles];
  switch (kind) {
    case "task_export":
      return [...new Set([...base, "task_lifecycle_projection"])];
    case "calendar_export":
      return [...new Set([...base, "temporal_event_projection"])];
    case "pdf_document":
    case "document":
    case "image_ocr":
      return [...new Set([...base, "source_topic_report", "document_lookup"])];
    case "dialogue":
      return [...new Set([...base, "relationship_graph", "temporal_event_projection"])];
    default:
      return base;
  }
}

export function buildSourceCapabilityProfile(params: {
  readonly sourceType: SourceType | string;
  readonly sourceRoute: IngestionRouterV2SourceRoute;
  readonly envelopeSourceType: SourceEnvelopeType | null;
  readonly sourceIntelligence: SourceIntelligenceRouting;
  readonly adapter: SourceEnvelopeAdapterOutput | null;
  readonly metadata?: Record<string, unknown>;
}): SourceCapabilityProfile {
  const sourceKind = sourceKindFor({
    sourceType: params.sourceType,
    sourceRoute: params.sourceRoute,
    metadata: params.metadata
  });
  const hasProviderExtraction =
    typeof params.metadata?.extracted_text === "string" ||
    typeof params.metadata?.extracted_text_path === "string" ||
    typeof params.metadata?.document_extraction_provider === "string";
  const pageNumbers = params.adapter?.artifactChunks.some((chunk) => typeof chunk.metadata.page === "number") ?? false;
  const structurePreserved = params.sourceIntelligence.extractionPolicy.preserveDocumentStructure || structuralUnits(sourceKind, params.envelopeSourceType).length > 1;
  const unsupportedCapabilities: string[] = [];
  if (sourceKind === "unsupported_binary") unsupportedCapabilities.push("text_extraction_missing");
  if ((sourceKind === "pdf_document" || sourceKind === "image_ocr") && !hasProviderExtraction) unsupportedCapabilities.push("provider_extraction_missing");
  if ((sourceKind === "pdf_document" || sourceKind === "image_ocr") && !params.adapter?.metrics.provenanceComplete) unsupportedCapabilities.push("layout_provenance_incomplete");
  return {
    version: "source_capability_profile_v1",
    sourceKind,
    sourceRoute: params.sourceRoute,
    envelopeSourceType: params.envelopeSourceType,
    originalSourceType: String(params.sourceType),
    authoritativeFor: authoritativeFor(sourceKind),
    structuralUnits: structuralUnits(sourceKind, params.envelopeSourceType),
    temporalAnchorSupport: {
      capturedAt: true,
      occurredAtCandidates: params.sourceIntelligence.extractionPolicy.temporalExtraction,
      eventWindowCandidates: sourceKind === "calendar_export" || params.sourceIntelligence.taxonomyProfiles.includes("temporal_event"),
      relativeTemporalPhrases: params.sourceIntelligence.extractionPolicy.temporalExtraction
    },
    identityAnchorSupport: {
      speakerHints: params.sourceIntelligence.extractionPolicy.dialogueAwareSubjectBinding,
      namedEntities: !params.sourceIntelligence.extractionPolicy.reviewOnly,
      sourceOwner: sourceKind === "personal_note" || sourceKind === "dialogue",
      roleCandidates: params.sourceIntelligence.extractionPolicy.relationEventExtraction
    },
    taskEventSupport: {
      taskCandidates: params.sourceIntelligence.extractionPolicy.taskFirst || params.sourceIntelligence.taxonomyProfiles.includes("task_ops"),
      taskStatusCandidates: sourceKind === "task_export",
      dueDateCandidates: sourceKind === "task_export",
      calendarEventCandidates: sourceKind === "calendar_export"
    },
    provenanceSupport: {
      sourceUri: Boolean(params.adapter?.envelope.sourceUri),
      sourceHash: true,
      chunkIds: (params.adapter?.artifactChunks.length ?? 0) > 0,
      characterOffsets: params.adapter?.artifactChunks.every((chunk) => chunk.charEnd >= chunk.charStart) ?? false,
      pageNumbers,
      extractionProvider: typeof params.metadata?.document_extraction_provider === "string" ? params.metadata.document_extraction_provider : hasProviderExtraction ? "text_proxy" : null
    },
    privacyDefaultLabel: typeof params.metadata?.privacy_label === "string" ? params.metadata.privacy_label as SourceCapabilityProfile["privacyDefaultLabel"] : "unknown",
    expectedReadModels: expectedReadModels(sourceKind, params.sourceIntelligence),
    unsupportedCapabilities,
    quality: {
      hasTextContent: (params.adapter?.artifactChunks.length ?? 0) > 0 && (params.adapter?.metrics.emptyOrBoilerplateChunkCount ?? 0) < (params.adapter?.artifactChunks.length ?? 0),
      chunkCount: params.adapter?.metrics.chunkCount ?? 0,
      extractionUnitCount: params.adapter?.metrics.extractionUnitCount ?? 0,
      provenanceComplete: params.adapter?.metrics.provenanceComplete ?? false,
      structurePreserved,
      needsProviderExtraction: unsupportedCapabilities.includes("provider_extraction_missing")
    }
  };
}
