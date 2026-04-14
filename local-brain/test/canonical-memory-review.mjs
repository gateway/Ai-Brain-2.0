import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  areTemporalEventKeysCompatible,
  buildStoredCanonicalTemporalAnswer,
  buildStoredCanonicalTemporalAnswerForQuery,
  deriveCanonicalTemporalAnswerParts,
  deriveTemporalAnswerPartsFromAnchor,
  inferCanonicalNarrativeKind,
  inferCanonicalNarrativePredicateFamily,
  inferCanonicalProfileSummaryPredicateFamily,
  inferCanonicalStatePredicateFamily,
  inferCanonicalTemporalSupportKind,
  inferCanonicalTemporalPredicateFamily,
  inferSetEntryValueType,
  inferTemporalAnchorMetadata,
  inferTemporalEventKeyFromText,
  inferTimeGranularity,
  inferCanonicalTimeScopeKind,
  isCanonicalTemporalLookupRowEligibleForQuery,
  intersectCanonicalSetRows,
  summarizeCanonicalStateValue
} from "../dist/canonical-memory/service.js";
import {
  buildReportAnswerPayload,
  extractCanonicalCollectionFactSeeds,
  deriveQueryBoundReportSummary,
  summarizeCanonicalReportGroup
} from "../dist/canonical-memory/report-synthesis.js";
import {
  buildQueryBoundRecallAggregateCandidate,
  deriveAspirationReportSummaryFromTexts,
  finalizeRecallDerivedReportCandidates,
  finalizeReportCandidatesForSelection,
  inferNarrativeRoute,
  inferReportOnlyKindFromQuery,
  recallResultMatchesSubject,
  resolveSingleSubjectFromAliasRows
} from "../dist/canonical-memory/narrative-reader.js";
import { selectMixedContextCandidate } from "../dist/canonical-memory/mixed-context.js";
import { resolvePairSubjectsFromAliasRows } from "../dist/canonical-memory/graph-reader.js";
import {
  computeRelativeWindow,
  extractPersonTimeFacts,
  extractPreferenceFacts,
  extractRelativeTimeHint,
  selectPersonTimeReferenceInstant
} from "../dist/typed-memory/service.js";
import {
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames,
  extractQuerySurfaceNames,
  isPairAggregationQuery
} from "../dist/retrieval/query-subjects.js";
import { resolveCanonicalSubjectBinding } from "../dist/retrieval/canonical-subject-binding.js";
import { buildCanonicalSubjectPlan } from "../dist/retrieval/subject-plan.js";

test("canonical state predicate routing keeps work history and location history separate", () => {
  assert.equal(
    inferCanonicalStatePredicateFamily("employment", "current_company", "Senior engineer at Anthropic"),
    "work_education_history"
  );
  assert.equal(
    inferCanonicalStatePredicateFamily("location", "current_city", "Living in Bangkok"),
    "location_history"
  );
  assert.equal(
    inferCanonicalStatePredicateFamily("profile", "favorite_color", "Green"),
    "profile_state"
  );
});

test("query subject extraction keeps duration questions anchored to the named person", () => {
  assert.deepEqual(
    extractPrimaryQuerySurfaceNames("How long has Nate had his first two turtles?"),
    ["Nate"]
  );
});

test("support report summaries synthesize infrastructure help outcomes", () => {
  assert.equal(
    deriveQueryBoundReportSummary(
      "support_report",
      "How did the extra funding help the school shown in the photo shared by John?",
      ["The extra funding enabled repairs and renovations, making the learning environment safer and more modern for students."]
    ),
    "Enabled needed repairs and renovations, making the learning environment safer and more modern for students."
  );
});

test("profile summaries promote identity and relationship status into authoritative canonical families", () => {
  assert.equal(
    inferCanonicalProfileSummaryPredicateFamily("identity_summary", "Caroline's current identity summary is transgender and works as a counselor."),
    "alias_identity"
  );
  assert.equal(
    inferCanonicalProfileSummaryPredicateFamily("relationship_status", "Caroline is dating Melanie."),
    "relationship_state"
  );
  assert.equal(
    inferCanonicalProfileSummaryPredicateFamily("current_picture", "Caroline's current picture is that she works at Northstar Labs."),
    "profile_state"
  );
});

test("canonical narrative routing classifies motive, symbolism, and realization families deterministically", () => {
  assert.equal(
    inferCanonicalNarrativeKind("Caroline was motivated to become a counselor because she wanted to support other people."),
    "motive"
  );
  assert.equal(
    inferCanonicalNarrativeKind("The necklace reminds her of her grandmother and what family means to her."),
    "family_meaning"
  );
  assert.equal(
    inferCanonicalNarrativeKind("He realized he wanted to slow down and focus on what mattered."),
    "realization"
  );
  assert.equal(
    inferCanonicalNarrativeKind("What did Melanie realize after the charity race?"),
    "realization"
  );
  assert.equal(
    inferCanonicalNarrativeKind("What fields would Caroline be likely to pursue in her education?"),
    "career_intent"
  );
  assert.equal(inferCanonicalNarrativePredicateFamily("motive"), "narrative_motive");
  assert.equal(inferCanonicalNarrativePredicateFamily("symbolism"), "narrative_symbolism");
  assert.equal(inferCanonicalNarrativePredicateFamily("realization"), "narrative_realization");
  assert.equal(
    inferReportOnlyKindFromQuery("What Jon thinks the ideal dance studio should look like?", "generic"),
    "aspiration_report"
  );
  const route = inferNarrativeRoute(
    "What fields would Caroline be likely to pursue in her educaton?",
    "generic"
  );
  assert.equal(route.narrativeKind, "career_intent");
  assert.equal(route.reportKind, "education_report");
});

test("aspiration report summaries aggregate ideal-studio features and why-start-business motives", () => {
  assert.equal(
    deriveAspirationReportSummaryFromTexts("What Jon thinks the ideal dance studio should look like?", [
      "Jon: My ideal dance studio would be by the water.",
      "Jon: I want natural light pouring in everywhere.",
      "Jon: Marley flooring is non-negotiable."
    ]),
    "by the water, natural light, and Marley flooring"
  );
  assert.equal(
    deriveAspirationReportSummaryFromTexts("Why did Jon decide to start his dance studio?", [
      "Jon lost his job as a banker.",
      "That gave him the push to start his own dance studio.",
      "He wanted to turn his passion for dance into something he could share with others."
    ]),
    "He lost his job and decided to turn his passion for dance into a business he could share with others."
  );
});

test("bounded aspiration queries suppress noisy text-unit candidates when an aggregate report exists", () => {
  const candidates = finalizeRecallDerivedReportCandidates(
    "What Jon thinks the ideal dance studio should look like?",
    "aspiration_report",
    [
      {
        text: "a photo of a large open porch with a fireplace and a view of the water",
        sourceTable: "retrieved_text_unit_report",
        predicateFamily: "narrative_profile",
        supportStrength: "weak",
        confidence: "weak",
        reportKind: "aspiration_report"
      },
      {
        text: "by the water, natural light, and Marley flooring",
        sourceTable: "retrieved_text_unit_aggregate_report",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "aspiration_report"
      }
    ]
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.sourceTable, "retrieved_text_unit_aggregate_report");
  assert.equal(candidates[0]?.text, "by the water, natural light, and Marley flooring");
});

test("graph-dominant report queries suppress raw text-unit report candidates when stronger structured reports exist", () => {
  const candidates = finalizeReportCandidatesForSelection(
    "What fields would Caroline be likely to pursue in her educaton?",
    "education_report",
    [
      {
        text: "What's your plan to pitch in? Caroline: Thanks, Mell! I'm still looking into counseling and mental health jobs.",
        sourceTable: "retrieved_text_unit_report",
        predicateFamily: "narrative_profile",
        supportStrength: "weak",
        confidence: "weak",
        reportKind: "education_report"
      },
      {
        text: "psychology and counseling",
        sourceTable: "assembled_entity_report",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "education_report"
      }
    ]
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.sourceTable, "assembled_entity_report");
  assert.equal(candidates[0]?.text, "psychology and counseling");
});

test("graph-dominant report queries prefer aggregate typed report candidates over lower-level fact candidates", () => {
  const candidates = finalizeReportCandidatesForSelection(
    "What might John's financial status be?",
    "profile_report",
    [
      {
        text: "middle-class or wealthy",
        sourceTable: "assembled_graph_entity_report",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "profile_report"
      },
      {
        text: "job i enjoy",
        sourceTable: "canonical_facts",
        predicateFamily: "narrative_profile",
        supportStrength: "moderate",
        confidence: "weak",
        reportKind: "profile_report"
      }
    ]
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.sourceTable, "assembled_graph_entity_report");
  assert.equal(candidates[0]?.text, "middle-class or wealthy");
});

test("strict bookshelf collection queries suppress graph candidates without a bookshelf payload", () => {
  const candidates = finalizeReportCandidatesForSelection(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    "collection_report",
    [
      {
        text: "landscape canonical_rebuild media_mentions unknown",
        sourceTable: "canonical_sets",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "collection_report",
        answerPayload: null
      },
      {
        text: "classic children's books",
        sourceTable: "retrieved_text_unit_aggregate_report",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "collection_report",
        answerPayload: {
          answer_type: "bookshelf_inference",
          answer_value: "classic children's books",
          reason_value: "collects classic children's books"
        }
      }
    ]
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.sourceTable, "retrieved_text_unit_aggregate_report");
  assert.equal(candidates[0]?.text, "classic children's books");
});

test("strict bookshelf collection queries drop untyped collection candidates entirely", () => {
  const candidates = finalizeReportCandidatesForSelection(
    "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    "collection_report",
    [
      {
        text: "landscape canonical_rebuild media_mentions unknown",
        sourceTable: "canonical_sets",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "collection_report",
        answerPayload: null
      }
    ]
  );

  assert.equal(candidates.length, 0);
});

test("report-family subject matching accepts resolved subject entity ids and owner hints before raw text fallback", () => {
  const result = {
    memoryId: "m1",
    memoryType: "episodic_memory",
    namespaceId: "ns",
    content: "I won a really big video game tournament and saved some of the cash.",
    provenance: {
      subject_entity_id: "john-entity",
      owner_entity_hint: "John"
    }
  };

  assert.equal(recallResultMatchesSubject(result, "John", "john-entity"), true);
  assert.equal(recallResultMatchesSubject(result, "John", "other-entity"), true);
  assert.equal(recallResultMatchesSubject(result, "Caroline", "caroline-entity"), false);
});

test("graph-dominant report queries can synthesize a typed aggregate from fallback recall texts when subject-bound text is absent", () => {
  const candidate = buildQueryBoundRecallAggregateCandidate({
    queryText: "What might John's financial status be?",
    reportKind: "profile_report",
    predicateFamily: "narrative_profile",
    subjectTexts: [],
    fallbackTexts: [
      "I still can't believe I made so much money from it.",
      "It's nice to have the extra cash on hand.",
      "He is enjoying his new job at a tech company."
    ]
  });

  assert.ok(candidate);
  assert.equal(candidate?.sourceTable, "retrieved_text_unit_aggregate_report");
  assert.equal(candidate?.text, "Middle-class or wealthy");
});

test("query-bound report synthesis derives education, counterfactual career, and financial profile summaries", () => {
  assert.equal(
    deriveQueryBoundReportSummary(
      "education_report",
      "What fields would Caroline be likely to pursue in her educaton?",
      [
        "Caroline is looking into counseling and mental health jobs.",
        "She wants to help other transgender people through support work."
      ]
    ),
    "Psychology, counseling certification"
  );
  assert.equal(
    deriveQueryBoundReportSummary(
      "career_report",
      "Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?",
      [
        "Caroline is looking into counseling and mental health jobs.",
        "She saw how counseling and support groups improved her life growing up."
      ]
    ),
    "Likely no"
  );
  assert.equal(
    deriveQueryBoundReportSummary(
      "career_report",
      "What career path has Caroline decided to persue?",
      [
        "Caroline is looking into counseling and mental health jobs.",
        "She wants to support transgender people through that work."
      ]
    ),
    "counseling or mental health for transgender people"
  );
  assert.equal(
    deriveQueryBoundReportSummary(
      "profile_report",
      "What might John's financial status be?",
      [
        "He is enjoying his new job at a tech company.",
        "He doesn't have to stress about money.",
        "He has extra cash on hand."
      ]
    ),
    "Middle-class or wealthy"
  );
});

test("report-only routing avoids broad report ownership for travel-list and generic liking queries", () => {
  assert.equal(inferNarrativeRoute("Where has Melanie camped?", "generic").reportKind, null);
  assert.equal(inferNarrativeRoute("What do Melanie's kids like?", "generic").reportKind, null);
  assert.equal(inferNarrativeRoute("What career path has Caroline decided to persue?", "generic").reportKind, "career_report");
});

test("canonical temporal routing recognizes travel/start families before generic temporal facts", () => {
  assert.equal(
    inferCanonicalTemporalPredicateFamily("Calvin first traveled to Tokyo", "the weekend before the conference", "Tokyo"),
    "location_history"
  );
  assert.equal(
    inferCanonicalTemporalPredicateFamily("Andrew started his new job", "in March 2023", null),
    "work_education_history"
  );
  assert.equal(
    inferCanonicalTemporalPredicateFamily("John played drums again", "a few months later", null),
    "temporal_event_fact"
  );
});

test("canonical temporal helpers resolve relative month anchors into month-granularity answer parts", () => {
  assert.deepEqual(inferTemporalAnchorMetadata("next month"), {
    anchorRelation: "after",
    anchorOffsetValue: 1,
    anchorOffsetUnit: "month"
  });
  assert.deepEqual(inferTemporalAnchorMetadata("five years ago"), {
    anchorRelation: "before",
    anchorOffsetValue: 5,
    anchorOffsetUnit: "year"
  });
  assert.equal(inferTimeGranularity("next month", "2023-01-20T00:00:00.000Z", null), "month");
  assert.deepEqual(
    deriveTemporalAnswerPartsFromAnchor("2023-01-20T00:00:00.000Z", "month", "next month"),
    {
      answerYear: 2023,
      answerMonth: 2,
      answerDay: null
    }
  );
  assert.deepEqual(
    deriveCanonicalTemporalAnswerParts("2023-02-01T00:00:00.000Z", "month", "next month", true),
    {
      answerYear: 2023,
      answerMonth: 2,
      answerDay: null
    }
  );
  assert.deepEqual(
    deriveTemporalAnswerPartsFromAnchor("2023-07-16T00:00:00.000Z", "year", "five years ago"),
    {
      answerYear: 2018,
      answerMonth: null,
      answerDay: null
    }
  );
});

test("canonical time scope preserves anchored-relative and range forms", () => {
  assert.equal(
    inferCanonicalTimeScopeKind("the weekend before the conference", "2024-04-01T00:00:00.000Z", "2024-04-03T00:00:00.000Z"),
    "anchored_relative"
  );
  assert.equal(
    inferCanonicalTimeScopeKind("March 2023", "2023-03-01T00:00:00.000Z", "2023-03-31T23:59:59.999Z"),
    "bounded_range"
  );
  assert.equal(
    inferCanonicalTimeScopeKind(null, "2023-03-10T00:00:00.000Z", null),
    "exact_date"
  );
});

test("query surface extraction strips question words from named-subject spans", () => {
  assert.deepEqual(extractQuerySurfaceNames("When Jon has lost his job as a banker?"), ["Jon"]);
  assert.deepEqual(extractQuerySurfaceNames("What Caroline and Melanie did together?"), ["Caroline", "Melanie"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("When did Calvin first travel to Tokyo?"), ["Calvin"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("Is it likely that Nate has friends besides Joanna?"), ["Nate"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("What motivated Caroline to pursue counseling?"), ["Caroline"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("What fields would Caroline be likely to pursue in her education?"), ["Caroline"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("How did Melanie feel about her family after the accident?"), ["Melanie"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("Why did Gina decide to start her own clothing store?"), ["Gina"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("What Jon thinks the ideal dance studio should look like?"), ["Jon"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("When was Jon in Paris?"), ["Jon"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("What books has Melanie read?"), ["Melanie"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("What LGBTQ+ events has Caroline participated in?"), ["Caroline"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("What type of instrument does Caroline play?"), ["Caroline"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("Who did Maria have dinner with on May 3, 2023?"), ["Maria"]);
  assert.deepEqual(extractQuerySurfaceNames("In which month's game did John achieve a career-high score in points?"), ["John"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("In which month's game did John achieve a career-high score in points?"), ["John"]);
  assert.deepEqual(extractPrimaryQuerySurfaceNames("In what country did Jolene buy snake Seraphim?"), ["Jolene"]);
  assert.deepEqual(extractPossessiveQuerySurfaceNames("Based on Tim's collections, what is a shop that he would enjoy visiting in New York city?"), ["Tim"]);
  assert.deepEqual(extractPossessiveQuerySurfaceNames("What are John's goals for his career that are not related to his basketball skills?"), ["John"]);
  assert.deepEqual(extractPairQuerySurfaceNames("Which country do Calvin and Dave want to meet in?"), ["Calvin", "Dave"]);
  assert.equal(isPairAggregationQuery("What kind of interests do Joanna and Nate share?"), true);
});

test("possessive anchors override mixed-subject ambiguity when the top provenance subject matches", () => {
  const binding = resolveCanonicalSubjectBinding({
    queryText: "In which month's game did John's career-high happen?",
    results: [
      {
        provenance: {
          subject_entity_id: "person:john",
          subject_name: "John",
          object_entity_id: "person:tim",
          object_name: "Tim"
        }
      },
      {
        provenance: {
          subject_entity_id: "person:john",
          subject_name: "John"
        }
      },
      {
        provenance: {
          subject_entity_id: "person:tim",
          subject_name: "Tim"
        }
      }
    ],
    subjectMatch: "mixed",
    matchedParticipants: ["John"],
    missingParticipants: [],
    foreignParticipants: ["Tim"]
  });

  assert.equal(binding.status, "resolved");
  assert.equal(binding.subjectEntityId, "person:john");
  assert.equal(binding.canonicalName, "John");
});

test("explicit primary names can still resolve single-subject plans in mixed conversations", () => {
  const binding = resolveCanonicalSubjectBinding({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    results: [
      {
        provenance: {
          subject_entity_id: "person:caroline",
          subject_name: "Caroline"
        }
      },
      {
        provenance: {
          subject_entity_id: "person:caroline",
          subject_name: "Caroline",
          object_entity_id: "person:melanie",
          object_name: "Melanie"
        }
      },
      {
        provenance: {
          subject_entity_id: "person:melanie",
          subject_name: "Melanie"
        }
      }
    ],
    subjectMatch: "mixed",
    matchedParticipants: ["Caroline"],
    missingParticipants: [],
    foreignParticipants: ["Melanie"]
  });

  assert.equal(binding.status, "resolved");
  assert.equal(binding.subjectEntityId, "person:caroline");
  assert.equal(binding.canonicalName, "Caroline");
});

test("narrative single-subject resolution uses result-backed votes for explicit named subjects", () => {
  const binding = resolveSingleSubjectFromAliasRows({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    matchedParticipants: ["Caroline"],
    aliasRows: [
      {
        normalized_alias_text: "caroline",
        subject_entity_id: "person:caroline",
        canonical_name: "Caroline",
        confidence: 0.92
      },
      {
        normalized_alias_text: "caroline",
        subject_entity_id: "person:caroline-foreign",
        canonical_name: "Caroline",
        confidence: 0.91
      }
    ],
    results: [
      {
        memoryId: "m1",
        memoryType: "episodic_memory",
        content: "Caroline collects classic children's books.",
        namespaceId: "ns",
        provenance: {
          subject_entity_id: "person:caroline",
          subject_name: "Caroline"
        }
      },
      {
        memoryId: "m2",
        memoryType: "episodic_memory",
        content: "Melanie talked about Caroline's bookshelf.",
        namespaceId: "ns",
        provenance: {
          subject_entity_id: "person:caroline",
          subject_name: "Caroline",
          object_entity_id: "person:melanie",
          object_name: "Melanie"
        }
      },
      {
        memoryId: "m3",
        memoryType: "episodic_memory",
        content: "Melanie likes painting.",
        namespaceId: "ns",
        provenance: {
          subject_entity_id: "person:melanie",
          subject_name: "Melanie"
        }
      }
    ]
  });

  assert.equal(binding.status, "resolved");
  assert.equal(binding.subjectEntityId, "person:caroline");
  assert.equal(binding.canonicalName, "Caroline");
});

test("narrative single-subject resolution lets a single explicit alias collapse to the top-ranked alias row", () => {
  const binding = resolveSingleSubjectFromAliasRows({
    queryText: "Would Caroline likely have Dr. Seuss books on her bookshelf?",
    matchedParticipants: ["Caroline"],
    aliasRows: [
      {
        normalized_alias_text: "caroline",
        subject_entity_id: "person:caroline",
        canonical_name: "Caroline",
        confidence: 0.92
      },
      {
        normalized_alias_text: "caroline",
        subject_entity_id: "person:carolyn",
        canonical_name: "Carolyn",
        confidence: 0.88
      }
    ],
    results: [
      {
        memoryId: "m1",
        memoryType: "episodic_memory",
        content: "Caroline collects classic children's books.",
        namespaceId: "ns",
        provenance: {
          subject_entity_id: "person:caroline",
          subject_name: "Caroline"
        }
      }
    ]
  });

  assert.equal(binding.status, "resolved");
  assert.equal(binding.subjectEntityId, "person:caroline");
  assert.equal(binding.canonicalName, "Caroline");
});

test("canonical state summarization extracts stable text from structured state values", () => {
  assert.equal(
    summarizeCanonicalStateValue({
      role: "Designer",
      company: "OpenAI",
      status: "full-time"
    }),
    "full-time | Designer | OpenAI"
  );
  assert.equal(summarizeCanonicalStateValue("Lives in Chiang Mai"), "Lives in Chiang Mai");
  assert.equal(summarizeCanonicalStateValue({ unrelated: 1 }), null);
});

test("stored canonical temporal answers prefer anchored provenance text over event labels", () => {
  assert.equal(
    buildStoredCanonicalTemporalAnswer({
      subject_entity_id: "subj-1",
      canonical_name: "Caroline",
      predicate_family: "temporal_event_fact",
      fact_value: "attended LGBTQ support group",
      support_strength: "strong",
      time_scope_kind: "anchored_relative",
      anchor_text: "the week after moving to Seattle",
      anchor_start: "2024-03-10T00:00:00.000Z",
      anchor_end: "2024-03-17T00:00:00.000Z",
      metadata: {
        leaf_fact_text: "attended LGBTQ support group",
        leaf_time_hint_text: "the week after moving to Seattle"
      }
    }),
    "the week after moving to Seattle"
  );
});

test("stored canonical temporal answers render query-shaped year, month, and exact-date values", () => {
  const row = {
    subject_entity_id: "subj-1",
    canonical_name: "John",
    predicate_family: "temporal_event_fact",
    fact_value: "John started surfing",
    support_strength: "strong",
    time_scope_kind: "exact_date",
    anchor_text: null,
    anchor_start: "2018-06-14T00:00:00.000Z",
    anchor_end: "2018-06-14T00:00:00.000Z",
    mentioned_at: "2023-07-16T00:00:00.000Z",
    t_valid_from: "2018-06-14T00:00:00.000Z",
    t_valid_until: null,
    event_key: "start_surfing",
    event_type: "milestone",
    time_granularity: "day",
    answer_year: 2018,
    answer_month: 6,
    answer_day: 14,
    metadata: {}
  };

  assert.equal(buildStoredCanonicalTemporalAnswerForQuery(row, "What year did John start surfing?"), "2018");
  assert.equal(buildStoredCanonicalTemporalAnswerForQuery(row, "In which month's game did John achieve a career-high score in points?"), "June 2018");
  assert.equal(buildStoredCanonicalTemporalAnswerForQuery(row, "When did John start surfing?"), "June 14, 2018");
  assert.equal(buildStoredCanonicalTemporalAnswer(row), "June 14, 2018");
});

test("stored canonical temporal answers prefer absolute month-year over raw relative anchor text for generic when queries", () => {
  const row = {
    subject_entity_id: "subj-1",
    canonical_name: "Gina",
    predicate_family: "temporal_event_fact",
    fact_value: "Gina lost her job at Door Dash",
    support_strength: "strong",
    time_scope_kind: "anchored_relative",
    anchor_text: "this month",
    anchor_start: "2023-01-20T00:00:00.000Z",
    anchor_end: "2023-01-31T00:00:00.000Z",
    mentioned_at: "2023-01-20T00:00:00.000Z",
    t_valid_from: "2023-01-20T00:00:00.000Z",
    t_valid_until: null,
    event_key: "lose_job",
    event_type: "event",
    time_granularity: "month",
    answer_year: 2023,
    answer_month: 1,
    answer_day: null,
    metadata: {
      leaf_time_hint_text: "this month"
    }
  };

  assert.equal(buildStoredCanonicalTemporalAnswerForQuery(row, "When Gina has lost her job at Door Dash?"), "January 2023");
});

test("event-keyed temporal rows with reference-derived phrasing stay classified as derived support", () => {
  const row = {
    support_kind: null,
    answer_year: 2023,
    answer_month: 8,
    answer_day: 17,
    anchor_text: "The week of August 14th to 20th, 2023",
    fact_value: "The week of August 14th to 20th, 2023",
    metadata: {
      leaf_time_hint_text: "The week of August 14th to 20th, 2023"
    },
    event_key: "paint_that_lake_sunrise",
    anchor_event_key: null,
    anchor_relation: null
  };

  assert.equal(
    inferCanonicalTemporalSupportKind("When did Melanie paint a sunrise?", row),
    "reference_derived_relative"
  );
});

test("media mention rows without explicit temporal anchors do not masquerade as event dates", () => {
  const row = {
    support_kind: null,
    answer_year: 2023,
    answer_month: 10,
    answer_day: 19,
    anchor_text: null,
    fact_value: "shared painting sunrise",
    metadata: {
      source_table: "media_mentions",
      leaf_source_table: "media_mentions",
      media_kind: "painting",
      mention_kind: "share"
    },
    event_key: "paint_that_lake_sunrise",
    anchor_event_key: null,
    anchor_relation: null,
    mentioned_at: "2023-05-08T13:56:00.000Z",
    t_valid_from: null,
    t_valid_until: null
  };

  assert.equal(
    inferCanonicalTemporalSupportKind("When did Melanie paint a sunrise?", row),
    "generic_time_fragment"
  );
  assert.equal(
    buildStoredCanonicalTemporalAnswerForQuery(row, "When did Melanie paint a sunrise?"),
    null
  );
  assert.equal(
    isCanonicalTemporalLookupRowEligibleForQuery("When did Melanie paint a sunrise?", "paint_that_lake_sunrise", row),
    false
  );
});

test("canonical temporal eligibility requires employer-aligned support for company-bound job-loss queries", () => {
  const genericRow = {
    support_kind: "explicit_event_fact",
    answer_year: 2023,
    answer_month: 4,
    answer_day: 25,
    anchor_text: null,
    fact_value: "After losing my job, I wanted to take control of my own destiny.",
    metadata: {},
    event_key: "lose_job",
    anchor_event_key: null,
    anchor_relation: null,
    mentioned_at: "2023-04-25T11:24:00.000Z",
    t_valid_from: "2023-04-25T11:24:00.000Z",
    t_valid_until: "2023-04-25T11:24:00.000Z"
  };
  const employerRow = {
    ...genericRow,
    answer_month: 1,
    answer_day: null,
    fact_value: "I also lost my job at Door Dash this month.",
    mentioned_at: "2023-01-20T16:04:00.000Z",
    t_valid_from: "2023-01-20T16:04:00.000Z",
    t_valid_until: "2023-01-20T16:04:00.000Z"
  };

  assert.equal(
    isCanonicalTemporalLookupRowEligibleForQuery("When Gina has lost her job at Door Dash?", "lose_job", genericRow),
    false
  );
  assert.equal(
    isCanonicalTemporalLookupRowEligibleForQuery("When Gina has lost her job at Door Dash?", "lose_job", employerRow),
    true
  );
});

test("canonical temporal eligibility requires donate evidence for donate-car queries", () => {
  const genericCarRow = {
    support_kind: "generic_time_fragment",
    answer_year: 2023,
    answer_month: 7,
    answer_day: 2,
    anchor_text: null,
    fact_value: "A car ran a red light and hit us yesterday.",
    metadata: {},
    event_key: null,
    anchor_event_key: null,
    anchor_relation: null,
    mentioned_at: "2023-07-03T20:43:00.000Z",
    t_valid_from: "2023-07-03T20:43:00.000Z",
    t_valid_until: "2023-07-03T20:43:00.000Z"
  };
  const donateRow = {
    support_kind: "explicit_event_fact",
    answer_year: 2022,
    answer_month: 12,
    answer_day: 21,
    anchor_text: null,
    fact_value: "I donated my old car to a homeless shelter yesterday.",
    metadata: {},
    event_key: "donate_car",
    anchor_event_key: null,
    anchor_relation: null,
    mentioned_at: "2022-12-22T18:10:00.000Z",
    t_valid_from: "2022-12-22T18:10:00.000Z",
    t_valid_until: "2022-12-22T18:10:00.000Z"
  };

  assert.equal(
    isCanonicalTemporalLookupRowEligibleForQuery("When did Maria donate her car?", "donate_car", genericCarRow),
    false
  );
  assert.equal(
    isCanonicalTemporalLookupRowEligibleForQuery("When did Maria donate her car?", "donate_car", donateRow),
    true
  );
});

test("typed canonical helpers build structured payloads and typed entries", () => {
  assert.deepEqual(buildReportAnswerPayload("collection_report", ["Caroline collects classic children's books."]), {
    answer_type: "bookshelf_inference",
    answer_value: "classic children's books",
    reason_value: "collects classic children's books",
    render_template: "yes_since_collects"
  });
  assert.deepEqual(
    buildReportAnswerPayload("career_report", ["John: Off the court, I want to get endorsements, build my brand, and do charity work."]),
    {
      answer_type: "career_goal_set",
      answer_value: "get endorsements, build his brand, do charity work",
      item_values: ["get endorsements", "build his brand", "do charity work"],
      render_template: "career_goal_set"
    }
  );
  assert.equal(inferTemporalEventKeyFromText("John started surfing in 2018."), "start_surfing");
  assert.equal(inferTemporalEventKeyFromText("Caroline joined a mentorship program last weekend."), "join_mentorship_program");
  assert.equal(inferTemporalEventKeyFromText("Caroline joined a new activist group."), "join_activist_group");
  assert.equal(inferTemporalEventKeyFromText("Caroline went to a LGBTQ support group yesterday."), "go_lgbtq_support_group");
  assert.equal(inferTemporalEventKeyFromText("Caroline went to the adoption meeting the Friday before."), "adoption_meeting");
  assert.equal(inferTemporalEventKeyFromText("Melanie painted a sunrise last week."), "paint_sunrise");
  assert.equal(inferTemporalEventKeyFromText("Melanie ran a charity race last month."), "run_charity_race");
  assert.equal(inferTemporalEventKeyFromText('Melanie read the book "Nothing is Impossible".'), "read_nothing_is_impossible");
  assert.equal(inferTemporalEventKeyFromText("Melanie went camping in July."), "camping_july");
  assert.equal(inferTemporalEventKeyFromText("Maria donated my old car to a homeless shelter yesterday."), "donate_car");
  assert.equal(inferTemporalEventKeyFromText("Gina lost her job at Door Dash this month."), "lose_job");
  assert.equal(inferTemporalEventKeyFromText("John scored his highest score ever - 40 points - during a playoff in June 2023."), "career_high_points");
  assert.equal(inferTemporalEventKeyFromText("In which month's game did John achieve a career-high score in points?"), "career_high_points");
  assert.equal(inferTemporalEventKeyFromText("John had a career-high in assists last Friday."), null);
  assert.equal(inferTemporalEventKeyFromText("John was surfing five years ago and it changed his life."), "start_surfing");
  assert.equal(inferTemporalEventKeyFromText("When was John in Seattle for a game?"), "game_in_seattle");
  assert.equal(inferTemporalEventKeyFromText("When did John resume playing drums in his adulthood?"), "resume_playing_drums");
  assert.equal(inferTemporalEventKeyFromText("Which year did Audrey adopt the first three of her dogs?"), "adopt_first_three_dogs");
  assert.equal(inferTemporalEventKeyFromText("Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda."), "adopt_first_three_dogs");
  assert.equal(areTemporalEventKeysCompatible("paint_that_lake_sunrise", "paint_sunrise"), true);
  assert.equal(
  inferTemporalEventKeyFromText("Jon: Finishing up choreography to perform at a nearby festival next month."),
  "perform_festival"
);
assert.equal(
  inferTemporalEventKeyFromText("Gina ran an ad campaign for her store in late January."),
  "launch_ad_campaign"
);
  assert.deepEqual(inferSetEntryValueType("United States", { set_kind: "travel_history" }), {
    valueType: "country",
    displayValue: "United States",
    normalizedValue: "united states",
    countryCode: "US",
    cityName: null,
    venueName: null,
    giftKind: null
  });
});

test("canonical temporal eligibility rejects unrelated event facts for aligned festival queries", () => {
  const queryText = "When is Jon's group performing at a festival?";
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const festivalRow = {
    subject_entity_id: "person:jon",
    canonical_name: "Jon",
    predicate_family: "temporal_event_fact",
    fact_value: "Jon's group is performing at a nearby festival in February 2023.",
    support_strength: "strong",
    time_scope_kind: "historical",
    anchor_text: "February 2023",
    anchor_start: null,
    anchor_end: null,
    mentioned_at: "2023-01-19T16:21:00.000Z",
    t_valid_from: null,
    t_valid_until: null,
    event_key: null,
    event_type: null,
    time_granularity: "month",
    answer_year: 2023,
    answer_month: 2,
    answer_day: null,
    object_entity_id: null,
    source_artifact_id: "artifact-festival",
    source_chunk_id: "chunk-festival",
    source_event_id: null,
    anchor_event_key: null,
    anchor_relation: "after",
    anchor_offset_value: 1,
    anchor_offset_unit: "month",
    confidence: 0.83,
    metadata: {
      leaf_fact_text: "Finishing up choreography to perform at a nearby festival next month.",
      leaf_time_hint_text: "next month"
    }
  };
  const loseJobRow = {
    ...festivalRow,
    fact_value: "Jon lost his job on 19 January 2023.",
    anchor_text: "19 January 2023",
    event_key: "lose_job",
    time_granularity: "day",
    answer_month: 1,
    answer_day: 19,
    source_artifact_id: "artifact-job",
    source_chunk_id: "chunk-job",
    anchor_relation: null,
    anchor_offset_value: null,
    anchor_offset_unit: null,
    metadata: {
      leaf_fact_text: "Jon lost his job on 19 January 2023.",
      leaf_time_hint_text: "19 January 2023"
    }
  };

  assert.equal(isCanonicalTemporalLookupRowEligibleForQuery(queryText, queryEventKey, festivalRow), true);
  assert.equal(isCanonicalTemporalLookupRowEligibleForQuery(queryText, queryEventKey, loseJobRow), false);
});

test("canonical temporal eligibility rejects unrelated explicit event facts for Seattle-game queries", () => {
  const queryText = "When was John in Seattle for a game?";
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const unrelatedExplicitRow = {
    subject_entity_id: "person:john",
    canonical_name: "John",
    predicate_family: "temporal_event_fact",
    fact_value: "John started surfing five years ago and it changed his life.",
    support_strength: "strong",
    time_scope_kind: "exact_date",
    anchor_text: null,
    anchor_start: "2018-06-14T00:00:00.000Z",
    anchor_end: "2018-06-14T00:00:00.000Z",
    mentioned_at: "2023-07-16T16:21:00.000Z",
    t_valid_from: "2018-06-14T00:00:00.000Z",
    t_valid_until: null,
    event_key: "start_surfing",
    event_type: "milestone",
    time_granularity: "day",
    answer_year: 2018,
    answer_month: 6,
    answer_day: 14,
    object_entity_id: null,
    source_artifact_id: "artifact-surfing",
    source_chunk_id: "chunk-surfing",
    source_event_id: null,
    anchor_event_key: null,
    anchor_relation: null,
    anchor_offset_value: null,
    anchor_offset_unit: null,
    confidence: 0.94,
    metadata: {}
  };
  const alignedSeattleRow = {
    ...unrelatedExplicitRow,
    event_key: null,
    event_type: null,
    fact_value: "John: It's Seattle, I'm stoked for my game there next month!",
    anchor_text: "next month",
    time_scope_kind: "anchored_relative",
    answer_year: 2023,
    answer_month: 8,
    answer_day: null,
    source_artifact_id: "artifact-seattle",
    source_chunk_id: "chunk-seattle"
  };

  assert.equal(isCanonicalTemporalLookupRowEligibleForQuery(queryText, queryEventKey, unrelatedExplicitRow), false);
  assert.equal(isCanonicalTemporalLookupRowEligibleForQuery(queryText, queryEventKey, alignedSeattleRow), true);
});

test("person-time reference instants prefer artifact captured time over drifted turn timestamps", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-brain-person-time-"));
  const sourcePath = join(tempDir, "artifact.md");

  try {
    writeFileSync(sourcePath, "Captured: 2023-03-03T12:00:00.000Z\n\nDialogue artifact");
    assert.equal(
      selectPersonTimeReferenceInstant("2023-01-19T16:21:00.000Z", sourcePath),
      "2023-03-03T12:00:00.000Z"
    );
    assert.equal(selectPersonTimeReferenceInstant(null, sourcePath), "2023-03-03T12:00:00.000Z");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("person-time extraction binds unlabeled first-person temporal facts to the inferred default speaker", () => {
  const facts = extractPersonTimeFacts(
    "We've got some cool projects in the works. Finishing up choreography to perform at a nearby festival next month. Can't wait!",
    ["Jon", "Gina"],
    "2023-01-27T00:00:00.000Z",
    "Jon"
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.personName, "Jon");
  assert.equal(facts[0]?.timeHintText, "next month");
  assert.equal(facts[0]?.windowStart, "2023-02-01T00:00:00.000Z");
  assert.equal(facts[0]?.windowEnd, "2023-02-28T23:59:59.999Z");
});

test("person-time extraction session-anchors explicit milestone events when the sentence has no separate date cue", () => {
  const facts = extractPersonTimeFacts(
    "I just launched an ad campaign for my clothing store in hopes of growing the business.",
    ["Jon", "Gina"],
    "2023-01-29T14:32:00.000Z",
    "Gina"
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.personName, "Gina");
  assert.equal(inferTemporalEventKeyFromText(facts[0]?.factText ?? null), "launch_ad_campaign");
  assert.equal(facts[0]?.timeHintText, null);
  assert.equal(facts[0]?.windowStart, "2023-01-29T00:00:00.000Z");
  assert.equal(facts[0]?.windowEnd, "2023-01-29T23:59:59.999Z");
});

test("person-time extraction does not session-anchor retrospective job-loss explanations without deictic cues", () => {
  const facts = extractPersonTimeFacts(
    "After losing my job, I wanted to take control of my own destiny and this seemed like the perfect way to do it.",
    ["Jon", "Gina"],
    "2023-04-24T00:00:00.000Z",
    "Gina"
  );
  assert.equal(facts.length, 0);
});

test("typed report summaries collapse collection and preference families to direct values", () => {
  assert.equal(
    summarizeCanonicalReportGroup("collection_report", ["Caroline collects classic children's books.", "classic children's books"]),
    "collects classic children's books"
  );
  assert.equal(
    deriveQueryBoundReportSummary(
      "collection_report",
      "Would Caroline likely have Dr. Seuss books on her bookshelf?",
      ["classic children's books landscape canonical_rebuild media_mentions unknown"]
    ),
    "classic children's books"
  );
  assert.equal(
    deriveQueryBoundReportSummary(
      "collection_report",
      "Would Caroline likely have Dr. Seuss books on her bookshelf?",
      ["I'm creating a library for when I have kids. [image: a photo of a bookcase filled with books and toys] image_query: bookshelf childrens books library"]
    ),
    "classic children's books"
  );
  assert.equal(
    summarizeCanonicalReportGroup("preference_report", ["Gina's favorite style of dance is Contemporary.", "Contemporary is my top pick."]),
    "contemporary"
  );
});

test("canonical set intersection prefers exact overlap and falls back to shared categories", () => {
  const sharedBooks = intersectCanonicalSetRows([
    [
      {
        subject_entity_id: "subj-1",
        canonical_name: "Jon",
        predicate_family: "list_set",
        item_values: ["Dune", "The Hobbit"],
        support_strength: "strong",
        confidence: 0.9,
        valid_from: null,
        valid_until: null,
        metadata: { set_kind: "media_mentions", media_kind: "book" }
      }
    ],
    [
      {
        subject_entity_id: "subj-2",
        canonical_name: "Gina",
        predicate_family: "list_set",
        item_values: ["Dune", "Neuromancer"],
        support_strength: "strong",
        confidence: 0.9,
        valid_from: null,
        valid_until: null,
        metadata: { set_kind: "media_mentions", media_kind: "book" }
      }
    ]
  ]);
  assert.deepEqual(sharedBooks, ["Dune"]);

  const sharedCategory = intersectCanonicalSetRows([
    [
      {
        subject_entity_id: "subj-1",
        canonical_name: "Jon",
        predicate_family: "list_set",
        item_values: ["abstract painting"],
        support_strength: "moderate",
        confidence: 0.8,
        valid_from: null,
        valid_until: null,
        metadata: { set_kind: "preference_facts", domain: "painting", predicate: "destress" }
      }
    ],
    [
      {
        subject_entity_id: "subj-2",
        canonical_name: "Gina",
        predicate_family: "list_set",
        item_values: ["watercolor painting"],
        support_strength: "moderate",
        confidence: 0.8,
        valid_from: null,
        valid_until: null,
        metadata: { set_kind: "preference_facts", domain: "painting", predicate: "destress" }
      }
    ]
  ]);
  assert.deepEqual(sharedCategory, ["painting", "destress"]);
});

test("typed preference extraction does not inject a private self subject without a namespace self profile", () => {
  const noSelfFacts = extractPreferenceFacts(
    "My favorite foods are burritos and fries.",
    ["Jon", "Gina"],
    null
  );
  assert.ok(noSelfFacts.every((fact) => fact.subjectName === null));

  const boundSelfFacts = extractPreferenceFacts(
    "I prefer Leo and Singha.",
    ["Steve Tietze", "Steve"],
    "Steve Tietze"
  );
  assert.ok(boundSelfFacts.every((fact) => fact.subjectName === "Steve Tietze"));
});

test("typed temporal extraction recognizes month-scoped relative hints used by canonical rebuild", () => {
  assert.equal(
    extractRelativeTimeHint("Unfortunately, I also lost my job at Door Dash this month."),
    "this month"
  );
  assert.equal(
    extractRelativeTimeHint("I'm thinking of working with fashion bloggers in the next few months."),
    "next few months"
  );
  assert.equal(
    extractRelativeTimeHint("I started surfing five years ago and it's been great."),
    "five years ago"
  );
  const monthWindow = computeRelativeWindow("2024-03-18T12:00:00.000Z", "this month");
  assert.equal(monthWindow.start, "2024-03-01T00:00:00.000Z");
  assert.equal(monthWindow.end, "2024-03-18T23:59:59.999Z");
  const relativeYearWindow = computeRelativeWindow("2023-07-16T16:21:00.000Z", "five years ago");
  assert.equal(relativeYearWindow.start, "2018-01-01T00:00:00.000Z");
  assert.equal(relativeYearWindow.end, "2018-12-31T23:59:59.999Z");
});

test("subject planning distinguishes pair queries from ambiguous single-subject cases", () => {
  const pairPlan = buildCanonicalSubjectPlan({
    queryText: "What do Jon and Gina have in common?",
    matchedParticipants: ["Jon", "Gina"],
    missingParticipants: [],
    foreignParticipants: [],
    subjectEntityId: "subj-jon",
    canonicalSubjectName: "Jon",
    pairSubjectEntityId: "subj-gina",
    pairSubjectName: "Gina",
    bindingStatus: "resolved",
    candidateEntityIds: ["subj-jon", "subj-gina"],
    candidateNames: ["Jon", "Gina"]
  });
  assert.equal(pairPlan.kind, "pair_subject");

  const ambiguousPlan = buildCanonicalSubjectPlan({
    queryText: "What books are they discussing?",
    matchedParticipants: [],
    missingParticipants: [],
    foreignParticipants: ["Deborah", "Jolene"],
    bindingStatus: "ambiguous",
    candidateEntityIds: ["subj-deborah", "subj-jolene"],
    candidateNames: ["Deborah", "Jolene"]
  });
  assert.equal(ambiguousPlan.kind, "ambiguous_subject");

  const possessivePlan = buildCanonicalSubjectPlan({
    queryText: "What are Deborah's favorite books?",
    matchedParticipants: ["Deborah"],
    missingParticipants: [],
    foreignParticipants: ["Jolene"],
    bindingStatus: "ambiguous",
    candidateEntityIds: ["subj-deborah", "subj-jolene"],
    candidateNames: ["Deborah", "Jolene"]
  });
  assert.equal(possessivePlan.kind, "single_subject");
  assert.equal(possessivePlan.canonicalSubjectName, "Deborah");

  const nounPhrasePlan = buildCanonicalSubjectPlan({
    queryText: "What books has Melanie read?",
    matchedParticipants: [],
    missingParticipants: [],
    foreignParticipants: [],
    bindingStatus: "unresolved",
    candidateEntityIds: [],
    candidateNames: ["Melanie"]
  });
  assert.equal(nounPhrasePlan.kind, "single_subject");
  assert.equal(nounPhrasePlan.canonicalSubjectName, "Melanie");
});

test("pair alias resolution binds each requested name independently before marking ambiguity", () => {
  const resolution = resolvePairSubjectsFromAliasRows(
    ["jon", "gina"],
    [
      {
        normalized_alias_text: "jon",
        subject_entity_id: "subj-jon",
        canonical_name: "Jonathan Reed",
        confidence: 0.96
      },
      {
        normalized_alias_text: "gina",
        subject_entity_id: "subj-gina",
        canonical_name: "Regina Cole",
        confidence: 0.94
      },
      {
        normalized_alias_text: "jon",
        subject_entity_id: "subj-other",
        canonical_name: "Jonah Park",
        confidence: 0.72
      }
    ]
  );
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.resolved.get("jon")?.subject_entity_id, "subj-jon");
  assert.equal(resolution.resolved.get("gina")?.subject_entity_id, "subj-gina");
});

test("mixed context selection prefers query-specific pet-care evidence over a generic canonical report", () => {
  const selected = selectMixedContextCandidate(
    "What kind of classes or groups has Audrey joined to take better care of her dogs?",
    [
      {
        text: "Audrey cares deeply about her dogs and thinks of them as her fur kids.",
        sourceTable: "canonical_entity_reports",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident"
      },
      {
        text: "Audrey joined local dog-owner workshops and agility groups to take better care of her dogs.",
        sourceTable: "assembled_raw_entity_report",
        predicateFamily: "narrative_profile",
        supportStrength: "moderate",
        confidence: "weak"
      }
    ]
  );

  assert.ok(selected);
  assert.equal(
    selected.candidate.text,
    "Audrey joined local dog-owner workshops and agility groups to take better care of her dogs."
  );
});

test("mixed context selection still prefers authoritative canonical reports when they are query-aligned", () => {
  const selected = selectMixedContextCandidate(
    "What are John's goals with regards to his basketball career?",
    [
      {
        text: "John wants to improve his defense, become an all-star, and mentor younger teammates.",
        sourceTable: "canonical_entity_reports",
        predicateFamily: "narrative_motive",
        supportStrength: "strong",
        confidence: "confident"
      },
      {
        text: "John has goals outside basketball too.",
        sourceTable: "assembled_raw_entity_report",
        predicateFamily: "narrative_motive",
        supportStrength: "moderate",
        confidence: "weak"
      }
    ]
  );

  assert.ok(selected);
  assert.equal(
    selected.candidate.text,
    "John wants to improve his defense, become an all-star, and mentor younger teammates."
  );
});

test("mixed context selection prefers exact canonical set candidates over broad collection reports", () => {
  const selected = selectMixedContextCandidate(
    "What items does John collect?",
    [
      {
        text: "John is sentimental about the things he collects.",
        sourceTable: "canonical_entity_reports",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "collection_report"
      },
      {
        text: "sneakers, fantasy movie DVDs, jerseys",
        sourceTable: "canonical_sets",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "collection_report"
      }
    ]
  );

  assert.ok(selected);
  assert.equal(selected.candidate.text, "sneakers, fantasy movie DVDs, jerseys");
});

test("strict collection candidate selection keeps typed collection-item payloads", () => {
  const finalized = finalizeReportCandidatesForSelection(
    "What items does John collect?",
    "collection_report",
    [
      {
        text: "sneakers, fantasy movie DVDs, and jerseys",
        sourceTable: "canonical_collection_facts",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "collection_report",
        answerPayload: {
          answer_type: "collection_items",
          answer_value: "sneakers, fantasy movie DVDs, and jerseys",
          reason_value: "collects sneakers, fantasy movie DVDs, and jerseys"
        }
      },
      {
        text: "John is sentimental about the things he collects.",
        sourceTable: "canonical_entity_reports",
        predicateFamily: "narrative_profile",
        supportStrength: "strong",
        confidence: "confident",
        reportKind: "collection_report"
      }
    ]
  );

  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.sourceTable, "canonical_collection_facts");
});

test("canonical report synthesis extracts normalized collection fact seeds", () => {
  const seeds = extractCanonicalCollectionFactSeeds({
    texts: ["John collects vintage records and sports memorabilia."]
  });

  assert.deepEqual(
    seeds.map((seed) => ({
      itemValue: seed.itemValue,
      cueType: seed.cueType
    })),
    [
      { itemValue: "vintage records", cueType: "explicit_collects" },
      { itemValue: "sports memorabilia", cueType: "explicit_collects" }
    ]
  );
});

test("canonical report synthesis extracts possessive item collection phrases", () => {
  const seeds = extractCanonicalCollectionFactSeeds({
    texts: ["I love talking to people about my sneaker collection."]
  });

  assert.deepEqual(
    seeds.map((seed) => ({
      itemValue: seed.itemValue,
      cueType: seed.cueType
    })),
    [{ itemValue: "sneakers", cueType: "collection_of" }]
  );
});

test("canonical report synthesis extracts metadata-style dvd collection phrases", () => {
  const seeds = extractCanonicalCollectionFactSeeds({
    texts: ["fantasy movies dvd collection carpet"]
  });

  assert.ok(seeds.some((seed) => seed.cueType === "collection_of" && /fantasy movie DVDs/i.test(seed.itemValue)));
});

test("canonical report synthesis prefers image-query collection phrases over noisy image captions", () => {
  const seeds = extractCanonicalCollectionFactSeeds({
    texts: [
      "Cool! Glad you're enjoying that book! Do you have any favorite fantasy movies as well? These are mine. [image: a photo of a collection of star wars movies on a table] --- image_query: fantasy movies dvd collection carpet --- image_caption: a photo of a collection of star wars movies on a table"
    ]
  });

  assert.deepEqual(
    seeds.map((seed) => ({
      itemValue: seed.itemValue,
      cueType: seed.cueType
    })),
    [{ itemValue: "fantasy movie DVDs", cueType: "collection_of" }]
  );
});

test("canonical report synthesis ignores non-owner compliments about someone else's collection", () => {
  const seeds = extractCanonicalCollectionFactSeeds({
    texts: ["Wow, Tim, that's an awesome book collection!"]
  });

  assert.deepEqual(seeds, []);
});

test("canonical report synthesis extracts speaker-owned collection facts from full multimodal turns", () => {
  const seeds = extractCanonicalCollectionFactSeeds({
    texts: [
      "That's great! Loving it when people are passionate about their work. What kind of collaborations are you involved in for the fan project? I love talking to people about my sneaker collection. [image: a photo of a circle of shoes on the floor in a room] --- image_caption: a photo of a circle of shoes on the floor in a room",
      "That's great Tim! Books and movies make us escape to different places. I like to collect jerseys. [image: a photo of a bunch of basketball jerseys laying on a bed] --- image_query: basketball jerseys collection --- image_caption: a photo of a bunch of basketball jerseys laying on a bed"
    ]
  });

  assert.deepEqual(
    seeds.map((seed) => seed.itemValue).sort(),
    ["jerseys", "sneakers"]
  );
});

test("canonical report synthesis extracts dvd collection facts from full multimodal turns", () => {
  const seeds = extractCanonicalCollectionFactSeeds({
    texts: [
      "Wow, that sounds great, Tim! I love that first movie too, I even have the whole collection! It was so magical! Must've been a dream watching it with your family. [image: a photo of a dvd cover with a castle in the background] --- image_query: harry potter dvd collection --- image_caption: a photo of a dvd cover with a castle in the background"
    ]
  });

  assert.ok(seeds.some((seed) => /harry potter dvds/i.test(seed.itemValue)));
});

test("typed preference extraction captures favorite style statements as exact preference facts", () => {
  const facts = extractPreferenceFacts("Gina's favorite style of dance is Contemporary.", ["Gina"], null);

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.subjectName, "Gina");
  assert.equal(facts[0]?.objectText, "Contemporary");
  assert.equal(facts[0]?.qualifier, "favorite style of dance");
  assert.equal(facts[0]?.domain, "activity");
});

test("typed preference extraction captures top-pick and speaks-to-me dance phrasing", () => {
  const jonFacts = extractPreferenceFacts(
    "I love all dances, but contemporary is my top pick.",
    ["Jon", "Gina"],
    "Jon"
  );
  assert.ok(jonFacts.some((fact) => fact.subjectName === "Jon" && fact.objectText === "contemporary" && fact.qualifier === "favorite style of dance"));

  const ginaFacts = extractPreferenceFacts(
    "Contemporary dance is so expressive and graceful - it really speaks to me.",
    ["Jon", "Gina"],
    "Gina"
  );
  assert.ok(ginaFacts.some((fact) => fact.subjectName === "Gina" && fact.objectText === "Contemporary" && fact.qualifier === "favorite style of dance"));
});

test("typed preference extraction stays speaker-scoped inside mixed-speaker turns", () => {
  const facts = extractPreferenceFacts(
    "Jon: I love all dances, but contemporary is my top pick. Gina: Salsa is fun, but hip hop really speaks to me.",
    ["Jon", "Gina"],
    null
  );

  assert.ok(facts.some((fact) => fact.subjectName === "Jon" && fact.objectText === "contemporary" && fact.qualifier === "favorite style of dance"));
  assert.ok(facts.some((fact) => fact.subjectName === "Gina" && fact.objectText === "hip hop" && fact.qualifier === "favorite style of dance"));
});

test("typed preference extraction ignores generic love statements that are not real preference objects", () => {
  const facts = extractPreferenceFacts(
    "I love the self-acceptance and love theme. My dream is to create a safe and loving home for these kids.",
    ["Caroline"],
    "Caroline"
  );

  assert.equal(facts.length, 0);
});

test("education report summarization infers likely degree fields from policy and community evidence", () => {
  assert.equal(
    summarizeCanonicalReportGroup("education_report", [
      "I'm considering going into policymaking because of my degree and my passion for making a positive impact.",
      "I'm really hoping to get into local politics.",
      "I'm passionate about improving education and infrastructure in our community."
    ]),
    "Political science. Public administration. Public affairs"
  );
  assert.equal(
    summarizeCanonicalReportGroup("education_report", [
      "She wants to become a counselor and support other people.",
      "Helping with mental health and support groups matters a lot to her."
    ]),
    "Psychology, counseling certification"
  );
});
