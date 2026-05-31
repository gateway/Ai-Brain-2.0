import type {
  QueryContractNameForRegistry,
  RegistryAnswerShape,
  RetrievalDomain
} from "../taxonomy/retrieval-domain-registry.js";

export type QueryCatalogPrimaryTool =
  | "memory.search"
  | "memory.recap"
  | "memory.extract_tasks"
  | "memory.extract_calendar"
  | "memory.explain_recap";

export interface QueryCatalogEntry {
  readonly id: string;
  readonly retrievalDomain: RetrievalDomain;
  readonly queryContract: QueryContractNameForRegistry;
  readonly answerShape: RegistryAnswerShape;
  readonly primaryTool: QueryCatalogPrimaryTool;
  readonly allowedReadModels: readonly string[];
  readonly supportedByDefault: boolean;
  readonly minimumEvidence: number;
  readonly expectedFinalClaimSources: readonly string[];
  readonly sampleQueries: readonly string[];
  readonly abstainWhen: readonly string[];
}

export const QUERY_CATALOG_V1: readonly QueryCatalogEntry[] = [
  {
    id: "relationship_chronology_v1",
    retrievalDomain: "relationship_social",
    queryContract: "relationship_chronology",
    answerShape: "timeline",
    primaryTool: "memory.search",
    allowedReadModels: ["relationship_chronology_projection", "relationship_history_direct_read_model"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["relationship_chronology_projection"],
    sampleQueries: [
      "what happened between Lauren and me?",
      "what is my history with Dan?",
      "give me a timeline of me and Lauren"
    ],
    abstainWhen: ["subject binding is ambiguous", "pair evidence is missing", "fallback would require weak canonical prose"]
  },
  {
    id: "relationship_map_v1",
    retrievalDomain: "relationship_social",
    queryContract: "relationship_map",
    answerShape: "report",
    primaryTool: "memory.search",
    allowedReadModels: ["relationship_map_projection", "relationship_single_fast_path"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["relationship_map_projection", "relationship_single_fast_path"],
    sampleQueries: ["who is Lauren to me?", "how do I know Dan?", "what is Tim associated with in my life?"],
    abstainWhen: ["the named person is unresolved", "only mixed-owner evidence exists"]
  },
  {
    id: "shared_social_graph_v1",
    retrievalDomain: "relationship_social",
    queryContract: "shared_social_graph",
    answerShape: "list",
    primaryTool: "memory.search",
    allowedReadModels: ["shared_social_graph", "relationship_graph_intersection", "support_network"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["shared_social_graph"],
    sampleQueries: [
      "Who are all of mine and Dan's friends?",
      "who are my mutual friends with Lauren?",
      "who do Dan and I both know?"
    ],
    abstainWhen: ["the pair is not fully bound", "no evidence-backed overlap exists", "the answer would collapse into relationship-map prose"]
  },
  {
    id: "current_state_v1",
    retrievalDomain: "project_current_state",
    queryContract: "current_state",
    answerShape: "report",
    primaryTool: "memory.search",
    allowedReadModels: ["continuity_current_state_projection", "alias_current_state_projection", "compiled_direct_fact"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["alias_current_state_projection", "current_state_purchase_projection", "compiled_direct_fact"],
    sampleQueries: ["what am I working on right now?", "what did I buy today?", "what coffee do I prefer now?"],
    abstainWhen: ["the state is partial and cannot be rendered safely", "only stale or unsupported state exists"]
  },
  {
    id: "temporal_event_v1",
    retrievalDomain: "temporal_history",
    queryContract: "temporal_event",
    answerShape: "scalar",
    primaryTool: "memory.search",
    allowedReadModels: ["compiled_temporal_facts", "typed_temporal_anchor"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["compiled_temporal_facts", "typed_temporal_anchor", "direct_source_read_model"],
    sampleQueries: ["when did Lauren leave Thailand?", "when did I go to Tahoe?", "when did the project start?"],
    abstainWhen: ["the event has no temporal anchor", "subject binding is missing"]
  },
  {
    id: "list_set_v1",
    retrievalDomain: "list_collection",
    queryContract: "list_set",
    answerShape: "list",
    primaryTool: "memory.search",
    allowedReadModels: ["compiled_list_sets", "typed_list_support", "alias_current_state_projection"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["compiled_list_sets", "typed_list_support", "alias_current_state_projection", "relationship_fast_path"],
    sampleQueries: ["what movies have I talked about?", "what books have I read?", "who are Steve's friends?"],
    abstainWhen: ["the list is weak or partial", "the list would require unsupported inference"]
  },
  {
    id: "profile_report_v1",
    retrievalDomain: "personal_memory",
    queryContract: "profile_report",
    answerShape: "report",
    primaryTool: "memory.recap",
    allowedReadModels: [
      "entity_dossier",
      "work_history_report_direct_read_model",
      "profile_report_projection",
      "recap_profile_projection",
      "compiled_profile_inference"
    ],
    supportedByDefault: false,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["entity_dossier", "work_history_report_direct_read_model", "profile_report_projection", "recap_profile_projection"],
    sampleQueries: [
      "summarize what I know about Lauren",
      "tell me everything about Chiang Mai",
      "what have I done in my career?",
      "what things did I do with id Software and John Carmack?",
      "give me an overview of my current life context"
    ],
    abstainWhen: ["the recap would be mixed-owner", "only weak canonical prose is available"]
  },
  {
    id: "project_definition_v1",
    retrievalDomain: "project_definition",
    queryContract: "project_definition",
    answerShape: "report",
    primaryTool: "memory.search",
    allowedReadModels: ["project_definition_projection", "compiled_direct_fact", "document_section_projection"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["project_definition_projection"],
    sampleQueries: ["What is Two Way?", "What is AI Brain?", "What is Well Inked?"],
    abstainWhen: ["the project or org is not source-backed", "the query resolves to a person relationship instead"]
  },
  {
    id: "document_lookup_v1",
    retrievalDomain: "document_knowledge",
    queryContract: "document_lookup",
    answerShape: "report",
    primaryTool: "memory.search",
    allowedReadModels: ["document_section_projection", "source_bounded_fallback"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["document_section_projection", "source_bounded_fallback"],
    sampleQueries: ["what does this spec say about Router v2?", "how do I run production readiness?", "what changed in this plan?"],
    abstainWhen: ["the document section is missing", "the answer would rely on unsupported summary prose"]
  },
  {
    id: "task_list_v1",
    retrievalDomain: "task_ops",
    queryContract: "task_list",
    answerShape: "list",
    primaryTool: "memory.extract_tasks",
    allowedReadModels: ["task_projection", "compiled_direct_fact"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["task_extraction", "task_projection"],
    sampleQueries: ["what do I need to do today?", "what tasks are open?", "what follow-up items came from the recap?"],
    abstainWhen: ["no task evidence exists", "extracted tasks are not grounded to evidence"]
  },
  {
    id: "procedure_lookup_v1",
    retrievalDomain: "procedural_memory",
    queryContract: "procedure_lookup",
    answerShape: "procedure",
    primaryTool: "memory.search",
    allowedReadModels: ["procedure_projection", "document_section_projection"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["procedure_projection", "document_section_projection"],
    sampleQueries: ["how do I run production readiness?", "how do I reset a namespace safely?"],
    abstainWhen: ["the procedure is not source-backed", "the query is actually a recap or task request"]
  },
  {
    id: "source_audit_v1",
    retrievalDomain: "source_audit",
    queryContract: "source_audit",
    answerShape: "report",
    primaryTool: "memory.search",
    allowedReadModels: ["source_audit_index", "artifact_chunks"],
    supportedByDefault: true,
    minimumEvidence: 0,
    expectedFinalClaimSources: ["source_audit", "direct_source_read_model"],
    sampleQueries: ["where did that come from?", "why do you think Steve lives in Chiang Mai?", "show me the evidence for that"],
    abstainWhen: ["the source is absent", "no provenance link exists"]
  },
  {
    id: "insight_report_v1",
    retrievalDomain: "cross_corpus_insight",
    queryContract: "insight_report",
    answerShape: "report",
    primaryTool: "memory.search",
    allowedReadModels: ["insight_support_bundle", "codex_memory_reader", "expandable_memory_reader", "document_section_projection", "task_projection"],
    supportedByDefault: true,
    minimumEvidence: 1,
    expectedFinalClaimSources: ["insight_report"],
    sampleQueries: [
      "what did we learn from this?",
      "what could we do better?",
      "what patterns are repeating?",
      "what should become a task or skill?"
    ],
    abstainWhen: ["no source-backed support bundle exists", "suggestions would be unsupported", "citation verification fails"]
  },
  {
    id: "review_only_v1",
    retrievalDomain: "review_unknown",
    queryContract: "review_only",
    answerShape: "abstention",
    primaryTool: "memory.search",
    allowedReadModels: ["taxonomy_review_items"],
    supportedByDefault: true,
    minimumEvidence: 0,
    expectedFinalClaimSources: ["review_unknown"],
    sampleQueries: ["what kind of unknown bucket is this?", "classify this uncategorized memory question"],
    abstainWhen: ["the query does not map to a safe contract", "the route would require unsupported guesswork"]
  }
];

const QUERY_CATALOG_BY_CONTRACT = new Map<QueryContractNameForRegistry, QueryCatalogEntry>(
  QUERY_CATALOG_V1.map((entry) => [entry.queryContract, entry])
);

export function queryCatalogEntryForContract(contractName: QueryContractNameForRegistry | string | null | undefined): QueryCatalogEntry | null {
  if (!contractName) {
    return null;
  }
  return QUERY_CATALOG_BY_CONTRACT.get(contractName as QueryContractNameForRegistry) ?? null;
}

export function queryCatalogEntries(): readonly QueryCatalogEntry[] {
  return QUERY_CATALOG_V1;
}
