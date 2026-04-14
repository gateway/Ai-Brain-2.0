import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjudicateCanonicalClaim } from "../dist/retrieval/canonical-adjudication.js";
import { adjudicateNarrativeClaim } from "../dist/retrieval/narrative-adjudication.js";
import { buildDualityObject } from "../dist/retrieval/service.js";

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

test("canonical adjudication prefers temporal family output over a later explicit snippet", () => {
  const results = [
    recallResult("The best supported date is 14 May 2023.", { subject_entity_id: "person:calvin" }),
    recallResult("He first traveled to Tokyo between late 2021 and early 2022.", { subject_entity_id: "person:calvin" })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "When did Calvin first travel to Tokyo?",
    results,
    evidence: [],
    assessment: supportedAssessment(),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      temporal: "between late 2021 and early 2022."
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "between late 2021 and early 2022.");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(adjudicated.canonical.kind, "temporal_fact");
  assert.equal(adjudicated.bundle.timeScopeKind, "range");
  assert.equal(adjudicated.formatted.answerBundle.claimKind, "temporal");
  assert.equal(adjudicated.formatted.answerBundle.timePlan.source, "event_time");
  assert.equal(adjudicated.formatted.shapingTrace.retrievalPlanFamily, "temporal");
  assert.equal(adjudicated.formatted.shapingTrace.winnerTier, "canonical_temporal_bound");
  assert.equal(adjudicated.formatted.shapingTrace.tieBreakReason, "named_subject_binding");
  assert.equal(adjudicated.formatted.shapingTrace.bindingSatisfied, true);
  assert.equal(adjudicated.formatted.shapingTrace.earlyExitReason, "direct_temporal_claim_selected");
  assert.ok((adjudicated.formatted.shapingTrace.atomicUnitCount ?? 0) >= 1);
});

test("canonical adjudication binds explicit named temporal subjects before snippet fallback", () => {
  const results = [
    recallResult("Jon was in Paris on 28 January 2023.", {
      subject_entity_id: "person:jon",
      subject_name: "Jon",
      object_entity_id: "place:paris",
      object_name: "Paris"
    })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "When was Jon in Paris?",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      temporal: "28 January 2023"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.bundle.subjectBindingStatus, "resolved");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(adjudicated.formatted.claimText, "28 January 2023");
});

test("canonical adjudication abstains for mixed-subject ownership queries before snippet fallback", () => {
  const results = [
    recallResult("Deborah mentioned Ollie and Pip in passing.", { subject_entity_id: "person:jolene" })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What are Deborah's snakes called?",
    results,
    evidence: [],
    assessment: supportedAssessment({ confidence: "missing", sufficiency: "missing", subjectMatch: "mixed" }),
    exactDetailFamily: "plural_names",
    exactDetailCandidateText: "Ollie and Pip",
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      residualExact: null
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.canonical.kind, "abstention");
  assert.equal(adjudicated.formatted.claimText, "None.");
  assert.equal(adjudicated.canonical.abstainReason, "insufficient_subject_binding");
});

test("canonical adjudication resolves a subject-bound set answer without falling back to raw snippets", () => {
  const results = [
    recallResult("Melanie and her kids have made bowls, mugs, and little clay animals.", {
      subject_entity_id: "person:melanie",
      subject_name: "Melanie"
    })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What types of pottery have Melanie and her kids made?",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Melanie"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      genericEnumerative: "bowls, mugs, clay animals"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.bundle.subjectBindingStatus, "resolved");
  assert.equal(adjudicated.canonical.kind, "set");
  assert.deepEqual(adjudicated.canonical.objectValues, ["bowls", "mugs", "clay animals"]);
  assert.equal(adjudicated.formatted.answerBundle.subjectPlan.kind, "single_subject");
});

test("canonical adjudication prefers richer generic structured claims before exact detail", () => {
  const results = [
    recallResult("Caroline mentioned a lot of adoption and education context.", {
      subject_entity_id: "person:caroline",
      subject_name: "Caroline"
    })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What fields would Caroline be likely to pursue in her education?",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: "home for these kids",
    exactDetailCandidateStrongSupport: true,
    exactDetailCandidatePredicateFit: false,
    abstentionClaimText: "None.",
    derived: {
      preferenceSummary: "Political science. Public administration. Public affairs"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "Political science. Public administration. Public affairs.");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_counterfactual");
  assert.equal(adjudicated.formatted.shapingTrace.winnerTier, "canonical_structured");
  assert.equal(adjudicated.formatted.shapingTrace.tieBreakReason, "structured_over_scalar");
  assert.equal(adjudicated.formatted.shapingTrace.structuredPayloadKind, "counterfactual_judgment");
});

test("canonical adjudication prefers stored canonical state over noisy snippet-derived profile text", () => {
  const results = [
    recallResult("He mentioned random side chatter about school and hobbies.", {
      subject_entity_id: "person:james",
      subject_name: "James"
    })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Does James live in Connecticut?",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["James"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: "James might live somewhere on the East Coast."
    },
    storedCanonical: {
      kind: "state",
      subjectEntityId: "person:james",
      canonicalSubjectName: "James",
      subjectBindingStatus: "resolved",
      predicateFamily: "profile_state",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "Yes, James lives in Connecticut.",
      validFrom: "2023-01-01T00:00:00.000Z",
      validUntil: null,
      sourceTable: "canonical_states"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "Yes, James lives in Connecticut.");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_profile");
  assert.equal(adjudicated.canonical.kind, "state");
  assert.equal(adjudicated.formatted.answerBundle.fallbackBlockedReason, "canonical_graph_precedence");
});

test("canonical adjudication lets derived temporal rendering beat stored relative temporal text", () => {
  const results = [
    recallResult("Caroline went to the LGBTQ support group yesterday.", {
      subject_entity_id: "person:caroline"
    })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "When did Caroline go to the LGBTQ support group?",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      temporal: "The best supported date is 7 May 2023."
    },
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "temporal_event_fact",
      supportStrength: "moderate",
      timeScopeKind: "anchored_relative",
      confidence: "confident",
      objectValue: "yesterday",
      validFrom: "2023-05-07T00:00:00.000Z",
      validUntil: "2023-05-07T00:00:00.000Z",
      sourceTable: "canonical_temporal_facts"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "7 May 2023");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(adjudicated.canonical.kind, "temporal_fact");
  assert.equal(adjudicated.formatted.shapingTrace?.winnerTier, "canonical_temporal_bound");
  assert.equal(adjudicated.formatted.shapingTrace?.tieBreakReason, "derived_temporal_over_stored_relative");
  assert.equal(adjudicated.formatted.shapingTrace?.bindingSatisfied, true);
  assert.equal(adjudicated.formatted.shapingTrace?.earlyExitReason, "direct_temporal_claim_selected");
});

test("canonical adjudication promotes explicit named temporal subjects before temporal shaping", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "When did Caroline go to the adoption meeting?",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      temporal: "The best supported date is 5 July 2023."
    },
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "ambiguous",
      predicateFamily: "temporal_event_fact",
      supportStrength: "moderate",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "The best supported date is 5 July 2023.",
      sourceTable: "canonical_temporal_facts",
      eventKey: "adoption_meeting",
      eventType: "event",
      timeGranularity: "day",
      answerYear: 2023,
      answerMonth: 7,
      answerDay: 5
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "5 July 2023");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(adjudicated.bundle.subjectBindingStatus, "resolved");
  assert.equal(
    adjudicated.formatted.shapingTrace?.subjectBindingReason,
    "Stored canonical subject matched the explicit named query anchor."
  );
  assert.equal(adjudicated.formatted.shapingTrace?.winnerTier, "canonical_temporal_bound");
  assert.equal(adjudicated.formatted.shapingTrace?.tieBreakReason, "named_subject_binding");
  assert.equal(adjudicated.formatted.shapingTrace?.bindingSatisfied, true);
  assert.equal(adjudicated.formatted.shapingTrace?.selectedEventKey, "adoption_meeting");
});

test("canonical adjudication promotes single-subject query anchors even without provenance-backed subject rows", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "When did Caroline go to the adoption meeting?",
    results: [
      recallResult("The best supported date is 5 July 2023.", {
        source_uri: "/tmp/conv-26-session_10.md"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      temporal: "The best supported date is 5 July 2023."
    },
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "unresolved",
      predicateFamily: "temporal_event_fact",
      supportStrength: "weak",
      timeScopeKind: "historical",
      confidence: "weak",
      objectValue: "The best supported date is 5 July 2023.",
      sourceTable: "canonical_temporal_facts",
      eventKey: "adoption_meeting",
      eventType: "event",
      timeGranularity: "day",
      answerYear: 2023,
      answerMonth: 7,
      answerDay: 5
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "5 July 2023");
  assert.equal(adjudicated.bundle.subjectBindingStatus, "resolved");
  assert.equal(
    adjudicated.formatted.shapingTrace?.subjectBindingReason,
    "Primary name anchor Caroline kept the subject plan single-subject."
  );
  assert.equal(adjudicated.formatted.shapingTrace?.winnerTier, "canonical_temporal_bound");
  assert.equal(adjudicated.formatted.shapingTrace?.tieBreakReason, "named_subject_binding");
  assert.equal(adjudicated.formatted.shapingTrace?.bindingSatisfied, true);
  assert.equal(adjudicated.formatted.shapingTrace?.selectedEventKey, "adoption_meeting");
});

test("canonical adjudication promotes explicit temporal subjects even when assessment evidence stays mismatched", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "When did Caroline apply to adoption agencies?",
    results: [
      recallResult("The best supported date is 23 August 2023.", {
        source_uri: "/tmp/conv-26-session_10.md"
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
    abstentionClaimText: "None.",
    derived: {
      temporal: "The best supported date is 23 August 2023."
    },
    storedCanonical: {
      kind: "temporal_fact",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "ambiguous",
      predicateFamily: "temporal_event_fact",
      supportStrength: "weak",
      timeScopeKind: "historical",
      confidence: "weak",
      objectValue: "The best supported date is 23 August 2023.",
      sourceTable: "canonical_temporal_facts",
      eventKey: null,
      eventType: "event",
      timeGranularity: "day",
      answerYear: 2023,
      answerMonth: 8,
      answerDay: 23
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.bundle.subjectBindingStatus, "resolved");
  assert.match(
    adjudicated.formatted.shapingTrace?.subjectBindingReason ?? "",
    /Caroline/
  );
  assert.notEqual(adjudicated.formatted.shapingTrace?.renderContractSelected, "temporal_subject_binding_missing");
});

test("canonical adjudication promotes explicit named list-set subjects before shaping", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What books has Melanie read?",
    results: [
      recallResult("Melanie read Nothing is Impossible and Charlotte's Web.", {
        source_uri: "/tmp/conv-26-session_12.md"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      matchedParticipants: ["Melanie"],
      subjectMatch: "matched",
      sufficiency: "supported"
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      hobbies: "\"Nothing is Impossible\", \"Charlotte's Web\""
    },
    storedCanonical: {
      kind: "set",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "unresolved",
      predicateFamily: "list_set",
      supportStrength: "moderate",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValues: ["Nothing is Impossible", "Charlotte's Web"],
      sourceTable: "canonical_sets"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.bundle.subjectBindingStatus, "resolved");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(adjudicated.canonical.kind, "set");
  assert.deepEqual(adjudicated.canonical.objectValues, ["Nothing is Impossible", "Charlotte's Web"]);
  assert.equal(adjudicated.formatted.shapingTrace?.winnerTier, "canonical_structured");
  assert.equal(adjudicated.formatted.shapingTrace?.tieBreakReason, "structured_over_scalar");
  assert.equal(adjudicated.formatted.shapingTrace?.bindingSatisfied, true);
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "ListSetSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "book_list_render");
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryType, "book_title");
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryCount, 2);
});

test("canonical adjudication promotes explicit named profile subjects before shaping", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    results: [
      recallResult("Caroline collects classic children's books.", {
        source_uri: "/tmp/conv-26-session_10.md"
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
    abstentionClaimText: "None.",
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

  assert.ok(adjudicated);
  assert.equal(adjudicated.bundle.subjectBindingStatus, "resolved");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_profile");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "CollectionInferenceSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "collection_yes_since_collects");
});

test("canonical adjudication keeps bookshelf profile-state rows on report contracts when stored summaries are weak", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    results: [
      recallResult("I've got lots of kids' books: classics, educational books, and stories from different cultures.", {
        source_uri: "/tmp/conv-26-session_10.md",
        subject_name: "Caroline",
        speaker_name: "Caroline"
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
    abstentionClaimText: "None.",
    derived: {
      profile: "Yes."
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
      objectValue: "Yes.",
      sourceTable: "canonical_states"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_profile");
  assert.equal(adjudicated.formatted.claimText, "Yes, since Caroline collects classic children's books.");
  assert.equal(adjudicated.formatted.shapingTrace?.selectedFamily, "report");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "CollectionInferenceSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "collection_yes_since_collects");
  assert.equal(adjudicated.formatted.shapingTrace?.bypassReason ?? null, null);
});

test("canonical adjudication routes profile-state membership questions through profile support contracts", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Would Melanie be considered a member of the LGBTQ community?",
    results: [
      recallResult("Melanie attended LGBTQ support groups and local LGBTQ events.", {
        source_uri: "/tmp/conv-26-session_14.md"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      matchedParticipants: ["Melanie"],
      subjectMatch: "matched",
      sufficiency: "supported"
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: "Yes"
    },
    storedCanonical: {
      kind: "state",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "unresolved",
      predicateFamily: "profile_state",
      supportStrength: "moderate",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValue: "Yes",
      sourceTable: "canonical_states"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_profile");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "ProfileInferenceSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "community_membership_inference");
  assert.equal(adjudicated.formatted.shapingTrace?.bypassReason ?? null, null);
});

test("canonical adjudication classifies explicit named event participation queries as list-set", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What events has Caroline participated in to help children?",
    results: [
      recallResult("Caroline participated in a school speech and a mentoring program to help children.", {
        source_uri: "/tmp/conv-26-session_11.md"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      matchedParticipants: ["Caroline"]
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      genericEnumerative: "literacy fundraiser, school speech"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.canonical.predicateFamily, "list_set");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(adjudicated.formatted.shapingTrace?.retrievalPlanFamily, "list_set");
  assert.ok(adjudicated.formatted.shapingTrace?.ownerEligibilityHints?.includes("canonical_list_set"));
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "event_list_render");
  assert.equal(adjudicated.formatted.shapingTrace?.typedSetEntryType, "event_name");
});

test("canonical adjudication preserves report ownership when report support overrides a stored fact row", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "How does John plan to honor the memories of his beloved pet?",
    results: [
      recallResult("John plans to honor his beloved pet by creating a memorial garden and photo wall.", {
        subject_entity_id: "person:john",
        subject_name: "John"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      matchedParticipants: ["John"],
      confidence: "partial",
      sufficiency: "supported",
      subjectMatch: "matched"
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: "by creating a memorial garden and photo wall",
    exactDetailCandidateStrongSupport: true,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: "He plans to honor his beloved pet by creating a memorial garden and photo wall."
    },
    storedCanonical: {
      kind: "fact",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "generic_fact",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "by creating a memorial garden and photo wall",
      sourceTable: "canonical_facts"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_profile");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "ProfileInferenceSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "report_scalar_value");
});

test("canonical adjudication rescues inferential bookshelf queries before canonical abstention wins", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    results: [
      recallResult("I'm creating a library for when I have kids and I keep collecting classic children's books.", {
        subject_name: "Caroline",
        speaker_name: "Caroline",
        source_uri: "/tmp/conv-26-session_10.md",
        metadata: {
          source_turn_text:
            "I'm creating a library for when I have kids and I keep collecting classic children's books."
        }
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      matchedParticipants: ["Caroline"],
      confidence: "partial",
      sufficiency: "weak",
      subjectMatch: "matched"
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: null
    },
    storedCanonical: {
      kind: "abstention",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "weak",
      timeScopeKind: "historical",
      confidence: "weak",
      abstainReason: "insufficient_support",
      sourceTable: "canonical_entity_reports"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_profile");
  assert.equal(adjudicated.formatted.claimText, "Yes, since Caroline collects classic children's books.");
  assert.equal(adjudicated.formatted.shapingTrace?.supportObjectType, "CollectionInferenceSupport");
  assert.equal(adjudicated.formatted.shapingTrace?.renderContractSelected, "collection_yes_since_collects");
});

test("canonical adjudication lets stored canonical abstention block weak snippet fallback", () => {
  const results = [
    recallResult("Someone else had the pet names in a neighboring turn.", {
      subject_entity_id: "person:other"
    })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What are Deborah's snakes called?",
    results,
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

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "None.");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_abstention");
  assert.equal(adjudicated.canonical.kind, "abstention");
});

test("narrative adjudication re-synthesizes financial profile reports from recall evidence when stored payload is empty", () => {
  const results = [
    recallResult("I won a really big video game tournament last week and made so much money from it.", {
      subject_entity_id: "person:john",
      subject_name: "John",
      metadata: {
        source_sentence_text: "John won a really big video game tournament and made so much money from it."
      }
    }),
    recallResult("It's nice to have the extra cash on hand, and I'm enjoying my new job at a tech company.", {
      subject_entity_id: "person:john",
      subject_name: "John",
      metadata: {
        source_sentence_text: "It's nice to have the extra cash on hand, and he is enjoying his new job at a tech company."
      }
    })
  ];

  const decision = adjudicateNarrativeClaim({
    queryText: "What might John's financial status be?",
    exactDetailFamily: "generic",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "weak",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "ride on a swing activity. canonical_rebuild. likes",
      reportKind: "profile_report",
      answerPayload: {},
      sourceTable: "canonical_facts"
    }
  });

  assert.ok(decision.candidate);
  assert.equal(decision.candidate.formatted.claimText, "Middle-class or wealthy");
  assert.equal(decision.candidate.formatted.finalClaimSource, "canonical_report");
});

test("narrative adjudication re-synthesizes financial profile reports from subject-bound source backfill", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "financial-status-"));
  const sourceUri = join(tempDir, "conv-41-session_01.md");
  writeFileSync(
    sourceUri,
    [
      "John: I won a really big video game tournament and made so much money from it.",
      "John: It's nice to have the extra cash on hand, and I'm enjoying my new job at a tech company.",
      "Someone Else: I liked the ride on a swing activity."
    ].join("\n"),
    "utf8"
  );

  try {
    const decision = adjudicateNarrativeClaim({
      queryText: "What might John's financial status be?",
      exactDetailFamily: "generic",
      results: [
        recallResult("ride on a swing activity. canonical_rebuild. likes", {
          subject_entity_id: "person:john",
          subject_name: "John",
          source_uri: sourceUri
        })
      ],
      evidence: [],
      assessment: supportedAssessment({ matchedParticipants: ["John"] }),
      abstentionClaimText: "Unknown.",
      storedNarrative: {
        kind: "report",
        subjectEntityId: "person:john",
        canonicalSubjectName: "John",
        subjectBindingStatus: "resolved",
        predicateFamily: "narrative_profile",
        supportStrength: "weak",
        timeScopeKind: "active",
        confidence: "confident",
        objectValue: "ride on a swing activity. canonical_rebuild. likes",
        reportKind: "profile_report",
        answerPayload: {},
        sourceTable: "canonical_facts"
      }
    });

    assert.ok(decision.candidate);
    assert.equal(decision.candidate.formatted.claimText, "Middle-class or wealthy");
    assert.equal(decision.candidate.formatted.finalClaimSource, "canonical_report");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("narrative adjudication renders collection inference as a direct bookshelf answer under cutover", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "collection_report";

  const decision = adjudicateNarrativeClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    exactDetailFamily: "generic",
    results: [recallResult("Caroline collects classic children's books.", { subject_entity_id: "person:caroline", subject_name: "Caroline" })],
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
      candidateCount: 3,
      sourceTable: "canonical_sets",
      selectionScoreMargin: 0.4
    }
  });

  assert.ok(decision.adjudication);
  assert.equal(decision.adjudication.formatted.claimText, "Yes, since Caroline collects classic children's books.");
  assert.equal(decision.telemetry.cutoverApplied, true);
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;
});

test("narrative adjudication prefers preference reports for favorite-style queries under cutover", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "preference_report";

  const decision = adjudicateNarrativeClaim({
    queryText: "What is Gina's favorite style of dance?",
    exactDetailFamily: "generic",
    results: [recallResult("Contemporary is my top pick.", { subject_entity_id: "person:gina", subject_name: "Gina" })],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Gina"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:gina",
      canonicalSubjectName: "Gina",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "Contemporary dance",
      reportKind: "preference_report",
      candidateCount: 2,
      sourceTable: "canonical_facts",
      selectionScoreMargin: 0.45
    }
  });

  assert.ok(decision.adjudication);
  assert.equal(decision.adjudication.formatted.claimText, "Contemporary");
  assert.equal(decision.telemetry.cutoverApplied, true);
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;
});

test("canonical adjudication renders pair commonality sets as a structured shared claim", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What do Jon and Gina both have in common?",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon", "Gina"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {},
    storedCanonical: {
      kind: "set",
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      pairSubjectEntityId: "person:gina",
      pairSubjectName: "Gina",
      subjectBindingStatus: "resolved",
      predicateFamily: "commonality",
      supportStrength: "strong",
      timeScopeKind: "historical",
      confidence: "confident",
      objectValues: ["lost their jobs", "started their own businesses"],
      sourceTable: "canonical_sets"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "They lost their jobs and started their own businesses.");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(adjudicated.formatted.answerBundle.subjectPlan.kind, "pair_subject");
  assert.equal(adjudicated.formatted.answerBundle.claimKind, "set");
});

test("canonical adjudication lets an explicit named-subject anchor beat early abstention when stored support exists", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What are Deborah's favorite books?",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Deborah"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {},
    storedCanonical: {
      kind: "fact",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "unresolved",
      predicateFamily: "generic_fact",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValue: "Sapiens",
      sourceTable: "canonical_facts"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.canonical.kind, "fact");
  assert.equal(adjudicated.formatted.claimText, "Sapiens");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_exact_detail");
  assert.equal(adjudicated.formatted.answerBundle.subjectPlan.kind, "single_subject");
});

test("canonical adjudication does not abstain solely because retrieval was mixed when canonical binding resolves the named subject", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    results: [
      recallResult("Caroline collects classic children's books.", {
        subject_entity_id: "person:caroline",
        subject_name: "Caroline",
        object_entity_id: "person:melanie",
        object_name: "Melanie"
      }),
      recallResult("Melanie likes painting sunrises.", {
        subject_entity_id: "person:melanie",
        subject_name: "Melanie"
      })
    ],
    evidence: [],
    assessment: supportedAssessment({
      subjectMatch: "mixed",
      matchedParticipants: ["Caroline"],
      foreignParticipants: ["Melanie"]
    }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      profile: "Yes, since Caroline collects classic children's books."
    }
  });

  assert.ok(adjudicated);
  assert.notEqual(adjudicated.canonical.kind, "abstention");
  assert.equal(adjudicated.formatted.claimText, "Yes, since Caroline collects classic children's books.");
});

test("canonical adjudication uses canonical goal sets for scoped career-goal queries", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "what are John's goals with regards to his basketball career?",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    exactDetailFamily: "goals",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      profile: "John has a lot of goals."
    },
    storedCanonical: {
      kind: "set",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "profile_state",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValues: ["improve shooting percentage", "win a championship"],
      sourceTable: "canonical_sets"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "improve shooting percentage, win a championship");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_list_set");
  assert.equal(adjudicated.formatted.answerBundle.subjectPlan.kind, "single_subject");
});

test("canonical adjudication preserves ordered non-basketball goal sets", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What are John's goals for his career that are not related to his basketball skills?",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    exactDetailFamily: "goals",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      profile: "John has goals outside basketball too."
    },
    storedCanonical: {
      kind: "set",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "profile_state",
      supportStrength: "strong",
      timeScopeKind: "active",
      confidence: "confident",
      objectValues: ["do charity work", "build his brand", "get endorsements"],
      sourceTable: "canonical_sets"
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.formatted.claimText, "get endorsements, build his brand, do charity work");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_list_set");
});

test("canonical adjudication abstains for unsupported tattoo-attribute ownership queries", () => {
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What kind of flowers does Andrew have a tattoo of?",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Andrew"], confidence: "missing", sufficiency: "missing" }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: "sunflowers",
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {}
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.canonical.kind, "abstention");
  assert.equal(adjudicated.canonical.abstainReason, "ownership_not_proven");
  assert.equal(adjudicated.formatted.claimText, "None.");
});

test("duality uses canonical adjudication when present instead of a noisy top snippet", () => {
  const results = [
    recallResult("The best supported date is 14 May 2023.", { subject_entity_id: "person:calvin" })
  ];
  const assessment = {
    confidence: "confident",
    sufficiency: "supported",
    reason: "supported",
    lexicalCoverage: 1,
    matchedTerms: [],
    totalTerms: 0,
    evidenceCount: 1,
    directEvidence: true,
    subjectMatch: "matched",
    matchedParticipants: [],
    missingParticipants: [],
    foreignParticipants: []
  };
  const canonicalAdjudication = adjudicateCanonicalClaim({
    queryText: "When did Calvin first travel to Tokyo?",
    results,
    evidence: [],
    assessment,
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      temporal: "between late 2021 and early 2022."
    }
  });

  const duality = buildDualityObject(results, [], assessment, "test", "When did Calvin first travel to Tokyo?", null, canonicalAdjudication);
  assert.equal(duality.claim.text, "between late 2021 and early 2022.");
});

test("canonical temporal adjudication keeps relative week windows on the typed support contract", () => {
  const results = [
    {
      ...recallResult("19 August 2023", {
        subject_entity_id: "person:audrey",
        subject_name: "Audrey",
        metadata: {
          source_turn_text: "I baked muffins just for myself last week."
        }
      }),
      occurredAt: "2023-04-10T12:00:00.000Z"
    }
  ];
  const assessment = {
    confidence: "confident",
    sufficiency: "supported",
    reason: "supported",
    lexicalCoverage: 1,
    matchedTerms: [],
    totalTerms: 0,
    evidenceCount: 1,
    directEvidence: true,
    subjectMatch: "matched",
    matchedParticipants: ["Audrey"],
    missingParticipants: [],
    foreignParticipants: []
  };
  const canonicalAdjudication = adjudicateCanonicalClaim({
    queryText: "When did Audrey make muffins for herself?",
    results,
    evidence: [],
    assessment,
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      temporal: "The week of April 3rd to 9th, 2023."
    }
  });

  assert.ok(canonicalAdjudication);
  assert.equal(canonicalAdjudication.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(canonicalAdjudication.formatted.claimText, "The week of April 3rd to 9th, 2023");
  assert.equal(canonicalAdjudication.formatted.shapingTrace.shapingPipelineEntered, true);
  assert.equal(canonicalAdjudication.formatted.shapingTrace.renderContractSelected, "temporal_relative_day");
  assert.equal(canonicalAdjudication.formatted.shapingTrace.earlyExitReason ?? null, null);

  const duality = buildDualityObject(
    results,
    [],
    assessment,
    "test",
    "When did Audrey make muffins for herself?",
    null,
    canonicalAdjudication
  );
  assert.equal(duality.claim.text, "The week of April 3rd to 9th, 2023");
});

test("canonical temporal adjudication prefers typed muffin-week support over derived direct dates", () => {
  const results = [
    {
      ...recallResult(
        "Wow, sounds amazing! Glad you got to enjoy them. Since you metioned pastries, I made some of my favorite treats last week. Let's have a pastry party sometime!",
        {
          subject_name: "Audrey",
          metadata: {
            source_turn_text:
              "Audrey: Wow, sounds amazing! Glad you got to enjoy them. Since you metioned pastries, I made some of my favorite treats last week. Let's have a pastry party sometime!",
            query: "homemade blueberry muffin pastry",
            blip_caption: "a photo of a muffin pan filled with blueberries and muffins"
          }
        }
      ),
      occurredAt: "2023-04-10T12:00:00.000Z"
    }
  ];
  const assessment = {
    confidence: "confident",
    sufficiency: "supported",
    reason: "supported",
    lexicalCoverage: 1,
    matchedTerms: [],
    totalTerms: 0,
    evidenceCount: 1,
    directEvidence: true,
    subjectMatch: "matched",
    matchedParticipants: ["Audrey"],
    missingParticipants: [],
    foreignParticipants: []
  };
  const canonicalAdjudication = adjudicateCanonicalClaim({
    queryText: "When did Audrey make muffins for herself?",
    results,
    evidence: [],
    assessment,
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      temporal: "The best supported date is 9 April 2023."
    }
  });

  assert.ok(canonicalAdjudication);
  assert.equal(canonicalAdjudication.formatted.finalClaimSource, "canonical_temporal");
  assert.equal(canonicalAdjudication.formatted.claimText, "The week of April 3rd to 9th, 2023");
  assert.equal(canonicalAdjudication.formatted.shapingTrace.shapingPipelineEntered, true);
  assert.equal(canonicalAdjudication.formatted.shapingTrace.renderContractSelected, "temporal_relative_day");
  assert.equal(canonicalAdjudication.formatted.shapingTrace.selectedEventKey, "make_muffins_self");
});

test("canonical adjudication treats support-removal career hypotheticals as counterfactuals before goal/profile routing", () => {
  const results = [
    recallResult("Counseling or mental health for transgender people feels like the right path.", {
      subject_entity_id: "person:caroline"
    }),
    recallResult("The support I got growing up made a huge difference and now I want to help people go through it too.", {
      subject_entity_id: "person:caroline"
    })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?",
    results,
    evidence: [],
    assessment: supportedAssessment(),
    exactDetailFamily: "goals",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "None.",
    derived: {
      counterfactual: "Likely no.",
      profile: "Caroline wants to pursue counseling."
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.bundle.predicateFamily, "counterfactual");
  assert.equal(adjudicated.formatted.claimText, "Likely no.");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_counterfactual");
});

test("canonical adjudication routes identity questions into the identity family", () => {
  const results = [
    recallResult("Caroline is a transgender woman.", {
      subject_entity_id: "person:caroline"
    })
  ];
  const adjudicated = adjudicateCanonicalClaim({
    queryText: "What is Caroline's identity?",
    results,
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    exactDetailFamily: "generic",
    exactDetailCandidateText: null,
    exactDetailCandidateStrongSupport: false,
    abstentionClaimText: "Unknown.",
    derived: {
      identity: "The best supported identity signal is that she is a transgender woman."
    }
  });

  assert.ok(adjudicated);
  assert.equal(adjudicated.bundle.predicateFamily, "alias_identity");
  assert.equal(adjudicated.formatted.finalClaimSource, "canonical_profile");
  assert.equal(adjudicated.formatted.claimText, "The best supported identity signal is that she is a transgender woman.");
});

test("narrative adjudication shadows narrative candidates until cutover is enabled", () => {
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;
  const decision = adjudicateNarrativeClaim({
    queryText: "Why did Caroline want to become a counselor?",
    exactDetailFamily: "generic",
    results: [recallResult("She wanted to help people who were going through similar experiences.")],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "narrative",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_motive",
      supportStrength: "strong",
      timeScopeKind: "historical",
      temporalValiditySource: "event_time",
      confidence: "confident",
      objectValue: "She wanted to help people who were going through similar experiences.",
      narrativeKind: "motive",
      candidateCount: 2,
      sourceTable: "canonical_narratives"
    }
  });

  assert.equal(decision.adjudication, null);
  assert.equal(decision.telemetry.pathUsed, true);
  assert.equal(decision.telemetry.narrativeKind, "motive");
  assert.equal(decision.telemetry.shadowDecision, "candidate_only");
});

test("narrative adjudication cuts over motive answers when enabled", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  const decision = adjudicateNarrativeClaim({
    queryText: "Why did Caroline want to become a counselor?",
    exactDetailFamily: "generic",
    results: [recallResult("She wanted to help people who were going through similar experiences.")],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "narrative",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_motive",
      supportStrength: "strong",
      timeScopeKind: "historical",
      temporalValiditySource: "event_time",
      confidence: "confident",
      objectValue: "She wanted to help people who were going through similar experiences.",
      narrativeKind: "motive",
      candidateCount: 2,
      sourceTable: "canonical_narratives"
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.adjudication.formatted.claimText, "She wanted to help people who were going through similar experiences.");
  assert.equal(decision.adjudication.formatted.finalClaimSource, "canonical_narrative");
  assert.equal(decision.adjudication.canonical.kind, "narrative");
  assert.equal(decision.adjudication.formatted.answerBundle.claimKind, "narrative");
  assert.equal(decision.telemetry.cutoverApplied, true);
});

test("narrative adjudication honors targeted cutover families", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "career_report,career_intent";
  const decision = adjudicateNarrativeClaim({
    queryText: "What are John's goals for his career that are not related to his basketball skills?",
    exactDetailFamily: "goals",
    results: [recallResult("He also wants to do charity work and mentor kids.")],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_motive",
      supportStrength: "strong",
      timeScopeKind: "historical",
      temporalValiditySource: "event_time",
      confidence: "confident",
      objectValue: "He wants to do charity work and mentor younger players.",
      narrativeKind: "career_intent",
      reportKind: "career_report",
      candidateCount: 1,
      sourceTable: "canonical_entity_reports"
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.adjudication.formatted.finalClaimSource, "canonical_report");
  assert.equal(decision.telemetry.cutoverApplied, true);
});

test("narrative adjudication keeps non-targeted families in shadow mode", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "career_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "Why did Caroline want to become a counselor?",
    exactDetailFamily: "generic",
    results: [recallResult("She wanted to help people who were going through similar experiences.")],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "narrative",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_motive",
      supportStrength: "strong",
      timeScopeKind: "historical",
      temporalValiditySource: "event_time",
      confidence: "confident",
      objectValue: "She wanted to help people who were going through similar experiences.",
      narrativeKind: "motive",
      candidateCount: 2,
      sourceTable: "canonical_narratives"
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.equal(decision.adjudication, null);
  assert.equal(decision.telemetry.shadowDecision, "candidate_only");
  assert.equal(decision.telemetry.cutoverApplied, false);
});

test("narrative adjudication keeps broad report families in shadow when the candidate margin is weak", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "preference_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "What does Gina like about dancing?",
    exactDetailFamily: "generic",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Gina"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:gina",
      canonicalSubjectName: "Gina",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      temporalValiditySource: "mention_time",
      confidence: "confident",
      objectValue: "Gina loves dancing.",
      reportKind: "preference_report",
      candidateCount: 3,
      sourceTable: "canonical_entity_reports",
      selectionScore: 7.4,
      selectionScoreMargin: 0.2
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.equal(decision.adjudication, null);
  assert.equal(decision.telemetry.shadowDecision, "candidate_only");
  assert.equal(decision.telemetry.cutoverApplied, false);
});

test("narrative adjudication allows non-career report cutover only for authoritative high-margin candidates", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "preference_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "What is Gina's favorite style of dance?",
    exactDetailFamily: "generic",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Gina"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:gina",
      canonicalSubjectName: "Gina",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      temporalValiditySource: "mention_time",
      confidence: "confident",
      objectValue: "Gina's favorite style of dance is salsa.",
      reportKind: "preference_report",
      candidateCount: 3,
      sourceTable: "canonical_entity_reports",
      selectionScore: 9.2,
      selectionScoreMargin: 1.6
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.telemetry.cutoverApplied, true);
  assert.equal(decision.adjudication.formatted.finalClaimSource, "canonical_report");
});

test("narrative adjudication allows high-margin graph-backed report cutover", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "collection_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "What items does John collect?",
    exactDetailFamily: "generic",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["John"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:john",
      canonicalSubjectName: "John",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      temporalValiditySource: "mention_time",
      confidence: "confident",
      objectValue: "sneakers, fantasy movie DVDs, jerseys",
      reportKind: "collection_report",
      candidateCount: 4,
      sourceTable: "canonical_sets",
      selectionScore: 10.4,
      selectionScoreMargin: 1.8
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.telemetry.cutoverApplied, true);
  assert.equal(decision.adjudication.formatted.finalClaimSource, "canonical_report");
});

test("narrative adjudication allows query-aligned preference report cutover from retrieved text units", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "preference_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "What is Gina's favorite style of dance?",
    exactDetailFamily: "generic",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Gina"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:gina",
      canonicalSubjectName: "Gina",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "moderate",
      timeScopeKind: "active",
      temporalValiditySource: "mention_time",
      confidence: "weak",
      objectValue: "Contemporary",
      reportKind: "preference_report",
      candidateCount: 2,
      sourceTable: "retrieved_text_unit_report",
      selectionScore: 8.1,
      selectionScoreMargin: 0.78
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.telemetry.cutoverApplied, true);
  assert.equal(decision.adjudication.formatted.finalClaimSource, "canonical_report");
});

test("narrative adjudication allows bookshelf collection inference cutover from assembled reports", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "collection_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    exactDetailFamily: "generic",
    results: [],
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
      temporalValiditySource: "mention_time",
      confidence: "weak",
      objectValue: "classic children's books",
      answerPayload: {
        answer_type: "bookshelf_inference",
        answer_value: "classic children's books",
        reason_value: "collects classic children's books",
        render_template: "yes_since_collects"
      },
      reportKind: "collection_report",
      candidateCount: 3,
      sourceTable: "assembled_entity_report",
      selectionScore: 7.9,
      selectionScoreMargin: 0.25
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.telemetry.cutoverApplied, true);
  assert.equal(decision.adjudication.formatted.finalClaimSource, "canonical_report");
});

test("narrative adjudication allows resolved bookshelf collection inference cutover from weak retrieved evidence", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "collection_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    exactDetailFamily: "generic",
    results: [],
    evidence: [],
    assessment: supportedAssessment({
      subjectMatch: "mixed",
      matchedParticipants: ["Caroline"],
      foreignParticipants: ["Melanie"]
    }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "weak",
      timeScopeKind: "active",
      temporalValiditySource: "mention_time",
      confidence: "missing",
      objectValue: "classic children's books",
      answerPayload: {
        answer_type: "bookshelf_inference",
        answer_value: "classic children's books",
        reason_value: "collects classic children's books",
        render_template: "yes_since_collects"
      },
      reportKind: "collection_report",
      candidateCount: 7,
      sourceTable: "retrieved_text_unit_report",
      selectionScore: 6.9,
      selectionScoreMargin: 0.01
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.telemetry.cutoverApplied, true);
  assert.equal(decision.adjudication.formatted.finalClaimSource, "canonical_report");
});

test("narrative adjudication prefers typed report payloads for bookshelf inference", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "collection_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    exactDetailFamily: "generic",
    results: [],
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
      temporalValiditySource: "mention_time",
      confidence: "weak",
      objectValue: "landscape canonical_rebuild media_mentions unknown",
      answerPayload: {
        answer_type: "bookshelf_inference",
        answer_value: "classic children's books",
        reason_value: "collects classic children's books",
        render_template: "yes_since_collects"
      },
      reportKind: "collection_report",
      candidateCount: 7,
      sourceTable: "canonical_entity_reports",
      selectionScore: 7.2,
      selectionScoreMargin: 0.12
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.adjudication.formatted.claimText, "Yes, since Caroline collects classic children's books.");
});

test("narrative adjudication re-synthesizes bookshelf inference from runtime report support when payload is weak", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "collection_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    exactDetailFamily: "generic",
    results: [
      recallResult("Caroline collects classic children's books.", {
        subject_name: "Caroline",
        source_sentence_text: "Caroline collects classic children's books."
      })
    ],
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
      temporalValiditySource: "mention_time",
      confidence: "weak",
      objectValue: "landscape canonical_rebuild media_mentions unknown",
      answerPayload: {},
      reportKind: "collection_report",
      candidateCount: 4,
      sourceTable: "retrieved_text_unit_aggregate_report",
      selectionScore: 7.2,
      selectionScoreMargin: 0.31
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.adjudication.formatted.claimText, "Yes, since Caroline collects classic children's books.");
});

test("narrative adjudication re-synthesizes direct career reports from runtime support when stored summary is too coarse", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "career_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "What career path has Caroline decided to persue?",
    exactDetailFamily: "generic",
    results: [
      recallResult("Caroline says she wants to focus on counseling and mental health support for transgender people.", {
        subject_name: "Caroline",
        source_sentence_text: "Caroline says she wants to focus on counseling and mental health support for transgender people."
      })
    ],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Caroline"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:caroline",
      canonicalSubjectName: "Caroline",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_motive",
      supportStrength: "moderate",
      timeScopeKind: "active",
      temporalValiditySource: "mention_time",
      confidence: "weak",
      objectValue: "counseling or mental health work",
      answerPayload: {},
      reportKind: "career_report",
      candidateCount: 4,
      sourceTable: "retrieved_text_unit_aggregate_report",
      selectionScore: 7.2,
      selectionScoreMargin: 0.31
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.ok(decision.adjudication);
  assert.equal(decision.adjudication.formatted.claimText, "counseling or mental health for transgender people");
});

test("narrative adjudication does not cut over zero-candidate preference abstentions", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "preference_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "What is Jon's favorite style of dance?",
    exactDetailFamily: "generic",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "abstention",
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "weak",
      timeScopeKind: "active",
      temporalValiditySource: "mention_time",
      confidence: "weak",
      abstainReason: "insufficient_support",
      reportKind: "preference_report",
      candidateCount: 0,
      sourceTable: "canonical_entity_reports",
      selectionScore: 4.2,
      selectionScoreMargin: 0.04
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.equal(decision.adjudication, null);
  assert.equal(decision.telemetry.cutoverApplied, false);
  assert.equal(decision.telemetry.shadowDecision, "candidate_abstained");
});

test("narrative adjudication keeps favorite-memory preference reports in shadow", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "preference_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "What is Jon's favorite dancing memory?",
    exactDetailFamily: "generic",
    results: [],
    evidence: [],
    assessment: supportedAssessment({ matchedParticipants: ["Jon"] }),
    abstentionClaimText: "Unknown.",
    storedNarrative: {
      kind: "report",
      subjectEntityId: "person:jon",
      canonicalSubjectName: "Jon",
      subjectBindingStatus: "resolved",
      predicateFamily: "narrative_profile",
      supportStrength: "strong",
      timeScopeKind: "active",
      temporalValiditySource: "mention_time",
      confidence: "confident",
      objectValue: "Contemporary",
      answerPayload: {
        answer_type: "preference_value",
        answer_value: "Contemporary"
      },
      reportKind: "preference_report",
      candidateCount: 3,
      sourceTable: "canonical_entity_reports",
      selectionScore: 8.7,
      selectionScoreMargin: 1.1
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.equal(decision.adjudication, null);
  assert.equal(decision.telemetry.cutoverApplied, false);
  assert.equal(decision.telemetry.shadowDecision, "candidate_only");
});

test("narrative adjudication keeps bookshelf inference in shadow without a typed payload", () => {
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER = "1";
  process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS = "collection_report";
  const decision = adjudicateNarrativeClaim({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    exactDetailFamily: "generic",
    results: [],
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
      temporalValiditySource: "mention_time",
      confidence: "weak",
      objectValue: "landscape canonical_rebuild media_mentions unknown",
      reportKind: "collection_report",
      candidateCount: 4,
      sourceTable: "canonical_sets",
      selectionScore: 7.3,
      selectionScoreMargin: 0.2
    }
  });
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  delete process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER;

  assert.equal(decision.adjudication, null);
  assert.equal(decision.telemetry.cutoverApplied, false);
  assert.equal(decision.telemetry.shadowDecision, "candidate_only");
});
