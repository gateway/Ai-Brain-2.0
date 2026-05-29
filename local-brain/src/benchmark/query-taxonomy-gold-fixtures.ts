import { createHash } from "node:crypto";
import { withClient } from "../db/client.js";

export type QueryGoldToolName = "memory.search" | "memory.extract_tasks";

export interface QueryGoldCase {
  readonly id: string;
  readonly namespaceKind: "personal" | "synthetic" | "fixture";
  readonly toolName: QueryGoldToolName;
  readonly query: string;
  readonly referenceNow?: string;
  readonly expectedDomain: string;
  readonly expectedContract: string;
  readonly expectedAnswerShape: string;
  readonly expectedFinalClaimSources: readonly string[];
  readonly expectedTerms: readonly string[];
  readonly minimumEvidence: number;
  readonly shouldAbstain?: boolean;
}

export const QUERY_GOLD_FIXTURE_NAMESPACE = "benchmark_query_taxonomy_gold";

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function goldCases(prefix: string, cases: readonly Omit<QueryGoldCase, "id">[]): readonly QueryGoldCase[] {
  return cases.map((testCase, index) => ({ id: `${prefix}_${index}`, ...testCase }));
}

export const QUERY_TAXONOMY_GOLD_CASES: readonly QueryGoldCase[] = [
  ...goldCases("relationship_chronology", [
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what happened between Lauren and me?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_chronology",
      expectedAnswerShape: "timeline",
      expectedFinalClaimSources: ["relationship_chronology_projection", "relationship_history_direct_read_model"],
      expectedTerms: ["Lauren"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what is my history with Lauren?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_chronology",
      expectedAnswerShape: "timeline",
      expectedFinalClaimSources: ["relationship_chronology_projection", "relationship_history_direct_read_model"],
      expectedTerms: ["Lauren"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what went on with Lauren?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_chronology",
      expectedAnswerShape: "timeline",
      expectedFinalClaimSources: ["relationship_chronology_projection", "relationship_history_direct_read_model"],
      expectedTerms: ["Lauren"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "tell me our history with Lauren",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_chronology",
      expectedAnswerShape: "timeline",
      expectedFinalClaimSources: ["relationship_chronology_projection", "relationship_history_direct_read_model"],
      expectedTerms: ["Lauren"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "how has my relationship with Lauren changed recently?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_chronology",
      expectedAnswerShape: "timeline",
      expectedFinalClaimSources: ["relationship_chronology_projection", "relationship_history_direct_read_model"],
      expectedTerms: ["Lauren"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "What is Steve's history with Lauren?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_chronology",
      expectedAnswerShape: "timeline",
      expectedFinalClaimSources: ["relationship_chronology_projection", "relationship_history_direct_read_model"],
      expectedTerms: ["Lauren"],
      minimumEvidence: 1
    }
  ]),
  ...goldCases("relationship_map", [
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "Who is Lauren to me?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_map",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["relationship_map_projection"],
      expectedTerms: ["Lauren"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "Who is Dan to me?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_map",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["relationship_map_projection"],
      expectedTerms: ["Dan"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "how do I know Ben?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_map",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["relationship_map_projection"],
      expectedTerms: ["Ben"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "who is Gumee in my life?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_map",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["relationship_map_projection"],
      expectedTerms: ["Gumee"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "who is Tim to me?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_map",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["relationship_map_projection"],
      expectedTerms: ["Tim"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what is Dan associated with in my life?",
      expectedDomain: "relationship_social",
      expectedContract: "relationship_map",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["relationship_map_projection"],
      expectedTerms: ["Dan"],
      minimumEvidence: 1
    }
  ]),
  ...goldCases("shared_social_graph", [
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "Who are all of mine and Dan's friends?",
      expectedDomain: "relationship_social",
      expectedContract: "shared_social_graph",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["shared_social_graph"],
      expectedTerms: ["Ben"],
      minimumEvidence: 2
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "who are my mutual friends with Dan?",
      expectedDomain: "relationship_social",
      expectedContract: "shared_social_graph",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["shared_social_graph"],
      expectedTerms: ["Ben"],
      minimumEvidence: 2
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "who do Dan and I both know?",
      expectedDomain: "relationship_social",
      expectedContract: "shared_social_graph",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["shared_social_graph"],
      expectedTerms: ["Ben"],
      minimumEvidence: 2
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "who are the shared friends between me and Dan?",
      expectedDomain: "relationship_social",
      expectedContract: "shared_social_graph",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["shared_social_graph"],
      expectedTerms: ["Ben"],
      minimumEvidence: 2
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "who are Dan's mutual friends with me?",
      expectedDomain: "relationship_social",
      expectedContract: "shared_social_graph",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["shared_social_graph"],
      expectedTerms: ["Ben"],
      minimumEvidence: 2
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "which friends do Dan and I have in common?",
      expectedDomain: "relationship_social",
      expectedContract: "shared_social_graph",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["shared_social_graph"],
      expectedTerms: ["Ben"],
      minimumEvidence: 2
    }
  ]),
  ...goldCases("current_state", [
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "where does Steve live now?",
      expectedDomain: "project_current_state",
      expectedContract: "current_state",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["compiled_direct_fact", "alias_current_state_projection", "current_state_purchase_projection", "relationship_fast_path"],
      expectedTerms: ["Chiang Mai"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what does Steve prefer now for coffee?",
      expectedDomain: "project_current_state",
      expectedContract: "current_state",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["compiled_direct_fact", "alias_current_state_projection"],
      expectedTerms: ["pour-over coffee"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what coffee does Steve prefer now?",
      expectedDomain: "project_current_state",
      expectedContract: "current_state",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["compiled_direct_fact", "alias_current_state_projection", "preference_fact"],
      expectedTerms: ["pour-over coffee"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what trip is Steve planning for the end of April?",
      expectedDomain: "project_current_state",
      expectedContract: "current_state",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["compiled_direct_fact", "alias_current_state_projection", "planned_trip"],
      expectedTerms: ["Istanbul"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what projects is Steve working on right now?",
      expectedDomain: "project_current_state",
      expectedContract: "current_state",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["compiled_direct_fact", "alias_current_state_projection", "active_project_focus"],
      expectedTerms: ["Two-Way"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what coffee does Steve prefer now?",
      expectedDomain: "project_current_state",
      expectedContract: "current_state",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["compiled_direct_fact", "alias_current_state_projection", "preference_fact"],
      expectedTerms: ["coffee"],
      minimumEvidence: 1
    }
  ]),
  ...goldCases("task_ops", [
    {
      namespaceKind: "fixture",
      toolName: "memory.extract_tasks",
      query: "what do I need to do?",
      expectedDomain: "task_ops",
      expectedContract: "task_list",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["task_extraction"],
      expectedTerms: ["Finish projection audit"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.extract_tasks",
      query: "what open tasks do I have?",
      expectedDomain: "task_ops",
      expectedContract: "task_list",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["task_extraction"],
      expectedTerms: ["Run production readiness manifest"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.extract_tasks",
      query: "pull out the action items from this note",
      expectedDomain: "task_ops",
      expectedContract: "task_list",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["task_extraction"],
      expectedTerms: ["Review MCP Studio wiring"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.extract_tasks",
      query: "what should I do for the query contract work?",
      expectedDomain: "task_ops",
      expectedContract: "task_list",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["task_extraction"],
      expectedTerms: ["Add stable queryContract"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.extract_tasks",
      query: "extract the tasks from this query contract note",
      expectedDomain: "task_ops",
      expectedContract: "task_list",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["task_extraction"],
      expectedTerms: ["Review MCP Studio wiring"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.extract_tasks",
      query: "list the remaining tasks from the query contract work note",
      expectedDomain: "task_ops",
      expectedContract: "task_list",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["task_extraction"],
      expectedTerms: ["Finish projection audit"],
      minimumEvidence: 1
    }
  ]),
  ...goldCases("temporal_history", [
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what did Steve do yesterday?",
      referenceNow: "2026-03-21T12:00:00Z",
      expectedDomain: "temporal_history",
      expectedContract: "temporal_event",
      expectedAnswerShape: "scalar",
      expectedFinalClaimSources: ["compiled_temporal_facts", "typed_temporal_anchor", "direct_source_read_model", "temporal_summary"],
      expectedTerms: ["karaoke"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what did Steve do on March 2, 2026?",
      referenceNow: "2026-03-23T12:00:00Z",
      expectedDomain: "temporal_history",
      expectedContract: "temporal_event",
      expectedAnswerShape: "scalar",
      expectedFinalClaimSources: ["compiled_temporal_facts", "typed_temporal_anchor", "direct_source_read_model", "canonical_temporal", "temporal_summary"],
      expectedTerms: ["Pai"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "where did Steve and Jules go after karaoke on March 21 2026?",
      expectedDomain: "temporal_history",
      expectedContract: "temporal_event",
      expectedAnswerShape: "scalar",
      expectedFinalClaimSources: ["compiled_temporal_facts", "typed_temporal_anchor", "direct_source_read_model", "canonical_temporal"],
      expectedTerms: ["Night Noodle Alley"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "when did Lauren leave for the US?",
      expectedDomain: "temporal_history",
      expectedContract: "temporal_event",
      expectedAnswerShape: "scalar",
      expectedFinalClaimSources: ["compiled_temporal_facts", "typed_temporal_anchor", "direct_source_read_model", "fallback_derived"],
      expectedTerms: ["October 18, 2025"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "When did Steve and Lauren stop talking?",
      expectedDomain: "temporal_history",
      expectedContract: "temporal_event",
      expectedAnswerShape: "scalar",
      expectedFinalClaimSources: ["compiled_temporal_facts", "typed_temporal_anchor", "direct_source_read_model", "relationship_transition_direct_read_model"],
      expectedTerms: ["October 18, 2025"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "When did Lauren leave Thailand?",
      expectedDomain: "temporal_history",
      expectedContract: "temporal_event",
      expectedAnswerShape: "scalar",
      expectedFinalClaimSources: ["compiled_temporal_facts", "typed_temporal_anchor", "direct_source_read_model", "relationship_transition_direct_read_model"],
      expectedTerms: ["2025"],
      minimumEvidence: 1
    }
  ]),
  ...goldCases("list_collection", [
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "who are Steve's friends?",
      expectedDomain: "list_collection",
      expectedContract: "list_set",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["relationship_fast_path", "compiled_list_sets", "typed_list_support"],
      expectedTerms: ["Dan"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what movies have I talked about recently?",
      expectedDomain: "list_collection",
      expectedContract: "list_set",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["compiled_list_sets", "typed_list_support", "alias_current_state_projection", "exact_detail_candidate"],
      expectedTerms: ["Sinners"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "What movies have I talked about?",
      expectedDomain: "list_collection",
      expectedContract: "list_set",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["compiled_list_sets", "typed_list_support", "alias_current_state_projection", "exact_detail_candidate"],
      expectedTerms: ["movie"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what movies has Steve watched recently?",
      expectedDomain: "list_collection",
      expectedContract: "list_set",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["compiled_list_sets", "typed_list_support", "exact_detail_candidate"],
      expectedTerms: ["Sinners"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "who are Steve's friends?",
      expectedDomain: "list_collection",
      expectedContract: "list_set",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["relationship_fast_path", "compiled_list_sets", "typed_list_support"],
      expectedTerms: ["Jules"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "what movies has Steve watched recently?",
      expectedDomain: "list_collection",
      expectedContract: "list_set",
      expectedAnswerShape: "list",
      expectedFinalClaimSources: ["compiled_list_sets", "typed_list_support", "exact_detail_candidate"],
      expectedTerms: ["Sinners"],
      minimumEvidence: 1
    }
  ]),
  ...goldCases("project_definition", [
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "What is Two Way?",
      expectedDomain: "project_definition",
      expectedContract: "project_definition",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["project_definition_projection"],
      expectedTerms: ["Two Way"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "What is AI Brain?",
      expectedDomain: "project_definition",
      expectedContract: "project_definition",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["project_definition_projection"],
      expectedTerms: ["AI Brain"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "What is Well Inked?",
      expectedDomain: "project_definition",
      expectedContract: "project_definition",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["project_definition_projection"],
      expectedTerms: ["Well Inked"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "tell me about Preset Kitchen",
      expectedDomain: "project_definition",
      expectedContract: "project_definition",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["project_definition_projection"],
      expectedTerms: ["Preset Kitchen"],
      minimumEvidence: 1
    }
  ]),
  ...goldCases("document_and_engineering", [
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what does this spec say about Router v2?",
      expectedDomain: "document_knowledge",
      expectedContract: "document_lookup",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["document_section_projection", "source_bounded_fallback"],
      expectedTerms: ["Router v2"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what does Router v2 preserve?",
      expectedDomain: "document_knowledge",
      expectedContract: "document_lookup",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["document_section_projection", "source_bounded_fallback"],
      expectedTerms: ["provenance-complete chunks"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what must profile report queries do?",
      expectedDomain: "document_knowledge",
      expectedContract: "document_lookup",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["document_section_projection", "source_bounded_fallback"],
      expectedTerms: ["source-bound projections"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what changed in this plan?",
      expectedDomain: "document_knowledge",
      expectedContract: "document_lookup",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["document_section_projection", "source_bounded_fallback"],
      expectedTerms: ["queryContract"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "how do I run production readiness?",
      expectedDomain: "procedural_memory",
      expectedContract: "procedure_lookup",
      expectedAnswerShape: "procedure",
      expectedFinalClaimSources: ["procedure_projection", "document_section_projection", "source_bounded_fallback"],
      expectedTerms: ["benchmark:production-readiness"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "how do I reset a namespace safely?",
      expectedDomain: "procedural_memory",
      expectedContract: "procedure_lookup",
      expectedAnswerShape: "procedure",
      expectedFinalClaimSources: ["procedure_projection", "document_section_projection", "source_bounded_fallback"],
      expectedTerms: ["namespace:reset"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what response fields must memory.search return?",
      expectedDomain: "document_knowledge",
      expectedContract: "document_lookup",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["document_section_projection", "source_bounded_fallback"],
      expectedTerms: ["queryContract"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what does the plan say about query-time model calls?",
      expectedDomain: "document_knowledge",
      expectedContract: "document_lookup",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["document_section_projection", "source_bounded_fallback"],
      expectedTerms: ["zero"],
      minimumEvidence: 1
    }
  ]),
  ...goldCases("source_audit_and_abstention", [
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "why does the brain think Steve prefers pour-over coffee now?",
      expectedDomain: "source_audit",
      expectedContract: "source_audit",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["direct_source_read_model", "source_audit", "alias_current_state_projection"],
      expectedTerms: ["pour-over coffee"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "show me the evidence for Steve's coffee preference",
      expectedDomain: "source_audit",
      expectedContract: "source_audit",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["direct_source_read_model", "source_audit", "preference_fact"],
      expectedTerms: ["pour-over coffee"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "synthetic",
      toolName: "memory.search",
      query: "show me the evidence that Steve prefers pour-over coffee now",
      expectedDomain: "source_audit",
      expectedContract: "source_audit",
      expectedAnswerShape: "report",
      expectedFinalClaimSources: ["direct_source_read_model", "source_audit", "preference_fact"],
      expectedTerms: ["pour-over coffee"],
      minimumEvidence: 1
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "What is Zednock?",
      expectedDomain: "review_unknown",
      expectedContract: "review_only",
      expectedAnswerShape: "abstention",
      expectedFinalClaimSources: ["review_unknown"],
      expectedTerms: [],
      minimumEvidence: 0,
      shouldAbstain: true
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "what happened between me and them?",
      expectedDomain: "review_unknown",
      expectedContract: "abstention",
      expectedAnswerShape: "abstention",
      expectedFinalClaimSources: ["review_unknown"],
      expectedTerms: [],
      minimumEvidence: 0,
      shouldAbstain: true
    },
    {
      namespaceKind: "fixture",
      toolName: "memory.search",
      query: "classify this uncategorized memory question",
      expectedDomain: "review_unknown",
      expectedContract: "review_only",
      expectedAnswerShape: "abstention",
      expectedFinalClaimSources: ["review_unknown"],
      expectedTerms: [],
      minimumEvidence: 0,
      shouldAbstain: true
    }
  ])
];

export async function seedQueryTaxonomyGoldFixture(namespaceId = QUERY_GOLD_FIXTURE_NAMESPACE): Promise<void> {
  await withClient(async (client) => {
    await client.query("DELETE FROM contract_projection_entries WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM contract_projection_heads WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM episodic_memory WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM artifact_chunks WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)", [namespaceId]);
    await client.query("DELETE FROM artifact_observations WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)", [namespaceId]);
    await client.query("DELETE FROM artifacts WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM taxonomy_review_items WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM entities WHERE namespace_id = $1", [namespaceId]);

    function normalizedName(value: string): string {
      return value.trim().toLowerCase().replace(/\s+/gu, " ");
    }

    async function insertArtifactMemory(params: {
      readonly uri: string;
      readonly content: string;
      readonly occurredAt: string;
      readonly artifactType?: string;
      readonly sourceRoute?: string;
      readonly sessionId: string;
    }): Promise<{ readonly artifactId: string; readonly observationId: string; readonly chunkId: string; readonly memoryId: string }> {
      const checksum = stableHash(params.content);
      const artifact = await client.query<{ id: string }>(
        `
          INSERT INTO artifacts (namespace_id, artifact_type, uri, latest_checksum_sha256, mime_type, source_channel, metadata)
          VALUES ($1, $2, $3, $4, 'text/markdown', 'benchmark:query-taxonomy-gold', $5::jsonb)
          RETURNING id::text
        `,
        [
          namespaceId,
          params.artifactType ?? "markdown",
          params.uri,
          checksum,
          JSON.stringify({ benchmark_seed: true, source_route: params.sourceRoute ?? "markdown" })
        ]
      );
      const artifactId = artifact.rows[0]!.id;
      const observation = await client.query<{ id: string }>(
        `
          INSERT INTO artifact_observations (artifact_id, version, checksum_sha256, byte_size, observed_at, metadata)
          VALUES ($1::uuid, 1, $2, $3, $4::timestamptz, $5::jsonb)
          RETURNING id::text
        `,
        [artifactId, checksum, params.content.length, params.occurredAt, JSON.stringify({ benchmark_seed: true })]
      );
      const observationId = observation.rows[0]!.id;
      const chunk = await client.query<{ id: string }>(
        `
          INSERT INTO artifact_chunks (artifact_id, artifact_observation_id, chunk_index, char_start, char_end, text_content, metadata)
          VALUES ($1::uuid, $2::uuid, 0, 0, $3, $4, $5::jsonb)
          RETURNING id::text
        `,
        [
          artifactId,
          observationId,
          params.content.length,
          params.content,
          JSON.stringify({ benchmark_seed: true, source_route: params.sourceRoute ?? "markdown" })
        ]
      );
      const memory = await client.query<{ id: string }>(
        `
          INSERT INTO episodic_memory (
            namespace_id, session_id, role, content, occurred_at, captured_at, artifact_id, artifact_observation_id, source_chunk_id, metadata
          )
          VALUES ($1, $2, 'import', $3, $4::timestamptz, $4::timestamptz, $5::uuid, $6::uuid, $7::uuid, $8::jsonb)
          RETURNING id::text
        `,
        [
          namespaceId,
          params.sessionId,
          params.content,
          params.occurredAt,
          artifactId,
          observationId,
          chunk.rows[0]!.id,
          JSON.stringify({ benchmark_seed: true, source_route: params.sourceRoute ?? "markdown" })
        ]
      );
      return { artifactId, observationId, chunkId: chunk.rows[0]!.id, memoryId: memory.rows[0]!.id };
    }

    async function ensureEntity(canonicalName: string, entityType: "self" | "person" | "project" = "person"): Promise<string> {
      const row = await client.query<{ id: string }>(
        `
          INSERT INTO entities (namespace_id, entity_type, canonical_name, normalized_name, metadata)
          VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (namespace_id, entity_type, normalized_name)
          DO UPDATE SET
            canonical_name = EXCLUDED.canonical_name,
            last_seen_at = now(),
            metadata = entities.metadata || EXCLUDED.metadata
          RETURNING id::text
        `,
        [namespaceId, entityType, canonicalName, normalizedName(canonicalName), JSON.stringify({ benchmark_seed: true })]
      );
      return row.rows[0]!.id;
    }

    async function insertRelationshipCandidate(params: {
      readonly subject: string;
      readonly predicate: string;
      readonly object: string;
      readonly snippet: string;
      readonly occurredAt: string;
    }): Promise<void> {
      const subjectEntityId = await ensureEntity(params.subject, /^steve(?:\s+tietze)?$/iu.test(params.subject) ? "self" : "person");
      const objectEntityId = await ensureEntity(params.object, "person");
      const memory = await insertArtifactMemory({
        uri: `query-gold://social/${stableHash(params.snippet).slice(0, 12)}`,
        content: params.snippet,
        occurredAt: params.occurredAt,
        artifactType: "note",
        sourceRoute: "chat",
        sessionId: "query-gold-social"
      });
      await client.query(
        `
          INSERT INTO relationship_candidates (
            namespace_id, subject_entity_id, predicate, object_entity_id, source_memory_id,
            confidence, status, valid_from, metadata
          )
          VALUES (
            $1, $2::uuid, $3, $4::uuid, $5::uuid,
            0.97, 'accepted', $6::timestamptz,
            jsonb_build_object(
              'snippet', $7::text,
              'source_quote', $7::text,
              'benchmark_seed', true,
              'source_route', 'chat'
            )
          )
        `,
        [namespaceId, subjectEntityId, params.predicate, objectEntityId, memory.memoryId, params.occurredAt, params.snippet]
      );
    }

    await insertArtifactMemory({
      uri: "query-gold://definitions",
      sessionId: "query-gold-definitions",
      occurredAt: "2026-05-17T00:00:00Z",
      content: [
        "# Query Gold Definitions",
        "",
        "Two Way is a client and product work context in Steve's notes. Omi works with Steve through Two Way on forum and backend work.",
        "AI Brain is a memory and retrieval system project. The AI Brain project stores source-bound memory and retrieves it through projections.",
        "Well Inked is a work project in Steve's notes, connected to content and backend operations.",
        "Preset Kitchen is a product concept for kitchen and home workflow experiments.",
        "This plan changed by adding stable queryContract and retrievalDomain fields to memory.search and memory.recap."
      ].join("\n")
    });

    await insertArtifactMemory({
      uri: "query-gold://specs",
      sessionId: "query-gold-specs",
      occurredAt: "2026-05-17T00:02:00Z",
      content: [
        "# Query Contract Spec",
        "",
        "Router v2 preserves provenance-complete chunks, extraction units, and source-bound compiled memory.",
        "Profile report queries must read from source-bound projections before broad fallback.",
        "memory.search must return queryContract, retrievalDomain, answerShape, finalClaimSource, evidenceCount, followUpAction, abstentionReason, blockedFallbacks, and reviewUnknown.",
        "The plan requires query-time GLiNER, Relex, and LLM calls to stay at zero."
      ].join("\n")
    });

    await insertArtifactMemory({
      uri: "query-gold://procedures",
      sessionId: "query-gold-procedures",
      occurredAt: "2026-05-17T00:04:00Z",
      content: [
        "# Procedures",
        "",
        "To run production readiness, execute npm run benchmark:production-readiness --workspace local-brain -- --manifest <generated-manifest>.",
        "To reset a namespace safely, execute npm run namespace:reset --workspace local-brain -- --namespace <id> and then replay the sources."
      ].join("\n")
    });

    await insertArtifactMemory({
      uri: "query-gold://tasks",
      sessionId: "query-gold-tasks",
      occurredAt: "2026-05-17T00:06:00Z",
      content: [
        "# Action List For The Query Contract Work",
        "",
        "Open tasks for the query contract work:",
        "- Finish projection audit by Friday.",
        "- Run production readiness manifest after the gold query pack.",
        "- Review MCP Studio wiring and publish the contract doc.",
        "- Add stable queryContract and retrievalDomain fields to memory.search and memory.recap.",
        "- Build the shared social graph contract for mutual friend questions.",
        "- Publish the MCP contract doc after the gold pack is green."
      ].join("\n")
    });

    const movieMemory = await insertArtifactMemory({
      uri: "query-gold://movies",
      sessionId: "query-gold-movies",
      occurredAt: "2026-05-17T00:06:30Z",
      content: [
        "# Movie Preferences",
        "",
        "Steve talked about movies recently and said he likes Sinners.",
        "The movie notes also mention Texas Chainsaw Massacre as a comparison point."
      ].join("\n")
    });

    await insertArtifactMemory({
      uri: "query-gold://engineering-note",
      sessionId: "query-gold-engineering-note",
      occurredAt: "2026-05-17T00:07:00Z",
      content: [
        "# Remaining Tasks From The Gold Query Plan",
        "",
        "Engineering note remaining tasks:",
        "- Build the shared social graph contract for mutual friend questions.",
        "- Publish the MCP contract doc after the gold pack is green.",
        "- Run production readiness manifest after the gold query pack."
      ].join("\n")
    });

    const steveEntityId = await ensureEntity("Steve Tietze", "self");
    await ensureEntity("Dan", "person");
    await ensureEntity("Ben", "person");
    await ensureEntity("Gumee", "person");
    await ensureEntity("Lauren", "person");
    await ensureEntity("Tim", "person");

    await client.query(
      `
        INSERT INTO media_mentions (
          namespace_id, source_memory_id, artifact_id, subject_entity_id, subject_name,
          media_title, normalized_media_title, media_kind, mention_kind, context_text, occurred_at, provenance, metadata
        )
        VALUES (
          $1, $2::uuid, $3::uuid, $4::uuid, 'Steve Tietze',
          'Sinners', 'sinners', 'movie', 'liked', $5, '2026-05-17T00:06:30Z'::timestamptz,
          jsonb_build_object('source_quote', $5::text, 'benchmark_seed', true),
          jsonb_build_object('benchmark_seed', true)
        )
        ON CONFLICT DO NOTHING
      `,
      [namespaceId, movieMemory.memoryId, movieMemory.artifactId, steveEntityId, "Steve talked about movies recently and said he likes Sinners."]
    );

    await client.query(
      `
        INSERT INTO preference_facts (
          namespace_id, source_memory_id, artifact_id, subject_entity_id, subject_name,
          predicate, object_text, normalized_object_text, domain, occurred_at, context_text, provenance, metadata
        )
        VALUES (
          $1, $2::uuid, $3::uuid, $4::uuid, 'Steve Tietze',
          'likes', 'Sinners', 'sinners', 'media', '2026-05-17T00:06:30Z'::timestamptz, $5,
          jsonb_build_object('source_quote', $5::text, 'benchmark_seed', true),
          jsonb_build_object('benchmark_seed', true)
        )
        ON CONFLICT DO NOTHING
      `,
      [namespaceId, movieMemory.memoryId, movieMemory.artifactId, steveEntityId, "Steve talked about movies recently and said he likes Sinners."]
    );

    await insertRelationshipCandidate({
      subject: "Steve Tietze",
      predicate: "friend_of",
      object: "Dan",
      snippet: "Dan is Steve's friend from Chiang Mai and Mexico City.",
      occurredAt: "2026-05-17T00:10:00Z"
    });
    await insertRelationshipCandidate({
      subject: "Steve Tietze",
      predicate: "friend_of",
      object: "Ben",
      snippet: "Ben is Steve's friend and part of the same social circle.",
      occurredAt: "2026-05-17T00:11:00Z"
    });
    await insertRelationshipCandidate({
      subject: "Steve Tietze",
      predicate: "friend_of",
      object: "Gumee",
      snippet: "Gumee is Steve's friend from the Chiang Mai circle.",
      occurredAt: "2026-05-17T00:12:00Z"
    });
    await insertRelationshipCandidate({
      subject: "Steve Tietze",
      predicate: "friend_of",
      object: "Lauren",
      snippet: "Lauren is Steve's friend and still part of his social world.",
      occurredAt: "2026-05-17T00:13:00Z"
    });
    await insertRelationshipCandidate({
      subject: "Steve Tietze",
      predicate: "friend_of",
      object: "Tim",
      snippet: "Tim is Steve's friend from the Chiang Mai circle.",
      occurredAt: "2026-05-17T00:13:30Z"
    });
    await insertRelationshipCandidate({
      subject: "Dan",
      predicate: "friend_of",
      object: "Ben",
      snippet: "Dan is also friends with Ben.",
      occurredAt: "2026-05-17T00:14:00Z"
    });
    await insertRelationshipCandidate({
      subject: "Dan",
      predicate: "friend_of",
      object: "Gumee",
      snippet: "Dan is also friends with Gumee.",
      occurredAt: "2026-05-17T00:15:00Z"
    });
    await insertRelationshipCandidate({
      subject: "Dan",
      predicate: "friend_of",
      object: "Lauren",
      snippet: "Dan is also friends with Lauren.",
      occurredAt: "2026-05-17T00:16:00Z"
    });
  });
}
