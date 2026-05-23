import test from "node:test";
import assert from "node:assert/strict";

import { offlineSubstrateAdjudicationStatusForTest } from "../dist/retrieval/offline-substrate-adjudication.js";

function row(metadata = {}, answerValue = "source value") {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    namespace_id: "test",
    subject_entity_id: null,
    pair_subject_entity_id: null,
    query_family: "profile_report",
    exact_detail_family: null,
    predicate_family: "event_memory_state",
    property_key: `event:${metadata.eventFamily ?? "causal_reason_event"}`,
    answer_value: answerValue,
    normalized_answer_value: String(answerValue).toLowerCase(),
    truth_status: "active",
    valid_from: null,
    valid_until: null,
    confidence: 0.84,
    source_table: "namespace_local_offline_substrate",
    source_row_id: null,
    source_scene_id: null,
    source_memory_id: null,
    source_chunk_id: null,
    source_uri: null,
    support_phrase: "Gina said she decided to start the store because she lost her job and loved fashion.",
    source_text: "Gina said she decided to start the store because she lost her job and loved fashion.",
    extractor: "namespace_local_event_centric_v1",
    model_id: "deterministic_event_centric_v1",
    schema_version: "event_memory_state_v1",
    promotion_status: "compiled",
    admissibility_status: "diagnostic",
    rejection_reason: null,
    metadata: {
      diagnosticOnly: true,
      admissionMode: "source_independent",
      expectedAnswerUsedForPromotion: false,
      sourceDerivedFamily: metadata.eventFamily ?? "causal_reason_event",
      sourceDerivedAnswerValue: answerValue,
      queryShape: metadata.queryShape ?? "causal_reason",
      answerShape: metadata.answerShape ?? "reason",
      eventFamily: metadata.eventFamily ?? "causal_reason_event",
      evidenceTriggers: metadata.evidenceTriggers ?? ["because", "lost", "loved"],
      premiseQuotes: metadata.premiseQuotes ?? ["Gina decided because she lost her job and loved fashion."],
      sourceSessionKeys: metadata.sourceSessionKeys ?? ["session_1"],
      listMembers: metadata.listMembers ?? [],
      temporalAnchor: metadata.temporalAnchor ?? null,
      identityClaimType: metadata.identityClaimType ?? null,
      mixedOwner: false,
      inferredIdentityMembershipFromSupport: false,
      ...metadata
    }
  };
}

test("causal reason row with explicit reason renders for why-query", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "Why did Gina decide to start her own clothing store?",
    row({}, "because she lost her job and loved fashion")
  );
  assert.equal(result.status, "renderable");
  assert.equal(result.renderable, true);
  assert.match(result.claimText, /lost her job/u);
});

test("origin causal query rejects downstream benefit as the reason", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "Why did Gina decide to start her own clothing store?",
    row({}, "because now I can expand my clothing store and get closer to my customers")
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "missing_reader_contract");
});

test("causal reason row does not answer who-inspired query unless value is actor-shaped support", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "Who inspired John to start volunteering?",
    row({}, "because volunteering seemed meaningful")
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "query_shape_mismatch");
});

test("favorite title row does not answer about-query without about/content clause", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "What is Joanna's favorite book series about?",
    row(
      {
        eventFamily: "favorite_preference_event",
        sourceDerivedFamily: "favorite_preference_event",
        queryShape: "favorite_preference",
        answerShape: "preference",
        evidenceTriggers: ["favorite"]
      },
      "The Broken Earth trilogy"
    )
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "missing_reader_contract");
});

test("explicit list row requires nonempty listMembers", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "Which bands has Dave enjoyed listening to?",
    row(
      {
        eventFamily: "explicit_list_event",
        sourceDerivedFamily: "explicit_list_event",
        queryShape: "explicit_list",
        answerShape: "list",
        evidenceTriggers: ["enjoyed"],
        listMembers: []
      },
      "Dave enjoyed several bands."
    )
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "weak_list_value");
});

test("explicit list row rejects raw prose members", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "What kind of classes or groups has Audrey joined to take better care of her dogs?",
    row(
      {
        eventFamily: "explicit_list_event",
        sourceDerivedFamily: "explicit_list_event",
        queryShape: "explicit_list",
        answerShape: "list",
        evidenceTriggers: [",", "and"],
        listMembers: ["Audrey: Sounds great! I'm in for the hike with the pups and we can enjoy nature together."]
      },
      "Audrey: Sounds great! I'm in for the hike with the pups and we can enjoy nature together."
    )
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "weak_list_value");
});

test("generic interest evidence cannot answer explicit list queries", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "Which bands has Dave enjoyed listening to?",
    row(
      {
        eventFamily: "interest_evidence_event",
        sourceDerivedFamily: "interest_evidence_event",
        queryShape: "interest_evidence",
        answerShape: "list",
        evidenceTriggers: ["enjoys"],
        listMembers: ["music"]
      },
      "Dave enjoys relaxing hobbies."
    )
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "query_shape_mismatch");
});

test("favorite row rejects generic category labels", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "Which band was Dave's favorite at the music festival in April 2023?",
    row(
      {
        eventFamily: "favorite_preference_event",
        sourceDerivedFamily: "favorite_preference_event",
        queryShape: "favorite_preference",
        answerShape: "preference",
        evidenceTriggers: ["favorite"]
      },
      "favorite albums"
    )
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "value_shape_mismatch");
});

test("dated activity row requires event-local temporal anchor", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "When did Dave see Aerosmith perform live?",
    row(
      {
        eventFamily: "dated_activity_event",
        sourceDerivedFamily: "dated_activity_event",
        queryShape: "date_activity",
        answerShape: "date",
        evidenceTriggers: ["when"],
        temporalAnchor: null
      },
      "Dave saw Aerosmith perform live."
    )
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "temporal_anchor_missing");
});

test("support evidence cannot become identity membership", () => {
  const result = offlineSubstrateAdjudicationStatusForTest(
    "Is John part of the community?",
    row(
      {
        eventFamily: "identity_support_event",
        sourceDerivedFamily: "identity_support_event",
        queryShape: "identity_support",
        answerShape: "identity",
        identityClaimType: "membership"
      },
      "John supports the community."
    )
  );
  assert.equal(result.renderable, false);
  assert.equal(result.status, "identity_inference_blocked");
});
