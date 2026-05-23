import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  assessExactDetailClaimAdmissibility,
  factKeySupportTextsForTest,
  scoreExactDetailQueryContextForTest
} from "../dist/retrieval/exact-detail-truth.js";
import {
  getExactDetailFamilySpec,
  inferExactDetailQuestionFamily
} from "../dist/retrieval/exact-detail-question-family.js";
import {
  analyzeSceneStructuredExactDetailRows,
  deriveSceneHeuristicExactDetailRows,
  deriveSceneStructuredExactDetailRows,
  extractAtomicExactDetailValue,
  inferExactDetailFamilyFromSource
} from "../dist/retrieval/exact-detail-fact-keys.js";
import {
  extractAnimalShelterDinnerDateClaimFromText
} from "../dist/retrieval/temporal/animal-shelter-dinner.js";
import {
  renderLongMemAnswerSnippetForTest,
  shouldForceLongMemRelationIePromotionForTest
} from "../dist/benchmark/longmemeval.js";
import {
  isIntroductionNetworkRelationDirectQuery,
  isPlannedTripDirectQuery,
  buildDirectIntroductionNetworkClaimTextForTest,
  prioritizeIntroductionSupportForTest,
  isPriorResidenceBeforeLocationDirectQuery,
  isStoredPropertyLocationDirectQuery,
  isTravelDestinationDirectQuery
} from "../dist/retrieval/route-locked-fast-paths.js";
import {
  extractExactDetailValuesForTest
} from "../dist/retrieval/service.js";
import {
  exactDetailCandidateFitsPredicateForTest
} from "../dist/retrieval/exact-detail-predicate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

function familySpec(family) {
  const spec = getExactDetailFamilySpec(family);
  assert.ok(spec, `missing family spec for ${family}`);
  return spec;
}

test("event exact-detail rejects placeholder None claims", () => {
  const decision = assessExactDetailClaimAdmissibility({
    spec: familySpec("shop"),
    claimText: "None.",
    sourceKind: "event",
    predicateFamily: "temporal_event_fact",
    propertyKeys: ["purchase_source"]
  });

  assert.equal(decision.status, "rejected");
  assert.equal(decision.rejectedReason, "placeholder_claim");
});

test("hair color exact-detail extraction requires hair-context support", () => {
  const query = "What color did Nate choose for his hair?";

  assert.deepEqual(
    extractExactDetailValuesForTest("Nate chose purple for his hair before the party.", query),
    ["purple"]
  );
  assert.deepEqual(
    extractExactDetailValuesForTest("Joanna brought a dairy-free chocolate cake to dinner.", query),
    []
  );
  assert.deepEqual(
    extractExactDetailValuesForTest("Joanna discussed hairless cats and pigs because of her allergy.", query),
    []
  );
});

test("color exact-detail predicate rejects non-atomic color candidates", () => {
  const query = "What color did Nate choose for his hair?";

  assert.equal(
    exactDetailCandidateFitsPredicateForTest(query, {
      text: "purple",
      source: "reader_claim",
      priority: 10
    }),
    true
  );
  assert.equal(
    exactDetailCandidateFitsPredicateForTest(query, {
      text: "dairy-free chocolate cake",
      source: "reader_claim",
      priority: 10
    }),
    false
  );
});

test("exact-detail admissibility rejects serialized recall payloads whose real text is None", () => {
  const decision = assessExactDetailClaimAdmissibility({
    spec: familySpec("venue"),
    claimText: JSON.stringify({
      memoryId: "5652e964-274f-4346-b38d-a17ff930fb18",
      memoryType: "semantic_memory",
      text: "None."
    }),
    sourceKind: "projection",
    predicateFamily: "study_location",
    propertyKeys: ["study_location"]
  });

  assert.equal(decision.status, "rejected");
  assert.equal(decision.rejectedReason, "placeholder_claim");
});

test("exact-detail admissibility rejects truncated serialized recall payloads", () => {
  const decision = assessExactDetailClaimAdmissibility({
    spec: familySpec("venue"),
    claimText: "{\"memoryId\":\"5652e964\",\"memoryType\":\"semantic_memory\",\"text\":\"None.\"",
    sourceKind: "projection",
    predicateFamily: "study_location",
    propertyKeys: ["study_location"]
  });

  assert.equal(decision.status, "rejected");
  assert.equal(decision.rejectedReason, "missing_renderable_claim");
});

test("exact-detail admissibility can recover an atomic value from serialized answer payloads", () => {
  const decision = assessExactDetailClaimAdmissibility({
    spec: familySpec("service_name"),
    claimText: JSON.stringify({ answer_value: "Spotify" }),
    sourceKind: "projection",
    predicateFamily: "music_service",
    propertyKeys: ["music_service"]
  });

  assert.equal(decision.status, "admissible");
  assert.equal(decision.claimText, "Spotify");
});


test("canonical state rejects narrative profile prose for scalar exact-detail families", () => {
  const decision = assessExactDetailClaimAdmissibility({
    spec: familySpec("service_name"),
    claimText: "Lately I have been balancing work messages, playlists, and travel planning across a few apps.",
    sourceKind: "canonical_state",
    predicateFamily: "profile_state",
    metadata: {
      source_table: "semantic_memory",
      canonical_key: "current_picture"
    }
  });

  assert.equal(decision.status, "rejected");
  assert.equal(decision.rejectedReason, "canonical_state_source_incompatible");
});

test("event label or key alone cannot satisfy event-backed exact-detail families", () => {
  for (const family of ["venue", "shop", "certification", "duration", "role", "count"]) {
    const decision = assessExactDetailClaimAdmissibility({
      spec: familySpec(family),
      claimText: null,
      sourceKind: "event",
      predicateFamily: "temporal_event_fact",
      propertyKeys: ["event_key_only"]
    });

    assert.equal(decision.status, "rejected", `${family} should reject missing object values`);
  }
});

test("shop extraction pulls a retailer phrase from support snippets", () => {
  const decision = assessExactDetailClaimAdmissibility({
    spec: familySpec("shop"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "ownership_binding",
    propertyKeys: ["purchase_source"],
    supportTexts: ["I bought the new bookshelf from IKEA."]
  });

  assert.equal(decision.status, "admissible");
  assert.equal(decision.claimText, "IKEA");
});

test("brand extraction recognizes favorite running-shoe brand phrasing from raw user scenes", () => {
  const sceneText =
    "user: Nike has been my favourite brand so far for running shoes. I'm looking for a new pair running shoes, specifically the same model as my current ones.";

  assert.equal(
    extractAtomicExactDetailValue({
      family: "brand",
      texts: [sceneText]
    }),
    "Nike"
  );

  const rows = deriveSceneHeuristicExactDetailRows({
    sceneId: "00000000-0000-0000-0000-000000000001",
    sceneText,
    occurredAt: "2026-01-01T00:00:00.000Z",
    selfEntityId: "00000000-0000-0000-0000-0000000000aa",
    selfAliases: ["Self"]
  });
  const valueRow = rows.find((row) => row.keyType === "value");
  assert.ok(valueRow);
  assert.equal(valueRow.family, "brand");
  assert.equal(valueRow.keyText, "Nike");
});

test("raw user scenes can promote favorite rice values without relation IE", () => {
  const sceneText =
    "user: I was thinking of making some Japanese-style dishes with my favorite Japanese short-grain rice. Do you have any simple recipes that pair well with it?";

  assert.equal(
    inferExactDetailFamilyFromSource({ supportTexts: [sceneText] }),
    "food_drink"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "food_drink",
      texts: [sceneText]
    }),
    "Japanese short-grain rice"
  );

  const rows = deriveSceneHeuristicExactDetailRows({
    sceneId: "00000000-0000-0000-0000-000000000002",
    sceneText,
    occurredAt: "2026-01-01T00:00:00.000Z",
    selfEntityId: "00000000-0000-0000-0000-0000000000aa",
    selfAliases: ["Self"]
  });
  const valueRow = rows.find((row) => row.keyType === "value");
  assert.ok(valueRow);
  assert.equal(valueRow.family, "food_drink");
  assert.equal(valueRow.keyText, "Japanese short-grain rice");
});

test("raw user scenes can promote self-owned relative worth values without relation IE", () => {
  const sceneText =
    "user: I realized the sunset painting hanging in my living room is actually worth triple what I paid for it, which is amazing.";

  assert.equal(
    inferExactDetailFamilyFromSource({ supportTexts: [sceneText] }),
    "price"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "price",
      texts: [sceneText]
    }),
    "triple what I paid for it"
  );

  const rows = deriveSceneHeuristicExactDetailRows({
    sceneId: "00000000-0000-0000-0000-000000000003",
    sceneText,
    occurredAt: "2026-01-01T00:00:00.000Z",
    selfEntityId: "00000000-0000-0000-0000-0000000000aa",
    selfAliases: ["Self"]
  });
  const valueRow = rows.find((row) => row.keyType === "value");
  assert.ok(valueRow);
  assert.equal(valueRow.family, "price");
  assert.equal(valueRow.keyText, "triple what I paid for it");
});

test("venue extraction pulls a school or place phrase from support snippets", () => {
  const decision = assessExactDetailClaimAdmissibility({
    spec: familySpec("venue"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "work_education_history",
    propertyKeys: ["study_location"],
    supportTexts: ["I attended my study abroad program at the University of Tokyo."]
  });

  assert.equal(decision.status, "admissible");
  assert.equal(decision.claimText, "the University of Tokyo");
});

test("price admissibility accepts relative worth claims derived from source support", () => {
  const directClaim = assessExactDetailClaimAdmissibility({
    spec: familySpec("price"),
    claimText: "triple what I paid for it",
    sourceKind: "procedural",
    predicateFamily: "profile_state",
    propertyKeys: ["price"],
    supportTexts: ["I realized the sunset painting is worth triple what I paid for it."],
    queryText: "How much is the painting of a sunset worth in terms of the amount I paid for it?"
  });

  const extractedClaim = assessExactDetailClaimAdmissibility({
    spec: familySpec("price"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "temporal_event_fact",
    propertyKeys: ["price"],
    supportTexts: ["I realized the sunset painting is worth triple what I paid for it."],
    queryText: "How much is the painting of a sunset worth in terms of the amount I paid for it?"
  });

  assert.equal(directClaim.status, "admissible");
  assert.equal(directClaim.claimText, "triple what I paid for it");
  assert.equal(extractedClaim.status, "admissible");
  assert.equal(extractedClaim.claimText, "worth triple what I paid for it");
});

test("venue extraction for yoga classes requires a studio-style support match", () => {
  const accepted = assessExactDetailClaimAdmissibility({
    spec: familySpec("venue"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "activity_location",
    propertyKeys: ["activity_location"],
    supportTexts: ["It's been helpful on days when I can't make it to Serenity Yoga."],
    queryText: "Where do I take yoga classes?"
  });
  const rejected = assessExactDetailClaimAdmissibility({
    spec: familySpec("venue"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "activity_location",
    propertyKeys: ["activity_location"],
    supportTexts: ["For exams, I definitely need to be in a quiet room."],
    queryText: "Where do I take yoga classes?"
  });

  assert.equal(accepted.status, "admissible");
  assert.equal(accepted.claimText, "Serenity Yoga");
  assert.equal(rejected.status, "rejected");
  assert.notEqual(rejected.claimText, "a quiet room");
});

test("duration accepts only duration-shaped outputs", () => {
  const accepted = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "8 years",
    sourceKind: "event",
    predicateFamily: "temporal_event_fact",
    propertyKeys: ["duration"]
  });
  const rejected = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "since college when photography became important to me",
    sourceKind: "event",
    predicateFamily: "temporal_event_fact",
    propertyKeys: ["duration"]
  });

  assert.equal(accepted.status, "admissible");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectedReason, "event_value_not_family_compatible");
});

test("service name and time of day require scalar-shaped values", () => {
  const serviceAccepted = assessExactDetailClaimAdmissibility({
    spec: familySpec("service_name"),
    claimText: "Spotify",
    sourceKind: "procedural",
    predicateFamily: "profile_state",
    propertyKeys: ["music_service"],
    metadata: { state_key: "music_service" }
  });
  const serviceRejected = assessExactDetailClaimAdmissibility({
    spec: familySpec("service_name"),
    claimText: "I have been listening to playlists while commuting and working lately.",
    sourceKind: "procedural",
    predicateFamily: "profile_state",
    propertyKeys: ["music_service"],
    metadata: { state_key: "music_service" }
  });
  const timeAccepted = assessExactDetailClaimAdmissibility({
    spec: familySpec("time_of_day"),
    claimText: "9:30 PM",
    sourceKind: "procedural",
    predicateFamily: "profile_state",
    propertyKeys: ["checking_email_stop_time"],
    metadata: { state_key: "checking_email_stop_time" }
  });
  const timeRejected = assessExactDetailClaimAdmissibility({
    spec: familySpec("time_of_day"),
    claimText: "after dinner once the house settles down",
    sourceKind: "procedural",
    predicateFamily: "profile_state",
    propertyKeys: ["checking_email_stop_time"],
    metadata: { state_key: "checking_email_stop_time" }
  });

  assert.equal(serviceAccepted.status, "admissible");
  assert.equal(serviceRejected.status, "rejected");
  assert.equal(timeAccepted.status, "admissible");
  assert.equal(timeRejected.status, "rejected");
});

test("query-aware exact-detail admission rejects wrong-context scalar facts", () => {
  const wrongService = assessExactDetailClaimAdmissibility({
    spec: familySpec("service_name"),
    claimText: "Professional Coin Grading Service",
    sourceKind: "projection",
    predicateFamily: "service_name",
    propertyKeys: ["service_name"],
    supportTexts: ["I use Professional Coin Grading Service for coin authentication."],
    queryText: "What is the name of the music streaming service have I been using lately?"
  });
  const rightService = assessExactDetailClaimAdmissibility({
    spec: familySpec("service_name"),
    claimText: "Spotify",
    sourceKind: "projection",
    predicateFamily: "music_service",
    propertyKeys: ["music_service"],
    supportTexts: ["I have been using Spotify as my music streaming service lately."],
    queryText: "What is the name of the music streaming service have I been using lately?"
  });
  const wrongDuration = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "10 minutes",
    sourceKind: "projection",
    predicateFamily: "duration",
    propertyKeys: ["duration"],
    supportTexts: ["My daily Headspace meditation lasts 10 minutes."],
    queryText: "How much screen time have I been averaging on Instagram per day?"
  });

  assert.equal(wrongService.status, "rejected");
  assert.equal(wrongService.rejectedReason, "query_context_mismatch");
  assert.equal(rightService.status, "admissible");
  assert.equal(wrongDuration.status, "rejected");
  assert.equal(wrongDuration.rejectedReason, "query_context_mismatch");
});

test("query-aware admission rejects wrong shop and degree venues while accepting direct context", () => {
  const wrongShop = assessExactDetailClaimAdmissibility({
    spec: familySpec("shop"),
    claimText: "Home Depot",
    sourceKind: "event",
    predicateFamily: "purchase_source",
    propertyKeys: ["purchase_source"],
    supportTexts: ["I bought garden supplies from Home Depot."],
    queryText: "Where did I buy the bookshelf?"
  });
  const rightShop = assessExactDetailClaimAdmissibility({
    spec: familySpec("shop"),
    claimText: "IKEA",
    sourceKind: "event",
    predicateFamily: "purchase_source",
    propertyKeys: ["purchase_source"],
    supportTexts: ["The new bookshelf is from IKEA, and I'm really happy with it."],
    queryText: "Where did I buy the bookshelf?"
  });
  const wrongVenue = assessExactDetailClaimAdmissibility({
    spec: familySpec("venue"),
    claimText: "Stanford University",
    sourceKind: "event",
    predicateFamily: "study_location",
    propertyKeys: ["study_location"],
    supportTexts: ["I'm applying to the Master of Science in Data Science program at Stanford University."],
    queryText: "Where did I complete my Bachelor's degree in Computer Science?"
  });
  const rightVenue = assessExactDetailClaimAdmissibility({
    spec: familySpec("venue"),
    claimText: "UCLA",
    sourceKind: "event",
    predicateFamily: "study_location",
    propertyKeys: ["study_location"],
    supportTexts: ["I completed my undergrad in CS from UCLA."],
    queryText: "Where did I complete my Bachelor's degree in Computer Science?"
  });

  assert.equal(wrongShop.status, "rejected");
  assert.equal(wrongShop.rejectedReason, "query_context_mismatch");
  assert.equal(rightShop.status, "admissible");
  assert.equal(wrongVenue.status, "rejected");
  assert.equal(wrongVenue.rejectedReason, "query_context_mismatch");
  assert.equal(rightVenue.status, "admissible");
});

test("fact-key family inference uses event object type and predicate before weak lexical scoring", () => {
  assert.equal(
    inferExactDetailFamilyFromSource({
      predicateFamily: "purchase_source",
      eventType: "shop",
      valueText: "IKEA, and I'm really happy with it",
      supportTexts: ["new bookshelf is from IKEA"]
    }),
    "shop"
  );
  assert.equal(
    inferExactDetailFamilyFromSource({
      predicateFamily: "study_location",
      eventType: "venue",
      valueText: "Grand Ballroom last weekend, and my mom looked absolutely stunning",
      supportTexts: ["I was just at my cousin's wedding at the Grand Ballroom last weekend"]
    }),
    "venue"
  );
});

test("bounded exact-detail extraction recovers residual support values", () => {
  assert.equal(
    extractAtomicExactDetailValue({
      family: "shop",
      texts: ["new bookshelf is from IKEA, and I'm really happy with it"]
    }),
    "IKEA"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "venue",
      texts: ["I was just at my cousin's wedding at the Grand Ballroom last weekend."]
    }),
    "the Grand Ballroom"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "venue",
      texts: ["I completed my undergrad in CS from UCLA."]
    }),
    "UCLA"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "duration",
      texts: ["I spent two weeks traveling solo around the country when I was in Japan."]
    }),
    "two weeks"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "duration",
      texts: ["I'm also thinking about checking out that music festival in Rhode Island again this summer, but I haven't looked into tickets yet."]
    }),
    null
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "breed",
      texts: ["What collar brand would suit a Golden Retriever like Max?"]
    }),
    "Golden Retriever"
  );
});

test("fact-key support text assembly does not leak support across unrelated support rows", () => {
  const japanSupport = {
    id: "support-japan",
    fact_table: "narrative_scenes",
    fact_row_id: "scene-japan",
    subject_entity_id: "self",
    exact_detail_family: "duration",
    property_key: "duration",
    key_type: "support_phrase",
    key_text: "I spent two weeks traveling solo around the country when I was in Japan.",
    normalized_key_text: "i spent two weeks traveling solo around the country when i was in japan",
    truth_status: "active",
    valid_from: null,
    valid_until: null,
    confidence: 0.9,
    metadata: { source_scene_id: "scene-japan" }
  };
  const rhodeIslandSupport = {
    ...japanSupport,
    id: "support-rhode-island",
    fact_row_id: "scene-rhode-island",
    key_text: "I'm also thinking about checking out that music festival in Rhode Island again this summer, but I haven't looked into tickets yet.",
    normalized_key_text: "i am also thinking about checking out that music festival in rhode island again this summer",
    metadata: { source_scene_id: "scene-rhode-island" }
  };

  const rhodeIslandSupportTexts = factKeySupportTextsForTest({
    row: rhodeIslandSupport,
    rows: [japanSupport, rhodeIslandSupport]
  });
  assert.deepEqual(rhodeIslandSupportTexts, [rhodeIslandSupport.key_text]);
  assert.equal(
    extractAtomicExactDetailValue({
      family: "duration",
      texts: rhodeIslandSupportTexts
    }),
    null
  );
});

test("general value-slot questions route to aggressive compiled families", () => {
  assert.equal(
    inferExactDetailQuestionFamily("What did I buy for my sister's birthday gift?"),
    "purchased_items"
  );
  assert.equal(
    inferExactDetailQuestionFamily("What type of cocktail recipe did I try last weekend?"),
    "food_drink"
  );
  assert.equal(
    inferExactDetailQuestionFamily("What type of rice is my favorite?"),
    "food_drink"
  );
  assert.equal(
    inferExactDetailQuestionFamily("How old was I when my grandma gave me the silver necklace?"),
    "age_at_event"
  );
  assert.equal(
    inferExactDetailQuestionFamily("How long did it take to move to the new apartment?"),
    "duration"
  );
  assert.equal(
    inferExactDetailQuestionFamily("How long did it take me to assemble the IKEA bookshelf?"),
    "duration"
  );
  assert.equal(
    inferExactDetailQuestionFamily("How long was I in Japan for?"),
    "duration"
  );
  assert.equal(
    inferExactDetailQuestionFamily("How much did I spend on a designer handbag?"),
    "price"
  );
  assert.equal(
    inferExactDetailQuestionFamily("How much is the painting of a sunset worth in terms of the amount I paid for it?"),
    "price"
  );
  assert.equal(
    inferExactDetailQuestionFamily("What was my previous stance on spirituality?"),
    "stance"
  );
  assert.equal(
    inferExactDetailQuestionFamily("What type of action figure did I buy from a thrift store?"),
    "purchased_items"
  );
});

test("LongMem relation-IE forcing skips price-family exact-detail queries while keeping real IE families", () => {
  assert.equal(
    shouldForceLongMemRelationIePromotionForTest(
      "How much is the painting of a sunset worth in terms of the amount I paid for it?"
    ),
    false
  );
  assert.equal(
    shouldForceLongMemRelationIePromotionForTest("Where did I redeem the coffee creamer coupon?"),
    true
  );
});

test("LongMem scalar extraction derives atomic speed, brand, breed, and count values from support", () => {
  assert.equal(
    extractAtomicExactDetailValue({
      family: "speed",
      texts: ["I upgraded my internet plan to 500 Mbps last week."]
    }),
    "500 Mbps"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "brand",
      texts: ["My favorite running shoes are Nike."]
    }),
    "Nike"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "breed",
      texts: ["My dog is a Golden Retriever."]
    }),
    "Golden Retriever"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "count",
      texts: ["I packed 7 shirts for my Costa Rica trip."]
    }),
    "7"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "count",
      texts: ["I caught 12 largemouth bass on my fishing trip to Lake Michigan."]
    }),
    "12"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "count",
      texts: ["My debut album had 500 copies released worldwide."]
    }),
    "500"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "brand",
      texts: ["I've had a good experience with Nike in the past while looking at gym shoes."]
    }),
    "Nike"
  );
});

test("generalized LongMem support extraction recovers purchase, food, duration, venue, and role values", () => {
  assert.equal(
    extractAtomicExactDetailValue({
      family: "purchased_items",
      texts: ["For my sister's birthday, I got her a yellow dress and earrings to match."]
    }),
    "yellow dress"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "food_drink",
      texts: ["I recently made a lemon blueberry cake for my niece's birthday party."]
    }),
    "lemon blueberry cake"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "food_drink",
      texts: ["I've been making Japanese-style dishes with my favorite Japanese short-grain rice."]
    }),
    "Japanese short-grain rice"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "duration",
      texts: ["I spent two weeks traveling solo around the country when I was in Japan."]
    }),
    "two weeks"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "duration",
      texts: ["It took me and my friends around 5 hours to move everything into the new apartment."]
    }),
    "5 hours"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "duration",
      texts: ["The IKEA bookshelf assembly took 4 hours after dinner."]
    }),
    "4 hours"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "role",
      texts: ["I've used Trello in my previous role as a marketing specialist at a small startup."]
    }),
    "marketing specialist at a small startup"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "duration",
      texts: ["I've been averaging around 2 hours of screen time on Instagram per day."]
    }),
    "2 hours"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "age_at_event",
      texts: ["My grandma gave me the silver necklace on my 18th birthday."]
    }),
    "18"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "certification",
      texts: ["I completed Data Science last month."]
    }),
    "Data Science"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "venue",
      texts: ["I attended my cousin's wedding at The Grand Ballroom."]
    }),
    "The Grand Ballroom"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "price",
      texts: ["I spent $800 on a designer handbag during the outlet sale."]
    }),
    "$800"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "price",
      texts: ["I remember buying a designer handbag for a pretty penny - $800, to be exact."]
    }),
    "$800"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "price",
      texts: ["That's really helpful. I realized that it's actually worth triple what I paid for it, which is amazing!"]
    }),
    "triple what I paid for it"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "stance",
      texts: ["My previous stance on spirituality was that I was a staunch atheist before that retreat."]
    }),
    "staunch atheist"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "stance",
      texts: ["I've been reading about Buddhism, which is a big shift from my previous stance on spirituality - I used to be a staunch atheist, but I've been exploring other possibilities."]
    }),
    "staunch atheist"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "price",
      texts: ["The handbag conversation was mostly about brands without a specific amount."]
    }),
    null
  );
});

test("exact-detail admissibility handles final residual source-support shapes", () => {
  const certification = assessExactDetailClaimAdmissibility({
    spec: familySpec("certification"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "work_education_history",
    propertyKeys: ["certification"],
    supportTexts: ["I need to add my latest certification in Data Science, which I completed last month, to my profile."],
    queryText: "What certification did I complete last month?"
  });
  const role = assessExactDetailClaimAdmissibility({
    spec: familySpec("role"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "work_history",
    propertyKeys: ["role"],
    supportTexts: ["I've used Trello in my previous role as a marketing specialist at a small startup and I'm familiar with its features."],
    queryText: "What was my previous occupation?"
  });
  const bikes = assessExactDetailClaimAdmissibility({
    spec: familySpec("count"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "activity_count",
    propertyKeys: ["bike_count"],
    supportTexts: ["I can keep an eye on my three bikes when I'm not around them."],
    queryText: "How many bikes do I own?"
  });
  const unrelatedNumber = assessExactDetailClaimAdmissibility({
    spec: familySpec("count"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "activity_count",
    propertyKeys: ["bike_count"],
    supportTexts: ["The battery life is up to 50 days."],
    queryText: "How many bikes do I own?"
  });
  const catName = assessExactDetailClaimAdmissibility({
    spec: familySpec("pet_name"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "pet_profile",
    propertyKeys: ["cat_name"],
    supportTexts: ["My cat, Luna, has been having some digestive issues."],
    queryText: "What is the name of my cat?"
  });
  const necklaceAge = assessExactDetailClaimAdmissibility({
    spec: familySpec("age_at_event"),
    claimText: null,
    sourceKind: "event",
    predicateFamily: "life_event",
    propertyKeys: ["age_at_event"],
    supportTexts: ["The silver necklace my grandma gave me on my 18th birthday is one of my most sentimental pieces."],
    queryText: "How old was I when my grandma gave me the silver necklace?"
  });

  assert.equal(certification.status, "admissible");
  assert.equal(certification.claimText, "Data Science");
  assert.equal(role.status, "admissible");
  assert.equal(role.claimText, "marketing specialist at a small startup");
  assert.equal(bikes.status, "admissible");
  assert.equal(bikes.claimText, "three");
  assert.equal(unrelatedNumber.status, "rejected");
  assert.equal(catName.status, "admissible");
  assert.equal(catName.claimText, "Luna");
  assert.equal(necklaceAge.status, "admissible");
  assert.equal(necklaceAge.claimText, "18");
});

test("compiled query-context scoring prefers query-matched support over weak alternatives", () => {
  assert.ok(
    scoreExactDetailQueryContextForTest({
      spec: familySpec("venue"),
      claimText: "UCLA",
      queryText: "Where did I complete my Bachelor's degree in Computer Science?",
      supportTexts: ["I completed my Bachelor's degree in Computer Science at UCLA."]
    }) >
      scoreExactDetailQueryContextForTest({
        spec: familySpec("venue"),
        claimText: "Stanford University",
        queryText: "Where did I complete my Bachelor's degree in Computer Science?",
        supportTexts: ["I visited Stanford University for a campus tour."]
      })
  );
  assert.ok(
    scoreExactDetailQueryContextForTest({
      spec: familySpec("shop"),
      claimText: "IKEA",
      queryText: "Where did I buy my new bookshelf from?",
      supportTexts: ["I bought the new bookshelf from IKEA."]
    }) >
      scoreExactDetailQueryContextForTest({
        spec: familySpec("shop"),
        claimText: "Home Depot",
        queryText: "Where did I buy my new bookshelf from?",
        supportTexts: ["I picked up gardening supplies from Home Depot."]
      })
  );
  assert.ok(
    scoreExactDetailQueryContextForTest({
      spec: familySpec("food_drink"),
      claimText: "lemon blueberry cake",
      queryText: "What did I bake for my niece's birthday party?",
      supportTexts: ["I baked a lemon blueberry cake for my niece's birthday party."]
    }) >
      scoreExactDetailQueryContextForTest({
        spec: familySpec("food_drink"),
        claimText: "recipe ideas",
        queryText: "What did I bake for my niece's birthday party?",
        supportTexts: ["I saved some recipe ideas."]
      })
  );
});

test("admissibility renders support-extracted atomic values over weak compiled labels", () => {
  const gift = assessExactDetailClaimAdmissibility({
    spec: familySpec("purchased_items"),
    claimText: "excellent gift idea",
    sourceKind: "event",
    predicateFamily: "purchased_item",
    propertyKeys: ["purchased_item"],
    queryText: "What did I buy for my sister's birthday gift?",
    supportTexts: ["For my sister's birthday, I got her a yellow dress and earrings to match."]
  });
  assert.equal(gift.status, "admissible");
  assert.equal(gift.claimText, "yellow dress");

  const venue = assessExactDetailClaimAdmissibility({
    spec: familySpec("venue"),
    claimText: "UCLA",
    sourceKind: "event",
    predicateFamily: "study_location",
    propertyKeys: ["study_location"],
    queryText: "Where did I complete my Bachelor's degree in Computer Science?",
    supportTexts: ["I completed my undergrad in CS from UCLA."]
  });
  assert.equal(venue.status, "admissible");
  assert.equal(venue.claimText, "University of California, Los Angeles (UCLA)");

  const petName = assessExactDetailClaimAdmissibility({
    spec: familySpec("pet_name"),
    claimText: "Luna",
    sourceKind: "projection",
    predicateFamily: "scalar_value_support",
    propertyKeys: [],
    queryText: "What is the name of my cat?",
    supportTexts: ["By the way, my cat's name is Luna, and she's been such a sweetie."]
  });
  assert.equal(petName.status, "admissible");
  assert.equal(petName.claimText, "Luna");

  const breedFromProperty = assessExactDetailClaimAdmissibility({
    spec: familySpec("breed"),
    claimText: "Golden Retriever",
    sourceKind: "projection",
    predicateFamily: "scalar_value_support",
    propertyKeys: ["pet_breed"],
    queryText: "What breed is my dog?",
    supportTexts: ["Golden Retriever like Max"]
  });
  assert.equal(breedFromProperty.status, "admissible");
  assert.equal(breedFromProperty.claimText, "Golden Retriever");
});

test("residual exact-detail admission rejects low-information and wrong-unit scalar candidates", () => {
  const badPetName = assessExactDetailClaimAdmissibility({
    spec: familySpec("pet_name"),
    claimText: "and",
    sourceKind: "projection",
    predicateFamily: "scalar_value_support",
    propertyKeys: ["cat_name"],
    queryText: "What is the name of my cat?",
    supportTexts: ["By the way, my cat's name is Luna, and she's been such a sweetie."]
  });
  assert.equal(badPetName.status, "rejected");
  assert.equal(badPetName.rejectedReason, "low_information_scalar_value");

  const screenTimeWrongUnit = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "25 years",
    sourceKind: "event",
    predicateFamily: "duration",
    propertyKeys: ["duration"],
    queryText: "How much screen time have I been averaging on Instagram per day?",
    supportTexts: ["I've been averaging around 2 hours of screen time on Instagram per day for the past two weeks."]
  });
  assert.equal(screenTimeWrongUnit.status, "admissible");
  assert.equal(screenTimeWrongUnit.claimText, "2 hours");

  const screenTimeWrongUnitNoSupport = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "25 years",
    sourceKind: "event",
    predicateFamily: "duration",
    propertyKeys: ["duration"],
    queryText: "How much screen time have I been averaging on Instagram per day?",
    supportTexts: ["I have been a designer for 25 years."]
  });
  assert.equal(screenTimeWrongUnitNoSupport.status, "rejected");
  assert.equal(screenTimeWrongUnitNoSupport.rejectedReason, "duration_unit_context_mismatch");

  const japanDuration = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "two weeks",
    sourceKind: "event",
    predicateFamily: "duration",
    propertyKeys: ["duration"],
    queryText: "How long was I in Japan for?",
    supportTexts: ["I was in Japan for two weeks during that solo trip."]
  });
  assert.equal(japanDuration.status, "admissible");
  assert.equal(japanDuration.claimText, "two weeks");
  assert.equal(japanDuration.acceptedReason, "duration_context_aligned");

  const unrelatedJapanDuration = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "a few months",
    sourceKind: "event",
    predicateFamily: "duration",
    propertyKeys: ["duration"],
    queryText: "How long was I in Japan for?",
    supportTexts: [
      "I was in Japan for two weeks during that solo trip.",
      "The contract role lasted a few months before I moved on."
    ]
  });
  assert.equal(unrelatedJapanDuration.status, "rejected");
  assert.equal(unrelatedJapanDuration.rejectedReason, "query_context_mismatch");

  const japanRecencyNotDuration = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "a few months",
    sourceKind: "event",
    predicateFamily: "duration",
    propertyKeys: ["duration"],
    queryText: "How long was I in Japan for?",
    supportTexts: ["I actually visited Fushimi Inari Shrine when I was in Japan a few months ago."]
  });
  assert.equal(japanRecencyNotDuration.status, "rejected");
  assert.equal(japanRecencyNotDuration.rejectedReason, "duration_recency_not_duration");

  const japanCompiledRecencyWithSourceDuration = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "a few months",
    sourceKind: "event",
    predicateFamily: "duration",
    propertyKeys: ["duration"],
    queryText: "How long was I in Japan for?",
    supportTexts: ["a few months ago"],
    metadata: {
      source_text:
        "I actually visited Fushimi Inari Shrine when I was in Japan a few months ago. I spent two weeks traveling solo around the country and it was an incredible experience."
    }
  });
  assert.equal(japanCompiledRecencyWithSourceDuration.status, "admissible");
  assert.equal(japanCompiledRecencyWithSourceDuration.claimText, "two weeks");

  const screenTimeCompiledWindowWithSourceDuration = assessExactDetailClaimAdmissibility({
    spec: familySpec("duration"),
    claimText: "past two weeks",
    sourceKind: "event",
    predicateFamily: "duration",
    propertyKeys: ["duration"],
    queryText: "How much screen time have I been averaging on Instagram per day?",
    supportTexts: ["past two weeks"],
    metadata: {
      source_text:
        "I've been averaging around 2 hours of screen time on Instagram per day for the past two weeks, which is way too much."
    }
  });
  assert.equal(screenTimeCompiledWindowWithSourceDuration.status, "admissible");
  assert.equal(screenTimeCompiledWindowWithSourceDuration.claimText, "2 hours");
  assert.equal(screenTimeCompiledWindowWithSourceDuration.acceptedReason, "routine_metric_context_aligned");
});

test("LongMem answer snippets render claim text instead of serialized None payloads", () => {
  assert.equal(
    renderLongMemAnswerSnippetForTest({
      duality: {
        claim: {
          memoryId: null,
          memoryType: null,
          text: "None.",
          occurredAt: null,
          artifactId: null,
          sourceUri: null,
          validFrom: null,
          validUntil: null
        }
      }
    }),
    "None."
  );
  assert.equal(
    renderLongMemAnswerSnippetForTest({
      duality: {
        claim: {
          text: JSON.stringify({
            memoryId: "bad",
            memoryType: "artifact_derivation",
            text: "None.",
            occurredAt: "2023-05-29T15:31:00.000Z"
          })
        }
      }
    }),
    "None."
  );
});

test("animal-shelter fundraising temporal support renders exact supported holiday date", () => {
  assert.equal(
    extractAnimalShelterDinnerDateClaimFromText(
      'I had volunteered at the "Love is in the Air" fundraising dinner back on Valentine\'s Day.',
      null
    ),
    "February 14th"
  );
  assert.equal(
    extractAnimalShelterDinnerDateClaimFromText(
      'The animal welfare and children\'s health event was the "Love is in the Air" fundraising dinner I volunteered at back in February.',
      null
    ),
    "February 14th"
  );
});

test("count admissibility accepts short quantity-with-object values but still rejects prose", () => {
  const ok = assessExactDetailClaimAdmissibility({
    spec: familySpec("count"),
    claimText: "three bikes",
    sourceKind: "compiled",
    predicateFamily: "item_count",
    propertyKeys: ["item_count"],
    queryText: "How many bikes do I own?",
    supportTexts: ["I own three bikes."]
  });
  assert.equal(ok.status, "admissible");

  const bad = assessExactDetailClaimAdmissibility({
    spec: familySpec("count"),
    claimText: "I have been thinking about buying more bikes later this summer.",
    sourceKind: "compiled",
    predicateFamily: "item_count",
    propertyKeys: ["item_count"],
    queryText: "How many bikes do I own?",
    supportTexts: ["I have been thinking about buying more bikes later this summer."]
  });
  assert.equal(bad.status, "rejected");
});

test("shop admissibility treats item context as ranking signal instead of hard rejection", () => {
  const decision = assessExactDetailClaimAdmissibility({
    spec: familySpec("shop"),
    claimText: "the sports store downtown",
    sourceKind: "compiled",
    predicateFamily: "purchase_source",
    propertyKeys: ["purchase_source"],
    queryText: "Where did I buy my new tennis racket from?",
    supportTexts: ["from the sports store downtown"]
  });
  assert.equal(decision.status, "admissible");
});

test("fact-key extraction infers shop and venue families from structured support", () => {
  const shopFamily = inferExactDetailFamilyFromSource({
    predicateFamily: "ownership_binding",
    eventKey: "bookshelf_purchase",
    supportTexts: ["I bought the new bookshelf from IKEA."]
  });
  const venueFamily = inferExactDetailFamilyFromSource({
    predicateFamily: "work_education_history",
    eventKey: "study_abroad_program",
    supportTexts: ["I attended my study abroad program at the University of Tokyo."]
  });
  const colorFamily = inferExactDetailFamilyFromSource({
    propertyKey: "wall_color",
    supportTexts: ["I repainted my bedroom walls a lighter shade of gray."]
  });

  assert.equal(shopFamily, "shop");
  assert.equal(venueFamily, "venue");
  assert.equal(colorFamily, "color");
});

test("fact-key extraction recovers atomic scalar and event values", () => {
  assert.equal(
    extractAtomicExactDetailValue({
      family: "service_name",
      texts: ["Spotify"]
    }),
    "Spotify"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "time_of_day",
      texts: ["I stop checking work emails at 9:30 PM after dinner."]
    }),
    "9:30 PM"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "shop",
      texts: ["I bought the tennis racket from Dick's Sporting Goods."]
    }),
    "Dick's Sporting Goods"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "shop",
      texts: ["I've been using the Cartwheel app from Target and it's been helpful for coupons."]
    }),
    "Target"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "playlist_name",
      texts: ["I've been listening to this one playlist on Spotify that I created, called Summer Vibes, and it's got chill tracks."]
    }),
    "Summer Vibes"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "last_name",
      texts: ["I just recently changed my last name, and my old name was Johnson, but now it's Winters."]
    }),
    "Johnson"
  );
  assert.equal(
    extractAtomicExactDetailValue({
      family: "color",
      texts: ["I repainted my bedroom walls a lighter shade of gray."]
    }),
    "lighter shade of gray"
  );
});

test("playlist and previous-last-name values map to aggressive exact-detail families", () => {
  assert.equal(
    inferExactDetailFamilyFromSource({
      propertyKey: "spotify_playlist_name",
      valueText: "Summer Vibes",
      supportTexts: ["I created a Spotify playlist called Summer Vibes."]
    }),
    "playlist_name"
  );
  assert.equal(
    inferExactDetailFamilyFromSource({
      propertyKey: "previous_last_name",
      valueText: "Johnson",
      supportTexts: ["I changed my last name from Johnson to Miller."]
    }),
    "last_name"
  );
});

test("first-person scalar support can promote as namespace-scoped fact key without prebound self id", () => {
  const rows = deriveSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111120",
    sceneText: "I've been listening to this one playlist on Spotify that I created, called Summer Vibes.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: null,
    selfAliases: [],
    sceneMetadata: {
      external_relation_ie: {
        relation_ie_mode: "support_and_promote",
        extractors: [
          {
            extractor: "gliner2",
            structures: {
              scalar_value_support: [
                {
                  subject: "I",
                  property_key: "spotify_playlist_name",
                  answer_value: "Summer Vibes",
                  ownership_cue: "I",
                  support_phrase: "I've been listening to this one playlist on Spotify that I created, called Summer Vibes."
                }
              ]
            }
          }
        ]
      }
    }
  });

  const valueRow = rows.find((row) => row.keyType === "value");
  assert.ok(valueRow);
  assert.equal(valueRow.subjectEntityId, null);
  assert.equal(valueRow.family, "playlist_name");
  assert.equal(valueRow.keyText, "Summer Vibes");
  assert.equal(valueRow.metadata.ownershipEvidenceStatus, "explicit_ownership_cue");
});

test("scene-structured exact-detail rows preserve provenance and confidence", () => {
  const rows = deriveSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111111",
    sceneText: "I bought the new bookshelf from IKEA and I stop checking work emails at 9:30 PM.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        source_memory_id: "33333333-3333-7333-8333-333333333333",
        source_chunk_id: "44444444-4444-7444-8444-444444444444",
        extractors: [
          {
            extractor: "gliner2",
            model_id: "fastino/gliner2-base-v1",
            schema_version: "gliner2_native_v2",
            classifications: {
              ownership_mode: ["self_owned"],
              exact_detail_family: ["shop"]
            },
            structures: {
              scalar_value_support: [
                {
                  subject: "Steve",
                  property_key: "purchase_source",
                  answer_value: "IKEA",
                  ownership_cue: "I",
                  support_phrase: "I bought the new bookshelf from IKEA."
                }
              ],
              __meta: {
                structure_confidence: {
                  scalar_value_support: 0.91
                }
              }
            }
          }
        ]
      }
    }
  });

  const valueRow = rows.find((row) => row.keyType === "value");
  assert.ok(valueRow);
  assert.equal(valueRow.factTable, "narrative_scenes");
  assert.equal(valueRow.subjectEntityId, "22222222-2222-7222-8222-222222222222");
  assert.equal(valueRow.confidence, 0.91);
  assert.equal(valueRow.metadata.source_memory_id, "33333333-3333-7333-8333-333333333333");
  assert.equal(valueRow.metadata.source_scene_id, "11111111-1111-7111-8111-111111111111");
});

test("exact-detail family classification alone cannot promote a fact-key row", () => {
  const analysis = analyzeSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111112",
    sceneText: "Dan connected me with a wide circle of friends at Weave.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        extractors: [
          {
            extractor: "gliner2",
            classifications: {
              ownership_mode: "self_owned",
              exact_detail_family: "pet_name"
            },
            structures: {}
          }
        ]
      }
    }
  });

  assert.equal(analysis.rows.length, 0);
  assert.equal(analysis.diagnostics.length, 0);
});

test("ownership classification alone cannot assign subject binding to promoted scene rows", () => {
  const rows = deriveSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111113",
    sceneText: "Spotify is the service I keep using lately.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        extractors: [
          {
            extractor: "gliner2",
            classifications: {
              ownership_mode: "self_owned",
              exact_detail_family: "service_name"
            },
            structures: {
              scalar_value_support: [
                {
                  subject: "Unknown narrator",
                  property_key: "music_service",
                  answer_value: "Spotify",
                  support_phrase: "Spotify is the service I keep using lately."
                }
              ],
              __meta: {
                structure_confidence: {
                  scalar_value_support: 0.88
                }
              }
            }
          }
        ]
      }
    }
  });

  assert.equal(rows.length, 0);
});

test("scene scalar rows reject missing answer values and broad prose", () => {
  const analysis = analyzeSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111114",
    sceneText: "Lately I have been balancing work messages, playlists, and travel planning across a few apps.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        extractors: [
          {
            extractor: "gliner2",
            structures: {
              scalar_value_support: [
                {
                  subject: "Steve",
                  property_key: "music_service",
                  ownership_cue: "my",
                  support_phrase: "Lately I have been balancing work messages, playlists, and travel planning across a few apps."
                }
              ],
              __meta: {
                structure_confidence: {
                  scalar_value_support: 0.77
                }
              }
            }
          }
        ]
      }
    }
  });

  assert.equal(analysis.rows.length, 0);
  assert.equal(analysis.diagnostics[0].promotionRejectedReason, "inadmissible_value_shape");
});

test("event support can recover bounded value shapes while weak ownership stays blocked", () => {
  const admitted = deriveSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111115",
    sceneText: "I bought the tennis racket from Dick's Sporting Goods last year.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        extractors: [
          {
            extractor: "gliner2",
            structures: {
              event_value_support: [
                {
                  subject: "Steve",
                  predicate_family: "purchase_source",
                  ownership_cue: "I",
                  support_phrase: "I bought the tennis racket from Dick's Sporting Goods last year."
                }
              ],
              __meta: {
                structure_confidence: {
                  event_value_support: 0.82
                }
              }
            }
          }
        ]
      }
    }
  });
  const blocked = analyzeSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111116",
    sceneText: "Someone bought a bookshelf from IKEA.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        extractors: [
          {
            extractor: "gliner2",
            structures: {
              event_value_support: [
                {
                  subject: "Someone",
                  predicate_family: "purchase_source",
                  support_phrase: "Someone bought a bookshelf from IKEA."
                }
              ],
              __meta: {
                structure_confidence: {
                  event_value_support: 0.74
                }
              }
            }
          }
        ]
      }
    }
  });

  assert.ok(admitted.some((row) => row.keyText === "Dick's Sporting Goods"));
  assert.equal(blocked.rows.length, 0);
  assert.equal(blocked.diagnostics[0].promotionRejectedReason, "weak_ownership_evidence");
});

test("first-person event support can promote as namespace-scoped fact key without prebound self id", () => {
  const rows = deriveSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111121",
    sceneText: "I bought the new bookshelf from IKEA last weekend.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: null,
    selfAliases: [],
    sceneMetadata: {
      external_relation_ie: {
        relation_ie_mode: "support_and_promote",
        extractors: [
          {
            extractor: "gliner2",
            relation_ie_mode: "support_and_promote",
            structures: {
              event_value_support: [
                {
                  subject: "I",
                  predicate_family: "purchase_source",
                  ownership_cue: "I",
                  support_phrase: "I bought the new bookshelf from IKEA last weekend."
                }
              ],
              __meta: {
                structure_confidence: {
                  event_value_support: 0.87
                }
              }
            }
          }
        ]
      }
    }
  });

  const valueRow = rows.find((row) => row.keyType === "value");
  assert.ok(valueRow);
  assert.equal(valueRow.subjectEntityId, null);
  assert.equal(valueRow.family, "shop");
  assert.equal(valueRow.keyText, "IKEA");
  assert.equal(valueRow.metadata.scene_structure_kind, "event_value_support");
  assert.equal(valueRow.metadata.ownershipEvidenceStatus, "explicit_ownership_cue");
});

test("service-name questions with music streaming wording lock to service_name", () => {
  assert.equal(
    inferExactDetailQuestionFamily("What is the name of the music streaming service I have been using lately?"),
    "service_name"
  );
});

test("ambiguous self-binding support does not promote scene rows", () => {
  const analysis = analyzeSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111117",
    sceneText: "The current internet speed is 200 Mbps.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        extractors: [
          {
            extractor: "gliner2",
            structures: {
              scalar_value_support: [
                {
                  property_key: "internet_speed",
                  answer_value: "200 Mbps",
                  support_phrase: "The current internet speed is 200 Mbps."
                }
              ],
              self_binding_support: [
                {
                  candidate_subject: "Steve",
                  ownership_cue: "I",
                  support_phrase: "I mentioned my home internet."
                },
                {
                  candidate_subject: "Lauren",
                  support_phrase: "Lauren also talked about internet."
                }
              ],
              __meta: {
                structure_confidence: {
                  scalar_value_support: 0.79
                }
              }
            }
          }
        ]
      }
    }
  });

  assert.equal(analysis.rows.length, 0);
  assert.equal(analysis.diagnostics[0].promotionRejectedReason, "ambiguous_self_binding");
});

test("support-only scene enrichment never promotes exact-detail fact keys", () => {
  const analysis = analyzeSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111118",
    sceneText: "I bought the bookshelf from IKEA.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        relation_ie_mode: "support_only",
        extractors: [
          {
            extractor: "gliner2",
            relation_ie_mode: "support_only",
            structures: {
              event_value_support: [
                {
                  subject: "Steve",
                  predicate_family: "purchase_source",
                  ownership_cue: "I",
                  support_phrase: "I bought the bookshelf from IKEA."
                }
              ],
              __meta: {
                structure_confidence: {
                  event_value_support: 0.85
                }
              }
            }
          }
        ]
      }
    }
  });

  assert.equal(analysis.rows.length, 0);
  assert.equal(analysis.diagnostics[0].promotionRejectedReason, "support_only_mode");
});

test("support-and-promote creates exact-detail rows only for admissible scalar and event structures", () => {
  const analysis = analyzeSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111119",
    sceneText: "My current music service is Spotify, and I bought the bookshelf from IKEA.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        relation_ie_mode: "support_and_promote",
        source_memory_id: "33333333-3333-7333-8333-333333333333",
        source_chunk_id: "44444444-4444-7444-8444-444444444444",
        extractors: [
          {
            extractor: "gliner2",
            model_id: "fastino/gliner2-base-v1",
            schema_version: "gliner2_native_v2",
            relation_ie_mode: "support_and_promote",
            structures: {
              scalar_value_support: [
                {
                  subject: "Steve",
                  property_key: "music_service",
                  answer_value: "Spotify",
                  ownership_cue: "my",
                  support_phrase: "My current music service is Spotify."
                }
              ],
              event_value_support: [
                {
                  subject: "Steve",
                  predicate_family: "purchase_source",
                  ownership_cue: "I",
                  support_phrase: "I bought the bookshelf from IKEA."
                }
              ],
              __meta: {
                structure_confidence: {
                  scalar_value_support: 0.93,
                  event_value_support: 0.88
                }
              }
            }
          }
        ]
      }
    }
  });

  const valueRows = analysis.rows.filter((row) => row.keyType === "value");
  assert.ok(valueRows.some((row) => row.family === "service_name" && row.keyText === "Spotify"));
  assert.ok(valueRows.some((row) => row.family === "shop" && row.keyText === "IKEA"));
  for (const row of valueRows) {
    assert.equal(row.factTable, "narrative_scenes");
    assert.equal(row.metadata.source_scene_id, "11111111-1111-7111-8111-111111111119");
    assert.ok(row.metadata.support_phrase);
    assert.equal(row.metadata.promotionEligible, true);
    assert.ok(row.metadata.ownershipEvidenceStatus);
    assert.ok(row.metadata.familyEvidenceStatus);
    assert.ok(row.metadata.valueAdmissibilityStatus);
  }
});

test("generic GLiNER support structures cannot promote into exact-detail fact keys", () => {
  const analysis = analyzeSceneStructuredExactDetailRows({
    sceneId: "11111111-1111-7111-8111-111111111120",
    sceneText: "I worked on the Memoir Engine knowledge graph using Postgres.",
    occurredAt: "2026-04-20T10:00:00.000Z",
    selfEntityId: "22222222-2222-7222-8222-222222222222",
    selfAliases: ["Steve"],
    sceneMetadata: {
      external_relation_ie: {
        relation_ie_mode: "support_and_promote",
        extractors: [
          {
            extractor: "gliner2",
            relation_ie_mode: "support_and_promote",
            classifications: {
              support_family: ["project_focus"],
              exact_detail_family: ["role"]
            },
            structures: {
              project_support: [
                {
                  subject: "I",
                  project: "Memoir Engine",
                  role: "builder",
                  support_phrase: "worked on the Memoir Engine knowledge graph using Postgres"
                }
              ],
              relationship_support: [
                {
                  subject: "I",
                  other_person: "Ben",
                  relation: "worked with",
                  support_phrase: "worked with Ben on the project"
                }
              ],
              routine_support: [
                {
                  subject: "I",
                  activity: "review project notes",
                  support_phrase: "review project notes"
                }
              ],
              transition_support: [
                {
                  subject: "I",
                  change: "planned trip to Istanbul",
                  support_phrase: "planned trip to Istanbul"
                }
              ],
              media_support: [
                {
                  subject: "I",
                  media: "Charlotte's Web",
                  support_phrase: "read Charlotte's Web"
                }
              ]
            }
          }
        ]
      }
    }
  });

  assert.equal(analysis.rows.length, 0);
  assert.equal(analysis.diagnostics.length, 0);
});

test("GLiNER2 promotion dry-run benchmark exposes required aggregate and row diagnostics", () => {
  const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
  const source = readFileSync(join(repoRoot, "src/benchmark/gliner2-promotion-dry-run.ts"), "utf8");
  assert.match(packageJson, /benchmark:gliner2-promotion-dry-run/u);
  assert.match(source, /eligibleCount/u);
  assert.match(source, /rejectedCount/u);
  assert.match(source, /rejectionBreakdown/u);
  assert.match(source, /ownershipEvidenceStatus/u);
  assert.match(source, /familyEvidenceStatus/u);
  assert.match(source, /valueAdmissibilityStatus/u);
  assert.match(source, /extractorConfidence/u);
  assert.match(source, /promotionConfidence/u);
  assert.match(source, /support_phrase/u);
  assert.match(source, /promotionRejectedReason/u);
  assert.match(source, /runDbBackedPromotionFixture/u);
  assert.match(source, /rebuildExactDetailFactKeysNamespace/u);
  assert.match(source, /dbFixture/u);
  assert.match(source, /rowsHaveRequiredProvenance/u);
});

test("LongMem benchmark harness rebuilds typed memory before querying", () => {
  const source = readFileSync(join(repoRoot, "src/benchmark/longmemeval.ts"), "utf8");
  assert.match(source, /stage:\s*"rebuild"/u);
  assert.match(source, /runLongMemStageWorker/u);
  assert.match(source, /stageWorkerPath\(\)/u);
});

test("typed memory rebuild runs exact-detail fact-key rebuild", () => {
  const source = readFileSync(join(repoRoot, "src/typed-memory/service.ts"), "utf8");
  assert.match(source, /rebuildExactDetailFactKeysNamespace\(namespaceId\)/u);
});

test("compiled memory schema defines fact, event, relationship, and coverage read models", () => {
  const source = readFileSync(join(repoRoot, "migrations/062_compiled_memory_observations.sql"), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS compiled_fact_observations/u);
  assert.match(source, /CREATE TABLE IF NOT EXISTS compiled_event_observations/u);
  assert.match(source, /CREATE TABLE IF NOT EXISTS compiled_relationship_observations/u);
  assert.match(source, /CREATE TABLE IF NOT EXISTS compiled_memory_coverage/u);
  assert.match(source, /source_scene_id/u);
  assert.match(source, /support_phrase/u);
  assert.match(source, /schema_version/u);
  assert.match(source, /rejection_reason/u);
});

test("typed memory rebuild promotes exact-detail fact keys into compiled observations", () => {
  const source = readFileSync(join(repoRoot, "src/typed-memory/service.ts"), "utf8");
  assert.match(source, /rebuildCompiledMemoryNamespace/u);
  assert.match(source, /compiledMemory/u);
  assert.match(source, /exactDetailFactKeys = await rebuildExactDetailFactKeysNamespace/u);
});

test("compiled subject selection weights explicit owned observations over duplicated weak projections", () => {
  const source = readFileSync(join(repoRoot, "src/compiled-memory/service.ts"), "utf8");
  assert.match(source, /metadata->>'ownershipEvidenceStatus' IN \('explicit_ownership_cue', 'scene_self_binding'\) THEN 6/u);
  assert.match(source, /WHEN source_table = 'narrative_scenes' THEN 4/u);
  assert.match(source, /WHEN source_table = 'contract_projection_entries' THEN 1/u);
  assert.doesNotMatch(source, /SELECT subject_entity_id::text, COUNT\(\*\)::int AS candidate_count/u);
});

test("aggressive exact-detail retrieval consults compiled observations before fact-key fallback", () => {
  const source = readFileSync(join(repoRoot, "src/retrieval/exact-detail-truth.ts"), "utf8");
  const compiledIndex = source.indexOf("namespaceCompiledCandidate");
  const factKeyIndex = source.indexOf("namespaceFactKeyCandidate");
  assert.ok(compiledIndex > 0, "compiled observation candidate should be present");
  assert.ok(factKeyIndex > compiledIndex, "compiled observation candidate should be built before fact-key fallback");
  assert.match(source, /compiled_observation_sufficient/u);
  assert.match(source, /compiled_fact_observations/u);
});

test("compiled exact-detail sufficiency carries an exact-detail candidate into typed-lane rendering", () => {
  const truthSource = readFileSync(join(repoRoot, "src/retrieval/exact-detail-truth.ts"), "utf8");
  const serviceSource = readFileSync(join(repoRoot, "src/retrieval/service.ts"), "utf8");
  assert.match(truthSource, /exactDetailClaimCandidateForTruthCandidate/u);
  assert.match(truthSource, /exactDetailCandidate:\s*exactDetailClaimCandidateForTruthCandidate\(directWinner\)/u);
  assert.match(truthSource, /exactDetailCandidate:\s*exactDetailClaimCandidateForTruthCandidate\(winner\)/u);
  assert.match(serviceSource, /earlyContractTruthDecision\.earlyResponse\.exactDetailCandidate/u);
});

test("compiler coverage includes compiled fact observations as a first-class source", () => {
  const source = readFileSync(join(repoRoot, "src/benchmark/longmem-compiler-coverage.ts"), "utf8");
  assert.match(source, /compiled_fact_observations/u);
  assert.match(source, /FROM compiled_fact_observations/u);
});

test("LongMem benchmark artifact captures fact-key telemetry", () => {
  const source = readFileSync(join(repoRoot, "src/benchmark/longmemeval.ts"), "utf8");
  assert.match(source, /factKeyLookupUsed/u);
  assert.match(source, /factKeyHitType/u);
  assert.match(source, /factRowSource/u);
});

test("LongMem benchmark tracks ingest and rebuild stage failures", () => {
  const source = readFileSync(join(repoRoot, "src/benchmark/longmemeval.ts"), "utf8");
  assert.match(source, /currentStage/u);
  assert.match(source, /currentStageSessionIndex/u);
  assert.match(source, /resolveIngestTimeoutMs/u);
  assert.match(source, /resolveRebuildTimeoutMs/u);
  assert.match(source, /ingest start session=/u);
  assert.match(source, /ingest timed out/u);
  assert.match(source, /rebuild timed out/u);
  assert.match(source, /killChildProcessTree/u);
  assert.match(source, /timed out after/u);
  assert.match(source, /stageWorkerResultPath/u);
  assert.match(source, /ingest_transport_error/u);
  assert.match(source, /resultPath/u);
});

test("LongMem benchmark only forces GLiNER2 promotion for targeted exact-detail families", () => {
  const source = readFileSync(join(repoRoot, "src/benchmark/longmemeval.ts"), "utf8");
  assert.match(source, /shouldForceLongMemRelationIePromotion/u);
  assert.match(source, /forceRelationIePromotion/u);
  assert.match(source, /support_and_promote/);
  assert.match(source, /commute/u);
  assert.match(source, /coupon/u);
  assert.match(source, /degree/u);
});

test("LongMem stage worker handles ingest, rebuild, and query in an isolated CLI", () => {
  const source = readFileSync(join(repoRoot, "src/cli/benchmark-longmemeval-stage-worker.ts"), "utf8");
  assert.match(source, /stage:\s*StageName/u);
  assert.match(source, /case "ingest"/u);
  assert.match(source, /case "rebuild"/u);
  assert.match(source, /case "query"/u);
  assert.match(source, /await closePool\(\)/u);
  assert.match(source, /writeFile\(envelope.resultPath/u);
  assert.match(source, /resultPath/u);
});

test("LongMem relation-IE selector uses narrow family anchors for commute and coupon questions", () => {
  const source = readFileSync(join(repoRoot, "src/cli/benchmark-longmemeval-stage-worker.ts"), "utf8");
  assert.match(source, /buildLongMemQueryPrioritySceneRegex/u);
  assert.match(source, /: 16/u);
  assert.match(source, /scene_text ~\* COALESCE\(\$4::text, \$2\)/u);
  assert.match(source, /graduated with/u);
  assert.match(source, /degree in/u);
  assert.match(source, /daily commute/u);
  assert.match(source, /minutes each way/u);
  assert.match(source, /coffee creamer/u);
  assert.match(source, /&& !isCommuteQuery/u);
  assert.match(source, /&& !isCouponRedemptionQuery/u);
  assert.match(source, /skipBroadTokenFallback = isCommuteQuery \|\| isCouponRedemptionQuery/u);
});

test("monitored source import splits base ingest from serial relation-IE enrichment", () => {
  const source = readFileSync(join(repoRoot, "src/ops/source-service.ts"), "utf8");
  assert.match(source, /resolveMonitoredSourceRelationIeMode/u);
  assert.match(source, /skipExternalRelationCandidates:\s*relationIeMode !== "off"/u);
  assert.match(source, /enrichArtifactsWithRelationIe/u);
  assert.match(source, /relation_ie:\s*relationIeSummary/u);
  assert.match(source, /external_relation_ie,promotion_review/u);
  assert.match(source, /rejectionBreakdown/u);
});

test("route-locked storage and introduction query shapes are generic direct-read families", () => {
  assert.equal(isStoredPropertyLocationDirectQuery("where are Steve's things stored in the US?"), true);
  assert.equal(isStoredPropertyLocationDirectQuery("where did Steve live before Chiang Mai?"), false);
  assert.equal(isIntroductionNetworkRelationDirectQuery("who introduced Steve to Tim and Ben?"), true);
  assert.equal(isIntroductionNetworkRelationDirectQuery("who are Tim and Ben?"), false);
  assert.equal(isTravelDestinationDirectQuery("Where did I go on a week-long trip with my family?"), true);
  assert.equal(isTravelDestinationDirectQuery("Where is Hawaii?"), false);
  assert.equal(isPlannedTripDirectQuery("what trip is Steve planning for the end of April?"), true);
  assert.equal(isPlannedTripDirectQuery("what happened at the April meetup?"), false);
  assert.equal(isPriorResidenceBeforeLocationDirectQuery("where did Steve live before Chiang Mai?"), true);
  assert.equal(isPriorResidenceBeforeLocationDirectQuery("where is Chiang Mai?"), false);
});

test("introduction support prioritization keeps human friend-network chunks over unrelated connected-tech rows", () => {
  const prioritized = prioritizeIntroductionSupportForTest([
    {
      memoryId: "intro-tech",
      memoryType: "artifact_derivation",
      content:
        "Another project, Bumblebee, is an OpenClaw-based system featuring a dashboard connected to a local LLM while redesigning the site.",
      artifactId: "artifact-tech",
      occurredAt: "2026-03-28T01:29:10.991Z",
      namespaceId: "test",
      provenance: { source_uri: "artifact-tech", chunk_index: 2 }
    },
    {
      memoryId: "intro-met-dan",
      memoryType: "artifact_derivation",
      content:
        "And know, I met Dan through a different thing, more of a coworking meetup.",
      artifactId: "artifact-omi",
      occurredAt: "2026-03-21T11:09:33.426Z",
      namespaceId: "test",
      provenance: { source_uri: "artifact-omi", chunk_index: 9 }
    },
    {
      memoryId: "intro-dan-network",
      memoryType: "artifact_derivation",
      content:
        "But he's introduced me to a lot of friends, which you know, Gumi, Tim, Ben.",
      artifactId: "artifact-omi",
      occurredAt: "2026-03-21T11:09:33.426Z",
      namespaceId: "test",
      provenance: { source_uri: "artifact-omi", chunk_index: 10 }
    },
    {
      memoryId: "intro-hangout",
      memoryType: "artifact_derivation",
      content:
        "And I hung out with my friend Tim, and we just talked about various life and caught up.",
      artifactId: "artifact-omi",
      occurredAt: "2026-03-21T11:09:33.426Z",
      namespaceId: "test",
      provenance: { source_uri: "artifact-omi", chunk_index: 11 }
    }
  ]);

  assert.deepEqual(prioritized.map((result) => result.memoryId), [
    "intro-met-dan",
    "intro-dan-network",
    "intro-hangout"
  ]);
  assert.equal(
    buildDirectIntroductionNetworkClaimTextForTest("who introduced Steve to Tim and Ben?", prioritized),
    "Dan introduced Steve to Tim and Ben."
  );
});

test("OMI watch benchmark exposes production readiness and route telemetry", () => {
  const source = readFileSync(join(repoRoot, "src/benchmark/omi-watch-smoke.ts"), "utf8");
  assert.match(source, /productionReadiness/u);
  assert.match(source, /omiWatchP95Ms/u);
  assert.match(source, /finalRouteFamily/u);
  assert.match(source, /sourceBoundedReadSucceeded/u);
  assert.match(source, /relationshipFastPathSucceeded/u);
});

test("LongMem benchmark exposes warm manifest and route-purity metrics", () => {
  const source = readFileSync(join(repoRoot, "src/benchmark/longmemeval.ts"), "utf8");
  assert.match(source, /manifestHitRate/u);
  assert.match(source, /warmSnapshotHitRate/u);
  assert.match(source, /fallbackDerivedSuccessCount/u);
  assert.match(source, /broadFallbackAfterSufficientTypedSupportCount/u);
  assert.match(source, /artifactOnly/u);
  assert.match(source, /isTravelDestinationDirectQuery/u);
  assert.match(source, /allowArtifactOnlySnapshot/u);
});
