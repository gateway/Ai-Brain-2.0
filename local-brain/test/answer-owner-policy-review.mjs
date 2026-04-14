import test from "node:test";
import assert from "node:assert/strict";

import { buildAnswerRetrievalPlan } from "../dist/retrieval/answer-retrieval-plan.js";
import {
  adjudicateCanonicalClaim,
  shouldSuppressGenericFallbackAfterOwnerResolution
} from "../dist/retrieval/canonical-adjudication.js";
import { adjudicateNarrativeClaim } from "../dist/retrieval/narrative-adjudication.js";
import { resolveAnswerOwner } from "../dist/retrieval/answer-owner-policy.js";
import {
  buildPersistedCollectionFactRecallResults,
  buildPersistedTemporalFactRecallResults,
  buildPlannerRuntimeCollectionFactCandidateFromResults,
  buildPlannerRuntimeReportCandidate,
  buildPlannerRuntimeStoredReportResult,
  buildPlannerTargetedBackfillSubqueries,
  preferPlannerRuntimeReportCandidate
} from "../dist/retrieval/service.js";
import { buildPlannerTypedCandidate, preferPlannerTypedCandidate } from "../dist/retrieval/planner-typed-candidates.js";
import {
  rankCollectionPoolResults,
  rankProfilePoolResults,
  rankTemporalPoolResults
} from "../dist/retrieval/planner-pool-ranker.js";

function recallResult(content, provenance = {}) {
  return {
    memoryId: `memory:${Math.random().toString(16).slice(2)}`,
    memoryType: "episodic_memory",
    content,
    artifactId: null,
    occurredAt: "2023-05-21T09:00:00.000Z",
    namespaceId: "test",
    provenance
  };
}

function supportedAssessment(overrides = {}) {
  return {
    confidence: "confident",
    sufficiency: "supported",
    subjectMatch: "matched",
    matchedParticipants: [],
    missingParticipants: [],
    foreignParticipants: [],
    ...overrides
  };
}

test("retrieval planner assigns collection inference lane and rescue policy for bookshelf questions", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:caroline"]
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "collection_inference");
  assert.equal(plan.resolvedSubjectEntityId, "person:caroline");
  assert.equal(plan.rescuePolicy, "single_targeted_rescue_before_abstention");
  assert.ok(plan.candidatePools.includes("collection_support"));
  assert.ok(plan.suppressionPools.includes("exact_detail_support"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "collection_support_missing"));
});

test("retrieval planner keeps concrete favorite-item questions in the exact-detail lane", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What is Nate's favorite movie trilogy?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:nate"]
  });

  assert.equal(plan.family, "exact_detail");
  assert.equal(plan.lane, "exact_detail");
  assert.ok(plan.candidatePools.includes("direct_detail_support"));
  assert.ok(!plan.suppressionHints.includes("canonical_exact_detail"));
});

test("retrieval planner routes favorite-style preference queries into report preference support", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What is Jon's favorite style of dance?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "report");
  assert.ok(plan.candidatePools.includes("preference_support"));
  assert.ok(plan.suppressionPools.includes("exact_detail_support"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "preference_support_missing"));
});

test("retrieval planner routes books-by-author preference choices into report preference support", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Would Tim enjoy reading books by C. S. Lewis or John Greene?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:tim"]
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "report");
  assert.ok(plan.candidatePools.includes("preference_support"));
  assert.ok(plan.queryExpansionTerms.includes("books"));
  assert.ok(plan.queryExpansionTerms.includes("fantasy"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "preference_support_missing"));
});

test("retrieval planner routes pet-care guidance questions into report pools", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What kind of classes or groups has Audrey joined to take better care of her dogs?",
    predicateFamily: "generic_fact",
    reportKind: "pet_care_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:audrey"]
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "report");
  assert.ok(plan.suppressionHints.includes("canonical_exact_detail"));
  assert.ok(plan.suppressionPools.includes("exact_detail_support"));
  assert.ok(!plan.candidatePools.includes("preference_support"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "pet_care_support_missing"));
});

test("retrieval planner routes roadtrip location queries into report pools", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Where has Evan been on roadtrips with his family?",
    predicateFamily: "generic_fact",
    reportKind: "travel_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:evan"]
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "report");
  assert.ok(plan.suppressionPools.includes("exact_detail_support"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "travel_location_entries_missing"));
});

test("retrieval planner separates subject and object names for object-bound country queries", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "In what country did Jolene buy snake Seraphim?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved"
  });

  assert.equal(plan.family, "exact_detail");
  assert.deepEqual(plan.subjectNames, ["Jolene"]);
  assert.deepEqual(plan.objectNames, ["Seraphim"]);
  assert.ok(plan.candidatePools.includes("subject_object_facts"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "object_binding_missing"));
});

test("retrieval planner routes favorite books into the book-list lane", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What are Jolene's favorite books?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved"
  });

  assert.equal(plan.family, "list_set");
  assert.equal(plan.lane, "book_list");
  assert.ok(plan.candidatePools.includes("book_list_support"));
  assert.ok(plan.suppressionHints.includes("canonical_exact_detail"));
});

test("retrieval planner keeps favorite painting style queries in the exact-detail lane", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What is Jon's favorite style of painting?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved"
  });

  assert.equal(plan.family, "exact_detail");
  assert.equal(plan.lane, "exact_detail");
  assert.ok(plan.candidatePools.includes("direct_detail_support"));
  assert.ok(!plan.candidatePools.includes("preference_support"));
});

test("retrieval planner does not route favorite book series about-queries into the book-list lane", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "What is Joanna's favorite book series about?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved"
  });

  assert.notEqual(plan.family, "list_set");
  assert.notEqual(plan.lane, "book_list");
});

test("retrieval planner keeps venue-fit enjoyment questions in report reasoning instead of preference choice", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Would Calvin enjoy performing at the Hollywood Bowl?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved"
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "report");
  assert.ok(!plan.candidatePools.includes("preference_support"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "causal_reason_missing"));
});

test("retrieval planner routes pair-advice questions into report reasoning", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Considering their conversations and personal growth, what advice might Evan and Sam give to someone facing a major life transition or challenge?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "ambiguous"
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "report");
  assert.ok(plan.pairSubjectNames.includes("Sam"));
});

test("retrieval planner keeps dog-sitting app uniqueness queries in aspiration support instead of pet-care support", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "How does James plan to make his dog-sitting app unique?",
    predicateFamily: "generic_fact",
    reportKind: "aspiration_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:james"]
  });

  assert.equal(plan.family, "report");
  assert.equal(plan.lane, "report");
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "aspiration_support_missing"));
  assert.ok(!plan.targetedBackfillRequests.some((request) => request.reason === "pet_care_support_missing"));
  assert.ok(!plan.requiredFields.includes("pet_care_support"));
});

test("retrieval planner routes friends-besides questions into support-network pools", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Is it likely that Nate has friends besides Joanna?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:nate"]
  });

  assert.equal(plan.family, "list_set");
  assert.equal(plan.lane, "support_network");
  assert.ok(plan.candidatePools.includes("support_network_support"));
  assert.ok(plan.suppressionPools.includes("generic_snippet_support"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "support_network_entries_missing"));
});

test("retrieval planner routes where-made-friends questions into location-history list-set pools", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "Where has Maria made friends?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:maria"]
  });

  assert.equal(plan.family, "list_set");
  assert.equal(plan.lane, "location_history");
  assert.ok(plan.candidatePools.includes("canonical_sets"));
  assert.ok(plan.candidatePools.includes("set_entries"));
  assert.ok(plan.suppressionPools.includes("exact_detail_support"));
  assert.ok(plan.targetedBackfillRequests.some((request) => request.reason === "location_history_entries_missing"));
});

test("owner policy lets a typed report beat generic exact detail for a bookshelf inference query", () => {
  const queryText = "Would Caroline likely have Dr. Seuss books on her bookshelf?";
  const results = [
    recallResult("Caroline collects classic children's books.", {
      subject_entity_id: "person:caroline",
      subject_name: "Caroline"
    })
  ];
  const narrativeDecision = adjudicateNarrativeClaim({
    queryText,
    exactDetailFamily: "generic",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "classic children's books",
      answerPayload: {
        answer_type: "bookshelf_inference",
        answer_value: "classic children's books",
        reason_value: "collects classic children's books",
        render_template: "yes_since_collects"
      },
      reportKind: "collection_report",
      candidateCount: 2,
      sourceTable: "canonical_entity_reports",
      selectionScoreMargin: 0.9
    }
  });
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: "home for these kids",
    exactDetailCandidateStrongSupport: true,
    exactDetailCandidatePredicateFit: false,
    abstentionClaimText: "Unknown.",
    derived: {
      residualExact: "home for these kids"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results,
    canonicalAdjudication: canonical,
    narrativeCandidate: narrativeDecision.candidate
  });

  assert.ok(resolution.adjudication);
  assert.equal(resolution.adjudication.formatted.finalClaimSource, "canonical_report");
  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "top_snippet" && owner.reason === "structured_owner_precedence"
    )
  );
});

test("owner policy lets a typed preference report beat exact detail for favorite-style queries", () => {
  const queryText = "What is Jon's favorite style of dance?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  const preferenceReportCandidate = {
    bundle: {
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      subjectBindingStatus: "resolved",
      subjectPlan: {
        kind: "single_subject",
        subjectEntityId: "person:jon",
        canonicalSubjectName: "Jon",
        candidateEntityIds: ["person:jon"],
        candidateNames: ["Jon"],
        reason: "explicit_subject"
      },
      predicateFamily: "narrative_profile",
      reportKind: "preference_report",
      ownerSourceTable: "planner_runtime_report_support"
    },
    canonical: {
      kind: "report"
    },
    formatted: {
      claimText: "Contemporary",
      finalClaimSource: "canonical_report",
      shapingTrace: {
        selectedFamily: "report",
        shapingPipelineEntered: true,
        supportObjectType: "ProfileInferenceSupport",
        renderContractSelected: "preference_value",
        retrievalPlanFamily: "report",
        retrievalPlanLane: "report",
        retrievalPlanSuppressionPools: ["exact_detail_support"],
        suppressionHints: ["canonical_exact_detail", "runtime_exact_detail"]
      }
    }
  };

  const exactDetailCandidate = {
    bundle: {
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      subjectBindingStatus: "resolved",
      subjectPlan: {
        kind: "single_subject",
        subjectEntityId: "person:jon",
        canonicalSubjectName: "Jon",
        candidateEntityIds: ["person:jon"],
        candidateNames: ["Jon"],
        reason: "explicit_subject"
      },
      predicateFamily: "generic_fact",
      ownerSourceTable: "canonical_facts"
    },
    canonical: {
      kind: "fact"
    },
    formatted: {
      claimText: "all dances",
      finalClaimSource: "canonical_exact_detail",
      shapingTrace: {
        selectedFamily: "exact_detail",
        shapingPipelineEntered: true,
        supportObjectType: "DirectDetailSupport",
        renderContractSelected: "exact_canonical_value"
      }
    }
  };

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results: [],
    retrievalPlan,
    exactDetailCandidate: null,
    canonicalAdjudication: exactDetailCandidate,
    narrativeCandidate: preferenceReportCandidate
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "canonical_exact_detail" && owner.reason === "planner_report_suppresses_exact_detail"
    )
  );
});

test("owner policy lets a planner-built collection report beat top-snippet fallback", () => {
  const queryText = "What items does John collect?";
  const results = [
    recallResult("John collects vintage records and sports memorabilia.", {
      subject_name: "John",
      subject_entity_id: "person:john",
      metadata: {
        source_sentence_text: "John collects vintage records and sports memorabilia."
      }
    })
  ];
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });
  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results,
    evidence: [
      {
        memoryId: "memory:john-collects",
        memoryType: "episodic_memory",
        snippet: "John collects vintage records and sports memorabilia.",
        provenance: {}
      }
    ],
    assessment: supportedAssessment({ matchedParticipants: ["John"] })
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results,
    retrievalPlan,
    canonicalAdjudication: null,
    narrativeCandidate: plannerCandidate,
    exactDetailCandidate: null
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate.bundle.subjectEntityId, "person:john");
  assert.equal(plannerCandidate.formatted.shapingTrace?.subjectBindingStatus, "resolved");
  assert.equal(plannerCandidate.formatted.shapingTrace?.supportObjectType, "CollectionSetSupport");
  assert.equal(plannerCandidate.formatted.shapingTrace?.renderContractSelected, "collection_set_render");
  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "top_snippet" && owner.reason === "structured_owner_precedence"
    )
  );
});

test("planner-built collection reports resolve explicit single-subject rows by name even without entity ids", () => {
  const queryText = "What items does John collect?";
  const results = [
    recallResult("John collects sneakers, fantasy movie DVDs, and jerseys.", {
      subject_name: "John",
      metadata: {
        source_sentence_text: "John collects sneakers, fantasy movie DVDs, and jerseys."
      }
    })
  ];
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "unresolved",
    subjectEntityHints: []
  });
  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results,
    evidence: [
      {
        memoryId: "memory:john-collects-no-entity",
        memoryType: "episodic_memory",
        snippet: "John collects sneakers, fantasy movie DVDs, and jerseys.",
        provenance: {}
      }
    ],
    assessment: supportedAssessment({ matchedParticipants: ["John"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate.bundle.subjectEntityId, null);
  assert.equal(plannerCandidate.bundle.subjectBindingStatus, "resolved");
  assert.equal(plannerCandidate.formatted.shapingTrace?.subjectBindingStatus, "resolved");
  assert.equal(plannerCandidate.formatted.shapingTrace?.supportObjectType, "CollectionSetSupport");
});

test("persisted collection facts can materialize a planner runtime collection candidate", () => {
  const queryText = "What items does John collect?";
  const results = buildPersistedCollectionFactRecallResults({
    namespaceId: "test",
    subjectEntityId: "person:john",
    subjectName: "John",
    rows: [
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "sneakers",
        normalized_value: "sneakers",
        cue_type: "explicit_collects",
        cue_strength: 5,
        confidence: 0.95,
        source_artifact_id: "artifact:1",
        source_chunk_id: "chunk:1",
        source_text: "John collects sneakers."
      },
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "fantasy movie DVDs",
        normalized_value: "fantasy movie dvds",
        cue_type: "collection_of",
        cue_strength: 4,
        confidence: 0.9,
        source_artifact_id: "artifact:1",
        source_chunk_id: "chunk:2",
        source_text: "John has a collection of fantasy movie DVDs."
      },
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "jerseys",
        normalized_value: "jerseys",
        cue_type: "typed_set",
        cue_strength: 4,
        confidence: 0.88,
        source_artifact_id: "artifact:2",
        source_chunk_id: "chunk:3",
        source_text: "Jerseys are part of John's collection."
      }
    ]
  });
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });
  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate.bundle.subjectEntityId, "person:john");
  assert.equal(plannerCandidate.formatted.shapingTrace?.supportObjectType, "CollectionSetSupport");
  assert.equal(plannerCandidate.formatted.shapingTrace?.renderContractSelected, "collection_set_render");
  assert.match(plannerCandidate.formatted.claimText, /sneakers/i);
  assert.match(plannerCandidate.formatted.claimText, /fantasy movie dvds/i);
  assert.match(plannerCandidate.formatted.claimText, /jerseys/i);
});

test("direct collection-fact candidate lane can materialize a typed collection owner from persisted facts alone", () => {
  const queryText = "What items does John collect?";
  const results = buildPersistedCollectionFactRecallResults({
    namespaceId: "test",
    subjectEntityId: "person:john",
    subjectName: "John",
    rows: [
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "sneakers",
        normalized_value: "sneakers",
        cue_type: "explicit_collects",
        cue_strength: 5,
        confidence: 0.95,
        source_artifact_id: "artifact:1",
        source_chunk_id: "chunk:1",
        source_text: "John collects sneakers."
      },
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "fantasy movie DVDs",
        normalized_value: "fantasy movie dvds",
        cue_type: "collection_of",
        cue_strength: 4,
        confidence: 0.9,
        source_artifact_id: "artifact:1",
        source_chunk_id: "chunk:2",
        source_text: "John has a collection of fantasy movie DVDs."
      }
    ]
  });
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved"
  });
  const plannerCandidate = buildPlannerRuntimeCollectionFactCandidateFromResults({
    queryText,
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate.formatted.shapingTrace?.supportObjectType, "CollectionSetSupport");
  assert.equal(plannerCandidate.formatted.shapingTrace?.renderContractSelected, "collection_set_render");
  assert.match(plannerCandidate.formatted.claimText, /sneakers/i);
  assert.match(plannerCandidate.formatted.claimText, /fantasy movie dvds/i);
});

test("canonical-set collection support can materialize a typed collection owner", () => {
  const queryText = "What items does John collect?";
  const results = buildPersistedCollectionFactRecallResults({
    namespaceId: "test",
    subjectEntityId: "person:john",
    subjectName: "John",
    sourceTable: "canonical_set_collection_support",
    rows: [
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "fantasy movie DVDs",
        normalized_value: "fantasy movie dvds",
        cue_type: "typed_set",
        cue_strength: 4,
        confidence: 0.82,
        source_artifact_id: null,
        source_chunk_id: "set:1",
        source_text: "fantasy movie DVDs"
      },
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "jerseys",
        normalized_value: "jerseys",
        cue_type: "typed_set",
        cue_strength: 5,
        confidence: 0.85,
        source_artifact_id: null,
        source_chunk_id: "set:1",
        source_text: "jerseys"
      }
    ]
  });
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved"
  });
  const plannerCandidate = buildPlannerRuntimeCollectionFactCandidateFromResults({
    queryText,
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate.formatted.shapingTrace?.supportObjectType, "CollectionSetSupport");
  assert.equal(plannerCandidate.formatted.shapingTrace?.renderContractSelected, "collection_set_render");
  assert.match(plannerCandidate.formatted.claimText, /fantasy movie dvds/i);
  assert.match(plannerCandidate.formatted.claimText, /jerseys/i);
});

test("collection pool ranker prefers subject-bound canonical collection facts over foreign rows", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What items does John collect?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const johnResults = buildPersistedCollectionFactRecallResults({
    namespaceId: "test",
    subjectEntityId: "person:john",
    subjectName: "John",
    rows: [
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "sneakers",
        normalized_value: "sneakers",
        cue_type: "explicit_collects",
        cue_strength: 5,
        confidence: 0.95,
        source_artifact_id: "artifact:1",
        source_chunk_id: "chunk:1",
        source_text: "John collects sneakers."
      },
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "fantasy movie DVDs",
        normalized_value: "fantasy movie dvds",
        cue_type: "collection_of",
        cue_strength: 4,
        confidence: 0.9,
        source_artifact_id: "artifact:1",
        source_chunk_id: "chunk:2",
        source_text: "John has a collection of fantasy movie DVDs."
      }
    ]
  });

  const foreignResult = recallResult("Michael collects trading cards, signed baseballs, and vintage bats.", {
    subject_entity_id: "person:michael",
    subject_name: "Michael",
    source_table: "canonical_collection_facts",
    metadata: {
      subject_entity_id: "person:michael",
      subject_name: "Michael",
      source_table: "canonical_collection_facts",
      cue_type: "explicit_collects",
      cue_strength: 5,
      confidence: 0.99,
      answer_payload: {
        answer_type: "collection_items",
        item_values: ["trading cards", "signed baseballs", "vintage bats"]
      }
    }
  });

  const ranked = rankCollectionPoolResults({
    queryText: "What items does John collect?",
    retrievalPlan,
    results: [foreignResult, ...johnResults]
  });

  assert.ok(ranked.length >= 2);
  assert.equal(ranked[0]?.provenance.subject_entity_id, "person:john");
  assert.match(ranked[0]?.content ?? "", /john|sneakers/i);
});

test("owner policy upgrades canonical exact-detail rows into report owners when report shaping already entered", () => {
  const resolution = resolveAnswerOwner({
    queryText: "How does John plan to honor the memories of his beloved pet?",
    exactDetailFamily: "generic",
    results: [recallResult("John plans to honor his beloved pet by creating a memorial garden and photo wall.")],
    canonicalAdjudication: {
      canonical: {
        kind: "fact",
        subjectEntityId: "person:john",
        canonicalSubjectName: "John",
        predicateFamily: "generic_fact",
        supportStrength: "strong",
        timeScopeKind: "active",
        confidence: "confident",
        status: "supported",
        objectValue: "by creating a memorial garden and photo wall",
        provenanceRows: [],
        validFrom: null,
        validUntil: null
      },
      formatted: {
        claimText: "He plans to honor his beloved pet by creating a memorial garden and photo wall.",
        finalClaimSource: "canonical_exact_detail",
        shapingTrace: {
          selectedFamily: "report",
          shapingMode: "typed_report_payload",
          retrievalPlanFamily: "report",
          retrievalPlanLane: "report",
          retrievalPlanSuppressionPools: ["exact_detail_support"],
          suppressionHints: ["canonical_exact_detail", "runtime_exact_detail"],
          shapingPipelineEntered: true,
          supportObjectAttempted: true,
          renderContractAttempted: true,
          typedValueUsed: true,
          generatedProseUsed: false,
          runtimeResynthesisUsed: false,
          supportRowsSelected: 1,
          supportTextsSelected: 1,
          supportSelectionMode: "report_support",
          supportObjectsBuilt: 1,
          supportObjectType: "ProfileInferenceSupport",
          supportNormalizationFailures: [],
          renderContractSelected: "report_scalar_value",
          renderContractFallbackReason: null
        },
        answerBundle: {
          topClaim: "He plans to honor his beloved pet by creating a memorial garden and photo wall.",
          claimKind: "report",
          subjectPlan: {
            kind: "single_subject",
            subjectEntityId: "person:john",
            canonicalSubjectName: "John",
            candidateEntityIds: ["person:john"],
            candidateNames: ["John"],
            reason: "test"
          },
          predicatePlan: "profile_state",
          timePlan: {
            timeScopeKind: "active",
            source: "unknown"
          },
          evidenceBundle: [],
          fallbackBlockedReason: null,
          reasoningChain: {
            subjectChain: ["John"],
            predicateChain: ["profile_state"],
            temporalChain: [],
            canonicalSupport: ["canonical_facts"],
            provenanceIds: [],
            abstentionBlockers: [],
            exclusionClauses: []
          }
        }
      },
      bundle: {
        subjectEntityId: "person:john",
        canonicalSubjectName: "John",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          subjectEntityId: "person:john",
          canonicalSubjectName: "John",
          candidateEntityIds: ["person:john"],
          candidateNames: ["John"],
          reason: "test"
        },
        predicateFamily: "generic_fact",
        provenanceRows: [],
        evidenceItems: [],
        supportStrength: "strong",
        timeScopeKind: "active",
        ownerSourceTable: "canonical_facts"
      }
    },
    narrativeCandidate: null,
    exactDetailCandidate: {
      text: "by creating a memorial garden and photo wall",
      source: "artifact_source",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) =>
        (owner.owner === "canonical_exact_detail" || owner.owner === "runtime_exact_detail") &&
        owner.reason.includes("exact_detail")
    )
  );
});

test("owner policy suppresses canonical report winners for concrete exact-detail questions when exact detail is viable", () => {
  const resolution = resolveAnswerOwner({
    queryText: "What kind of pastries did Andrew and his girlfriend have at the cafe?",
    exactDetailFamily: "generic",
    results: [recallResult("They had croissants and fruit danishes.")],
    canonicalAdjudication: {
      canonical: {
        kind: "report",
        subjectEntityId: "person:andrew",
        canonicalSubjectName: "Andrew",
        subjectBindingStatus: "resolved",
        predicateFamily: "profile_state",
        supportStrength: "weak",
        timeScopeKind: "active",
        confidence: "weak",
        objectValue: "dog-friendly park city",
        sourceTable: "canonical_states"
      },
      formatted: {
        claimText: "dog-friendly park city",
        finalClaimSource: "canonical_profile",
        shapingTrace: {
          selectedFamily: "report",
          retrievalPlanFamily: "exact_detail",
          retrievalPlanLane: "exact_detail",
          shapingMode: "typed_report_payload",
          shapingPipelineEntered: true,
          supportObjectAttempted: true,
          renderContractAttempted: true,
          typedValueUsed: true,
          generatedProseUsed: false,
          runtimeResynthesisUsed: false,
          supportRowsSelected: 1,
          supportTextsSelected: 1,
          supportSelectionMode: "report_support",
          supportObjectsBuilt: 1,
          supportObjectType: "ProfileInferenceSupport",
          supportNormalizationFailures: [],
          renderContractSelected: "report_scalar_value",
          renderContractFallbackReason: null
        },
        answerBundle: null
      },
      bundle: {
        subjectEntityId: "person:andrew",
        canonicalSubjectName: "Andrew",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          subjectEntityId: "person:andrew",
          canonicalSubjectName: "Andrew",
          candidateEntityIds: ["person:andrew"],
          candidateNames: ["Andrew"],
          reason: "test"
        },
        predicateFamily: "profile_state",
        provenanceRows: [],
        evidenceItems: [],
        supportStrength: "weak",
        timeScopeKind: "active",
        ownerSourceTable: "canonical_states"
      }
    },
    narrativeCandidate: null,
    exactDetailCandidate: {
      text: "croissants and fruit danishes",
      source: "artifact_source",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "exact_detail");
  assert.equal(resolution.trace.winner, "runtime_exact_detail");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "canonical_report" && owner.reason === "exact_detail_family_precedence"
    )
  );
});

test("owner policy uses the runtime retrieval plan to suppress exact detail when a collection report lane is active", () => {
  const queryText = "What items does John collect?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    retrievalPlan,
    results: [recallResult("John collects Harry Potter items and related memorabilia.")],
    canonicalAdjudication: {
      canonical: {
        kind: "fact",
        subjectEntityId: "person:john",
        canonicalSubjectName: "John",
        subjectBindingStatus: "resolved",
        predicateFamily: "generic_fact",
        supportStrength: "strong",
        timeScopeKind: "active",
        confidence: "confident",
        status: "supported",
        objectValue: "not being on the court",
        provenanceRows: [],
        validFrom: null,
        validUntil: null
      },
      formatted: {
        claimText: "not being on the court",
        finalClaimSource: "canonical_exact_detail",
        answerBundle: null
      },
      bundle: {
        subjectEntityId: "person:john",
        canonicalSubjectName: "John",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          subjectEntityId: "person:john",
          canonicalSubjectName: "John",
          candidateEntityIds: ["person:john"],
          candidateNames: ["John"],
          reason: "test"
        },
        predicateFamily: "generic_fact",
        provenanceRows: [],
        evidenceItems: [],
        supportStrength: "strong",
        timeScopeKind: "active",
        ownerSourceTable: "canonical_facts"
      }
    },
    narrativeCandidate: {
      canonical: {
        kind: "report",
        subjectEntityId: "person:john",
        canonicalSubjectName: "John",
        subjectBindingStatus: "resolved",
        predicateFamily: "narrative_profile",
        supportStrength: "moderate",
        timeScopeKind: "active",
        confidence: "weak",
        reportKind: "collection_report",
        summaryText: "Harry Potter items",
        provenanceRows: [],
        validFrom: null,
        validUntil: null
      },
      formatted: {
        claimText: "Harry Potter items",
        finalClaimSource: "canonical_report",
        shapingTrace: {
          selectedFamily: "report",
          shapingMode: "stored_report_summary",
          retrievalPlanFamily: retrievalPlan.family,
          retrievalPlanLane: retrievalPlan.lane,
          retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
          suppressionHints: retrievalPlan.suppressionHints,
          shapingPipelineEntered: false,
          supportObjectAttempted: false,
          renderContractAttempted: false,
          typedValueUsed: false,
          generatedProseUsed: false,
          runtimeResynthesisUsed: false,
          supportRowsSelected: 1,
          supportTextsSelected: 0,
          supportSelectionMode: null,
          supportObjectsBuilt: 0,
          supportObjectType: null,
          supportNormalizationFailures: [],
          renderContractSelected: null,
          renderContractFallbackReason: null
        },
        answerBundle: null
      },
      bundle: {
        subjectEntityId: "person:john",
        canonicalSubjectName: "John",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          subjectEntityId: "person:john",
          canonicalSubjectName: "John",
          candidateEntityIds: ["person:john"],
          candidateNames: ["John"],
          reason: "test"
        },
        predicateFamily: "narrative_profile",
        provenanceRows: [],
        evidenceItems: [],
        supportStrength: "moderate",
        timeScopeKind: "active",
        ownerSourceTable: "canonical_entity_reports"
      }
    },
    exactDetailCandidate: {
      text: "not being on the court",
      source: "artifact_source",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) =>
        (owner.owner === "canonical_exact_detail" || owner.owner === "runtime_exact_detail") &&
        owner.reason.includes("suppresses_exact_detail")
    )
  );
});

test("owner policy suppresses exact detail when a pet-care report lane is active", () => {
  const queryText = "What kind of classes or groups has Audrey joined to take better care of her dogs?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    reportKind: "pet_care_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:audrey"]
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    retrievalPlan,
    results: [recallResult("Audrey joined local dog-owner workshops and agility groups to take better care of her dogs.")],
    canonicalAdjudication: {
      canonical: {
        kind: "fact",
        subjectEntityId: "person:audrey",
        canonicalSubjectName: "Audrey",
        subjectBindingStatus: "resolved",
        predicateFamily: "generic_fact",
        supportStrength: "strong",
        timeScopeKind: "active",
        confidence: "confident",
        status: "supported",
        objectValue: "on pets or even hurting them",
        provenanceRows: [],
        validFrom: null,
        validUntil: null
      },
      formatted: {
        claimText: "on pets or even hurting them",
        finalClaimSource: "canonical_exact_detail",
        answerBundle: null
      },
      bundle: {
        subjectEntityId: "person:audrey",
        canonicalSubjectName: "Audrey",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          subjectEntityId: "person:audrey",
          canonicalSubjectName: "Audrey",
          candidateEntityIds: ["person:audrey"],
          candidateNames: ["Audrey"],
          reason: "test"
        },
        predicateFamily: "generic_fact",
        provenanceRows: [],
        evidenceItems: [],
        supportStrength: "strong",
        timeScopeKind: "active",
        ownerSourceTable: "canonical_facts"
      }
    },
    narrativeCandidate: {
      canonical: {
        kind: "report",
        subjectEntityId: "person:audrey",
        canonicalSubjectName: "Audrey",
        subjectBindingStatus: "resolved",
        predicateFamily: "narrative_profile",
        supportStrength: "moderate",
        timeScopeKind: "active",
        confidence: "weak",
        reportKind: "pet_care_report",
        summaryText: "local dog-owner workshops and agility groups",
        provenanceRows: [],
        validFrom: null,
        validUntil: null
      },
      formatted: {
        claimText: "local dog-owner workshops and agility groups",
        finalClaimSource: "canonical_report",
        shapingTrace: {
          selectedFamily: "report",
          shapingMode: "typed_report_payload",
          retrievalPlanFamily: retrievalPlan.family,
          retrievalPlanLane: retrievalPlan.lane,
          retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
          suppressionHints: retrievalPlan.suppressionHints,
          shapingPipelineEntered: true,
          supportObjectAttempted: true,
          renderContractAttempted: true,
          typedValueUsed: true,
          generatedProseUsed: false,
          runtimeResynthesisUsed: false,
          supportRowsSelected: 1,
          supportTextsSelected: 1,
          supportSelectionMode: "explicit_subject_filtered",
          supportObjectsBuilt: 1,
          supportObjectType: "ProfileInferenceSupport",
          supportNormalizationFailures: [],
          renderContractSelected: "pet_care_classes_render",
          renderContractFallbackReason: null
        },
        answerBundle: null
      },
      bundle: {
        subjectEntityId: "person:audrey",
        canonicalSubjectName: "Audrey",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          subjectEntityId: "person:audrey",
          canonicalSubjectName: "Audrey",
          candidateEntityIds: ["person:audrey"],
          candidateNames: ["Audrey"],
          reason: "test"
        },
        predicateFamily: "narrative_profile",
        provenanceRows: [],
        evidenceItems: [],
        supportStrength: "moderate",
        timeScopeKind: "active",
        ownerSourceTable: "canonical_entity_reports"
      }
    },
    exactDetailCandidate: {
      text: "on pets or even hurting them",
      source: "artifact_source",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) =>
        (owner.owner === "canonical_exact_detail" || owner.owner === "runtime_exact_detail") &&
        owner.reason.includes("suppresses_exact_detail")
    )
  );
});

test("owner policy maps canonical profile-state rows to report owners before exact detail", () => {
  const queryText = "Would Caroline likely have Dr. Seuss books on her bookshelf?";
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results: [
      recallResult("Caroline collects classic children's books.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      confidence: "missing",
      sufficiency: "contradicted",
      subjectMatch: "mismatched",
      matchedParticipants: ["Caroline"]
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: "Yes, since she collects classic children's books"
    },
    storedCanonical: {
      kind: "state",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "ambiguous",
      predicateFamily: "profile_state",
      supportStrength: "weak",
      timeScopeKind: "historical",
      confidence: "weak",
      objectValue: "Yes, since she collects classic children's books",
      sourceTable: "canonical_states"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results: [],
    canonicalAdjudication: canonical,
    narrativeCandidate: null
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.equal(resolution.adjudication?.formatted.finalClaimSource, "canonical_profile");
  assert.ok(
    resolution.trace.candidates.some(
      (candidate) => candidate.owner === "canonical_report" && candidate.family === "report"
    )
  );
});

test("owner policy keeps canonical profile-state winners from collapsing into narrative abstentions", () => {
  const queryText = "Would Caroline likely have Dr. Seuss books on her bookshelf?";
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results: [
      recallResult("Caroline collects classic children's books.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      confidence: "missing",
      sufficiency: "contradicted",
      subjectMatch: "mismatched",
      matchedParticipants: ["Caroline"]
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: "Yes, since she collects classic children's books"
    },
    storedCanonical: {
      kind: "state",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "ambiguous",
      predicateFamily: "profile_state",
      supportStrength: "weak",
      timeScopeKind: "historical",
      confidence: "weak",
      objectValue: "Yes, since she collects classic children's books",
      sourceTable: "canonical_states"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results: [],
    canonicalAdjudication: canonical,
    narrativeCandidate: {
      canonical: {
        kind: "abstention",
        subjectEntityId: "person:caroline",
        canonicalSubjectName: "Caroline",
        subjectBindingStatus: "resolved",
        predicateFamily: "narrative_profile",
        supportStrength: "weak",
        timeScopeKind: "historical",
        confidence: "missing",
        abstainReason: "insufficient_support",
        sourceTable: "canonical_entity_reports"
      },
      formatted: {
        claimText: "No authoritative evidence matched the requested person.",
        finalClaimSource: "canonical_abstention"
      },
      bundle: {
        ownerSourceTable: "canonical_entity_reports",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          requestedNames: ["Caroline"],
          foreignNames: []
        }
      }
    }
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.equal(resolution.adjudication?.formatted.finalClaimSource, "canonical_profile");
});

test("owner policy maps canonical event-list rows to list-set owners before exact detail", () => {
  const queryText = "What events has Caroline participated in to help children?";
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results: [
      recallResult("Caroline spoke at a school fundraiser to support children's literacy.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      genericEnumerative: "school fundraiser, literacy event"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results: [],
    canonicalAdjudication: canonical,
    narrativeCandidate: null
  });

  assert.equal(canonical?.canonical.predicateFamily, "list_set");
  assert.equal(canonical?.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(resolution.trace.family, "list_set");
  assert.equal(resolution.trace.winner, "canonical_list_set");
});

test("owner policy lets typed temporal owners beat generic exact detail for event-keyed queries", () => {
  const queryText = "What year did John start surfing?";
  const results = [
    recallResult("John started surfing in 2018.", {
      subject_entity_id: "person:john",
      subject_name: "John"
    })
  ];
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: "14 May 2023",
    exactDetailCandidateStrongSupport: true,
    abstentionClaimText: "Unknown.",
    derived: {
      temporal: "2018"
    },
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "temporal_event_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "2018",
      validFrom: "2018-01-01T00:00:00.000Z",
      validUntil: null,
      sourceTable: "canonical_temporal_facts",
      eventKey: "start_surfing"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results,
    canonicalAdjudication: canonical,
    narrativeCandidate: null
  });

  assert.ok(resolution.adjudication);
  assert.equal(resolution.adjudication.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(resolution.trace.family, "temporal");
  assert.equal(resolution.trace.winner, "canonical_temporal");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "top_snippet" && owner.reason === "structured_owner_precedence"
    )
  );
});

test("owner policy prioritizes temporal family over report family for explicit temporal questions", () => {
  const queryText = "When did Caroline go to the LGBTQ support group?";
  const results = [
    recallResult("Caroline went to the LGBTQ support group yesterday.", {
      subject_entity_id: "person:caroline",
      subject_name: "Caroline"
    })
  ];
  const narrativeDecision = adjudicateNarrativeClaim({
    queryText,
    exactDetailFamily: "generic",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "moderate",
      timeScopeKind: "active",
      confidence: "weak",
      objectValue: "She found support through an LGBTQ support group.",
      reportKind: "support_report",
      candidateCount: 1,
      sourceTable: "retrieved_text_unit_report"
    }
  });
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    abstentionClaimText: "Unknown.",
    derived: {
      temporal: "2023-08-23"
    },
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "temporal_event_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "2023-08-23",
      validFrom: "2023-08-23T00:00:00.000Z",
      validUntil: null,
      sourceTable: "canonical_temporal_facts",
      eventKey: "go_lgbtq_support_group"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results,
    canonicalAdjudication: canonical,
    narrativeCandidate: narrativeDecision.candidate
  });

  assert.equal(resolution.trace.family, "temporal");
  assert.equal(resolution.trace.winner, "canonical_temporal");
});

test("owner policy lets typed list/set owners beat mixed string fallback for pair list queries", () => {
  const queryText = "Which country do Calvin and Dave want to meet in?";
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Calvin", "Dave"] }),
    exactDetailFamily: "country",
    exactDetailCandidateText: "Tokyo and Japanese",
    exactDetailCandidateStrongSupport: true,
    abstentionClaimText: "Unknown.",
    derived: {},
    storedCanonical: {
      kind: "set",
      subjectEntityId: "person:calvin",
      canonicalSubjectName: "Calvin",
      pairSubjectEntityId: "person:dave",
      pairSubjectName: "Dave",
      subjectBindingStatus: "resolved",
      predicateFamily: "list_set",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValues: ["Japan"],
      sourceTable: "canonical_sets"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "country",
    results: [recallResult("They talked about Tokyo and Japanese food.")],
    canonicalAdjudication: canonical,
    narrativeCandidate: null
  });

  assert.ok(resolution.adjudication);
  assert.equal(resolution.adjudication.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(resolution.trace.family, "list_set");
  assert.equal(resolution.trace.winner, "canonical_list_set");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "top_snippet" && owner.reason === "structured_owner_precedence"
    )
  );
});

test("owner policy lets typed list/set owners outrank exact detail for object-bound country questions", () => {
  const queryText = "In what country did Jolene buy snake Seraphim?";
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jolene"] }),
    exactDetailFamily: "country",
    exactDetailCandidateText: "Thailand",
    exactDetailCandidateStrongSupport: true,
    abstentionClaimText: "Unknown.",
    derived: {},
    storedCanonical: {
      kind: "set",
      subjectEntityId: "person:jolene",
      canonicalSubjectName: "Jolene",
      subjectBindingStatus: "resolved",
      predicateFamily: "list_set",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValues: ["France"],
      typedSetEntryValues: ["France"],
      typedSetEntryType: "country",
      sourceTable: "canonical_sets"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "country",
    results: [recallResult("Jolene bought Seraphim in Thailand.")],
    retrievalPlan: buildAnswerRetrievalPlan({
      queryText,
      predicateFamily: "generic_fact",
      subjectBindingStatus: "resolved"
    }),
    canonicalAdjudication: canonical,
    narrativeCandidate: null,
    exactDetailCandidate: {
      text: "Thailand",
      source: "episodic_leaf",
      strongSupport: true
    }
  });

  assert.equal(resolution.trace.family, "exact_detail");
  assert.equal(resolution.trace.winner, "canonical_list_set");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "runtime_exact_detail" && owner.reason === "typed_list_set_owner_precedence"
    )
  );
});

test("owner policy does not let an unresolved list/set owner suppress exact detail on explicit-name queries", () => {
  const queryText = "What books has Melanie read?";
  const readBooksEvidence = `Melanie read "Nothing is Impossible" and "Charlotte's Web".`;
  const expectedBooksClaim = `"Nothing is Impossible", "Charlotte's Web"`;
  const canonical = {
    canonical: {
      kind: "set",
      subjectEntityId: null,
      canonicalSubjectName: null,
      pairSubjectEntityId: null,
      pairSubjectName: null,
      subjectBindingStatus: "unresolved",
      predicateFamily: "list_set",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValues: ['"Nothing is Impossible"', `"Charlotte's Web"`],
      sourceTable: "runtime_adjudication"
    },
    formatted: {
      claimText: expectedBooksClaim,
      finalClaimSource: "canonical_list_set"
    },
    bundle: {
      ownerSourceTable: "runtime_adjudication",
      subjectBindingStatus: "unresolved",
      subjectPlan: {
        kind: "no_subject",
        requestedNames: [],
        foreignNames: []
      }
    }
  };

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "favorite_books",
    results: [recallResult(readBooksEvidence, {
      subject_entity_id: "person:melanie",
      subject_name: "Melanie"
    })],
    canonicalAdjudication: canonical,
    narrativeCandidate: null,
    exactDetailCandidate: {
      text: expectedBooksClaim,
      source: "episodic_leaf",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "list_set");
  assert.equal(resolution.trace.winner, "runtime_exact_detail");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "canonical_list_set" && owner.reason === "binding_required_for_explicit_subject"
    )
  );
});

test("owner policy only lets abstention win after typed and generic owners are exhausted", () => {
  const queryText = "What are Deborah's snakes called?";
  const canonical = adjudicateCanonicalClaim({
    queryText,
    results: [recallResult("Someone else had the pet names in a neighboring turn.", { subject_entity_id: "person:other" })],
    evidence: [],
    assessment: supportedAssessment({ confidence: "partial", sufficiency: "weak", subjectMatch: "mixed" }),
    exactDetailFamily: "plural_names",
    exactDetailCandidateText: "Ollie and Pip",
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      residualExact: null
    },
    storedCanonical: {
      kind: "abstention",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "ambiguous",
      predicateFamily: "ownership_binding",
      supportStrength: "weak",
      timeScopeKind: "unknown",
      confidence: "missing",
      abstainReason: "insufficient_subject_binding",
      sourceTable: "canonical_ambiguities"
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "plural_names",
    results: [recallResult("Someone else had the pet names in a neighboring turn.", { subject_entity_id: "person:other" })],
    canonicalAdjudication: canonical,
    narrativeCandidate: null
  });

  assert.ok(resolution.adjudication);
  assert.equal(resolution.adjudication.formatted.finalClaimSource, "canonical_abstention");
  assert.equal(resolution.trace.winner, "canonical_abstention");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "top_snippet" && owner.reason === "structured_owner_precedence"
    )
  );
});

test("owner policy traces narrative abstentions as abstention owners instead of reports", () => {
  const queryText = "Would Caroline likely have Dr. Seuss books on her bookshelf?";
  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results: [recallResult("I'm creating a library for when I have kids.", {
      subject_entity_id: "person:caroline",
      subject_name: "Caroline"
    })],
    canonicalAdjudication: null,
    narrativeCandidate: {
      canonical: {
        kind: "abstention",
        subjectEntityId: "person:caroline",
        canonicalSubjectName: "Caroline",
        subjectBindingStatus: "resolved",
        predicateFamily: "narrative_profile",
        supportStrength: "weak",
        timeScopeKind: "unknown",
        confidence: "missing",
        abstainReason: "insufficient_support",
        sourceTable: "canonical_entity_reports"
      },
      formatted: {
        claimText: "No authoritative evidence found.",
        finalClaimSource: "canonical_abstention"
      },
      bundle: {
        ownerSourceTable: "canonical_entity_reports",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          requestedNames: ["Caroline"],
          foreignNames: []
        }
      }
    },
    exactDetailCandidate: null
  });

  assert.equal(resolution.trace.winner, "canonical_abstention");
  assert.equal(resolution.adjudication?.formatted.finalClaimSource, "canonical_abstention");
});

test("owner policy keeps why-start motive questions in the report family instead of misclassifying them as temporal", () => {
  const queryText = "Why did Jon decide to start his dance studio?";
  const results = [
    recallResult("Jon lost his job and decided to start his own business so he could share his passion for dance.", {
      subject_entity_id: "person:jon",
      subject_name: "Jon"
    })
  ];
  const narrativeDecision = adjudicateNarrativeClaim({
    queryText,
    exactDetailFamily: "generic",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_motive",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "lost his job and decided to start his own business to share his passion",
      reportKind: "aspiration_report",
      sourceTable: "canonical_entity_reports",
      candidateCount: 1,
      selectionScoreMargin: 0.8
    }
  });

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results,
    canonicalAdjudication: null,
    narrativeCandidate: narrativeDecision.candidate,
    exactDetailCandidate: {
      text: "all dances",
      source: "artifact_source",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) =>
        (owner.owner === "runtime_exact_detail" || owner.owner === "canonical_exact_detail") &&
        owner.reason === "typed_report_owner_precedence"
    )
  );
});

test("owner policy traces runtime exact-detail candidates as structured winners when canonical lookup is absent", () => {
  const queryText = "Who did Maria have dinner with on May 3, 2023?";
  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "meal_companion",
    results: [recallResult("I had dinner with my mother on May 3, 2023.", {
      subject_entity_id: "person:maria",
      subject_name: "Maria"
    })],
    canonicalAdjudication: null,
    narrativeCandidate: null,
    exactDetailCandidate: {
      text: "her mother",
      source: "artifact_source",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "exact_detail");
  assert.equal(resolution.trace.winner, "runtime_exact_detail");
  assert.equal(resolution.trace.resolvedSubject.subjectName, "Maria");
  assert.ok(
    resolution.trace.candidates.some(
      (candidate) => candidate.owner === "runtime_exact_detail" && candidate.sourceTable === "runtime_exact_detail:artifact_source"
    )
  );
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "top_snippet" && owner.reason === "structured_owner_precedence"
    )
  );
});

test("owner policy classifies explicit temporal-qualified exact-detail queries before a candidate exists", () => {
  const resolution = resolveAnswerOwner({
    queryText: "Who did Maria have dinner with on May 3, 2023?",
    exactDetailFamily: "meal_companion",
    results: [],
    canonicalAdjudication: null,
    narrativeCandidate: null,
    exactDetailCandidate: null
  });

  assert.equal(resolution.trace.family, "exact_detail");
  assert.equal(resolution.trace.winner, null);
  assert.equal(resolution.trace.candidates.length, 1);
  assert.equal(resolution.trace.candidates[0]?.owner, "top_snippet");
  assert.equal(resolution.trace.candidates[0]?.eligible, false);
});

test("owner policy suppresses top snippet when a planner-owned collection lane is still incomplete", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What items does John collect?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });
  const resolution = resolveAnswerOwner({
    queryText: "What items does John collect?",
    exactDetailFamily: "generic",
    results: [recallResult("John: I like collecting jerseys.", { subject_name: "John" })],
    retrievalPlan,
    canonicalAdjudication: null,
    narrativeCandidate: null,
    exactDetailCandidate: {
      text: "jerseys",
      source: "canonical_fact",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, null);
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "top_snippet" && owner.reason === "planner_typed_lane_incomplete"
    )
  );
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "runtime_exact_detail" && owner.reason === "planner_report_suppresses_exact_detail"
    )
  );
});

test("service suppresses generic fallback when owner resolution blocks top snippet for an incomplete typed lane", () => {
  assert.equal(
    shouldSuppressGenericFallbackAfterOwnerResolution({
      winner: null,
      suppressedOwners: [
        {
          owner: "top_snippet",
          reason: "planner_typed_lane_incomplete"
        }
      ]
    }),
    true
  );
  assert.equal(
    shouldSuppressGenericFallbackAfterOwnerResolution({
      winner: "canonical_report",
      suppressedOwners: [
        {
          owner: "top_snippet",
          reason: "planner_typed_lane_incomplete"
        }
      ]
    }),
    false
  );
});

test("typed candidate builders materialize a first-class collection candidate from persisted facts", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What items does John collect?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });
  const results = buildPersistedCollectionFactRecallResults({
    namespaceId: "test",
    subjectEntityId: "person:john",
    subjectName: "John",
    rows: [
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "jerseys",
        normalized_value: "jerseys",
        cue_type: "collects",
        cue_strength: 0.95,
        confidence: 0.91,
        source_artifact_id: "artifact:1",
        source_chunk_id: "chunk:1",
        source_text: "John collects jerseys."
      },
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        item_value: "rare coins",
        normalized_value: "rare coins",
        cue_type: "collects",
        cue_strength: 0.92,
        confidence: 0.88,
        source_artifact_id: "artifact:1",
        source_chunk_id: "chunk:2",
        source_text: "John also collects rare coins."
      }
    ]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText: "What items does John collect?",
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_report");
  assert.equal(candidate.formatted.shapingTrace?.supportObjectType, "CollectionSetSupport");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "collection_set_render");
  assert.equal(candidate.bundle.ownerSourceTable, "planner_runtime_collection_candidate");
  assert.equal(candidate.bundle.subjectBindingStatus, "resolved");
});

test("typed candidate builders materialize planner-first temporal candidates from persisted temporal facts", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What year did John start surfing?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText: "What year did John start surfing?",
    retrievalPlan,
    results: [recallResult("John started surfing in 2018.", {
      subject_entity_id: "person:john",
      subject_name: "John"
    })],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "temporal_event_fact",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "2018",
      validFrom: "2018-01-01T00:00:00.000Z",
      validUntil: null,
      sourceTable: "canonical_temporal_facts",
      eventKey: "start_surfing",
      eventType: "inception",
      timeGranularity: "year",
      answerYear: 2018
    }
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "2018");
  assert.equal(candidate.formatted.shapingTrace?.supportObjectType, "TemporalEventSupport");
  assert.equal(candidate.bundle.ownerSourceTable, "canonical_temporal_facts");
});

test("typed temporal candidates keep aligned festival rows ahead of unrelated subject events", () => {
  const queryText = "When is Jon's group performing at a festival?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Jon lost his job on 19 January 2023.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          event_key: "lose_job",
          time_granularity: "day",
          answer_year: 2023,
          answer_month: 1,
          answer_day: 19,
          leaf_fact_text: "Jon lost his job on 19 January 2023.",
          leaf_time_hint_text: "19 January 2023"
        }
      }),
      recallResult("Finishing up choreography to perform at a nearby festival next month.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          time_granularity: "month",
          answer_year: 2023,
          answer_month: 2,
          answer_day: null,
          leaf_fact_text: "Finishing up choreography to perform at a nearby festival next month.",
          leaf_time_hint_text: "next month",
          anchor_relation: "after",
          anchor_offset_value: 1,
          anchor_offset_unit: "month"
        }
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "February 2023");
  assert.equal(candidate.formatted.shapingTrace?.selectedEventKey, "perform_festival");
});

test("typed temporal candidates keep subject-bound aligned festival snippets in the pool when canonical rows exist", () => {
  const queryText = "When is Jon's group performing at a festival?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Love to have you there! Group performance event next month.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          time_granularity: "month",
          answer_year: 2023,
          answer_month: 6,
          answer_day: null,
          leaf_fact_text: "Love to have you there! Group performance event next month.",
          leaf_time_hint_text: "next month"
        }
      }),
      recallResult("Finishing up choreography to perform at a nearby festival next month.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        source_table: "snippet_results",
        metadata: {
          source_table: "snippet_results",
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          time_granularity: "month",
          answer_year: 2023,
          answer_month: 2,
          answer_day: null,
          leaf_fact_text: "Finishing up choreography to perform at a nearby festival next month.",
          leaf_time_hint_text: "next month",
          anchor_relation: "after",
          anchor_offset_value: 1,
          anchor_offset_unit: "month"
        }
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "February 2023");
  assert.equal(candidate.formatted.shapingTrace?.selectedEventKey, "perform_festival");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_month_year");
});

test("typed temporal candidates treat dance-competition event neighbors as aligned festival evidence", () => {
  const queryText = "When is Jon's group performing at a festival?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("I'm getting ready for a dance comp near me next month.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          time_granularity: "month",
          answer_year: 2023,
          answer_month: 2,
          answer_day: null,
          leaf_fact_text: "I'm getting ready for a dance comp near me next month.",
          leaf_time_hint_text: "next month"
        }
      }),
      recallResult("Love to have you there! Group performance event next month.", {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          time_granularity: "month",
          answer_year: 2023,
          answer_month: 6,
          answer_day: null,
          leaf_fact_text: "Love to have you there! Group performance event next month.",
          leaf_time_hint_text: "next month"
        }
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "February 2023");
  assert.equal(candidate.formatted.shapingTrace?.selectedEventKey, "perform_festival");
});

test("temporal pool ranker prefers subject-bound year facts over noisy or foreign rows", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What year did John start surfing?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const ranked = rankTemporalPoolResults({
    queryText: "What year did John start surfing?",
    retrievalPlan,
    results: [
      recallResult("Michael started surfing in 2011.", {
        subject_entity_id: "person:michael",
        subject_name: "Michael",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:michael",
          subject_name: "Michael",
          event_key: "start_surfing",
          time_granularity: "year",
          answer_year: 2011
        }
      }),
      recallResult("John talked about surfing recently.", {
        subject_entity_id: "person:john",
        subject_name: "John"
      }),
      recallResult("John started surfing in 2018.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:john",
          subject_name: "John",
          event_key: "start_surfing",
          time_granularity: "year",
          answer_year: 2018
        }
      })
    ]
  });

  assert.equal(ranked[0]?.provenance.subject_entity_id, "person:john");
  assert.match(ranked[0]?.content ?? "", /2018/i);
});

test("temporal pool ranker keeps event-aligned raw rows ahead of generic canonical dates", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What year did John start surfing?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const ranked = rankTemporalPoolResults({
    queryText: "What year did John start surfing?",
    retrievalPlan,
    results: [
      recallResult("John scored 40 points last week.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:john",
          subject_name: "John",
          time_granularity: "day",
          answer_year: 2023,
          answer_month: 7,
          answer_day: 16
        }
      }),
      recallResult("John recently talked about the beach.", {
        subject_entity_id: "person:john",
        subject_name: "John"
      }),
      recallResult("John started surfing in 2018.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        metadata: {
          subject_entity_id: "person:john",
          subject_name: "John",
          source_turn_text: "John started surfing in 2018."
        }
      })
    ]
  });

  assert.match(ranked[0]?.content ?? "", /2018/i);
});

test("temporal pool ranker keeps aligned anchor rows ahead of generic canonical dates for no-event queries", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "When was John in Seattle for a game?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const ranked = rankTemporalPoolResults({
    queryText: "When was John in Seattle for a game?",
    retrievalPlan,
    results: [
      recallResult("John scored 40 points last week.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:john",
          subject_name: "John",
          time_granularity: "day",
          answer_year: 2023,
          answer_month: 7,
          answer_day: 16
        }
      }),
      {
        memoryId: "john-seattle",
        memoryType: "episodic_memory",
        content: "John: It's Seattle, I'm stoked for my game there next month!",
        artifactId: null,
        occurredAt: "2023-07-16T16:21:00.000Z",
        namespaceId: "test",
        provenance: {
          subject_entity_id: "person:john",
          subject_name: "John",
          source_table: "canonical_temporal_facts",
          metadata: {
            source_table: "canonical_temporal_facts",
            subject_entity_id: "person:john",
            subject_name: "John",
            source_turn_text: "John: It's Seattle, I'm stoked for my game there next month!",
            source_sentence_text: "John: It's Seattle, I'm stoked for my game there next month!"
          }
        }
      }
    ]
  });

  assert.match(ranked[0]?.content ?? "", /Seattle/i);
});

test("typed temporal candidates keep earliest inception year when noisy recent rows compete", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What year did John start surfing?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText: "What year did John start surfing?",
    retrievalPlan,
    results: [
      recallResult("2023", {
        subject_entity_id: "person:john",
        subject_name: "John",
        source_table: "temporal_results",
        metadata: {
          source_table: "temporal_results",
          subject_entity_id: "person:john",
          subject_name: "John",
          event_key: "start_surfing",
          time_granularity: "day",
          answer_year: 2023,
          answer_month: 7,
          answer_day: 16,
          source_turn_text: "John was talking about surfing recently."
        }
      }),
      recallResult("John started surfing in 2018.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        source_table: "canonical_temporal_facts",
        metadata: {
          source_table: "canonical_temporal_facts",
          subject_entity_id: "person:john",
          subject_name: "John",
          event_key: "start_surfing",
          event_type: "inception",
          time_granularity: "year",
          answer_year: 2018
        }
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "2018");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_year");
});

test("typed temporal candidates resolve single-subject relative-year rows by inline speaker binding", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What year did John start surfing?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "unresolved",
    subjectEntityHints: []
  });

  const candidate = buildPlannerTypedCandidate({
    queryText: "What year did John start surfing?",
    retrievalPlan,
    results: [
      recallResult("John: I started surfing five years ago and it's been great.", {
        metadata: {
          source_turn_text: "John: I started surfing five years ago and it's been great."
        }
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "2018");
  assert.equal(candidate.bundle.subjectBindingStatus, "resolved");
  assert.equal(candidate.formatted.shapingTrace?.supportObjectType, "TemporalEventSupport");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_year");
});

test("typed temporal candidates normalize structured recall blobs before year binding", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What year did John start surfing?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "unresolved",
    subjectEntityHints: []
  });

  const candidate = buildPlannerTypedCandidate({
    queryText: "What year did John start surfing?",
    retrievalPlan,
    results: [
      recallResult(
        JSON.stringify({
          text: "John: I started surfing five years ago and it's been great."
        }),
        {
          metadata: {
            source_turn_text: "John: I started surfing five years ago and it's been great."
          }
        }
      )
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "2018");
  assert.equal(candidate.bundle.subjectBindingStatus, "resolved");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_year");
});

test("typed temporal candidates render month-year answers for generic when queries with month-level support", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "When is Jon's group performing at a festival?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText: "When is Jon's group performing at a festival?",
    retrievalPlan,
    results: [
      recallResult(
        JSON.stringify({
          text: "Jon's group is performing at a festival in February 2023."
        }),
        {
          subject_name: "Jon",
          subject_entity_id: "person:jon",
          metadata: {
            source_turn_text: "Jon's group is performing at a festival in February 2023.",
            answer_year: 2023,
            answer_month: 2,
            time_granularity: "month"
          }
        }
      )
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "February 2023");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_month_year");
});

test("typed temporal candidates prefer the earliest exact event fact within the same bound temporal neighborhood", () => {
  const queryText = "When is Jon's group performing at a festival?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: buildPersistedTemporalFactRecallResults({
      namespaceId: "test",
      queryText,
      subjectEntityId: "person:jon",
      subjectName: "Jon",
      rows: [
        {
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          event_key: "perform_festival",
          event_type: "event",
          time_granularity: "month",
          answer_year: 2023,
          answer_month: 5,
          answer_day: null,
          fact_value: "Jon's group is performing at a festival in May 2023.",
          anchor_text: "May 2023",
          confidence: 0.91,
          source_artifact_id: "artifact-festival-may",
          source_chunk_id: "chunk-festival-may",
          anchor_event_key: null,
          anchor_relation: null,
          anchor_offset_value: null,
          anchor_offset_unit: null,
          mentioned_at: "2023-03-10T16:21:00.000Z",
          t_valid_from: null,
          t_valid_until: null
        },
        {
          subject_entity_id: "person:jon",
          subject_name: "Jon",
          event_key: "perform_festival",
          event_type: "event",
          time_granularity: "month",
          answer_year: 2023,
          answer_month: 2,
          answer_day: null,
          fact_value: "Jon's group is performing at a festival in February 2023.",
          anchor_text: "February 2023",
          confidence: 0.9,
          source_artifact_id: "artifact-festival-february",
          source_chunk_id: "chunk-festival-february",
          anchor_event_key: null,
          anchor_relation: null,
          anchor_offset_value: null,
          anchor_offset_unit: null,
          mentioned_at: "2023-01-19T16:21:00.000Z",
          t_valid_from: null,
          t_valid_until: null
        }
      ],
      sourceTable: "normalized_event_facts"
    }),
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "February 2023");
  assert.equal(candidate.formatted.shapingTrace?.selectedEventKey, "perform_festival");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_month_year");
});

test("typed temporal candidates recover month answers from structured participant-bound rows", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "In which month's game did John achieve a career-high score in points?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "unresolved",
    subjectEntityHints: []
  });

  const candidate = buildPlannerTypedCandidate({
    queryText: "In which month's game did John achieve a career-high score in points?",
    retrievalPlan,
    results: [
      recallResult(
        JSON.stringify({
          text: "Participant-bound turn for John."
        }),
        {
          metadata: {
            source_turn_text: "John achieved a career-high score in points in June 2023.",
            answer_year: 2023,
            answer_month: 6,
            time_granularity: "month"
          }
        }
      )
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "June 2023");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_month");
});

test("typed temporal candidates recover month answers from persisted aligned temporal facts without explicit event keys", () => {
  const queryText = "In which month's game did John achieve a career-high score in points?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const results = buildPersistedTemporalFactRecallResults({
    namespaceId: "test",
    queryText,
    subjectEntityId: "person:john",
    subjectName: "John",
    rows: [
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        event_key: null,
        event_type: null,
        time_granularity: "month",
        answer_year: 2023,
        answer_month: 6,
        answer_day: null,
        fact_value: "Last week I scored 40 points, my highest ever, and it feels like all my hard work's paying off.",
        anchor_text: "June 2023",
        confidence: 0.93,
        source_artifact_id: "artifact-career-high",
        source_chunk_id: "chunk-career-high",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-07-16T16:21:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      }
    ],
    sourceTable: "canonical_temporal_facts"
  });

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "June 2023");
  assert.equal(candidate.formatted.shapingTrace?.supportObjectType, "TemporalEventSupport");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_month");
});

test("persisted temporal fact recall rejects career-high assists rows for career-high points queries", () => {
  const results = buildPersistedTemporalFactRecallResults({
    namespaceId: "test",
    queryText: "In which month's game did John achieve a career-high score in points?",
    subjectEntityId: "person:john",
    subjectName: "John",
    rows: [
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        event_key: "career_high_points",
        event_type: "milestone",
        time_granularity: "month",
        answer_year: 2023,
        answer_month: 12,
        answer_day: null,
        fact_value: "John had a career-high in assists last Friday in our big game against our rival.",
        anchor_text: "December 2023",
        confidence: 0.92,
        source_artifact_id: "artifact-assists",
        source_chunk_id: "chunk-assists",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-12-11T20:28:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      },
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        event_key: null,
        event_type: null,
        time_granularity: "month",
        answer_year: 2023,
        answer_month: 6,
        answer_day: null,
        fact_value: "Last week I scored 40 points, my highest ever, and it feels like all my hard work's paying off.",
        anchor_text: "June 2023",
        confidence: 0.93,
        source_artifact_id: "artifact-career-high",
        source_chunk_id: "chunk-career-high",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-07-16T16:21:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      }
    ],
    sourceTable: "canonical_temporal_facts"
  });

  assert.equal(results.length, 1);
  assert.match(results[0]?.content ?? "", /highest ever/i);
  assert.equal(results[0]?.provenance?.metadata?.answer_month, 6);
});

test("persisted temporal fact recall prefers explicit stored day parts over conflicting fact text", () => {
  const results = buildPersistedTemporalFactRecallResults({
    namespaceId: "test",
    queryText: "When did Maria donate her car?",
    subjectEntityId: "person:maria",
    subjectName: "Maria",
    rows: [
      {
        subject_entity_id: "person:maria",
        subject_name: "Maria",
        event_key: "donate_car",
        event_type: "charity",
        time_granularity: "day",
        answer_year: 2022,
        answer_month: 12,
        answer_day: 21,
        fact_value: "2 July 2023",
        anchor_text: "July 2023",
        support_kind: "explicit_event_fact",
        temporal_source_quality: "canonical_event",
        derived_from_reference: false,
        confidence: 0.96,
        source_artifact_id: "artifact-donate",
        source_chunk_id: "chunk-donate",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2022-12-21T16:21:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      }
    ],
    sourceTable: "canonical_temporal_facts"
  });

  assert.equal(results[0]?.content, "Maria donate car on 2022-12-21.");
});

test("typed temporal candidates prefer grounded month facts over retrospective mention-time rows", () => {
  const queryText = "When Gina has lost her job at Door Dash?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:gina"]
  });

  const results = buildPersistedTemporalFactRecallResults({
    namespaceId: "test",
    queryText,
    subjectEntityId: "person:gina",
    subjectName: "Gina",
    rows: [
      {
        subject_entity_id: "person:gina",
        subject_name: "Gina",
        event_key: "lose_job",
        event_type: "event",
        time_granularity: "month",
        answer_year: 2023,
        answer_month: 1,
        answer_day: null,
        fact_value: "Unfortunately, I also lost my job at Door Dash this month.",
        anchor_text: "this month",
        support_kind: "reference_derived_relative",
        temporal_source_quality: "derived_relative",
        derived_from_reference: true,
        confidence: 0.85,
        source_artifact_id: "artifact-gina-month",
        source_chunk_id: "chunk-gina-month",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-01-19T07:00:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      },
      {
        subject_entity_id: "person:gina",
        subject_name: "Gina",
        event_key: "lose_job",
        event_type: "event",
        time_granularity: "unknown",
        answer_year: null,
        answer_month: null,
        answer_day: null,
        fact_value: "After losing my job, I wanted to take control of my own destiny and this seemed like the perfect way to do it.",
        anchor_text: null,
        support_kind: "generic_time_fragment",
        temporal_source_quality: "generic",
        derived_from_reference: false,
        confidence: 0.7,
        source_artifact_id: "artifact-gina-april",
        source_chunk_id: "chunk-gina-april",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-04-24T07:00:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      },
      {
        subject_entity_id: "person:gina",
        subject_name: "Gina",
        event_key: "lose_job",
        event_type: "event",
        time_granularity: "unknown",
        answer_year: null,
        answer_month: null,
        answer_day: null,
        fact_value: "Losing my job was a bummer, but it pushed me to take the plunge and go for my biz dreams.",
        anchor_text: null,
        support_kind: "generic_time_fragment",
        temporal_source_quality: "generic",
        derived_from_reference: false,
        confidence: 0.7,
        source_artifact_id: "artifact-gina-july",
        source_chunk_id: "chunk-gina-july",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-07-09T07:00:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      }
    ],
    sourceTable: "canonical_temporal_facts"
  });

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Gina"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(candidate.formatted.claimText, "January 2023");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "temporal_month_year");
});

test("persisted temporal fact recall rejects adopt-first-three rows without adoption cues", () => {
  const queryText = "Which year did Audrey adopt the first three of her dogs?";
  const results = buildPersistedTemporalFactRecallResults({
    namespaceId: "test",
    queryText,
    subjectEntityId: "person:audrey",
    subjectName: "Audrey",
    rows: [
      {
        subject_entity_id: "person:audrey",
        subject_name: "Audrey",
        event_key: "adopt_first_three_dogs",
        event_type: "adoption",
        time_granularity: "year",
        answer_year: 2023,
        answer_month: null,
        answer_day: null,
        fact_value: "They're all 3-year-old and they are a great pack. We had a doggy playdate last Friday.",
        anchor_text: "2023",
        confidence: 0.96,
        source_artifact_id: "artifact-generic-dogs",
        source_chunk_id: "chunk-generic-dogs",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-08-24T00:24:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      },
      {
        subject_entity_id: "person:audrey",
        subject_name: "Audrey",
        event_key: null,
        event_type: null,
        time_granularity: "year",
        answer_year: 2020,
        answer_month: null,
        answer_day: null,
        fact_value: "I've had them for 3 years! Their names are Pepper, Precious and Panda.",
        anchor_text: "2020",
        confidence: 0.91,
        source_artifact_id: "artifact-adoption",
        source_chunk_id: "chunk-adoption",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-08-24T00:24:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      }
    ],
    sourceTable: "canonical_temporal_facts"
  });

  assert.equal(results.length, 1);
  assert.match(results[0]?.content ?? "", /I've had them for 3 years/i);
  assert.doesNotMatch(results[0]?.content ?? "", /3-year-old/i);
  assert.equal(results[0]?.provenance?.metadata?.answer_year, 2020);
});

test("planner typed career candidates keep goal-set rendering for career goal list queries", () => {
  const queryText = "What are John's goals for his career that are not related to his basketball skills?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult(
        "John: My goal is to improve my shooting percentage and win a championship. Off the court, I want to get endorsements, build my brand, and do charity work.",
        {
          subject_name: "John",
          speaker_name: "John",
          subject_entity_id: "person:john"
        }
      )
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.claimText, "get endorsements, build his brand, do charity work");
  assert.equal(candidate.formatted.shapingTrace?.supportObjectType, "ProfileInferenceSupport");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "career_goal_set_render");
});

test("targeted backfill subqueries use off-court career-goal prompts for non-basketball goal queries", () => {
  const queryText = "What are John's goals for his career that are not related to his basketball skills?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["John"]);

  assert.deepEqual(subqueries, [
    "what goals does John have off the court?",
    "what endorsements, brand, or charity goals does John have?"
  ]);
});

test("targeted backfill subqueries use basketball-goal prompts for basketball career goal queries", () => {
  const queryText = "what are John's goals with regards to his basketball career?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["John"]);

  assert.deepEqual(subqueries, [
    "what goals does John have for John's basketball career?",
    "what basketball goals does John mention like improving shooting percentage or winning a championship?"
  ]);
});

test("retrieval planner resolves Andrew financial-analyst start queries into a typed temporal event", () => {
  const plan = buildAnswerRetrievalPlan({
    queryText: "When did Andrew start his new job as a financial analyst?",
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:andrew"]
  });

  assert.equal(plan.family, "temporal");
  assert.equal(plan.lane, "temporal_event");
  assert.equal(plan.resolvedEventKey, "start_financial_analyst_job");
  assert.ok(plan.queryExpansionTerms.includes("financial analyst"));
  assert.ok(plan.queryExpansionTerms.includes("last week"));
});

test("targeted backfill subqueries use festival-location prompts for single-event travel queries", () => {
  const queryText = "Where did Calvin attend a music festival in April 2023?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    reportKind: "travel_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:calvin"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["Calvin"]);

  assert.deepEqual(subqueries, [
    "where did Calvin attend the music festival?",
    "what city or country was the music festival Calvin attended in?"
  ]);
});

test("planner runtime travel candidates extract festival locations from source-grounded rows", () => {
  const queryText = "Where did Calvin attend a music festival in April 2023?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:calvin"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Calvin attended a music festival in Tokyo in April 2023.", {
        subject_entity_id: "person:calvin",
        subject_name: "Calvin",
        speaker_name: "Calvin",
        metadata: {
          source_sentence_text: "Calvin attended a music festival in Tokyo in April 2023."
        }
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Calvin"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate.formatted.finalClaimSource, "canonical_report");
  assert.equal(plannerCandidate.formatted.shapingTrace?.renderContractSelected, "travel_location_set_render");
  assert.match(plannerCandidate.formatted.claimText ?? "", /Tokyo/i);
});

test("targeted backfill subqueries use comparative-fit prompts for venue-fit judgment queries", () => {
  const queryText = "Would Calvin enjoy performing at the Hollywood Bowl?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:calvin"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["Calvin"]);

  assert.deepEqual(subqueries, [
    "what does Calvin enjoy about performing live?",
    "does Calvin enjoy performing to large crowds?"
  ]);
});

test("planner runtime report candidates keep strong comparative-fit reasons over generic venue-fit summaries", () => {
  const queryText = "Would Calvin enjoy performing at the Hollywood Bowl?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:calvin"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Yes, because he would likely enjoy performing there.", {
        subject_entity_id: "person:calvin",
        subject_name: "Calvin",
        source_table: "canonical_reports"
      }),
      recallResult("Calvin loves the rush of performing onstage to large crowds.", {
        subject_entity_id: "person:calvin",
        subject_name: "Calvin"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Calvin"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.shapingTrace?.renderContractSelected, "comparative_fit_render");
  assert.match(plannerCandidate?.formatted.claimText ?? "", /rush of performing onstage to large crowds/i);
});

test("planner runtime report candidates upgrade crowd-connection phrasing into comparative-fit reasons", () => {
  const queryText = "Would Calvin enjoy performing at the Hollywood Bowl?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:calvin"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult(
        "Performing live always fuels my soul! I love the rush and connection with the crowd, the feeling's indescribable—it's an absolute high!",
        {
          subject_entity_id: "person:calvin",
          subject_name: "Calvin"
        }
      )
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Calvin"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.shapingTrace?.renderContractSelected, "comparative_fit_render");
  assert.match(plannerCandidate?.formatted.claimText ?? "", /rush of performing onstage to large crowds/i);
});

test("persisted temporal fact recall keeps dance-competition rows for festival-performance queries", () => {
  const results = buildPersistedTemporalFactRecallResults({
    namespaceId: "test",
    queryText: "When is Jon's group performing at a festival?",
    subjectEntityId: "person:jon",
    subjectName: "Jon",
    rows: [
      {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        event_key: null,
        event_type: null,
        time_granularity: "month",
        answer_year: 2023,
        answer_month: 2,
        answer_day: null,
        fact_value: "I'm getting ready for a dance comp near me next month.",
        anchor_text: "next month",
        confidence: 0.85,
        source_artifact_id: "artifact-dance-comp",
        source_chunk_id: "chunk-dance-comp",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-01-04T10:43:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      },
      {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        event_key: null,
        event_type: null,
        time_granularity: "month",
        answer_year: 2023,
        answer_month: 6,
        answer_day: null,
        fact_value: "Love to have you there! Group performance event next month.",
        anchor_text: "next month",
        confidence: 0.85,
        source_artifact_id: "artifact-group-performance",
        source_chunk_id: "chunk-group-performance",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-05-03T13:26:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      }
    ],
    sourceTable: "canonical_temporal_facts"
  });

  assert.equal(results.length, 2);
  assert.ok(results.some((result) => result.content.includes("dance comp near me next month")));
});

test("persisted temporal fact recall rejects unrelated explicit event facts for Seattle-game queries", () => {
  const results = buildPersistedTemporalFactRecallResults({
    namespaceId: "test",
    queryText: "When was John in Seattle for a game?",
    subjectEntityId: "person:john",
    subjectName: "John",
    rows: [
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        event_key: "start_surfing",
        event_type: "milestone",
        time_granularity: "day",
        answer_year: 2018,
        answer_month: 6,
        answer_day: 14,
        fact_value: "John started surfing five years ago and it changed his life.",
        anchor_text: null,
        confidence: 0.94,
        source_artifact_id: "artifact-surfing",
        source_chunk_id: "chunk-surfing",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-07-16T16:21:00.000Z",
        t_valid_from: "2018-06-14T00:00:00.000Z",
        t_valid_until: null
      },
      {
        subject_entity_id: "person:john",
        subject_name: "John",
        event_key: null,
        event_type: null,
        time_granularity: "month",
        answer_year: 2023,
        answer_month: 8,
        answer_day: null,
        fact_value: "John: It's Seattle, I'm stoked for my game there next month!",
        anchor_text: "next month",
        confidence: 0.85,
        source_artifact_id: "artifact-seattle",
        source_chunk_id: "chunk-seattle",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-07-16T16:21:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      }
    ],
    sourceTable: "canonical_temporal_facts"
  });

  assert.equal(results.length, 1);
  assert.match(results[0]?.content ?? "", /Seattle/i);
});

test("typed temporal candidates do not duplicate canonical-only temporal facts", () => {
  const queryText = "When is Jon's group performing at a festival?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jon"]
  });

  const results = buildPersistedTemporalFactRecallResults({
    namespaceId: "test",
    queryText,
    subjectEntityId: "person:jon",
    subjectName: "Jon",
    rows: [
      {
        subject_entity_id: "person:jon",
        subject_name: "Jon",
        event_key: "perform_festival",
        event_type: "event",
        time_granularity: "month",
        answer_year: 2023,
        answer_month: 2,
        answer_day: null,
        fact_value: "Jon's group is performing at a festival in February 2023.",
        anchor_text: "February 2023",
        confidence: 0.93,
        source_artifact_id: "artifact-festival",
        source_chunk_id: "chunk-festival",
        anchor_event_key: null,
        anchor_relation: null,
        anchor_offset_value: null,
        anchor_offset_unit: null,
        mentioned_at: "2023-01-19T16:21:00.000Z",
        t_valid_from: null,
        t_valid_until: null
      }
    ],
    sourceTable: "canonical_temporal_facts"
  });

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      subjectBindingStatus: "resolved",
      predicateFamily: "temporal_event_fact",
      objectValue: "February 2023",
      anchorText: null,
      timeScopeKind: "historical",
      provenanceRows: [],
      supportStrength: "strong",
      confidence: "confident",
      status: "supported",
      validFrom: null,
      validUntil: null,
      sourceTable: "canonical_temporal_facts",
      eventKey: "perform_festival",
      eventType: "event",
      timeGranularity: "month",
      answerYear: 2023,
      answerMonth: 2,
      answerDay: null,
      objectEntityId: null,
      sourceArtifactId: "artifact-festival",
      sourceChunkId: "chunk-festival",
      sourceEventId: null,
      anchorEventKey: null,
      anchorRelation: null,
      anchorOffsetValue: null,
      anchorOffsetUnit: null,
      canonicalConfidence: 0.93
    }
  });

  assert.equal(candidate, null);
});

test("typed candidate builders split causal profile rows into dedicated planner candidates", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "Why did Gina decide to start her own clothing store?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:gina"]
  });

  const candidate = buildPlannerTypedCandidate({
    queryText: "Why did Gina decide to start her own clothing store?",
    retrievalPlan,
    results: [
      recallResult(
        "Gina said she started her own clothing store because she wanted creative freedom and to design clothes herself.",
        {
          subject_entity_id: "person:gina",
          subject_name: "Gina"
        }
      )
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Gina"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_report");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "causal_reason_render");
  assert.equal(candidate.bundle.ownerSourceTable, "planner_runtime_causal_candidate");
});

test("planner typed candidates seed education rows from subject-bound profile results", () => {
  const queryText = "What fields would Caroline be likely to pursue in her educaton?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "unresolved",
    subjectEntityHints: []
  });

  assert.ok(retrievalPlan.candidatePools.includes("education_support"));
  assert.ok(retrievalPlan.targetedBackfillRequests.some((request) => request.reason === "education_field_missing"));

  const candidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Caroline wants to become a counselor and support other transgender people.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline",
        source_table: "profile_report_support"
      }),
      recallResult("John is exploring sports marketing and endorsement work.", {
        subject_entity_id: "person:john",
        subject_name: "John",
        source_table: "profile_report_support"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    storedCanonical: null
  });

  assert.ok(candidate);
  assert.equal(candidate.formatted.finalClaimSource, "canonical_report");
  assert.equal(candidate.formatted.claimText, "Psychology, counseling certification");
  assert.equal(candidate.formatted.shapingTrace?.renderContractSelected, "education_field_render");
  assert.equal(candidate.bundle.ownerSourceTable, "planner_runtime_education_candidate");
  assert.equal(candidate.bundle.subjectBindingStatus, "resolved");
  assert.equal(candidate.bundle.subjectEntityId, "person:caroline");
});

test("planner runtime report candidates beat raw text-unit narrative reports for graph-dominant education queries", () => {
  const queryText = "What fields would Caroline be likely to pursue in her educaton?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:caroline"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Psychology, counseling certification", {
        source_table: "retrieved_text_unit_aggregate_report",
        subject_entity_id: "person:caroline",
        subject_name: "Caroline"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] })
  });

  assert.ok(plannerCandidate);

  const narrativeCandidate = {
    bundle: {
      ownerSourceTable: "retrieved_text_unit_report"
    },
    canonical: {
      kind: "report"
    },
    formatted: {
      shapingTrace: {
        supportObjectType: "ProfileInferenceSupport",
        renderContractSelected: "education_field_render"
      }
    }
  };

  const preferred = preferPlannerRuntimeReportCandidate({
    retrievalPlan,
    narrativeCandidate,
    plannerCandidate
  });

  assert.equal(preferred, plannerCandidate);
});

test("planner runtime report candidates infer aspiration support for app-uniqueness queries", () => {
  const queryText = "How does James plan to make his dog-sitting app unique?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:james"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("James plans to make his dog-sitting app unique by allowing users to customize their pup's preferences and needs.", {
        subject_entity_id: "person:james",
        subject_name: "James"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["James"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate.formatted.shapingTrace?.renderContractSelected, "aspiration_unique_feature_render");
  assert.equal(plannerCandidate.bundle.ownerSourceTable, "planner_runtime_report_support");
  assert.match(plannerCandidate.formatted.claimText, /customiz/i);
});

test("planner typed candidates prefer aspiration unique-feature renders over stale canonical report summaries", () => {
  const queryText = "How does James plan to make his dog-sitting app unique?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:james"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("James plans to make his dog-sitting app unique by allowing users to customize their pup's preferences and needs.", {
        subject_entity_id: "person:james",
        subject_name: "James"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["James"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.shapingTrace?.renderContractSelected, "aspiration_unique_feature_render");

  const preferred = preferPlannerTypedCandidate({
    retrievalPlan,
    plannerCandidate,
    narrativeCandidate: {
      bundle: {
        ownerSourceTable: "canonical_sets"
      },
      canonical: {
        kind: "report"
      },
      formatted: {
        shapingTrace: {
          selectedFamily: "report",
          supportObjectType: null,
          renderContractSelected: null
        }
      }
    }
  });

  assert.equal(preferred, plannerCandidate);
});

test("planner typed candidates prefer travel-location renders over aggregate report summaries", () => {
  const queryText = "Where has Evan been on roadtrips with his family?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:evan"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Evan has been on family roadtrips through the Rockies and Jasper.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        source_table: "retrieved_text_unit_aggregate_report"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Evan"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.shapingTrace?.renderContractSelected, "travel_location_set_render");

  const preferred = preferPlannerTypedCandidate({
    retrievalPlan,
    plannerCandidate,
    narrativeCandidate: {
      bundle: {
        ownerSourceTable: "retrieved_text_unit_aggregate_report"
      },
      canonical: {
        kind: "report"
      },
      formatted: {
        shapingTrace: {
          selectedFamily: "report",
          supportObjectType: null,
          renderContractSelected: null
        }
      }
    }
  });

  assert.equal(preferred, plannerCandidate);
});

test("planner runtime report candidates ignore abstention-like travel summaries when grounded roadtrip rows exist", () => {
  const queryText = "Where has Evan been on roadtrips with his family?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:evan"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("No authoritative evidence found.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        source_table: "canonical_reports"
      }),
      recallResult("Evan has been on family roadtrips through the Rockies and Jasper.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Evan"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.shapingTrace?.renderContractSelected, "travel_location_set_render");
  assert.match(plannerCandidate?.formatted.claimText ?? "", /Rockies/i);
  assert.match(plannerCandidate?.formatted.claimText ?? "", /Jasper/i);
});

test("planner runtime travel candidates filter vehicle nouns from benchmark-shaped roadtrip rows", () => {
  const queryText = "Where has Evan been on roadtrips with his family?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:evan"]
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Evan just got back from a trip with his family in his new Prius.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan"
      }),
      recallResult("Glad you asked, we went to Rockies.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan"
      }),
      recallResult("Last weekend, I took my family on a road trip to Jasper.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Evan"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.shapingTrace?.renderContractSelected, "travel_location_set_render");
  assert.match(plannerCandidate?.formatted.claimText ?? "", /Rockies/i);
  assert.match(plannerCandidate?.formatted.claimText ?? "", /Jasper/i);
  assert.doesNotMatch(plannerCandidate?.formatted.claimText ?? "", /Prius/i);
});

test("planner runtime report candidates synthesize pair advice for multi-subject growth questions", () => {
  const queryText = "Considering their conversations and personal growth, what advice might Evan and Sam give to someone facing a major life transition or challenge?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "ambiguous"
  });

  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Evan: Big changes get easier when you take them one step at a time and lean on the people who support you.", {
        subject_name: "Evan"
      }),
      recallResult("Sam: Hiking and road trips help me reset, and good friends make hard transitions feel manageable.", {
        subject_name: "Sam"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Evan", "Sam"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate.formatted.shapingTrace?.renderContractSelected, "pair_advice_render");
  assert.match(plannerCandidate.formatted.claimText, /support|friendship/i);
});

test("planner owner policy keeps report family precedence over stray temporal candidates for help queries", () => {
  const queryText = "What helped Deborah find peace when grieving deaths of her loved ones?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    reportKind: "support_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:deborah"]
  });
  const plannerCandidate = buildPlannerRuntimeReportCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Yoga, old photos, the roses and dahlias in her flower garden, and time in nature helped Deborah find peace.", {
        subject_entity_id: "person:deborah",
        subject_name: "Deborah"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Deborah"] })
  });
  assert.ok(plannerCandidate);

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results: [],
    retrievalPlan,
    canonicalAdjudication: {
      bundle: {
        predicateFamily: "temporal_event_fact",
        ownerSourceTable: "canonical_temporal_facts"
      },
      canonical: {
        kind: "temporal_fact"
      },
      formatted: {
        finalClaimSource: "canonical_temporal",
        shapingTrace: {
          shapingPipelineEntered: true,
          selectedFamily: "temporal",
          supportObjectType: "TemporalEventSupport",
          retrievalPlanFamily: "temporal",
          retrievalPlanLane: "temporal_event"
        }
      }
    },
    narrativeCandidate: plannerCandidate
  });

  assert.equal(resolution.trace.family, "report");
  assert.equal(resolution.trace.winner, "canonical_report");
});

test("planner typed candidates keep grief-support queries in the support-report lane", () => {
  const queryText = "What helped Deborah find peace when grieving deaths of her loved ones?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    reportKind: "support_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:deborah"]
  });

  const plannerCandidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Deborah: Yoga helped me find peace during difficult times.", {
        subject_entity_id: "person:deborah",
        subject_name: "Deborah",
        speaker_name: "Deborah"
      }),
      recallResult("Deborah: Looking through old photos in the family album helps when I am grieving.", {
        subject_entity_id: "person:deborah",
        subject_name: "Deborah",
        speaker_name: "Deborah"
      }),
      recallResult("Deborah: The roses and dahlias in my flower garden and time in nature help me feel grounded after loss.", {
        subject_entity_id: "person:deborah",
        subject_name: "Deborah",
        speaker_name: "Deborah"
      }),
      recallResult("It was a gorgeous island that made me feel calm.", {
        subject_entity_id: "person:deborah",
        subject_name: "Deborah"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Deborah"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.shapingTrace?.renderContractSelected, "causal_reason_render");
  assert.match(plannerCandidate?.formatted.claimText ?? "", /yoga/i);
  assert.match(plannerCandidate?.formatted.claimText ?? "", /old photos/i);
  assert.doesNotMatch(plannerCandidate?.formatted.claimText ?? "", /gorgeous island/i);
});

test("planner typed candidates keep family roadtrip reports in the travel lane and drop unrelated travel noise", () => {
  const queryText = "Where has Evan been on roadtrips with his family?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    reportKind: "travel_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:evan"]
  });

  const plannerCandidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Last weekend, I took my family on a road trip to Jasper.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        speaker_name: "Evan"
      }),
      recallResult("Glad you asked, we went to Rockies.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        speaker_name: "Evan"
      }),
      recallResult("Last week I went on a trip to Canada and met someone special there.", {
        subject_entity_id: "person:evan",
        subject_name: "Evan",
        speaker_name: "Evan"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Evan"] })
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.shapingTrace?.renderContractSelected, "travel_location_set_render");
  assert.match(plannerCandidate?.formatted.claimText ?? "", /Rockies/i);
  assert.match(plannerCandidate?.formatted.claimText ?? "", /Jasper/i);
  assert.doesNotMatch(plannerCandidate?.formatted.claimText ?? "", /Canada/i);
});

test("planner targeted backfill subqueries use typed donor-style prompts for aspiration, travel, and pair-advice reports", () => {
  const jamesPlan = buildAnswerRetrievalPlan({
    queryText: "How does James plan to make his dog-sitting app unique?",
    predicateFamily: "generic_fact",
    reportKind: "aspiration_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:james"]
  });
  const evanPlan = buildAnswerRetrievalPlan({
    queryText: "Where has Evan been on roadtrips with his family?",
    predicateFamily: "generic_fact",
    reportKind: "travel_report",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:evan"]
  });
  const pairPlan = buildAnswerRetrievalPlan({
    queryText: "Considering their conversations and personal growth, what advice might Evan and Sam give to someone facing a major life transition or challenge?",
    predicateFamily: "generic_fact",
    subjectBindingStatus: "ambiguous"
  });

  const jamesSubqueries = buildPlannerTargetedBackfillSubqueries(
    "How does James plan to make his dog-sitting app unique?",
    jamesPlan,
    ["James"]
  );
  const evanSubqueries = buildPlannerTargetedBackfillSubqueries(
    "Where has Evan been on roadtrips with his family?",
    evanPlan,
    ["Evan"]
  );
  const pairSubqueries = buildPlannerTargetedBackfillSubqueries(
    "Considering their conversations and personal growth, what advice might Evan and Sam give to someone facing a major life transition or challenge?",
    pairPlan,
    ["Evan", "Sam"]
  );

  assert.ok(jamesSubqueries.some((query) => /what makes james'?s dog-sitting app unique/i.test(query) || /preferences or needs/i.test(query)));
  assert.ok(evanSubqueries.some((query) => /family roadtrips/i.test(query)));
  assert.ok(pairSubqueries.some((query) => /what advice would evan give/i.test(query)));
  assert.ok(pairSubqueries.some((query) => /what advice would sam give/i.test(query)));
});

test("stored canonical report seeds prefer typed answer payload over raw object text", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "What fields would Caroline be likely to pursue in her educaton?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:caroline"]
  });

  const seeded = buildPlannerRuntimeStoredReportResult({
    namespaceId: "test",
    queryText: "What fields would Caroline be likely to pursue in her educaton?",
    retrievalPlan,
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "profile_state",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "{\"memoryId\":\"abc\",\"text\":\"Keep up the great work!\"}",
      answerPayload: {
        answer_value: "Psychology, counseling certification"
      },
      reportKind: "education_report"
    }
  });

  assert.ok(seeded);
  assert.equal(seeded.content, "Psychology, counseling certification");
  assert.equal(seeded.provenance.source_table, "canonical_reports");
  assert.equal(seeded.provenance.metadata?.answer_payload?.answer_value, "Psychology, counseling certification");
});

test("planner typed candidates beat raw text-unit narrative reports for graph-dominant education queries", () => {
  const queryText = "What fields would Caroline be likely to pursue in her educaton?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:caroline"]
  });

  const plannerCandidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Psychology, counseling certification", {
        source_table: "retrieved_text_unit_aggregate_report",
        subject_entity_id: "person:caroline",
        subject_name: "Caroline"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    storedCanonical: null
  });

  assert.ok(plannerCandidate);

  const preferred = preferPlannerTypedCandidate({
    retrievalPlan,
    plannerCandidate,
    narrativeCandidate: {
      bundle: {
        ownerSourceTable: "retrieved_text_unit_report"
      },
      canonical: {
        kind: "report"
      },
      formatted: {
        shapingTrace: {
          supportObjectType: "ProfileInferenceSupport",
          renderContractSelected: "education_field_render"
        }
      }
    }
  });

  assert.equal(preferred, plannerCandidate);
});

test("profile pool ranker prioritizes causal explanation rows for why queries", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "Why did Gina decide to start her own clothing store?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:gina"]
  });

  const ranked = rankProfilePoolResults({
    queryText: "Why did Gina decide to start her own clothing store?",
    retrievalPlan,
    results: [
      recallResult("Gina runs a clothing store and enjoys fashion.", {
        subject_entity_id: "person:gina",
        subject_name: "Gina"
      }),
      recallResult("Gina started her own clothing store because she wanted creative freedom and to design clothes herself.", {
        subject_entity_id: "person:gina",
        subject_name: "Gina",
        source_table: "profile_report_support"
      })
    ]
  });

  assert.match(ranked[0]?.content ?? "", /because she wanted creative freedom/i);
});

test("profile pool ranker promotes aggregate education evidence and demotes praise-only rows", () => {
  const queryText = "What fields would Caroline be likely to pursue in her educaton?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:caroline"]
  });

  const ranked = rankProfilePoolResults({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Keep up the great work! Caroline: Thanks Mel! Your kind words mean a lot.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline",
        source_table: "retrieved_text_unit_report"
      }),
      recallResult("Psychology, counseling certification", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline",
        source_table: "retrieved_text_unit_aggregate_report"
      }),
      recallResult("Gonna continue my edu and check out career options, which is pretty exciting!", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline",
        source_table: "retrieved_text_unit_report"
      }),
      recallResult("I'm keen on counseling or working in mental health - I'd love to support those with similar issues.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline",
        source_table: "retrieved_text_unit_report"
      })
    ]
  });

  assert.equal(ranked[0]?.provenance?.source_table, "retrieved_text_unit_aggregate_report");
  assert.doesNotMatch(ranked[0]?.content ?? "", /keep up the great work/i);
  assert.doesNotMatch(ranked[1]?.content ?? "", /keep up the great work/i);
});

test("planner targeted backfill generates education-field subqueries for education report gaps", () => {
  const queryText = "What fields would Caroline be likely to pursue in her educaton?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:caroline"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["Caroline"]);

  assert.ok(subqueries.some((query) => /what field does Caroline want to study/i.test(query)));
  assert.ok(subqueries.some((query) => /what education or certification is Caroline considering/i.test(query)));
  assert.ok(subqueries.length <= 2);
});

test("planner targeted backfill generates temporal subqueries for event-identity gaps", () => {
  const queryText = "What year did John start surfing?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["John"]);

  assert.ok(subqueries.some((query) => /when did John start surfing/i.test(query)));
  assert.ok(subqueries.some((query) => /what year did John start surfing/i.test(query)));
  assert.ok(subqueries.length <= 2);
});

test("planner targeted backfill generates resumed-drums temporal rescue queries", () => {
  const queryText = "When did John resume playing drums in his adulthood?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:john"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["John"]);

  assert.ok(subqueries.some((query) => /when did John start playing drums again/i.test(query)));
  assert.ok(subqueries.some((query) => /what month did John resume playing drums/i.test(query)));
  assert.ok(subqueries.length <= 2);
});

test("planner targeted backfill keeps muffins rescue anchored to the baking event", () => {
  const queryText = "When did Audrey make muffins for herself?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:audrey"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["Audrey"]);

  assert.ok(subqueries.some((query) => /when did Audrey make muffins for herself/i.test(query)));
  assert.ok(subqueries.some((query) => /when did Audrey bake muffins for herself/i.test(query)));
  assert.ok(subqueries.length <= 2);
  assert.ok(retrievalPlan.targetedBackfill.includes("year"));
  assert.ok(retrievalPlan.targetedBackfill.includes("month"));
  assert.ok(retrievalPlan.targetedBackfill.includes("day"));
});

test("planner proactively requests year rescue for mother-pass-away relative queries", () => {
  const queryText = "When did Jolene`s mother pass away?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:jolene"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["Jolene"]);

  assert.ok(retrievalPlan.targetedBackfill.includes("year"));
  assert.ok(subqueries.some((query) => /what year did Jolene'?s mother pass away/i.test(query)));
});

test("planner targeted backfill uses subtype probes for generic stress-buster painting answers", () => {
  const queryText = "What did Evan start doing a few years back as a stress-buster?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "generic_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:evan"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(
    queryText,
    retrievalPlan,
    ["Evan"],
    "default",
    "exact_detail_support_specificity_missing"
  );

  assert.deepEqual(subqueries, [
    "What did Evan start doing a few years back as a stress-buster?",
    "what kind of painting does Evan do for stress relief?"
  ]);
});

test("planner targeted backfill keeps support-group temporal rescue aligned to the visit event", () => {
  const queryText = "When did Caroline go to the LGBTQ support group?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "temporal_event_fact",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:caroline"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["Caroline"]);

  assert.ok(subqueries.some((query) => /when did Caroline go to the LGBTQ support group/i.test(query)));
  assert.ok(subqueries.some((query) => /what date did Caroline go to the LGBTQ support group/i.test(query)));
  assert.ok(subqueries.length <= 2);
});

test("planner targeted backfill generates location-history subqueries for social place gaps", () => {
  const queryText = "Where has Maria made friends?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "location_history",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:maria"]
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["Maria"]);

  assert.ok(subqueries.some((query) => /where has Maria made friends/i.test(query)));
  assert.ok(subqueries.some((query) => /what places has Maria made friends/i.test(query)));
  assert.ok(subqueries.length <= 2);
});

test("planner targeted backfill keeps pair meetup subqueries anchored to both named subjects", () => {
  const queryText = "Which places or events have John and James planned to meet at?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "location_history",
    subjectBindingStatus: "ambiguous"
  });

  const subqueries = buildPlannerTargetedBackfillSubqueries(queryText, retrievalPlan, ["John", "James"]);

  assert.ok(subqueries.some((query) => /John and James/i.test(query)));
  assert.ok(subqueries.some((query) => /planned to meet at|plan to meet/i.test(query)));
  assert.ok(subqueries.length <= 2);
});

test("planner typed list/set candidates materialize location-history owners before runtime exact detail", () => {
  const queryText = "Where has Maria made friends?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "location_history",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:maria"]
  });
  const results = [
    recallResult("Maria made friends at the homeless shelter, church, and gym.", {
      subject_entity_id: "person:maria",
      subject_name: "Maria"
    })
  ];
  const plannerCandidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Maria"] }),
    storedCanonical: null
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.finalClaimSource, "canonical_list_set");

  const resolution = resolveAnswerOwner({
    queryText,
    exactDetailFamily: "generic",
    results,
    retrievalPlan,
    canonicalAdjudication: null,
    narrativeCandidate: plannerCandidate,
    exactDetailCandidate: {
      text: "shelter, East Coast, church, Oregon, California, Florida, yoga studio",
      source: "episodic_leaf",
      strongSupport: true,
      predicateFit: true
    }
  });

  assert.equal(resolution.trace.family, "list_set");
  assert.equal(resolution.trace.winner, "canonical_list_set");
  assert.ok(
    resolution.trace.suppressedOwners.some(
      (owner) => owner.owner === "runtime_exact_detail" && owner.reason?.includes("list_set")
    )
  );
});

test("planner typed list/set candidates keep query-bound location evidence when structured rows are sparse", () => {
  const queryText = "Where has Maria made friends?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "location_history",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:maria"]
  });
  const plannerCandidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results: [
      recallResult("Maria summary row", {
        subject_entity_id: "person:maria",
        subject_name: "Maria",
        source_table: "canonical_sets"
      }),
      recallResult("Maria made friends at the homeless shelter, church, and gym.", {
        subject_entity_id: "person:maria",
        subject_name: "Maria"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Maria"] }),
    storedCanonical: null
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.finalClaimSource, "canonical_list_set");
  assert.match(plannerCandidate?.formatted.claimText ?? "", /homeless shelter/i);
  assert.match(plannerCandidate?.formatted.claimText ?? "", /church/i);
  assert.match(plannerCandidate?.formatted.claimText ?? "", /gym/i);
});

test("planner typed list/set candidates filter pair meetup venue evidence before stale canonical sets", () => {
  const queryText = "Which places or events have John and James planned to meet at?";
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText,
    predicateFamily: "location_history",
    subjectBindingStatus: "ambiguous"
  });
  const results = [
    recallResult("Conversation between James and John John: Hey James! Busy few weeks for sure, but I'm pushing through. Got an email about a volunteer gig at a game dev non-profit.", {
      metadata: {
        participant_names: ["John", "James"]
      }
    }),
    recallResult("John: Heard about VR gaming? It's pretty immersive. We can try it together! James: Yeah, VR gaming is awesome! Let`s do it next Saturday!", {
      metadata: {
        participant_names: ["John", "James"]
      }
    }),
    recallResult("James: Well, how about we go to McGee's pub then? I heard they serve a great stout there! John: Great, then I agree! See you tomorrow at McGee's Pub!", {
      metadata: {
        participant_names: ["John", "James"]
      }
    }),
    recallResult("James: Thanks, John. She and I are going to a baseball game next Sunday, want to join?", {
      metadata: {
        participant_names: ["John", "James"]
      }
    })
  ];
  const plannerCandidate = buildPlannerTypedCandidate({
    queryText,
    retrievalPlan,
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John", "James"] }),
    storedCanonical: {
      kind: "set",
      subjectEntityId: null,
      canonicalSubjectName: "John",
      pairSubjectEntityId: null,
      pairSubjectName: "James",
      subjectBindingStatus: "ambiguous",
      predicateFamily: "list_set",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValues: ["Cyberpunk"],
      typedSetEntryValues: ["Cyberpunk"],
      typedSetEntryType: "venue",
      sourceTable: "canonical_sets"
    }
  });

  assert.ok(plannerCandidate);
  assert.equal(plannerCandidate?.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(plannerCandidate?.formatted.claimText, "VR Club, McGee's, and baseball game");
  assert.equal(plannerCandidate?.bundle.subjectPlan.kind, "pair_subject");
});

test("planner typed candidates outrank older narrative report candidates for causal rows", () => {
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: "Why did Gina decide to start her own clothing store?",
    predicateFamily: "profile_state",
    subjectBindingStatus: "resolved",
    subjectEntityHints: ["person:gina"]
  });

  const plannerCandidate = buildPlannerTypedCandidate({
    queryText: "Why did Gina decide to start her own clothing store?",
    retrievalPlan,
    results: [
      recallResult(
        "Gina said she started her own clothing store because she wanted creative freedom and to design clothes herself.",
        {
          subject_entity_id: "person:gina",
          subject_name: "Gina"
        }
      )
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Gina"] }),
    storedCanonical: null
  });

  const preferred = preferPlannerTypedCandidate({
    retrievalPlan,
    plannerCandidate,
    narrativeCandidate: {
      bundle: {
        subjectEntityId: "person:gina",
        canonicalSubjectName: "Gina",
        subjectBindingStatus: "resolved",
        subjectPlan: {
          kind: "single_subject",
          subjectEntityId: "person:gina",
          canonicalSubjectName: "Gina",
          candidateEntityIds: ["person:gina"],
          candidateNames: ["Gina"],
          reason: "test"
        },
        predicateFamily: "narrative_motive",
        provenanceRows: [],
        evidenceItems: [],
        supportStrength: "moderate",
        timeScopeKind: "active",
        reportKind: "aspiration_report",
        ownerSourceTable: "retrieved_text_unit_report"
      },
      canonical: {
        kind: "report",
        subjectEntityId: "person:gina",
        canonicalSubjectName: "Gina",
        predicateFamily: "narrative_motive",
        reportKind: "aspiration_report",
        summaryText: "She wanted to we talked.",
        timeScopeKind: "active",
        provenanceRows: [],
        supportStrength: "moderate",
        confidence: "weak",
        status: "supported"
      },
      formatted: {
        claimText: "She wanted to we talked.",
        finalClaimSource: "canonical_report",
        answerBundle: {
          topClaim: "She wanted to we talked.",
          claimKind: "report",
          subjectPlan: {
            kind: "single_subject",
            subjectEntityId: "person:gina",
            canonicalSubjectName: "Gina",
            candidateEntityIds: ["person:gina"],
            candidateNames: ["Gina"],
            reason: "test"
          },
          predicatePlan: "narrative_motive",
          timePlan: {
            timeScopeKind: "active",
            source: "mention_time"
          },
          evidenceBundle: [],
          reasoningChain: {
            subjectChain: [],
            predicateChain: [],
            temporalChain: [],
            canonicalSupport: [],
            provenanceIds: [],
            abstentionBlockers: [],
            exclusionClauses: []
          }
        },
        shapingTrace: {
          selectedFamily: "report",
          shapingMode: "typed_report_payload",
          typedValueUsed: true,
          generatedProseUsed: true,
          runtimeResynthesisUsed: false,
          supportRowsSelected: 1,
          supportObjectType: "ProfileInferenceSupport",
          renderContractSelected: "report_scalar_value"
        }
      }
    }
  });

  assert.equal(preferred?.bundle.ownerSourceTable, "planner_runtime_causal_candidate");
});
