import { extractStructuredClaimText } from "./recall-content.js";
import type {
  AnswerShapingMode,
  CanonicalSubjectBindingStatus,
  ExactDetailClaimCandidate,
  RecallExactDetailSource
} from "./types.js";

export interface RenderedSupportClaim {
  readonly claimText: string | null;
  readonly shapingMode: AnswerShapingMode;
  readonly targetedRetrievalAttempted?: boolean;
  readonly targetedRetrievalReason?: string | null;
  readonly targetedFieldsRequested?: readonly string[];
  readonly targetedRetrievalSatisfied?: boolean;
  readonly typedValueUsed: boolean;
  readonly generatedProseUsed: boolean;
  readonly runtimeResynthesisUsed: boolean;
  readonly supportRowsSelected: number;
  readonly supportTextsSelected: number;
  readonly supportSelectionMode: string | null;
  readonly selectedEventKey?: string | null;
  readonly selectedEventType?: string | null;
  readonly selectedTimeGranularity?: string | null;
  readonly typedSetEntryCount?: number;
  readonly typedSetEntryType?: string | null;
  readonly exactDetailSource?: RecallExactDetailSource | null;
  readonly supportObjectsBuilt: number;
  readonly supportObjectType: string | null;
  readonly supportNormalizationFailures: readonly string[];
  readonly renderContractSelected: string | null;
  readonly renderContractFallbackReason: string | null;
  readonly subjectBindingStatus?: CanonicalSubjectBindingStatus;
  readonly subjectBindingReason?: string | null;
  readonly temporalEventIdentityStatus?: string | null;
  readonly temporalGranularityStatus?: string | null;
  readonly relativeAnchorStatus?: string | null;
}

export interface DirectDetailSupport {
  readonly supportObjectType: "DirectDetailSupport";
  readonly selectedText: string | null;
  readonly exactDetailSource: RecallExactDetailSource | null;
  readonly strongSupport: boolean;
  readonly supportNormalizationFailures: readonly string[];
}

export interface SnippetFactSupport {
  readonly supportObjectType: "SnippetFactSupport";
  readonly selectedText: string | null;
  readonly supportNormalizationFailures: readonly string[];
}

export function buildDirectDetailSupport(params: {
  readonly finalClaimText: string | null;
  readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
}): DirectDetailSupport {
  const selectedText =
    extractStructuredClaimText(params.exactDetailCandidate?.text) ??
    extractStructuredClaimText(params.finalClaimText);
  return {
    supportObjectType: "DirectDetailSupport",
    selectedText,
    exactDetailSource: params.exactDetailCandidate?.source ?? null,
    strongSupport: params.exactDetailCandidate?.strongSupport === true,
    supportNormalizationFailures: selectedText ? [] : ["no_exact_detail_support_normalized"]
  };
}

export function renderDirectDetailSupport(
  support: DirectDetailSupport,
  supportRowsSelected: number
): RenderedSupportClaim {
  const typedValueSelected = Boolean(support.selectedText);
  return {
    claimText: support.selectedText,
    shapingMode: support.strongSupport ? "support_span_extraction" : "stored_canonical_fact",
    typedValueUsed: typedValueSelected,
    generatedProseUsed: false,
    runtimeResynthesisUsed: false,
    supportRowsSelected,
    supportTextsSelected: typedValueSelected ? 1 : 0,
    supportSelectionMode: typedValueSelected ? "atomic_unit" : null,
    targetedRetrievalAttempted: false,
    targetedRetrievalReason: null,
    exactDetailSource: support.exactDetailSource,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: support.strongSupport ? "exact_support_span" : "exact_canonical_value",
    renderContractFallbackReason: support.strongSupport ? null : "strong_support_span_missing"
  };
}

export function buildSnippetFactSupport(params: {
  readonly finalClaimText: string | null;
}): SnippetFactSupport {
  const selectedText = extractStructuredClaimText(params.finalClaimText);
  return {
    supportObjectType: "SnippetFactSupport",
    selectedText,
    supportNormalizationFailures: selectedText ? [] : ["snippet_fact_missing"]
  };
}

export function renderSnippetFactSupport(
  support: SnippetFactSupport,
  supportRowsSelected: number
): RenderedSupportClaim {
  return {
    claimText: support.selectedText,
    shapingMode: "snippet_fallback",
    targetedRetrievalAttempted: false,
    targetedRetrievalReason: null,
    typedValueUsed: false,
    generatedProseUsed: false,
    runtimeResynthesisUsed: false,
    supportRowsSelected,
    supportTextsSelected: 0,
    supportSelectionMode: null,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: "support_span_extract",
    renderContractFallbackReason: support.selectedText ? null : "snippet_fact_missing"
  };
}
