import type { AnswerSectionSourceTrailEntry } from "./types.js";

export type InsightType =
  | "pattern"
  | "trend"
  | "recommendation"
  | "before_after"
  | "risk_gap"
  | "task_candidate"
  | "skill_candidate"
  | "source_audit_summary";

export interface InsightEvidenceExample {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly sourceUri: string;
  readonly sourceKind: string;
  readonly quote: string;
}

export interface InsightObservation {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly supportStatus: "supported" | "partial" | "derived_from_supported_pattern" | "unsupported";
  readonly sourceTrail: readonly AnswerSectionSourceTrailEntry[];
  readonly claimAudit?: readonly Record<string, unknown>[];
}

export interface InsightSuggestion {
  readonly id: string;
  readonly action: string;
  readonly rationale: string;
  readonly expectedImpact: string;
  readonly effort: "low" | "medium" | "high";
  readonly confidence: "low" | "medium" | "high";
  readonly supportStatus: "derived_from_supported_pattern" | "supported";
  readonly sourceTrail: readonly AnswerSectionSourceTrailEntry[];
}

export interface InsightVerification {
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly unsupportedInsightClaimCount: number;
  readonly unsupportedSuggestionCount: number;
  readonly citationFaithfulnessScore: number;
  readonly queryTimeModelCalls: number;
}

export interface InsightReport {
  readonly id: string;
  readonly query: string;
  readonly insightType: InsightType;
  readonly answer: string;
  readonly observations: readonly InsightObservation[];
  readonly examples: readonly InsightEvidenceExample[];
  readonly suggestions: readonly InsightSuggestion[];
  readonly trendSummary?: string | null;
  readonly uncertainty: readonly string[];
  readonly sourceTrail: readonly AnswerSectionSourceTrailEntry[];
  readonly verification: InsightVerification;
}
