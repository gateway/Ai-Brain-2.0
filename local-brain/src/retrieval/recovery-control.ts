import {
  isIdentityProfileQuery,
  isPreciseFactDetailQuery,
  isProfileInferenceQuery,
  isRelationshipStyleExactQuery,
  isSharedCommonalityQuery,
  isTemporalDetailQuery
} from "./query-signals.js";
import type {
  RecallAdequacyStatus,
  RecallMissingInfoType,
  RecallPlan,
  RecallQueryModeHint,
  RecallReflectEligibility,
  RecallReflectOutcome,
  RecallSubjectMatch,
  RecallSufficiencyGrade
} from "./types.js";

interface RecoveryAssessmentInput {
  readonly queryText: string;
  readonly planner: RecallPlan;
  readonly queryModeHint: RecallQueryModeHint;
  readonly reflectEligibility: RecallReflectEligibility;
  readonly sufficiency: RecallSufficiencyGrade;
  readonly subjectMatch: RecallSubjectMatch;
  readonly evidenceCount: number;
  readonly exactDetailExtractionEnabled: boolean;
  readonly exactDetailResolved: boolean;
  readonly matchedParticipantCount: number;
  readonly missingParticipantCount: number;
}

export interface RecoveryAssessment {
  readonly adequacyStatus: RecallAdequacyStatus;
  readonly missingInfoType?: RecallMissingInfoType;
}

export function inferQueryModeHint(queryText: string, planner: RecallPlan): RecallQueryModeHint {
  const structuredExactCue =
    /\bwhat\s+(?:color|team|position|title|kind|type|name)\b/i.test(queryText) ||
    /\bwhich\s+(?:team|position|title|color)\b/i.test(queryText) ||
    /\bwhat\s+did\s+.+\s+(?:name|buy|purchase|adopt)\b/i.test(queryText) ||
    /\bwhat\s+are\s+.+['’]s\s+(?:hobbies|favorite\s+movies?|favorite\s+books?)\b/i.test(queryText) ||
    /\bwhat\s+is\s+.+['’]s\s+(?:favorite\s+movie|favorite\s+movie\s+trilog(?:y|ies)|main\s+focus)\b/i.test(queryText) ||
    /\bwhat\s+might\s+.+\s+financial\s+status\b/i.test(queryText) ||
    /\bwhat\s+sparked?\s+.+\s+interest\b/i.test(queryText) ||
    /\bwhich\s+places?\s+or\s+events?\b/i.test(queryText);

  if (
    isPreciseFactDetailQuery(queryText) ||
    (planner.queryClass === "direct_fact" &&
      structuredExactCue &&
      !/\b(?:currently|now|still|lately|overall|compare|common|share|why)\b/i.test(queryText))
  ) {
    return "exact_detail";
  }
  if (isTemporalDetailQuery(queryText) || planner.queryClass === "temporal_detail") {
    return "temporal_reconstruction";
  }
  if (isSharedCommonalityQuery(queryText) || /\b(both|common|share|together|similar|difference|compare)\b/i.test(queryText)) {
    return "commonality";
  }
  if (isProfileInferenceQuery(queryText) || isIdentityProfileQuery(queryText)) {
    return "broad_profile";
  }
  if (
    /\b(talk about|discuss|conversation|recap|summary|summarize|going on|overall|lately|recently|current picture)\b/i.test(queryText)
  ) {
    return "recap";
  }
  if (planner.queryClass === "graph_multi_hop" || isRelationshipStyleExactQuery(queryText) || /\bwhy\b/i.test(queryText)) {
    return "relation_bridge";
  }
  return "current_state";
}

export function reflectEligibilityForQueryMode(queryModeHint: RecallQueryModeHint): RecallReflectEligibility {
  switch (queryModeHint) {
    case "exact_detail":
      return "never";
    case "current_state":
    case "temporal_reconstruction":
      return "eligible";
    case "broad_profile":
    case "commonality":
    case "recap":
    case "relation_bridge":
      return "preferred_if_inadequate";
    default:
      return "eligible";
  }
}

export function assessRecoveryState(input: RecoveryAssessmentInput): RecoveryAssessment {
  if (input.subjectMatch === "mismatched") {
    return {
      adequacyStatus: "missing_subject",
      missingInfoType: "subject_identity_missing"
    };
  }

  if (input.subjectMatch === "mixed") {
    return {
      adequacyStatus: "mixed_subject",
      missingInfoType: "subject_isolation_missing"
    };
  }

  if (input.sufficiency === "contradicted") {
    return {
      adequacyStatus: "contradicted",
      missingInfoType: "conflict_resolution_missing"
    };
  }

  if (input.queryModeHint === "commonality" && input.missingParticipantCount > 0) {
    return {
      adequacyStatus: "missing_overlap_proof",
      missingInfoType: "overlap_proof_missing"
    };
  }

  if (input.evidenceCount === 0 || input.sufficiency === "missing") {
    return {
      adequacyStatus: "insufficient_evidence",
      missingInfoType:
        input.queryModeHint === "recap" || input.queryModeHint === "broad_profile"
          ? "recap_structure_missing"
          : input.queryModeHint === "relation_bridge"
            ? "relation_bridge_missing"
            : input.queryModeHint === "temporal_reconstruction"
              ? "temporal_anchor_missing"
              : undefined
    };
  }

  if (input.queryModeHint === "temporal_reconstruction" && input.sufficiency !== "supported") {
    return {
      adequacyStatus: "missing_temporal_anchor",
      missingInfoType: "temporal_anchor_missing"
    };
  }

  if (input.queryModeHint === "relation_bridge" && input.sufficiency !== "supported") {
    return {
      adequacyStatus: "missing_relation_bridge",
      missingInfoType: "relation_bridge_missing"
    };
  }

  if (input.queryModeHint === "exact_detail" && input.exactDetailExtractionEnabled && !input.exactDetailResolved) {
    return {
      adequacyStatus: input.evidenceCount > 0 ? "supported_but_unshapable" : "insufficient_evidence",
      missingInfoType: "slot_value_missing"
    };
  }

  if (
    input.sufficiency === "weak" &&
    (input.queryModeHint === "broad_profile" || input.queryModeHint === "recap" || input.queryModeHint === "commonality")
  ) {
    return {
      adequacyStatus: "insufficient_evidence",
      missingInfoType: input.queryModeHint === "commonality" ? "overlap_proof_missing" : "recap_structure_missing"
    };
  }

  return {
    adequacyStatus: "adequate"
  };
}

export function shouldEnterReflect(
  reflectEligibility: RecallReflectEligibility,
  recovery: RecoveryAssessment
): boolean {
  if (reflectEligibility === "never") {
    return false;
  }
  return recovery.adequacyStatus !== "adequate";
}

export function compareReflectOutcome(
  before: RecoveryAssessment,
  after: RecoveryAssessment,
  reflectApplied: boolean
): { readonly reflectHelped: boolean; readonly reflectOutcome?: RecallReflectOutcome } {
  if (!reflectApplied) {
    return { reflectHelped: false };
  }
  if (before.adequacyStatus === "adequate" && after.adequacyStatus !== "adequate") {
    return {
      reflectHelped: false,
      reflectOutcome: "harmful"
    };
  }
  if (before.adequacyStatus !== "adequate" && after.adequacyStatus === "adequate") {
    return {
      reflectHelped: true,
      reflectOutcome: "helped"
    };
  }
  return {
    reflectHelped: false,
    reflectOutcome: "no_gain"
  };
}
