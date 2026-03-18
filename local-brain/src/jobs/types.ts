export type ConsolidationAction = "ADD" | "UPDATE" | "SUPERSEDE" | "IGNORE";

export interface JobRunContext {
  readonly runId: string;
  readonly startedAt: string;
}

export interface ConsolidationDecision {
  readonly action: ConsolidationAction;
  readonly reason: string;
  readonly confidence?: number;
  readonly supersedesId?: string;
}

export interface ScheduledJob {
  readonly name:
    | "candidate_consolidation"
    | "relationship_adjudication"
    | "temporal_summary_scaffold"
    | "daily_summary"
    | "weekly_summary"
    | "monthly_profile_refresh"
    | "semantic_decay";
  readonly schedule: string;
}
