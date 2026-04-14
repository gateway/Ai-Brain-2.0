import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlannerTargetedBackfillSubqueries,
  buildRecursiveReflectSubqueries,
  buildDualityObject,
  deriveRelationshipLaneClaimText,
  deriveSharedCommonalityClaimText,
  deriveMediaSummaryClaimText,
  deriveSubjectBoundExactDetailClaimWithTelemetry,
  deriveIdealDanceStudioClaimText,
  deriveHobbyClaimText,
  derivePetSafetyClaimText,
  extractConversationParticipants,
  extractSubjectHintsFromQuery,
  shouldSuppressRecursiveReflectForGeneratedQuery
} from "../dist/retrieval/service.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function relationshipResult({
  relationshipId,
  predicate,
  objectName,
  status = "active",
  confidence = 1,
  validFrom = null,
  validUntil = null
}) {
  return {
    relationshipId,
    predicate,
    subjectName: "Lauren",
    objectName,
    confidence,
    status,
    validFrom,
    validUntil,
    occurredAt: validUntil ?? validFrom,
    sourceMemoryId: null,
    provenance: {
      source_uri: "/tmp/relationship.md"
    }
  };
}

function recallResult({
  memoryId,
  content,
  subjectName,
  sourceSentenceText,
  memoryType = "episodic_memory",
  occurredAt = null,
  provenance = {}
}) {
  const metadata = {
    subject_name: subjectName,
    source_sentence_text: sourceSentenceText,
    ...(provenance.metadata ?? {})
  };
  return {
    memoryId,
    memoryType,
    content,
    score: 1,
    artifactId: null,
    occurredAt,
    namespaceId: "ns_supported_claim",
    provenance: {
      subject_name: subjectName,
      metadata,
      ...provenance
    }
  };
}

test("current relationship profile prefers former partner over weaker friend label", () => {
  const claim = deriveRelationshipLaneClaimText(
    "Who is Lauren in my life right now, exactly?",
    "Lauren",
    [
      relationshipResult({
        relationshipId: "friend",
        predicate: "friend_of",
        objectName: "Steve"
      }),
      relationshipResult({
        relationshipId: "former",
        predicate: "former_partner_of",
        objectName: "Steve",
        status: "ended",
        validUntil: "2025-10-18T00:00:00.000Z"
      }),
      relationshipResult({
        relationshipId: "place",
        predicate: "associated_with",
        objectName: "Chiang Mai"
      })
    ]
  );

  assert.ok(claim);
  assert.match(claim, /former partner/i);
  assert.doesNotMatch(claim, /friend/i);
});

test("shared commonality reducer uses provenance-backed source text to recover job-loss and business overlap", () => {
  const claim = deriveSharedCommonalityClaimText(
    "What do Jon and Gina both have in common?",
    [
      recallResult({
        memoryId: "jon-job",
        subjectName: "Jon",
        content: "He has been rebuilding lately.",
        sourceSentenceText: "Jon lost his job as a banker and decided to start his own dance studio."
      }),
      recallResult({
        memoryId: "gina-job",
        subjectName: "Gina",
        content: "She has been rebuilding lately too.",
        sourceSentenceText: "Gina lost her job at Door Dash and opened an online clothing store."
      })
    ]
  );

  assert.equal(
    claim,
    "The best supported overlap is that they both lost their jobs and decided to start their own businesses."
  );
});

test("shared commonality reducer binds profile-summary person_name back to the participant", () => {
  const claim = deriveSharedCommonalityClaimText(
    "What do Jon and Gina both have in common?",
    [
      recallResult({
        memoryId: "jon-summary",
        memoryType: "semantic_memory",
        subjectName: "",
        content: "The best supported reason is that he lost his job and decided to turn his passion into a business he could share with others.",
        sourceSentenceText: "",
        provenance: {
          metadata: {
            person_name: "Jon"
          }
        }
      }),
      recallResult({
        memoryId: "jon-business",
        subjectName: "Jon",
        content: "Jon followed through on the dream.",
        sourceSentenceText: "Jon lost his job and finally started his own dance studio."
      }),
      recallResult({
        memoryId: "gina-job",
        subjectName: "Gina",
        content: "She has been rebuilding lately too.",
        sourceSentenceText: "Gina lost her job at Door Dash and opened an online clothing store."
      })
    ]
  );

  assert.equal(
    claim,
    "The best supported overlap is that they both lost their jobs and decided to start their own businesses."
  );
});

test("shared commonality reducer recognizes gerund job-loss phrasing in participant evidence", () => {
  const claim = deriveSharedCommonalityClaimText(
    "What do Jon and Gina both have in common?",
    [
      recallResult({
        memoryId: "jon-business",
        subjectName: "Jon",
        content: "Jon: Losing my job gave me the push to finally start my dream business: my own dance studio!",
        sourceSentenceText: ""
      }),
      recallResult({
        memoryId: "gina-business",
        subjectName: "Gina",
        content: "Gina: Thanks, Jon! After losing my job, I wanted to take control of my own destiny and this seemed like the perfect way to do it. My online clothing store has been rewarding.",
        sourceSentenceText: ""
      })
    ]
  );

  assert.equal(
    claim,
    "The best supported overlap is that they both lost their jobs and decided to start their own businesses."
  );
});

test("shared commonality recursive subqueries stay participant-balanced before truncation", () => {
  const subqueries = buildRecursiveReflectSubqueries(
    "What do Jon and Gina both have in common?",
    ["Jon", "Gina"],
    {
      globalQuestionFocus: false,
      reflectiveRoutingFocus: false,
      profileInferenceFocus: false,
      identityProfileFocus: false,
      sharedCommonalityFocus: true,
      causalDecisionFocus: false,
      exactDetailFocus: false
    }
  );

  assert.deepEqual(subqueries, [
    "did Jon lose a job?",
    "did Gina lose a job?",
    "did Jon start a business?",
    "did Gina start a business?",
    "what kind of business did Jon start?",
    "what kind of business did Gina start?"
  ]);
});

test("capitalized subject extractors strip leading modal verbs from explicit-name profile queries", () => {
  const subqueries = buildRecursiveReflectSubqueries(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    extractSubjectHintsFromQuery("Would Caroline likely have Dr. Seuss books on her bookshelf?"),
    {
      globalQuestionFocus: false,
      reflectiveRoutingFocus: false,
      profileInferenceFocus: true,
      identityProfileFocus: false,
      sharedCommonalityFocus: false,
      causalDecisionFocus: false,
      exactDetailFocus: false
    }
  );

  assert.deepEqual(
    extractConversationParticipants("Would Caroline likely have Dr. Seuss books on her bookshelf?"),
    ["Caroline", "Dr", "Seuss"]
  );
  assert.deepEqual(
    extractSubjectHintsFromQuery("Would Caroline likely have Dr. Seuss books on her bookshelf?"),
    ["Caroline", "Dr. Seuss"]
  );
  assert.deepEqual(
    extractSubjectHintsFromQuery("In which month's game did John achieve a career-high score in points?"),
    ["John"]
  );
  assert.ok(subqueries.every((query) => !/\bWould Caroline\b/.test(query)));
  assert.ok(subqueries.some((query) => /bookshelf/i.test(query)));
  assert.ok(subqueries.some((query) => /books does Caroline collect/i.test(query)));
});

test("planner targeted backfill stays collection-specific for bookshelf inference queries", () => {
  const subqueries = buildPlannerTargetedBackfillSubqueries(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    {
      family: "report",
      subjectNames: ["Caroline"],
      candidatePools: ["canonical_reports", "collection_support", "report_support", "snippet_results"],
      suppressionPools: ["career_support", "health_support", "exact_detail_support"],
      targetedFields: [],
      requiredFields: ["profile_support", "collection_support"],
      targetedBackfill: ["collection_support"],
      queryExpansionTerms: ["Caroline", "bookshelf", "dr seuss", "books"],
      bannedExpansionTerms: ["career", "counseling"],
      ownerEligibilityHints: ["canonical_report"],
      suppressionHints: ["canonical_exact_detail"],
      reason: "collection inference"
    },
    ["Caroline", "Dr. Seuss"]
  );

  assert.deepEqual(subqueries, [
    "what is on Caroline's bookshelf?",
    "what children's books does Caroline have?"
  ]);
});

test("planner targeted backfill keeps generic collection queries out of bookshelf rescue prompts", () => {
  const subqueries = buildPlannerTargetedBackfillSubqueries(
    "What items does John collect?",
    {
      family: "report",
      subjectNames: ["John"],
      candidatePools: ["canonical_reports", "collection_support", "report_support", "snippet_results"],
      suppressionPools: ["career_support", "health_support", "exact_detail_support"],
      targetedFields: [],
      requiredFields: ["profile_support", "collection_support", "collection_entries"],
      targetedBackfill: ["collection_entries"],
      queryExpansionTerms: ["John", "collect", "items", "memorabilia"],
      bannedExpansionTerms: ["career", "counseling"],
      ownerEligibilityHints: ["canonical_report"],
      suppressionHints: ["canonical_exact_detail"],
      reason: "collection inference"
    },
    ["John"]
  );

  assert.deepEqual(subqueries, [
    "what else does John collect?",
    "what items are in John's collection?"
  ]);
});

test("planner targeted backfill asks for event-list completeness instead of generic profile prompts", () => {
  const subqueries = buildPlannerTargetedBackfillSubqueries(
    "What events has Caroline participated in to help children?",
    {
      family: "list_set",
      subjectNames: ["Caroline"],
      candidatePools: ["canonical_sets", "normalized_event_facts", "event_list_support", "set_entries", "snippet_results"],
      suppressionPools: ["exact_detail_support"],
      targetedFields: [],
      requiredFields: ["event_list_entries"],
      targetedBackfill: ["event_list_entries"],
      queryExpansionTerms: ["Caroline", "events", "children"],
      bannedExpansionTerms: [],
      ownerEligibilityHints: ["canonical_list_set"],
      suppressionHints: ["canonical_exact_detail"],
      reason: "event list completeness"
    },
    ["Caroline"]
  );

  assert.deepEqual(subqueries, [
    "what events did Caroline participate in to help children?",
    "what school or charity events did Caroline do for children?"
  ]);
});

test("planner targeted backfill asks for career evidence instead of generic profile prompts", () => {
  const subqueries = buildPlannerTargetedBackfillSubqueries(
    "Would Caroline pursue writing as a career option?",
    {
      family: "report",
      subjectNames: ["Caroline"],
      candidatePools: ["canonical_reports", "career_support", "report_support", "snippet_results"],
      suppressionPools: ["exact_detail_support"],
      targetedFields: [],
      requiredFields: ["career_support"],
      targetedBackfill: ["career_support"],
      queryExpansionTerms: ["Caroline", "writing", "career", "counseling"],
      bannedExpansionTerms: [],
      ownerEligibilityHints: ["canonical_report"],
      suppressionHints: ["canonical_exact_detail"],
      reason: "career report completeness"
    },
    ["Caroline"]
  );

  assert.deepEqual(subqueries, [
    "what kind of work does Caroline want to do?",
    "does Caroline want to be a counselor?"
  ]);
});

test("planner targeted backfill asks for bookshelf evidence before abstaining collection rows", () => {
  const subqueries = buildPlannerTargetedBackfillSubqueries(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    {
      family: "report",
      subjectNames: ["Caroline"],
      candidatePools: ["canonical_reports", "collection_support", "report_support", "snippet_results"],
      suppressionPools: ["career_support", "health_support", "exact_detail_support"],
      targetedFields: [],
      requiredFields: ["collection_support"],
      targetedBackfill: ["collection_support"],
      queryExpansionTerms: ["Caroline", "bookshelf", "dr seuss"],
      bannedExpansionTerms: ["career", "counseling"],
      ownerEligibilityHints: ["canonical_report"],
      suppressionHints: ["canonical_exact_detail"],
      reason: "collection support completeness"
    },
    ["Caroline"]
  );

  assert.deepEqual(subqueries, [
    "what is on Caroline's bookshelf?",
    "what children's books does Caroline have?"
  ]);
});

test("planner abstention rescue pivots to remaining collection probes for bookshelf inference queries", () => {
  const subqueries = buildPlannerTargetedBackfillSubqueries(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    {
      family: "report",
      subjectNames: ["Caroline"],
      candidatePools: ["canonical_reports", "collection_support", "report_support", "snippet_results"],
      suppressionPools: ["career_support", "health_support", "exact_detail_support"],
      targetedFields: [],
      requiredFields: ["collection_support"],
      targetedBackfill: ["collection_support"],
      queryExpansionTerms: ["Caroline", "bookshelf", "dr seuss"],
      bannedExpansionTerms: ["career", "counseling"],
      ownerEligibilityHints: ["canonical_report"],
      suppressionHints: ["canonical_exact_detail"],
      reason: "collection support completeness"
    },
    ["Caroline"],
    "abstention_rescue"
  );

  assert.deepEqual(subqueries, [
    "what books does Caroline collect?",
    "what books does Caroline read to children?"
  ]);
});

test("planner targeted backfill asks for explicit preference evidence for park-vs-theme-park queries", () => {
  const subqueries = buildPlannerTargetedBackfillSubqueries(
    "Would Melanie be more interested in going to a national park or a theme park?",
    {
      family: "report",
      subjectNames: ["Melanie"],
      candidatePools: ["canonical_reports", "preference_support", "report_support", "snippet_results"],
      suppressionPools: ["exact_detail_support"],
      targetedFields: [],
      requiredFields: ["preference_support"],
      targetedBackfill: ["preference_support"],
      queryExpansionTerms: ["Melanie", "national park", "theme park"],
      bannedExpansionTerms: [],
      ownerEligibilityHints: ["canonical_report"],
      suppressionHints: ["canonical_exact_detail"],
      reason: "preference support completeness"
    },
    ["Melanie"]
  );

  assert.deepEqual(subqueries, [
    "does Melanie prefer national parks or theme parks?",
    "what does Melanie say about national parks or theme parks?"
  ]);
});

test("planner-targeted backfill queries suppress nested recursive reflect", () => {
  assert.equal(
    shouldSuppressRecursiveReflectForGeneratedQuery("what is on Caroline's bookshelf?", 1),
    true
  );
  assert.equal(
    shouldSuppressRecursiveReflectForGeneratedQuery("what children's books does Caroline have?", 1),
    true
  );
  assert.equal(
    shouldSuppressRecursiveReflectForGeneratedQuery("does Melanie prefer national parks or theme parks?", 1),
    true
  );
  assert.equal(
    shouldSuppressRecursiveReflectForGeneratedQuery("what school or charity events did Caroline do for children?", 1),
    true
  );
});

test("shared commonality duality prefers reduced overlap claim over generic top snippet", () => {
  const results = [
    recallResult({
      memoryId: "jon-summary",
      memoryType: "semantic_memory",
      subjectName: "",
      content: "The best supported reason is that he lost his job and decided to turn his passion into a business he could share with others.",
      sourceSentenceText: "",
      provenance: {
        metadata: {
          person_name: "Jon"
        }
      }
    }),
    recallResult({
      memoryId: "gina-start",
      memoryType: "artifact_derivation",
      subjectName: "",
      content: "Topic segment about dance and store. Jon told Gina about his studio. Gina said she started her own online clothing store.",
      sourceSentenceText: "",
      provenance: {
        metadata: {
          participant_names: ["Jon", "Gina"]
        }
      }
    }),
    recallResult({
      memoryId: "gina-job",
      subjectName: "Gina",
      content: "Gina: Thanks, Jon! After losing my job, I wanted to take control of my own destiny.",
      sourceSentenceText: "Gina lost her job at Door Dash and opened an online clothing store."
    }),
    recallResult({
      memoryId: "jon-start",
      subjectName: "Jon",
      content: "Jon: Losing my job gave me the push to finally start my dream business: my own dance studio!",
      sourceSentenceText: "Jon lost his job and finally started his own dance studio."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["jon", "gina"],
      totalTerms: 2,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["jon", "gina"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What do Jon and Gina both have in common?"
  );

  assert.equal(
    duality.claim.text,
    "The best supported overlap is that they both lost their jobs and decided to start their own businesses."
  );
});

test("media summary reducer ignores ambiguous kinship aliases and recovers canonical dusk title from source text", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "media-summary-"));
  const sourcePath = path.join(tempDir, "movies.md");
  writeFileSync(
    sourcePath,
    [
      "They mention a movie called Sinners.",
      "It reminded me of the movie, Dusk Till Dawn.",
      "And then I've been watching TV show, Slow Horses."
    ].join("\n"),
    "utf8"
  );

  const claim = deriveMediaSummaryClaimText("What movies have I talked about?", [
    {
      memoryId: "uncle-noise",
      memoryType: "procedural_memory",
      content: "Someone mentioned the unknown Uncle. Context: Mom mentioned Uncle again but never said which uncle she meant.",
      score: 1,
      artifactId: null,
      occurredAt: null,
      namespaceId: "ns_supported_claim",
      provenance: {
        media_title: "Uncle",
        media_kind: "unknown",
        source_uri: sourcePath
      }
    },
    {
      memoryId: "sinners",
      memoryType: "procedural_memory",
      content: "Dan mentioned the movie Sinners.",
      score: 1,
      artifactId: null,
      occurredAt: null,
      namespaceId: "ns_supported_claim",
      provenance: {
        media_title: "Sinners",
        media_kind: "movie",
        source_uri: sourcePath
      }
    },
    {
      memoryId: "slow-horses",
      memoryType: "procedural_memory",
      content: "Someone watched the show Slow Horses.",
      score: 1,
      artifactId: null,
      occurredAt: null,
      namespaceId: "ns_supported_claim",
      provenance: {
        media_title: "Slow Horses",
        media_kind: "show",
        source_uri: sourcePath
      }
    }
  ]);

  assert.ok(claim);
  assert.match(claim, /From Dusk Till Dawn/);
  assert.doesNotMatch(claim, /\bUncle\b/);
});

test("subject-bound exact detail reducer extracts non-basketball goals as a bounded list", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What are John's goals for his career that are not related to his basketball skills?",
    [
      recallResult({
        memoryId: "john-basketball",
        subjectName: "John",
        content: "John: I want to improve my shooting percentage and win a championship.",
        sourceSentenceText: ""
      }),
      recallResult({
        memoryId: "john-brand",
        subjectName: "John",
        content: "John: I also want to get endorsements, build my brand, and do charity work.",
        sourceSentenceText: ""
      })
    ],
    true
  ).candidate?.text;

  assert.match(claim ?? "", /endorsements/i);
  assert.match(claim ?? "", /brand/i);
  assert.match(claim ?? "", /charity/i);
  assert.doesNotMatch(claim ?? "", /championship/i);
});

test("subject-bound exact detail reducer extracts bought-item lists from a single statement", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What items did Calvin buy in March 2023?",
    [
      recallResult({
        memoryId: "calvin-buy",
        subjectName: "Calvin",
        content: "Calvin bought a mansion in Japan and a Ferrari 488 GTB in March 2023.",
        sourceSentenceText: ""
      })
    ],
    true
  ).candidate?.text;

  assert.match(claim ?? "", /mansion in Japan/i);
  assert.match(claim ?? "", /Ferrari 488 GTB/i);
});

test("subject-bound exact detail reducer extracts listened-to bands as a bounded list", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Which bands has Dave enjoyed listening to?",
    [
      recallResult({
        memoryId: "dave-bands",
        subjectName: "Dave",
        content: "Dave: I've enjoyed listening to Aerosmith and The Fireworks lately.",
        sourceSentenceText: ""
      })
    ],
    true
  ).candidate?.text;

  assert.match(claim ?? "", /Aerosmith/i);
  assert.match(claim ?? "", /The Fireworks/i);
});

test("subject-bound exact detail reducer answers dated team queries from subject-bound support", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Which team did John sign with on 21 May, 2023?",
    [
      recallResult({
        memoryId: "john-team",
        subjectName: "John",
        content: "John signed with the Minnesota Wolves for the upcoming season as a shooting guard.",
        sourceSentenceText: "John signed with the Minnesota Wolves for the upcoming season as a shooting guard."
      }),
      recallResult({
        memoryId: "tim-no-team",
        subjectName: "Tim",
        content: "Tim asked John about the new team.",
        sourceSentenceText: "Tim asked John about the new team."
      })
    ],
    true
  ).candidate?.text;

  assert.match(claim ?? "", /Minnesota Wolves/i);
});

test("subject-bound exact detail reducer extracts team from adjacent question-answer turns", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Which team did John sign with on 21 May, 2023?",
    [
      recallResult({
        memoryId: "john-team-qa",
        subjectName: "John",
        content: "Tim: Which team did you sign with? John: The Minnesota Wolves! I can't wait to play with them!",
        sourceSentenceText: "John: The Minnesota Wolves! I can't wait to play with them!"
      })
    ],
    true
  ).candidate?.text;

  assert.match(claim ?? "", /Minnesota Wolves/i);
});

test("subject-bound exact detail reducer abstains when John has no subject-bound adoption evidence", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did John adopt in April 2022?",
    [
      recallResult({
        memoryId: "john-no-adopt",
        subjectName: "John",
        content: "John: Sounds intense but cool. I like games that test my strategizing.",
        sourceSentenceText: "John: Sounds intense but cool."
      })
    ],
    true
  ).candidate?.text;

  assert.equal(claim, "None.");
});

test("subject-bound exact detail reducer abstains for kitten-name queries when the adoption was a pup", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What is the name of the kitten that was adopted by James?",
    [
      recallResult({
        memoryId: "james-pup",
        subjectName: "James",
        content: "James: I adopted a pup from a shelter in Stamford last week and I named it Ned.",
        sourceSentenceText: "James: I adopted a pup from a shelter in Stamford last week and I named it Ned."
      })
    ],
    true
  ).candidate?.text;

  assert.equal(claim, "None.");
});

test("subject-bound exact detail reducer extracts snake names from owner-bound statements", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What are the names of Jolene's snakes?",
    [
      recallResult({
        memoryId: "jolene-susie",
        subjectName: "Jolene",
        content: "Jolene: I want to show you one of my snakes! They always calm me down and make me happy. This is Susie.",
        sourceSentenceText: "This is Susie."
      }),
      recallResult({
        memoryId: "jolene-seraphim",
        subjectName: "Jolene",
        content: "Jolene: My second snake Seraphim did it. Look at her sly eyes!",
        sourceSentenceText: "My second snake Seraphim did it."
      })
    ],
    true
  ).candidate?.text;

  assert.match(claim ?? "", /Susie/i);
  assert.match(claim ?? "", /Seraphim/i);
});

test("subject-bound exact detail reducer accepts reduced meal-companion answers from reader backfill", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "Who did Maria have dinner with on May 3, 2023?",
    [
      recallResult({
        memoryId: "maria-dinner-context",
        subjectName: "Maria",
        content: "Maria spent the evening catching up after dinner.",
        sourceSentenceText: "Maria spent the evening catching up after dinner."
      })
    ],
    true,
    ["her mother"]
  ).candidate?.text;

  assert.equal(claim, "her mother");
});

test("subject-bound exact detail reducer rejects contaminated raw fragments for research-topic queries", () => {
  const claim = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What did Caroline research?",
    [
      recallResult({
        memoryId: "caroline-fragment",
        subjectName: "Caroline",
        content: "Caroline: I want to find a home for these kids someday.",
        sourceSentenceText: "home for these kids"
      })
    ],
    true
  ).candidate?.text;

  assert.equal(claim ?? null, null);
});

test("duality abstains for Deborah snake-name queries when only another subject owns the snakes", () => {
  const results = [
    recallResult({
      memoryId: "deborah-generic",
      subjectName: "Deborah",
      content: "Deborah: Snakes are interesting, but I've mostly been focused on family stuff lately.",
      sourceSentenceText: "Deborah: Snakes are interesting, but I've mostly been focused on family stuff lately."
    }),
    recallResult({
      memoryId: "jolene-susie",
      subjectName: "Jolene",
      content: "Jolene: I want to show you one of my snakes! This is Susie.",
      sourceSentenceText: "This is Susie."
    }),
    recallResult({
      memoryId: "jolene-seraphim",
      subjectName: "Jolene",
      content: "Jolene: My second snake Seraphim did it.",
      sourceSentenceText: "My second snake Seraphim did it."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["deborah", "snakes"],
      totalTerms: 2,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["deborah"],
      missingParticipants: [],
      foreignParticipants: ["jolene"]
    },
    "ns_supported_claim",
    "What are the names of Deborah's snakes?"
  );

  assert.equal(duality.claim.text, "None.");
});

test("duality abstains for kitten-name queries when the owner only adopted a pup", () => {
  const results = [
    recallResult({
      memoryId: "james-pup",
      subjectName: "James",
      content: "James: I adopted a pup from a shelter in Stamford last week and I named it Ned.",
      sourceSentenceText: "James: I adopted a pup from a shelter in Stamford last week and I named it Ned."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["james", "kitten", "adopted"],
      totalTerms: 3,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["james"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What is the name of the kitten that was adopted by James?"
  );

  assert.equal(duality.claim.text, "None.");
});

test("duality prefers counterfactual support-dependency claim over direct career snippet fallback", () => {
  const results = [
    recallResult({
      memoryId: "caroline-career",
      subjectName: "Caroline",
      content: "Caroline: I'm thinking about psychology and getting a counseling certification so I can help people.",
      sourceSentenceText: "I'm thinking about psychology and getting a counseling certification so I can help people."
    }),
    recallResult({
      memoryId: "caroline-support",
      subjectName: "Caroline",
      content: "Caroline: The support I got from friends and mentors made a huge difference and gave me courage to embrace myself. I saw how counseling and support groups improved my life, and now I want to help people go through it too.",
      sourceSentenceText: "The support I got from friends and mentors made a huge difference and gave me courage to embrace myself."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["caroline", "support", "counseling"],
      totalTerms: 3,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?"
  );

  assert.equal(duality.claim.text, "Likely no.");
});

test("ideal dance studio reducer combines water, light, and Marley flooring from bounded support", () => {
  const claim = deriveIdealDanceStudioClaimText(
    "What Jon thinks the ideal dance studio should look like?",
    [
      recallResult({
        memoryId: "jon-water",
        subjectName: "Jon",
        content: "Jon: Check my ideal dance studio by the water.",
        sourceSentenceText: "Jon: Check my ideal dance studio by the water."
      }),
      recallResult({
        memoryId: "jon-light",
        subjectName: "Jon",
        content: "Jon: I even found a place with great natural light!",
        sourceSentenceText: "Jon: I even found a place with great natural light!"
      }),
      recallResult({
        memoryId: "jon-floor",
        subjectName: "Jon",
        content: "Jon: Yeah, good flooring's crucial. I'm after Marley flooring.",
        sourceSentenceText: "Jon: Yeah, good flooring's crucial. I'm after Marley flooring."
      })
    ]
  );

  assert.equal(claim, "by the water, natural light, Marley flooring");
});

test("duality infers country answers from city meetup support in structured family lane", () => {
  const results = [
    recallResult({
      memoryId: "calvin-boston",
      subjectName: "Calvin",
      content: "Calvin: I'm looking forward to my upcoming trip to Boston after I finish the Frank Ocean tour.",
      sourceSentenceText: "I'm looking forward to my upcoming trip to Boston after I finish the Frank Ocean tour."
    }),
    recallResult({
      memoryId: "dave-meetup",
      subjectName: "Dave",
      content: "Dave: Let's meet up when you're here in Boston.",
      sourceSentenceText: "Let's meet up when you're here in Boston."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["calvin", "dave", "boston"],
      totalTerms: 3,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["calvin", "dave"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Which country do Calvin and Dave want to meet in?"
  );

  assert.equal(duality.claim.text, "United States");
});

test("duality aggregates festival favorite and headliner bands for music disambiguation", () => {
  const results = [
    recallResult({
      memoryId: "dave-favorite",
      subjectName: "Dave",
      content: "Dave: If I had to pick a favorite, it would definitely be Aerosmith.",
      sourceSentenceText: "If I had to pick a favorite, it would definitely be Aerosmith."
    }),
    recallResult({
      memoryId: "dave-headliner",
      subjectName: "Dave",
      content: "Dave: The Fireworks headlined the festival.",
      sourceSentenceText: "The Fireworks headlined the festival."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["dave", "bands"],
      totalTerms: 2,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["dave"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Which bands has Dave enjoyed listening to?"
  );

  assert.match(duality.claim.text ?? "", /Aerosmith/i);
  assert.match(duality.claim.text ?? "", /The Fireworks/i);
});

test("duality surfaces strong exact-detail reducers even when assessment confidence is missing", () => {
  const results = [
    recallResult({
      memoryId: "joanna-hobbies",
      subjectName: "Joanna",
      content: "Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature.",
      sourceSentenceText: "Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));
  const exactDetailCandidate = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What are Joanna's hobbies?",
    results,
    true
  ).candidate;

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "missing",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "missing",
      subjectMatch: "matched",
      matchedParticipants: ["joanna"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What are Joanna's hobbies?",
    exactDetailCandidate
  );

  assert.match(duality.claim.text ?? "", /writing/i);
  assert.match(duality.claim.text ?? "", /watching movies/i);
});

test("hobby reducer prefers declarative hobby cluster over incidental creative-outlet chatter", () => {
  const claim = deriveHobbyClaimText(
    "What are Joanna's hobbies?",
    [
      recallResult({
        memoryId: "joanna-standalone",
        subjectName: "Joanna",
        content: "Joanna: Writing and hanging with friends!",
        sourceSentenceText: "Joanna: Writing and hanging with friends!"
      }),
      recallResult({
        memoryId: "joanna-declarative",
        subjectName: "Joanna",
        content: "Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature.",
        sourceSentenceText: "Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature."
      }),
      recallResult({
        memoryId: "joanna-incidental",
        subjectName: "Joanna",
        content: "Joanna: Cooking and baking are my creative outlets these days.",
        sourceSentenceText: "Joanna: Cooking and baking are my creative outlets these days."
      })
    ]
  );

  assert.match(claim ?? "", /writing/i);
  assert.match(claim ?? "", /hanging with friends/i);
  assert.match(claim ?? "", /watching movies/i);
  assert.match(claim ?? "", /exploring nature/i);
  assert.doesNotMatch(claim ?? "", /cooking/i);
  assert.doesNotMatch(claim ?? "", /baking/i);
});

test("hobby reducer drops conversational tail chatter from contaminated list snippets", () => {
  const claim = deriveHobbyClaimText(
    "What are Joanna's hobbies?",
    [
      recallResult({
        memoryId: "joanna-contaminated",
        subjectName: "Joanna",
        content: "Joanna: I love writing, watching movies, and exploring nature. Nate! Sounds like a fun experience.",
        sourceSentenceText:
          "Joanna: I love writing, watching movies, and exploring nature. Nate! Sounds like a fun experience."
      }),
      recallResult({
        memoryId: "joanna-friends",
        subjectName: "Joanna",
        content: "Joanna: Writing and hanging with friends!",
        sourceSentenceText: "Joanna: Writing and hanging with friends!"
      })
    ]
  );

  assert.match(claim ?? "", /writing/i);
  assert.match(claim ?? "", /watching movies/i);
  assert.match(claim ?? "", /exploring nature/i);
  assert.match(claim ?? "", /hanging with friends/i);
  assert.doesNotMatch(claim ?? "", /Nate/i);
  assert.doesNotMatch(claim ?? "", /fun experience/i);
});

test("hobby reducer extracts the final speaker answer from prompt-plus-answer hobby rows", () => {
  const claim = deriveHobbyClaimText(
    "What are Joanna's hobbies?",
    [
      recallResult({
        memoryId: "joanna-besides",
        subjectName: "Joanna",
        content: "Joanna: Yeah! Besides writing, I also enjoy reading, watching movies, and exploring nature.",
        sourceSentenceText:
          "Joanna: Yeah! Besides writing, I also enjoy reading, watching movies, and exploring nature."
      }),
      recallResult({
        memoryId: "joanna-prompt-answer",
        content: "What else brings you joy? Joanna: Writing and hanging with friends!",
        sourceSentenceText: "What else brings you joy? Joanna: Writing and hanging with friends!"
      })
    ]
  );

  assert.match(claim ?? "", /writing/i);
  assert.match(claim ?? "", /watching movies/i);
  assert.match(claim ?? "", /exploring nature/i);
  assert.match(claim ?? "", /hanging with friends/i);
  assert.doesNotMatch(claim ?? "", /reading/i);
});

test("safe-pet reducer ignores unrelated pet nostalgia once allergy constraints are present", () => {
  const claim = derivePetSafetyClaimText(
    "What pets wouldn't cause any discomfort to Joanna?",
    [
      recallResult({
        memoryId: "joanna-noise",
        subjectName: "Joanna",
        content: "Joanna: I still have that stuffed animal dog you gave me!",
        sourceSentenceText: "Joanna: I still have that stuffed animal dog you gave me!"
      }),
      recallResult({
        memoryId: "joanna-fur",
        subjectName: "Joanna",
        content: "Joanna: Animals with fur are one of the main causes of my allergy.",
        sourceSentenceText: "Joanna: Animals with fur are one of the main causes of my allergy."
      }),
      recallResult({
        memoryId: "joanna-reptiles",
        subjectName: "Joanna",
        content: "Joanna: I'm allergic to most reptiles too.",
        sourceSentenceText: "Joanna: I'm allergic to most reptiles too."
      })
    ]
  );

  assert.equal(
    claim,
    "hairless cats or pigs, since they don't have fur, which is one of the main causes of Joanna's allergy."
  );
});

test("duality keeps realization queries abstained when only non-target realization chatter exists", () => {
  const results = [
    recallResult({
      memoryId: "caroline-anchor",
      subjectName: "Caroline",
      content: "Caroline: It was nice hearing everyone cheer me on after the charity race.",
      sourceSentenceText: "Caroline: It was nice hearing everyone cheer me on after the charity race."
    }),
    recallResult({
      memoryId: "melanie-realization",
      subjectName: "Melanie",
      content: "Melanie: I'm starting to realize that self-care is really important.",
      sourceSentenceText: "Melanie: I'm starting to realize that self-care is really important."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["caroline", "charity", "race"],
      totalTerms: 3,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: ["melanie"]
    },
    "ns_supported_claim",
    "What did Caroline realize after her charity race?"
  );

  assert.equal(duality.claim.text, "None.");
});

test("duality surfaces strong temporal reducers even when assessment confidence is missing", () => {
  const results = [
    recallResult({
      memoryId: "joanna-first-watch",
      memoryType: "procedural_memory",
      subjectName: "Joanna",
      content:
        "Joanna watched Eternal Sunshine of the Spotless Mind. Time hint: around 3 years ago. Normalized year: 2019. Context: I first watched it around 3 years ago.",
      sourceSentenceText: "I first watched it around 3 years ago.",
      occurredAt: "2022-01-21T19:31:00.000Z",
      provenance: {
        typed_fact_kind: "temporal_media_anchor",
        subject_name: "Joanna",
        media_title: "Eternal Sunshine of the Spotless Mind",
        mention_kind: "watched",
        time_hint_text: "around 3 years ago",
        normalized_year: "2019",
        event_anchor_start: "2022-01-21T19:31:00.000Z",
        event_anchor_end: "2022-01-21T19:31:00.000Z"
      }
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "missing",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "missing",
      subjectMatch: "matched",
      matchedParticipants: ["joanna"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    'When did Joanna first watch "Eternal Sunshine of the Spotless Mind?'
  );

  assert.equal(duality.claim.text, "The best supported year is 2019.");
});

test("duality surfaces hobby reducers from source-backed evidence even when confidence is missing", () => {
  const sourcePath = path.join(mkdtempSync(path.join(tmpdir(), "hobby-source-")), "conv.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2022-01-21T19:31:00.000Z",
      "",
      "Joanna: Yeah! Besides writing, I also enjoy reading, watching movies, and exploring nature.",
      "Joanna: Writing and hanging with friends!"
    ].join("\n"),
    "utf8"
  );

  const results = [
    recallResult({
      memoryId: "joanna-hobby-top",
      subjectName: "Joanna",
      content: "None.",
      sourceSentenceText: "",
      provenance: {
        source_uri: sourcePath
      }
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "missing",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "missing",
      subjectMatch: "matched",
      matchedParticipants: ["joanna"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What are Joanna's hobbies?"
  );

  assert.match(duality.claim.text ?? "", /writing/i);
  assert.match(duality.claim.text ?? "", /watching movies/i);
  assert.match(duality.claim.text ?? "", /exploring nature/i);
});

test("duality prefers the richer hobby candidate when the direct hobby reducer is only partial", () => {
  const results = [
    recallResult({
      memoryId: "joanna-hobby-partial",
      subjectName: "Joanna",
      content: "Joanna: Besides writing, I also enjoy watching movies and exploring nature.",
      sourceSentenceText: "Joanna: Besides writing, I also enjoy watching movies and exploring nature."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "missing",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "missing",
      subjectMatch: "matched",
      matchedParticipants: ["joanna"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What are Joanna's hobbies?",
    {
      text: "writing, watching movies, exploring nature, hanging with friends",
      source: "episodic_leaf",
      strongSupport: true
    }
  );

  assert.match(duality.claim.text ?? "", /hanging with friends/i);
});

test("duality prefers explicit hobby declarations over incidental creative-outlet snippets", () => {
  const results = [
    recallResult({
      memoryId: "joanna-hobby-explicit",
      subjectName: "Joanna",
      content: "Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature.",
      sourceSentenceText: "Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature."
    }),
    recallResult({
      memoryId: "joanna-hobby-social",
      subjectName: "Joanna",
      content: "Joanna: Writing and hanging with friends!",
      sourceSentenceText: "Joanna: Writing and hanging with friends!"
    }),
    recallResult({
      memoryId: "joanna-hobby-incidental",
      subjectName: "Joanna",
      content: "Joanna: Cooking and baking are my creative outlets.",
      sourceSentenceText: "Joanna: Cooking and baking are my creative outlets."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const exactDetailCandidate = deriveSubjectBoundExactDetailClaimWithTelemetry(
    "What are Joanna's hobbies?",
    results,
    true
  ).candidate;

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "missing",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "missing",
      subjectMatch: "matched",
      matchedParticipants: ["joanna"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What are Joanna's hobbies?",
    exactDetailCandidate
  );

  assert.match(duality.claim.text ?? "", /watching movies/i);
  assert.match(duality.claim.text ?? "", /exploring nature/i);
  assert.match(duality.claim.text ?? "", /hanging with friends/i);
  assert.doesNotMatch(duality.claim.text ?? "", /cooking/i);
  assert.doesNotMatch(duality.claim.text ?? "", /baking/i);
});

test("duality treats standalone hobby declarations as explicit cluster evidence", () => {
  const results = [
    recallResult({
      memoryId: "joanna-hobby-explicit-list",
      subjectName: "Joanna",
      content: "Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature.",
      sourceSentenceText: "Joanna: Besides writing, I also enjoy reading, watching movies, and exploring nature."
    }),
    recallResult({
      memoryId: "joanna-hobby-standalone",
      subjectName: "Joanna",
      content: "Joanna: Writing and hanging with friends!",
      sourceSentenceText: "Joanna: Writing and hanging with friends!"
    }),
    recallResult({
      memoryId: "joanna-hobby-incidental-2",
      subjectName: "Joanna",
      content: "Joanna: Cooking and baking are my creative outlets.",
      sourceSentenceText: "Joanna: Cooking and baking are my creative outlets."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "missing",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "missing",
      subjectMatch: "matched",
      matchedParticipants: ["joanna"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What are Joanna's hobbies?"
  );

  assert.match(duality.claim.text ?? "", /writing/i);
  assert.match(duality.claim.text ?? "", /watching movies/i);
  assert.match(duality.claim.text ?? "", /exploring nature/i);
  assert.match(duality.claim.text ?? "", /hanging with friends/i);
  assert.doesNotMatch(duality.claim.text ?? "", /reading/i);
  assert.doesNotMatch(duality.claim.text ?? "", /cooking/i);
});

test("duality prefers participant-scoped hobby summaries over incidental creative-outlet rows", () => {
  const results = [
    recallResult({
      memoryId: "joanna-interest-summary",
      memoryType: "semantic_memory",
      subjectName: "",
      content: "Joanna's interests include writing, watching movies, exploring nature, and hanging with friends.",
      sourceSentenceText: "",
      provenance: {
        metadata: {
          person_name: "Joanna",
          profile_kind: "interest_pattern"
        }
      }
    }),
    recallResult({
      memoryId: "joanna-hobby-incidental",
      subjectName: "Joanna",
      content: "Joanna: Cooking and baking are my creative outlets.",
      sourceSentenceText: "Joanna: Cooking and baking are my creative outlets."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "weak",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["joanna", "hobbies"],
      totalTerms: 2,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["joanna"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What are Joanna's hobbies?"
  );

  assert.match(duality.claim.text ?? "", /watching movies/i);
  assert.match(duality.claim.text ?? "", /exploring nature/i);
  assert.match(duality.claim.text ?? "", /hanging with friends/i);
  assert.doesNotMatch(duality.claim.text ?? "", /cooking/i);
  assert.doesNotMatch(duality.claim.text ?? "", /baking/i);
});

test("duality prefers teammate canonicalization over outside-circle fallback for social exclusion", () => {
  const results = [
    recallResult({
      memoryId: "nate-outside-circle",
      subjectName: "Nate",
      content: "Nate: I started to hang out with some people outside of my circle at the tournament.",
      sourceSentenceText: "Nate: I started to hang out with some people outside of my circle at the tournament."
    }),
    recallResult({
      memoryId: "nate-team",
      subjectName: "Nate",
      content: "Nate: Me and my team had a blast, and some old friends and teammates from other tournaments came too.",
      sourceSentenceText: "Nate: Me and my team had a blast, and some old friends and teammates from other tournaments came too."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "missing",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "missing",
      subjectMatch: "matched",
      matchedParticipants: ["nate"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Is it likely that Nate has friends besides Joanna?"
  );

  assert.equal(duality.claim.text, "Yes, teammates on his video game team.");
});

test("duality hard-abstains realization queries when only a neighboring speaker has the realization", () => {
  const results = [
    recallResult({
      memoryId: "caroline-anchor",
      subjectName: "Caroline",
      content: "Caroline: That charity race sounds great, Mel!",
      sourceSentenceText: "Caroline: That charity race sounds great, Mel!"
    }),
    recallResult({
      memoryId: "melanie-realization",
      subjectName: "Melanie",
      content: "Melanie: I'm starting to realize that self-care is really important.",
      sourceSentenceText: "Melanie: I'm starting to realize that self-care is really important."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "confident",
      reason: "test",
      lexicalCoverage: 1,
      matchedTerms: ["caroline", "charity", "race", "realize"],
      totalTerms: 4,
      evidenceCount: evidence.length,
      directEvidence: true,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: ["melanie"]
    },
    "ns_supported_claim",
    "What did Caroline realize after her charity race?"
  );

  assert.equal(duality.claim.text, "None.");
});

test("duality prefers the richer ideal-dance-studio candidate when the direct reducer is missing a feature", () => {
  const results = [
    recallResult({
      memoryId: "jon-studio-partial",
      subjectName: "Jon",
      content: "Jon: I even found a place with great natural light and Marley flooring.",
      sourceSentenceText: "Jon: I even found a place with great natural light and Marley flooring."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "missing",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "missing",
      subjectMatch: "matched",
      matchedParticipants: ["jon"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What Jon thinks the ideal dance studio should look like?",
    {
      text: "by the water, natural light, Marley flooring",
      source: "episodic_leaf",
      strongSupport: true
    }
  );

  assert.equal(duality.claim.text, "by the water, natural light, Marley flooring");
});

test("duality surfaces allergy-safe pet reducers from source-backed evidence", () => {
  const sourcePath = path.join(mkdtempSync(path.join(tmpdir(), "pet-source-")), "conv.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2022-07-16T01:12:00.000Z",
      "",
      "Joanna: I wish I wasn't allergic! I would get two turtles today if I could!",
      "Joanna: I'm allergic to most reptiles and animals with fur."
    ].join("\n"),
    "utf8"
  );

  const results = [
    recallResult({
      memoryId: "joanna-pets-top",
      subjectName: "Joanna",
      content: "Joanna: I wish I wasn't allergic! I would get two turtles today if I could!",
      sourceSentenceText: "",
      provenance: {
        source_uri: sourcePath
      }
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "weak",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "weak",
      subjectMatch: "matched",
      matchedParticipants: ["joanna"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What pets wouldn't cause any discomfort to Joanna?"
  );

  assert.match(duality.claim.text ?? "", /hairless cats/i);
  assert.match(duality.claim.text ?? "", /pigs/i);
});

test("duality prefers goal-family reducers over generic snippets", () => {
  const results = [
    recallResult({
      memoryId: "john-goals",
      subjectName: "John",
      content:
        "John: My goal is to improve my shooting percentage and win a championship. Off the court, I want to get endorsements, build my brand, and do charity work.",
      sourceSentenceText: ""
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "weak",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["john"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What are John's goals for his career that are not related to his basketball skills?"
  );

  assert.equal(duality.claim.text, "get endorsements, build his brand, do charity work");
});

test("duality suppresses generic snippet fallback for exact bird detail with no subject-bound support", () => {
  const results = [
    recallResult({
      memoryId: "andrew-bird",
      subjectName: "Andrew",
      content: "Andrew: Eagles have always mesmerized me.",
      sourceSentenceText: "Andrew: Eagles have always mesmerized me."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "mixed",
      matchedParticipants: ["andrew"],
      missingParticipants: ["audrey"],
      foreignParticipants: ["andrew"]
    },
    "ns_supported_claim",
    "Which specific type of bird mesmerizes Audrey?"
  );

  assert.equal(duality.claim.text, "None.");
});

test("duality prefers bounded basketball goal family output over a richer snippet", () => {
  const results = [
    recallResult({
      memoryId: "john-bball-goals",
      subjectName: "John",
      content:
        "John: Definitely! I'm focusing on better shooting and making more of an impact on the court. I want to be known as a consistent performer and help my team. Off the court, I'm also looking into more endorsements and building my brand.",
      sourceSentenceText: "John: Definitely! I'm focusing on better shooting and making more of an impact on the court."
    }),
    recallResult({
      memoryId: "john-championship",
      subjectName: "John",
      content: "John: Winning a championship is my number one goal.",
      sourceSentenceText: "John: Winning a championship is my number one goal."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "weak",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["john"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "what are John's goals with regards to his basketball career?"
  );

  assert.equal(duality.claim.text, "improve shooting percentage, win a championship");
});

test("duality returns None for chef advice when no chef advice evidence exists", () => {
  const results = [
    recallResult({
      memoryId: "calvin-producer-advice",
      subjectName: "Calvin",
      content: "Calvin: The producer gave me some advice to stay true to myself and sound unique.",
      sourceSentenceText: "Calvin: The producer gave me some advice to stay true to myself and sound unique."
    }),
    recallResult({
      memoryId: "calvin-chef-poster",
      subjectName: "Calvin",
      content: "Calvin: Take a look at this cool Disney poster! [image: a photo of a poster for a disney movie with a chef]",
      sourceSentenceText: "Calvin: Take a look at this cool Disney poster!"
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "weak",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["calvin"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What advice did Calvin receive from the chef at the music festival?"
  );

  assert.equal(duality.claim.text, "None.");
});

test("duality allows adoption-year temporal reducers to override generic fallback", () => {
  const results = [
    recallResult({
      memoryId: "audrey-dogs",
      subjectName: "Audrey",
      content: "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda.",
      occurredAt: "2023-03-27T13:10:00.000Z",
      sourceSentenceText: "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["audrey"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Which year did Audrey adopt the first three of her dogs?"
  );

  assert.equal(duality.claim.text, "2020.");
});

test("duality aggregates open hiking space into the Andrew city-places family lane", () => {
  const results = [
    recallResult({
      memoryId: "andrew-cafe",
      subjectName: "Andrew",
      content: "Andrew: I checked out a new cafe yesterday.",
      sourceSentenceText: "Andrew: I checked out a new cafe yesterday."
    }),
    recallResult({
      memoryId: "andrew-eat",
      subjectName: "Andrew",
      content: "Andrew: We found some new places to eat around the city.",
      sourceSentenceText: "Andrew: We found some new places to eat around the city."
    }),
    recallResult({
      memoryId: "andrew-hike",
      subjectName: "Andrew",
      content: "Andrew: Fox Hollow is a great trail to hike on weekends; the views are awesome!",
      sourceSentenceText: "Andrew: Fox Hollow is a great trail to hike on weekends; the views are awesome!"
    }),
    recallResult({
      memoryId: "andrew-shelter",
      subjectName: "Andrew",
      content: "Andrew: My girlfriend and I volunteered at a pet shelter on Monday.",
      sourceSentenceText: "Andrew: My girlfriend and I volunteered at a pet shelter on Monday."
    }),
    recallResult({
      memoryId: "andrew-wine",
      subjectName: "Andrew",
      content: "Andrew: My girlfriend and I went to a wine tasting last weekend.",
      sourceSentenceText: "Andrew: My girlfriend and I went to a wine tasting last weekend."
    }),
    recallResult({
      memoryId: "andrew-park",
      subjectName: "Andrew",
      content: "Andrew: We also checked out a park nearby.",
      sourceSentenceText: "Andrew: We also checked out a park nearby."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["andrew"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What kind of places have Andrew and his girlfriend checked out around the city?"
  );

  assert.match(duality.claim.text, /open space for hikes/);
});

test("duality lets a strong generic exact-detail candidate beat top snippet fallback", () => {
  const results = [
    recallResult({
      memoryId: "maria-noisy-top",
      subjectName: "Maria",
      content: "Maria: Wow John, that's intense! Helping out like that takes guts.",
      sourceSentenceText: "Maria: Wow John, that's intense! Helping out like that takes guts."
    }),
    recallResult({
      memoryId: "maria-class-detail",
      subjectName: "Maria",
      content: "Maria has taken fiction workshops and poetry classes.",
      sourceSentenceText: "Maria has taken fiction workshops and poetry classes."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["maria"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What writing classes has Maria taken?",
    {
      text: "The best supported writing classes are fiction workshops and poetry classes.",
      source: "artifact_source",
      strongSupport: true
    }
  );

  assert.equal(duality.claim.text, "The best supported writing classes are fiction workshops and poetry classes.");
});

test("duality promotes generic direct-fact activity aggregation over noisy top snippets", () => {
  const results = [
    recallResult({
      memoryId: "mel-noise",
      subjectName: "Melanie",
      content: "Melanie: Thanks Caroline, that means a lot.",
      sourceSentenceText: "Melanie: Thanks Caroline, that means a lot."
    }),
    recallResult({
      memoryId: "mel-activities",
      subjectName: "Melanie",
      content: "Melanie loves pottery, camping, painting, and swimming with her family.",
      sourceSentenceText: "Melanie loves pottery, camping, painting, and swimming with her family."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["melanie"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What activities does Melanie partake in?"
  );

  assert.equal(duality.claim.text, "pottery, camping, painting, swimming");
});

test("duality promotes generic book-list aggregation over noisy top snippets", () => {
  const results = [
    recallResult({
      memoryId: "mel-books-noise",
      subjectName: "Melanie",
      content: "Melanie: I had a great day at the beach.",
      sourceSentenceText: "Melanie: I had a great day at the beach."
    }),
    recallResult({
      memoryId: "mel-books",
      subjectName: "Melanie",
      content: "Melanie: I loved reading \"Charlotte's Web\" and later read \"Nothing is Impossible\" too.",
      sourceSentenceText: "Melanie: I loved reading \"Charlotte's Web\" and later read \"Nothing is Impossible\" too."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["melanie"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What books has Melanie read?"
  );

  assert.equal(duality.claim.text, "Charlotte's Web, Nothing is Impossible");
});

test("duality promotes generic event aggregation over noisy top snippets", () => {
  const results = [
    recallResult({
      memoryId: "caroline-noise",
      subjectName: "Caroline",
      content: "Caroline: Glad it helped!",
      sourceSentenceText: "Caroline: Glad it helped!"
    }),
    recallResult({
      memoryId: "caroline-events",
      subjectName: "Caroline",
      content: "Caroline participated in the Pride parade, a school speech, and a support group this year.",
      sourceSentenceText: "Caroline participated in the Pride parade, a school speech, and a support group this year."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What LGBTQ+ events has Caroline participated in?"
  );

  assert.equal(duality.claim.text, "Pride parade, school speech, support group");
});

test("duality promotes destress activities over abstention fallback", () => {
  const results = [
    recallResult({
      memoryId: "mel-destress-noise",
      subjectName: "Melanie",
      content: "Melanie: Thanks for checking in.",
      sourceSentenceText: "Melanie: Thanks for checking in."
    }),
    recallResult({
      memoryId: "mel-destress",
      subjectName: "Melanie",
      content: "Melanie destresses by running in the morning and taking pottery classes on weekends.",
      sourceSentenceText: "Melanie destresses by running in the morning and taking pottery classes on weekends."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["melanie"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What does Melanie do to destress?"
  );

  assert.equal(duality.claim.text, "running, pottery");
});

test("duality promotes support network aggregation over fallback", () => {
  const results = [
    recallResult({
      memoryId: "caroline-support-noise",
      subjectName: "Caroline",
      content: "Caroline: I know, right?",
      sourceSentenceText: "Caroline: I know, right?"
    }),
    recallResult({
      memoryId: "caroline-support",
      subjectName: "Caroline",
      content: "When Caroline has a negative experience, her mentors, family, and friends support her.",
      sourceSentenceText: "When Caroline has a negative experience, her mentors, family, and friends support her."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Who supports Caroline when she has a negative experience?"
  );

  assert.equal(duality.claim.text, "mentors, family, friends");
});

test("duality promotes bookshelf inference from classic children's books", () => {
  const results = [
    recallResult({
      memoryId: "caroline-bookshelf",
      subjectName: "Caroline",
      content: "Caroline collects classic children's books and keeps them on her bookshelf.",
      sourceSentenceText: "Caroline collects classic children's books and keeps them on her bookshelf."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Would Caroline likely have Dr. Seuss books on her bookshelf?"
  );

  assert.equal(duality.claim.text, "Yes");
});

test("duality abstains for favorite-books queries without explicit favorite-book evidence", () => {
  const results = [
    recallResult({
      memoryId: "deborah-random-book",
      subjectName: "Deborah",
      content: "Deborah finished reading Sapiens and kept thinking about it all night.",
      sourceSentenceText: "Deborah finished reading Sapiens and kept thinking about it all night."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["deborah"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What are Deborah's favorite books?"
  );

  assert.equal(duality.claim.text, "None.");
});

test("duality promotes shared painted subject over fallback", () => {
  const results = [
    recallResult({
      memoryId: "shared-sunset",
      subjectName: "Caroline",
      content: "Caroline and Melanie both painted sunsets during their art nights.",
      sourceSentenceText: "Caroline and Melanie both painted sunsets during their art nights."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline", "melanie"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What subject have Caroline and Melanie both painted?"
  );

  assert.equal(duality.claim.text, "Sunsets");
});

test("duality promotes generic camp-location aggregation over noisy top snippets", () => {
  const results = [
    recallResult({
      memoryId: "mel-camp-noise",
      subjectName: "Melanie",
      content: "Melanie: Thanks again!",
      sourceSentenceText: "Melanie: Thanks again!"
    }),
    recallResult({
      memoryId: "mel-camp",
      subjectName: "Melanie",
      content: "Melanie camped at the beach, in the mountains, and in the forest with her family.",
      sourceSentenceText: "Melanie camped at the beach, in the mountains, and in the forest with her family."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["melanie"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Where has Melanie camped?"
  );

  assert.equal(duality.claim.text, "beach, mountains, forest");
});

test("duality promotes move-from country extraction over abstention for direct-fact history queries", () => {
  const results = [
    recallResult({
      memoryId: "caroline-home-country",
      subjectName: "Caroline",
      content: "Caroline: I've known these friends for 4 years, since I moved from my home country.",
      sourceSentenceText:
        "Caroline: I've known these friends for 4 years, since I moved from my home country."
    }),
    recallResult({
      memoryId: "caroline-sweden",
      subjectName: "Caroline",
      content: "Caroline: This necklace is a gift from my grandma in my home country, Sweden.",
      sourceSentenceText:
        "Caroline: This necklace is a gift from my grandma in my home country, Sweden."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "Where did Caroline move from 4 years ago?"
  );

  assert.equal(duality.claim.text, "Sweden");
});

test("duality promotes birthday-duration extraction over noisy top snippets for direct-fact history queries", () => {
  const results = [
    recallResult({
      memoryId: "caroline-art-question",
      subjectName: "Caroline",
      content: "Melanie: Wow, Caroline, that looks awesome! How long have you been creating art?",
      sourceSentenceText: "Melanie: Wow, Caroline, that looks awesome! How long have you been creating art?"
    }),
    recallResult({
      memoryId: "caroline-birthday-bowl",
      subjectName: "Caroline",
      content:
        "Caroline: I've got some other stuff with sentimental value, like my hand-painted bowl. A friend made it for my 18th birthday ten years ago.",
      sourceSentenceText:
        "Caroline: I've got some other stuff with sentimental value, like my hand-painted bowl. A friend made it for my 18th birthday ten years ago."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "How long ago was Caroline's 18th birthday?",
    {
      text: "ten years ago",
      source: "artifact_source",
      strongSupport: true
    }
  );

  assert.equal(duality.claim.text, "ten years ago");
});

test("profile reducer returns a trans-specific counseling path when the evidence is explicit", () => {
  const results = [
    recallResult({
      memoryId: "caroline-career-1",
      subjectName: "Caroline",
      content: "Caroline: I'm keen on counseling or working in mental health - I'd love to support those with similar issues.",
      sourceSentenceText:
        "Caroline: I'm keen on counseling or working in mental health - I'd love to support those with similar issues."
    }),
    recallResult({
      memoryId: "caroline-career-2",
      subjectName: "Caroline",
      content:
        "Caroline: I'm thinking of working with trans people, helping them accept themselves and supporting their mental health.",
      sourceSentenceText:
        "Caroline: I'm thinking of working with trans people, helping them accept themselves and supporting their mental health."
    })
  ];
  const evidence = results.map((result) => ({
    memoryId: result.memoryId,
    memoryType: result.memoryType,
    artifactId: result.artifactId ?? null,
    sourceUri: result.provenance.source_uri ?? null,
    snippet: result.content,
    provenance: result.provenance
  }));

  const duality = buildDualityObject(
    results,
    evidence,
    {
      confidence: "supported",
      reason: "test",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: false,
      sufficiency: "supported",
      subjectMatch: "matched",
      matchedParticipants: ["caroline"],
      missingParticipants: [],
      foreignParticipants: []
    },
    "ns_supported_claim",
    "What career path has Caroline decided to persue?"
  );

  assert.match(duality.claim.text, /trans/i);
  assert.match(duality.claim.text, /mental health|counseling/i);
});
