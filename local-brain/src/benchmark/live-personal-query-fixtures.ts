export interface LivePersonalQueryCase {
  readonly id: string;
  readonly toolName: "memory.search";
  readonly query: string;
  readonly expectedContract: string;
  readonly expectedDomain: string;
  readonly expectedAnswerShape: string;
  readonly expectedFinalClaimSources: readonly string[];
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
  readonly minimumEvidence: number;
  readonly shouldAbstain?: boolean;
}

function personalCase(id: string, testCase: Omit<LivePersonalQueryCase, "id" | "toolName">): LivePersonalQueryCase {
  return {
    id,
    toolName: "memory.search",
    ...testCase
  };
}

export const LIVE_PERSONAL_QUERY_CASES: readonly LivePersonalQueryCase[] = [
  personalCase("lauren_relationship_history", {
    query: "What happened between Lauren and me?",
    expectedContract: "relationship_chronology",
    expectedDomain: "relationship_social",
    expectedAnswerShape: "timeline",
    expectedFinalClaimSources: ["relationship_chronology_projection"],
    expectedTerms: ["Lauren"],
    forbiddenTerms: ["Lauren and Bend, Oregon", "And and Bend"],
    minimumEvidence: 1
  }),
  personalCase("lauren_relationship_breakdown", {
    query: "Give me a breakdown of Lauren and my relationship or friendship.",
    expectedContract: "relationship_chronology",
    expectedDomain: "relationship_social",
    expectedAnswerShape: "timeline",
    expectedFinalClaimSources: ["relationship_chronology_projection"],
    expectedTerms: ["Lauren"],
    minimumEvidence: 1
  }),
  personalCase("lauren_relationship_map", {
    query: "Who is Lauren to me?",
    expectedContract: "relationship_map",
    expectedDomain: "relationship_social",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["relationship_map_projection"],
    expectedTerms: ["Lauren"],
    minimumEvidence: 1
  }),
  personalCase("lauren_full_dossier", {
    query: "Tell me everything about Lauren.",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["entity_dossier"],
    expectedTerms: ["Lauren", "Koh Samui"],
    forbiddenTerms: ["Lauren and Bend, Oregon", "And and Bend"],
    minimumEvidence: 1
  }),
  personalCase("bend_place_dossier", {
    query: "What does the system know about Bend for me?",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["entity_dossier"],
    expectedTerms: ["Bend"],
    forbiddenTerms: ["Bend lived in Steve Tietze", "Bend lived in Lauren", "And lived in Bend", "Oregon contained in Bend"],
    minimumEvidence: 1
  }),
  personalCase("samui_experience_org_dossier", {
    query: "What do we know about The Samui Experience?",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["entity_dossier"],
    expectedTerms: ["The Samui Experience", "Lauren"],
    minimumEvidence: 1
  }),
  personalCase("steve_friends", {
    query: "Who are Steve's friends?",
    expectedContract: "list_set",
    expectedDomain: "list_collection",
    expectedAnswerShape: "list",
    expectedFinalClaimSources: ["relationship_fast_path", "compiled_list_sets", "typed_list_support", "alias_current_state_projection"],
    expectedTerms: ["Lauren"],
    minimumEvidence: 1
  }),
  personalCase("preference_profile", {
    query: "What do I like and dislike?",
    expectedContract: "current_state",
    expectedDomain: "project_current_state",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["alias_current_state_projection"],
    expectedTerms: ["MacBook Pros", "Android phones"],
    minimumEvidence: 1
  }),
  personalCase("source_audit_without_context", {
    query: "Where did that answer come from?",
    expectedContract: "source_audit",
    expectedDomain: "source_audit",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: [],
    expectedTerms: [],
    minimumEvidence: 0,
    shouldAbstain: true
  }),
  personalCase("well_inked_definition", {
    query: "What is Well Inked?",
    expectedContract: "project_definition",
    expectedDomain: "project_definition",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["project_definition_projection", "source_bounded_fallback", "document_section_projection"],
    expectedTerms: ["Well Inked"],
    minimumEvidence: 1
  }),
  personalCase("career_work_history", {
    query: "What have I done in my career?",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["work_history_report_direct_read_model"],
    expectedTerms: ["AI Brain", "Apogee"],
    minimumEvidence: 1
  }),
  personalCase("employment_company_list", {
    query: "Can you give me a list of companies that I've worked for in summarized short form?",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["work_history_report_direct_read_model"],
    expectedTerms: ["Apogee", "Rogue", "Well Inked", "Two-Way"],
    minimumEvidence: 1
  }),
  personalCase("career_full_work_history", {
    query: "Give me my full work history with roles and dates.",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["work_history_report_direct_read_model"],
    expectedTerms: ["Apogee", "Rogue", "Two-Way", "Well Inked"],
    minimumEvidence: 1
  }),
  personalCase("employment_vs_projects", {
    query: "List employers vs projects I've worked on.",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["work_history_report_direct_read_model"],
    expectedTerms: ["Apogee", "AI Brain"],
    minimumEvidence: 1
  }),
  personalCase("two_way_well_inked_roles", {
    query: "What roles have I had at Two-Way and Well Inked?",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["work_history_report_direct_read_model"],
    expectedTerms: ["Two-Way", "Well Inked"],
    minimumEvidence: 1
  }),
  personalCase("active_build_vs_work", {
    query: "What am I actively building now versus where do I work?",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["work_history_report_direct_read_model"],
    expectedTerms: ["Two-Way", "AI Brain"],
    minimumEvidence: 1
  }),
  personalCase("john_carmack_game_era_story", {
    query: "What things did I do with id Software and John Carmack?",
    expectedContract: "profile_report",
    expectedDomain: "personal_memory",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["work_history_report_direct_read_model"],
    expectedTerms: ["John Carmack", "Quake", "id Software"],
    minimumEvidence: 1
  }),
  personalCase("ai_brain_full_definition", {
    query: "Tell me everything about AI Brain.",
    expectedContract: "project_definition",
    expectedDomain: "project_definition",
    expectedAnswerShape: "report",
    expectedFinalClaimSources: ["project_definition_projection"],
    expectedTerms: ["AI Brain"],
    minimumEvidence: 1
  }),
  personalCase("shared_social_graph_gap", {
    query: "Who are all of mine and Dan's friends?",
    expectedContract: "shared_social_graph",
    expectedDomain: "relationship_social",
    expectedAnswerShape: "list",
    expectedFinalClaimSources: ["shared_social_graph"],
    expectedTerms: ["Lauren"],
    minimumEvidence: 1
  })
];
