import type { IngestionRouterV2SourceRoute, TaxonomyProfile } from "../ingest/router-v2.js";

export type RetrievalDomain =
  | "personal_memory"
  | "relationship_social"
  | "project_current_state"
  | "project_definition"
  | "task_ops"
  | "engineering_specs"
  | "document_knowledge"
  | "temporal_history"
  | "list_collection"
  | "procedural_memory"
  | "source_audit"
  | "cross_corpus_insight"
  | "review_unknown";

export type QueryContractNameForRegistry =
  | "relationship_chronology"
  | "relationship_map"
  | "shared_social_graph"
  | "current_state"
  | "temporal_event"
  | "list_set"
  | "profile_report"
  | "project_definition"
  | "document_lookup"
  | "codex_session_report"
  | "engineering_memory_packet"
  | "workflow_pattern_report"
  | "codex_source_audit"
  | "insight_report"
  | "task_list"
  | "procedure_lookup"
  | "source_audit"
  | "review_only"
  | "direct_fact"
  | "abstention";

export type RegistryAnswerShape = "scalar" | "list" | "reason" | "report" | "timeline" | "procedure" | "abstention";

export interface RetrievalDomainSpec {
  readonly domain: RetrievalDomain;
  readonly description: string;
  readonly allowedSourceRoutes: readonly IngestionRouterV2SourceRoute[];
  readonly allowedTaxonomyProfiles: readonly TaxonomyProfile[];
  readonly allowedQueryContracts: readonly QueryContractNameForRegistry[];
  readonly allowedAnswerShapes: readonly RegistryAnswerShape[];
  readonly allowedReadModels: readonly string[];
  readonly requiredEvidence: {
    readonly sourceQuote: boolean;
    readonly sourceRowId: boolean;
    readonly subjectBinding: boolean;
    readonly objectBinding?: boolean;
    readonly temporalAnchor?: boolean;
  };
  readonly blockedFallbacks: readonly string[];
  readonly reviewOnlyWhen: readonly string[];
}

const ALL_SOURCE_ROUTES: readonly IngestionRouterV2SourceRoute[] = [
  "omi",
  "markdown",
  "pdf",
  "asr",
  "chat",
  "task_list",
  "calendar",
  "locomo",
  "longmem",
  "watched_source",
  "generic_text",
  "unsupported_binary"
];

export const RETRIEVAL_DOMAIN_SPECS: readonly RetrievalDomainSpec[] = [
  {
    domain: "personal_memory",
    description: "Owner-centered personal observations, preferences, and life events.",
    allowedSourceRoutes: ["omi", "chat", "asr", "markdown", "watched_source", "locomo", "longmem"],
    allowedTaxonomyProfiles: ["direct_fact", "temporal_event", "relation_event", "profile_report"],
    allowedQueryContracts: ["current_state", "temporal_event", "profile_report", "direct_fact"],
    allowedAnswerShapes: ["scalar", "list", "report", "timeline"],
    allowedReadModels: ["compiled_direct_fact", "continuity_current_state_projection", "recap_profile_projection"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: true },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["missing_source_quote", "source_provenance_missing", "unknown_taxonomy"]
  },
  {
    domain: "relationship_social",
    description: "People, relationship maps, relationship chronology, social support, and transitions.",
    allowedSourceRoutes: ["omi", "chat", "asr", "locomo", "longmem", "watched_source"],
    allowedTaxonomyProfiles: ["relation_event", "profile_report", "direct_fact", "temporal_event"],
    allowedQueryContracts: ["relationship_chronology", "relationship_map", "shared_social_graph", "profile_report"],
    allowedAnswerShapes: ["report", "timeline", "reason", "list"],
    allowedReadModels: [
      "relationship_map_projection",
      "relationship_chronology_projection",
      "shared_social_graph",
      "profile_report_projection"
    ],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: true, objectBinding: true },
    blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
    reviewOnlyWhen: ["mixed_owner", "co_mention_only", "subject_binding_missing"]
  },
  {
    domain: "project_current_state",
    description: "Active project status, blockers, priorities, and current project focus.",
    allowedSourceRoutes: ["omi", "markdown", "watched_source", "chat", "asr", "task_list", "longmem"],
    allowedTaxonomyProfiles: ["direct_fact", "profile_report", "task_ops", "document_summary"],
    allowedQueryContracts: ["current_state", "profile_report", "list_set"],
    allowedAnswerShapes: ["report", "list", "scalar"],
    allowedReadModels: ["continuity_current_state_projection", "alias_current_state_projection", "recap_profile_projection"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: true },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["value_shape_mismatch", "source_provenance_missing"]
  },
  {
    domain: "project_definition",
    description: "What a project, company, product, or system is and why it matters.",
    allowedSourceRoutes: ["omi", "markdown", "pdf", "watched_source", "chat", "asr", "longmem"],
    allowedTaxonomyProfiles: ["direct_fact", "document_summary", "profile_report", "relation_event"],
    allowedQueryContracts: ["project_definition", "profile_report", "direct_fact"],
    allowedAnswerShapes: ["scalar", "report"],
    allowedReadModels: ["project_definition_projection", "compiled_direct_fact", "document_section_projection"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: true },
    blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
    reviewOnlyWhen: ["missing_source_quote", "subject_binding_missing", "unknown_taxonomy"]
  },
  {
    domain: "task_ops",
    description: "Tasks, owners, due dates, statuses, and action items.",
    allowedSourceRoutes: ["task_list", "calendar", "markdown", "watched_source", "chat", "asr"],
    allowedTaxonomyProfiles: ["task_ops", "temporal_event", "direct_fact"],
    allowedQueryContracts: ["task_list", "current_state", "temporal_event"],
    allowedAnswerShapes: ["list", "scalar", "report"],
    allowedReadModels: ["task_projection", "compiled_direct_fact"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: true, temporalAnchor: false },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["co_mention_only", "object_binding_missing", "source_provenance_missing"]
  },
  {
    domain: "engineering_specs",
    description: "Engineering specs, architecture plans, implementation requirements, and decision records.",
    allowedSourceRoutes: ["markdown", "pdf", "watched_source", "generic_text"],
    allowedTaxonomyProfiles: ["document_summary", "direct_fact", "task_ops", "review_only"],
    allowedQueryContracts: ["document_lookup", "codex_session_report", "engineering_memory_packet", "workflow_pattern_report", "codex_source_audit", "profile_report", "list_set"],
    allowedAnswerShapes: ["report", "list", "scalar", "procedure"],
    allowedReadModels: ["document_section_projection", "compiled_direct_fact"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: false },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["review_only_taxonomy_profile", "missing_source_quote"]
  },
  {
    domain: "document_knowledge",
    description: "Document, page, section, and source-file knowledge.",
    allowedSourceRoutes: ["markdown", "pdf", "watched_source", "generic_text"],
    allowedTaxonomyProfiles: ["document_summary", "direct_fact", "temporal_event", "review_only"],
    allowedQueryContracts: ["document_lookup", "profile_report", "direct_fact"],
    allowedAnswerShapes: ["report", "scalar", "list"],
    allowedReadModels: ["document_section_projection", "source_bounded_fallback"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: false },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["review_only_taxonomy_profile", "source_provenance_missing"]
  },
  {
    domain: "temporal_history",
    description: "Dated events, sequences, history, and recaps.",
    allowedSourceRoutes: ["omi", "chat", "asr", "markdown", "pdf", "calendar", "watched_source", "locomo", "longmem"],
    allowedTaxonomyProfiles: ["temporal_event", "direct_fact", "relation_event", "profile_report", "document_summary"],
    allowedQueryContracts: ["temporal_event", "relationship_chronology", "profile_report"],
    allowedAnswerShapes: ["scalar", "timeline", "report"],
    allowedReadModels: ["compiled_temporal_facts", "typed_temporal_anchor", "relationship_chronology_projection"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: true, temporalAnchor: true },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["temporal_anchor_missing", "missing_source_quote"]
  },
  {
    domain: "list_collection",
    description: "Lists and sets of books, movies, people, places, activities, items, and preferences.",
    allowedSourceRoutes: ["omi", "chat", "asr", "markdown", "pdf", "watched_source", "locomo", "longmem"],
    allowedTaxonomyProfiles: ["direct_fact", "relation_event", "document_summary", "profile_report"],
    allowedQueryContracts: ["list_set", "direct_fact"],
    allowedAnswerShapes: ["list", "scalar"],
    allowedReadModels: ["compiled_list_sets", "typed_list_support", "alias_current_state_projection"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: true },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["value_shape_mismatch", "missing_source_quote"]
  },
  {
    domain: "procedural_memory",
    description: "How-to workflows and repeatable procedures.",
    allowedSourceRoutes: ["markdown", "pdf", "watched_source", "task_list", "calendar", "generic_text"],
    allowedTaxonomyProfiles: ["document_summary", "task_ops", "direct_fact", "review_only"],
    allowedQueryContracts: ["procedure_lookup", "document_lookup"],
    allowedAnswerShapes: ["procedure", "list", "report"],
    allowedReadModels: ["procedure_projection", "document_section_projection"],
    requiredEvidence: { sourceQuote: true, sourceRowId: true, subjectBinding: false },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["review_only_taxonomy_profile", "source_provenance_missing"]
  },
  {
    domain: "source_audit",
    description: "Source-present/source-absent proof and evidence audits.",
    allowedSourceRoutes: ALL_SOURCE_ROUTES,
    allowedTaxonomyProfiles: ["direct_fact", "relation_event", "temporal_event", "task_ops", "profile_report", "document_summary", "review_only"],
    allowedQueryContracts: ["source_audit", "abstention"],
    allowedAnswerShapes: ["abstention", "report"],
    allowedReadModels: ["source_audit_index", "artifact_chunks"],
    requiredEvidence: { sourceQuote: false, sourceRowId: false, subjectBinding: false },
    blockedFallbacks: ["weak_canonical_profile"],
    reviewOnlyWhen: ["source_absent", "source_inconclusive"]
  },
  {
    domain: "cross_corpus_insight",
    description: "Source-backed observations, trends, recommendations, and what-we-learned reports across selected corpora.",
    allowedSourceRoutes: ALL_SOURCE_ROUTES,
    allowedTaxonomyProfiles: ["direct_fact", "relation_event", "temporal_event", "task_ops", "profile_report", "document_summary", "review_only"],
    allowedQueryContracts: ["insight_report", "document_lookup", "profile_report", "task_list", "source_audit"],
    allowedAnswerShapes: ["report"],
    allowedReadModels: ["insight_support_bundle", "source_audit_index", "document_section_projection", "task_projection"],
    requiredEvidence: { sourceQuote: true, sourceRowId: false, subjectBinding: false },
    blockedFallbacks: ["weak_canonical_profile", "generic_lexical_without_support"],
    reviewOnlyWhen: ["source_absent", "unsupported_recommendation", "citation_faithfulness_failed"]
  },
  {
    domain: "review_unknown",
    description: "Unknown, weakly understood, or unapproved source/query shape.",
    allowedSourceRoutes: ["generic_text", "unsupported_binary"],
    allowedTaxonomyProfiles: ["review_only"],
    allowedQueryContracts: ["review_only", "abstention"],
    allowedAnswerShapes: ["abstention"],
    allowedReadModels: ["taxonomy_review_items"],
    requiredEvidence: { sourceQuote: false, sourceRowId: false, subjectBinding: false },
    blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
    reviewOnlyWhen: ["review_only_taxonomy_profile", "unsupported_binary_source", "unknown_taxonomy"]
  }
];

const SPECS_BY_DOMAIN = new Map(RETRIEVAL_DOMAIN_SPECS.map((spec) => [spec.domain, spec]));

const QUERY_CONTRACT_PRIMARY_DOMAIN: Readonly<Record<QueryContractNameForRegistry, RetrievalDomain>> = {
  relationship_chronology: "relationship_social",
  relationship_map: "relationship_social",
  shared_social_graph: "relationship_social",
  current_state: "project_current_state",
  temporal_event: "temporal_history",
  list_set: "list_collection",
  profile_report: "personal_memory",
  project_definition: "project_definition",
  document_lookup: "document_knowledge",
  codex_session_report: "engineering_specs",
  engineering_memory_packet: "engineering_specs",
  workflow_pattern_report: "engineering_specs",
  codex_source_audit: "engineering_specs",
  insight_report: "cross_corpus_insight",
  task_list: "task_ops",
  procedure_lookup: "procedural_memory",
  source_audit: "source_audit",
  review_only: "review_unknown",
  direct_fact: "personal_memory",
  abstention: "review_unknown"
};

export function retrievalDomainSpec(domain: RetrievalDomain): RetrievalDomainSpec {
  const spec = SPECS_BY_DOMAIN.get(domain);
  if (!spec) {
    throw new Error(`Unknown retrieval domain: ${domain}`);
  }
  return spec;
}

export function retrievalDomainsForSourceRoute(
  sourceRoute: IngestionRouterV2SourceRoute,
  taxonomyProfile?: TaxonomyProfile | null
): readonly RetrievalDomain[] {
  const matches = RETRIEVAL_DOMAIN_SPECS.filter((spec) => {
    if (!spec.allowedSourceRoutes.includes(sourceRoute)) return false;
    if (taxonomyProfile && !spec.allowedTaxonomyProfiles.includes(taxonomyProfile)) return false;
    return true;
  }).map((spec) => spec.domain);
  return matches.length > 0 ? matches : ["review_unknown"];
}

export function primaryRetrievalDomainForSourceRoute(
  sourceRoute: IngestionRouterV2SourceRoute,
  taxonomyProfile?: TaxonomyProfile | null
): RetrievalDomain {
  if (sourceRoute === "generic_text" || sourceRoute === "unsupported_binary" || taxonomyProfile === "review_only") {
    return "review_unknown";
  }
  if (sourceRoute === "task_list") return "task_ops";
  if (sourceRoute === "calendar") return "temporal_history";
  if (sourceRoute === "markdown" || sourceRoute === "pdf" || sourceRoute === "watched_source") return "document_knowledge";
  if (sourceRoute === "omi" || sourceRoute === "chat" || sourceRoute === "asr" || sourceRoute === "locomo" || sourceRoute === "longmem") {
    return "personal_memory";
  }
  return retrievalDomainsForSourceRoute(sourceRoute, taxonomyProfile)[0] ?? "review_unknown";
}

export function primaryRetrievalDomainForQueryContract(contractName: QueryContractNameForRegistry): RetrievalDomain {
  return QUERY_CONTRACT_PRIMARY_DOMAIN[contractName] ?? "review_unknown";
}

export function queryContractNamesForRegistry(): readonly QueryContractNameForRegistry[] {
  return Object.keys(QUERY_CONTRACT_PRIMARY_DOMAIN) as QueryContractNameForRegistry[];
}

export function sourceRoutesForRegistry(): readonly IngestionRouterV2SourceRoute[] {
  return ALL_SOURCE_ROUTES;
}
