import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDirectFactCandidatesFromSourceRowsForTest,
  buildDirectFactCandidatesFromSourceTextForTest,
  compileDirectFactCandidate
} from "../dist/taxonomy-temporal/direct-fact-compiler.js";
import { deterministicAssistantCandidates } from "../dist/taxonomy-temporal/assistant.js";

function runFor(candidate, options = {}) {
  const entry = {
    candidate,
    promotionEligible: options.promotionEligible ?? true,
    issues: options.issueCode ? [{ code: options.issueCode, message: options.issueCode, candidateIndex: 0 }] : [],
    normalizedTemporal: null
  };
  return compileDirectFactCandidate({
    entry,
    registry: {
      version: "memory_taxonomy_v1",
      core_object_types: [],
      domains: {},
      families: {},
      temporal_types: [],
      statuses: []
    },
    run: {
      unit: {
        unitId: "00000000-0000-7000-8000-000000000001",
        namespaceId: "direct_fact_test",
        sourceType: options.sourceType ?? "locomo",
        sourceId: "unit",
        sourceMemoryId: null,
        sourceChunkId: null,
        sourceSceneId: null,
        capturedAt: "2026-05-10T00:00:00.000Z",
        speaker: options.speaker ?? null,
        unitIndex: 0,
        charStart: 0,
        charEnd: String(candidate.evidence_quote ?? "").length,
        unitText: candidate.evidence_quote ?? "",
        contextBefore: "",
        contextAfter: "",
        tokenEstimate: 0,
        chunkingStatus: "ready",
        splitReason: "test",
        metadata: options.metadata ?? { promotionMode: "support_and_promote" }
      },
      cache: { status: "bypass", cacheKey: "test", sourceHash: "test" },
      gliner2: { attempted: false, warningCount: 0, response: null, error: null },
      assistant: { mode: "off", provider: "deterministic", model: null, jsonValid: true, skippedReason: null, rawOutput: null, output: null, validationIssues: [], latencyMs: 0 },
      candidates: [],
      metrics: {
        chunkBudgetPass: true,
        jsonValidityPass: true,
        taxonomyCompliancePass: true,
        temporalNormalizationPass: true,
        promotionSafetyPass: true,
        suggestedTaxonomyCount: 0,
        needsClarificationCount: 0
      }
    }
  });
}

function candidate(family, evidence, subject = "Audrey", extra = {}) {
  const base = {
    preference_fact: { domain: "personal", family: "preference", subtype: "explicit_preference", evidence_family: "preference", answer_shape: "atomic_value" },
    owned_object_fact: { domain: "personal", family: "owns", subtype: "owned_object", evidence_family: "owned_object", answer_shape: "atomic_value" },
    purchase_fact: { domain: "personal", family: "purchase", subtype: "purchased_object", evidence_family: "purchase", answer_shape: "atomic_value" },
    project_goal_fact: { domain: "project_ops", family: "project_support", subtype: "project_goal", evidence_family: "project_goal", answer_shape: "atomic_value" },
    health_status_fact: { domain: "health", family: "health_status", subtype: "health_uncertain", evidence_family: "health_status", answer_shape: "atomic_value" },
    causal_reason_fact: { domain: "project_ops", family: "causal_reason", subtype: "decision_reason", evidence_family: "causal_reason", answer_shape: "reason" },
    relationship_status_fact: { domain: "family", family: "relationship_status", subtype: "married", evidence_family: "relationship_status", answer_shape: "yes_no" },
    explicit_list_set: { domain: "personal", family: "explicit_list_set", subtype: "explicit_items", evidence_family: "explicit_list_set", answer_shape: "list" },
    role_position_fact: { domain: "work", family: "role", subtype: "job_title", evidence_family: "role_position", answer_shape: "atomic_value" },
    owned_object_duration_fact: { domain: "personal", family: "owned_object_duration", subtype: "owned_duration", evidence_family: "owned_object_duration", answer_shape: "duration" },
    social_location_fact: { domain: "personal", family: "social_location", subtype: "friend_location", evidence_family: "social_location", answer_shape: "list" },
    residence_fact: { domain: "travel", family: "lives_in", subtype: "current_residence", evidence_family: "residence", answer_shape: "yes_no" },
    date_activity_fact: { domain: "personal", family: "temporal_event", subtype: "exact_date", evidence_family: "date_activity", answer_shape: "atomic_value" }
  }[family];
  return {
    candidate_type: "fact",
    object_type: "CLAIM",
    evidence_quote: evidence,
    subject,
    taxonomy_status: "approved",
    confidence: { gliner2: null, llm_taxonomy: 0.8, llm_temporal: null, evidence: 0.9, overall: 0.84 },
    promotion_recommendation: "promote",
    suggested_taxonomy: null,
    tags: [family],
    ...base,
    ...extra
  };
}

test("direct-fact compiler promotes broad source-bound families", () => {
  const cases = [
    ["preference_fact", "Audrey prefers chicken for dinner.", "chicken for dinner"],
    ["owned_object_fact", "Calvin owns a red bicycle.", "red bicycle"],
    ["purchase_fact", "Calvin bought a Ferrari 488 GTB in March.", "Ferrari 488 GTB in March"],
    ["project_goal_fact", "Dave wants to open a car maintenance shop.", "open a car maintenance shop"],
    ["health_status_fact", "James has suspected obesity as a health problem.", "obesity"],
    ["causal_reason_fact", "Gina started the store because she loved fashion trends and lost her job.", "she loved fashion trends and lost her job"],
    ["relationship_status_fact", "Maria is married to Alex.", "married"],
    ["explicit_list_set", "John collects sneakers, fantasy movie DVDs, and jerseys.", "sneakers, fantasy movie DVDs, and jerseys"],
    ["role_position_fact", "John's position was shooting guard.", "shooting guard"],
    ["owned_object_duration_fact", "Nate has had his first two turtles for three years.", "three years"],
    ["social_location_fact", "Maria made friends at the homeless shelter, gym, and church.", "homeless shelter"],
    ["residence_fact", "James lives in Connecticut.", "Connecticut"],
    ["date_activity_fact", "James went bowling as the recreational activity on March 16.", "bowling as the recreational activity on March 16"]
  ];
  for (const [family, evidence, expectedValue] of cases) {
    const decision = runFor(candidate(family, evidence, evidence.split(" ")[0]));
    assert.equal(decision.handled, true, family);
    assert.equal(decision.family, family);
    assert.equal(decision.promotionStatus, "compiled", family);
    assert.match(decision.value ?? "", new RegExp(expectedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 20), "i"), family);
    assert.ok(decision.supportPhrase, family);
  }
});

test("direct-fact compiler promotes broader LoCoMo source-bound direct facts", () => {
  const cases = [
    ["preference_fact", "Gina says contemporary dance really speaks to me and it is my fav style.", "contemporary"],
    ["project_goal_fact", "Melanie is carving out some me-time each day - running, reading, or playing my violin - as self-care.", "carving out some me-time"],
    ["causal_reason_fact", "Gina always loved fashion trends and finding unique pieces before opening the store.", "loved fashion trends"],
    ["causal_reason_fact", "Jon: Lost my job as a banker yesterday, so I'm gonna take a shot at starting my own business.", "Lost my job"],
    ["causal_reason_fact", "Dave: I love the feeling of taking something broken and making it whole again. That's why I keep doing what I do.", "taking something broken"],
    ["relationship_status_fact", "Caroline is not seeing anyone and has no romantic relationship right now.", "single"],
    ["social_location_fact", "Maria joined a gym and a nearby church.", "gym"],
    ["social_location_fact", "Maria has been busy volunteering at the homeless shelter.", "homeless shelter"],
    ["project_goal_fact", "Dave has always wanted to learn auto engineering and work on building a custom car.", "auto engineering"]
  ];
  for (const [family, evidence, expectedValue] of cases) {
    const decision = runFor(candidate(family, evidence, evidence.split(" ")[0]));
    assert.equal(decision.handled, true, family);
    assert.equal(decision.family, family);
    assert.equal(decision.promotionStatus, "compiled", family);
    assert.match(decision.value ?? "", new RegExp(expectedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 20), "i"), family);
    assert.ok(decision.supportPhrase, family);
  }
});

test("direct-fact compiler extracts broad families from artifact-chunk style source text", () => {
  const candidates = buildDirectFactCandidatesFromSourceTextForTest(`
    Gina: Yeah, me too! Contemporary dance is so expressive and graceful - it really speaks to me.
    Jolene: I'm really into this book called "Sapiens" by Yuval Noah Harari.
    Jolene: Two weeks ago I read "Avalanche" by Neal Stephenson and liked the way it blends science fiction with engineering.
    Jolene: I also love Avalanche by Neal Stephenson because the engineering details are fascinating.
    John: My number one goal is to improve my shooting percentage this season.
    John: I also want to win a championship with the team someday.
    John: Fitting into the new team's style of play was a challenge during pre-season.
    Lost my job as a banker yesterday, so I'm gonna take a shot at starting my own business. Gina: Sorry about your job Jon, but starting your own business sounds awesome!
    James: Users can add their pup's preferences and needs so the dog-sitting app stands out.
    Dave: The shop employs a lot of people from the local community.
    Sam: Wow, that's impressive! How did you get into watercolor painting?
    Evan: Yep, it's a great stress-buster. I started doing this a few years back.
    Deborah: My mother passed away a few years ago.
    Andrew: We tried board games, volunteering at the pet shelter, and wine tasting with my girlfriend.
    Caroline: It'll be tough as a single parent, but I'm up for the challenge!
    Caroline: I've got lots of kids' books- classics, stories from different cultures, educational books, all of that.
    Melanie: What kind of books you got in your library?
  `);
  const byFamily = new Map();
  for (const entry of candidates) {
    const key = entry.evidence_family;
    byFamily.set(key, [...(byFamily.get(key) ?? []), entry]);
  }

  assert.ok((byFamily.get("preference") ?? []).some((entry) => /contemporary|Sapiens|Avalanche/iu.test(String(entry.value ?? ""))));
  assert.ok((byFamily.get("project_support") ?? []).some((entry) => /shooting percentage|championship|team's style|pup's preferences|employs a lot of people/iu.test(String(entry.value ?? ""))));
  assert.ok((byFamily.get("project_support") ?? []).some((entry) => /watercolor painting|stress-buster/iu.test(String(entry.value ?? ""))));
  assert.ok((byFamily.get("causal_reason") ?? []).some((entry) => entry.subject === "Jon" && /lost my job|starting my own business/iu.test(String(entry.value ?? ""))));
  assert.ok((byFamily.get("temporal_event") ?? []).some((entry) => /few years ago/iu.test(String(entry.value ?? ""))));
  assert.ok((byFamily.get("explicit_list_set") ?? []).some((entry) => /board games|pet shelter|wine tasting/iu.test(String(entry.value ?? ""))));
  assert.ok((byFamily.get("relationship_status") ?? []).some((entry) => /single parent/iu.test(String(entry.value ?? ""))));
  assert.ok((byFamily.get("explicit_list_set") ?? []).some((entry) => /children's books|classic children's books|educational books/iu.test(String(entry.value ?? ""))));
  assert.ok(!(byFamily.get("owns") ?? []).some((entry) => /in your library/iu.test(String(entry.value ?? ""))));
  for (const entry of candidates) {
    assert.ok(entry.evidence_quote, String(entry.evidence_family));
    assert.ok(entry.subject, String(entry.evidence_family));
  }
});

test("deterministic assistant maps military service country language to civic identity", () => {
  const candidates = deterministicAssistantCandidates({
    unitText: "John: I recently talked to a military recruiter. I feel drawn to serving my country in this way, and I'm proud to have this opportunity."
  });
  const civic = candidates.find((entry) => entry.family === "civic_identity" || entry.trait_family === "civic_identity");
  assert.ok(civic);
  assert.equal(civic.subject, "John");
  assert.equal(civic.trait_value, "patriotic");
  assert.equal(civic.polarity, "positive");
  assert.match(civic.evidence_quote, /serving my country|military recruiter/iu);
});

test("direct-fact compiler uses bounded adjacent source windows for split dialogue turns", () => {
  const candidates = buildDirectFactCandidatesFromSourceRowsForTest([
    "Gina: What is your favorite style of dance?",
    "Jon: Contemporary is my top pick.",
    "Jon: What is your favorite style?",
    "Gina: Contemporary dance is so expressive and graceful - it really speaks to me.",
    "Joanna: How long have you had your first two turtles?",
    "Nate: I've had them for 3 years now.",
    "James: What makes your dog-sitting app unique?",
    "James: Users can add their pup's preferences and needs so it stands out."
  ]);

  assert.ok(candidates.some((entry) => entry.subject === "Gina" && entry.evidence_family === "preference" && /contemporary/iu.test(String(entry.value ?? ""))));
  assert.ok(candidates.some((entry) => entry.subject === "Jon" && entry.evidence_family === "preference" && /contemporary/iu.test(String(entry.value ?? ""))));
  assert.ok(candidates.some((entry) => entry.subject === "Nate" && entry.evidence_family === "owned_object_duration" && /3 years/iu.test(String(entry.value ?? ""))));
  assert.ok(candidates.some((entry) => entry.subject === "James" && entry.evidence_family === "project_support" && /preferences|needs/iu.test(String(entry.value ?? ""))));
  for (const entry of candidates) {
    assert.ok(entry.evidence_quote, String(entry.evidence_family));
    assert.ok(entry.subject, String(entry.evidence_family));
  }
});

test("direct-fact compiler rejects unsafe promotion cases", () => {
  const missingSubject = runFor(candidate("preference_fact", "prefers chicken for dinner.", null));
  assert.equal(missingSubject.promotionStatus, "rejected");
  assert.equal(missingSubject.rejectionReason, "subject_binding");

  const unknownTaxonomy = runFor(candidate("purchase_fact", "Calvin bought a Ferrari.", "Calvin", {
    taxonomy_status: "needs_taxonomy_review",
    suggested_taxonomy: { key: "luxury_ego_purchase", reason: "too narrow" }
  }), { promotionEligible: false, issueCode: "unknown_family" });
  assert.equal(unknownTaxonomy.promotionStatus, "rejected");
  assert.equal(unknownTaxonomy.rejectionReason, "taxonomy_unknown");

  const mixedOwner = runFor(candidate("purchase_fact", "Morgan and Taylor both discussed Morgan bought a Ferrari.", "Morgan"));
  assert.equal(mixedOwner.promotionStatus, "rejected");
  assert.equal(mixedOwner.rejectionReason, "mixed_owner");

  const genericProfile = runFor(candidate("health_status_fact", "James is a person who has a background in work and career progress.", "James"));
  assert.equal(genericProfile.promotionStatus, "rejected");
  assert.equal(genericProfile.rejectionReason, "generic_profile_prose");

  const creativeMediaMention = runFor(candidate(
    "preference_fact",
    "Joanna loves cool places and said she could write a whole movie when she is out there.",
    "Joanna",
    { value: "I could write a whole movie when she is out there" }
  ));
  assert.equal(creativeMediaMention.promotionStatus, "rejected");
  assert.match(creativeMediaMention.rejectionReason, /^(?:value_shape_mismatch|low_information_value)$/);

  const coMention = runFor(candidate("relationship_status_fact", "Maria and Alex appeared together in a story.", "Maria"));
  assert.equal(coMention.promotionStatus, "rejected");
  assert.equal(coMention.rejectionReason, "mixed_owner");

  const omiSupportOnly = runFor(candidate("preference_fact", "Audrey prefers chicken for dinner.", "Audrey"), {
    sourceType: "omi",
    metadata: { promotionMode: "support_only" }
  });
  assert.equal(omiSupportOnly.promotionStatus, "rejected");
  assert.equal(omiSupportOnly.rejectionReason, "omi_support_only");
});

test("direct-fact compiler rejects low-information conversational fragments", () => {
  const weakCausal = runFor(candidate(
    "causal_reason_fact",
    "Gina: We talked about the store.",
    "Gina",
    { value: "we talked" }
  ));
  assert.equal(weakCausal.promotionStatus, "rejected");

  const weakProject = runFor(candidate(
    "project_goal_fact",
    "Dave: The project is going great.",
    "Dave",
    { value: "going great" }
  ));
  assert.equal(weakProject.promotionStatus, "rejected");
  assert.equal(weakProject.rejectionReason, "low_information_value");

  const weakOwnedObject = runFor(candidate(
    "owned_object_fact",
    "Evan: That helps too.",
    "Evan",
    { value: "helps too" }
  ));
  assert.equal(weakOwnedObject.promotionStatus, "rejected");
  assert.equal(weakOwnedObject.rejectionReason, "low_information_value");

  const causalPositive = runFor(candidate(
    "causal_reason_fact",
    "Gina: I'm passionate about fashion trends and finding unique pieces.",
    "Gina",
    { value: "passionate about fashion trends and finding unique pieces" }
  ));
  assert.equal(causalPositive.promotionStatus, "compiled");

  for (const value of [
    "since we last talked, lots has been happening",
    "I had the chance to do it",
    "I am working on - super excited"
  ]) {
    const weak = runFor(candidate("causal_reason_fact", `Evan: ${value}.`, "Evan", { value }));
    assert.equal(weak.promotionStatus, "rejected", value);
    assert.equal(weak.rejectionReason, "low_information_value", value);
  }
});
