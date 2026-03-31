export interface ProductGoldCase {
  readonly id: string;
  readonly pack:
    | "continuity_gold"
    | "entity_gold"
    | "temporal_gold"
    | "task_project_gold"
    | "canonical_entity_gold"
    | "clarification_rebuild_gold"
    | "relationship_history_gold"
    | "atlas_truth_gold"
    | "typed_fact_gold";
  readonly query: string;
  readonly expectedAnswerTerms: readonly string[];
  readonly requiredEvidenceCount: number;
  readonly requireSourceLink: boolean;
  readonly allowAbstention: boolean;
  readonly failureCategoryIfWrong: string;
}

export const PRODUCT_GOLD_CASES: readonly ProductGoldCase[] = [
  {
    id: "continuity_yesterday",
    pack: "continuity_gold",
    query: "What was I talking about yesterday?",
    expectedAnswerTerms: ["preset kitchen", "continuity", "dan"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "continuity_pack_error"
  },
  {
    id: "continuity_two_weeks_ago",
    pack: "continuity_gold",
    query: "Summarize everything I said two weeks ago.",
    expectedAnswerTerms: ["john", "burning man"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "continuity_pack_error"
  },
  {
    id: "entity_dan_relationship",
    pack: "entity_gold",
    query: "Who is Dan in my life right now, exactly?",
    expectedAnswerTerms: ["friend", "chiang mai"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "entity_resolution_error"
  },
  {
    id: "entity_four_people",
    pack: "entity_gold",
    query: "If I mention Dan, John, Lauren, and James, what is each person's relationship to me?",
    expectedAnswerTerms: ["dan", "john", "lauren", "james"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "entity_resolution_error"
  },
  {
    id: "entity_john_relationship",
    pack: "entity_gold",
    query: "Who is John in my life, and what is he associated with?",
    expectedAnswerTerms: ["john", "owner", "samui"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "entity_resolution_error"
  },
  {
    id: "entity_uncle_resolution",
    pack: "entity_gold",
    query: "Who is Uncle?",
    expectedAnswerTerms: ["billy smith", "joe bob"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "entity_resolution_error"
  },
  {
    id: "entity_james_relationship",
    pack: "entity_gold",
    query: "Who is James in my life, and what is he associated with?",
    expectedAnswerTerms: ["friend", "burning man", "lake tahoe"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "entity_resolution_error"
  },
  {
    id: "temporal_lauren_departure",
    pack: "temporal_gold",
    query: "When did Lauren leave for the US?",
    expectedAnswerTerms: ["october 18", "2025"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "temporal_resolution_error"
  },
  {
    id: "temporal_relationship_change",
    pack: "temporal_gold",
    query: "What changed recently in one important relationship, and when did it change?",
    expectedAnswerTerms: ["lauren", "2025"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "temporal_resolution_error"
  },
  {
    id: "task_open_items",
    pack: "task_project_gold",
    query: "What tasks were still open?",
    expectedAnswerTerms: ["continuity benchmark", "review open tasks"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "task_extraction_error"
  },
  {
    id: "task_pick_back_up",
    pack: "task_project_gold",
    query: "What should I pick back up this morning?",
    expectedAnswerTerms: ["preset kitchen", "continuity"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "task_extraction_error"
  },
  {
    id: "canonical_koh_samui_alias",
    pack: "canonical_entity_gold",
    query: "Who is John in my life, and what is he associated with?",
    expectedAnswerTerms: ["john", "samui experience", "koh samui"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "entity_resolution_error"
  },
  {
    id: "clarification_uncle_closed",
    pack: "clarification_rebuild_gold",
    query: "Who is Uncle?",
    expectedAnswerTerms: ["billy smith", "joe bob"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "clarification_closure_error"
  },
  {
    id: "relationship_history_lauren",
    pack: "relationship_history_gold",
    query: "What is Steve's history with Lauren?",
    expectedAnswerTerms: ["lake tahoe", "bend", "thailand"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "temporal_resolution_error"
  },
  {
    id: "atlas_alias_koh_samui",
    pack: "atlas_truth_gold",
    query: "What is Kozimui?",
    expectedAnswerTerms: ["koh samui"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "atlas_truth_error"
  },
  {
    id: "typed_fact_dan_movie",
    pack: "typed_fact_gold",
    query: "What movie did Dan mention two weeks ago, and where did he mention it?",
    expectedAnswerTerms: ["sinners", "13 march 2026", "korean barbecue place"],
    requiredEvidenceCount: 1,
    requireSourceLink: true,
    allowAbstention: false,
    failureCategoryIfWrong: "temporal_resolution_error"
  }
];
