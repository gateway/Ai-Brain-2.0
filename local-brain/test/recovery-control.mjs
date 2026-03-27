import assert from "node:assert/strict";
import test from "node:test";

import {
  assessRecoveryState,
  compareReflectOutcome,
  inferQueryModeHint,
  reflectEligibilityForQueryMode,
  shouldEnterReflect
} from "../dist/retrieval/recovery-control.js";
import { planRecallQuery } from "../dist/retrieval/planner.js";

test("exact-detail queries stay recall-first even when inadequacy is detected", () => {
  const planner = planRecallQuery({
    query: "What color is Audrey's bike?",
    namespaceId: "personal"
  });
  const queryModeHint = inferQueryModeHint("What color is Audrey's bike?", planner);
  const reflectEligibility = reflectEligibilityForQueryMode(queryModeHint);
  const recovery = assessRecoveryState({
    queryText: "What color is Audrey's bike?",
    planner,
    queryModeHint,
    reflectEligibility,
    sufficiency: "weak",
    subjectMatch: "matched",
    evidenceCount: 2,
    exactDetailExtractionEnabled: true,
    exactDetailResolved: false,
    matchedParticipantCount: 1,
    missingParticipantCount: 0
  });

  assert.equal(queryModeHint, "exact_detail");
  assert.equal(reflectEligibility, "never");
  assert.equal(recovery.adequacyStatus, "supported_but_unshapable");
  assert.equal(shouldEnterReflect(reflectEligibility, recovery), false);
});

test("commonality queries surface missing overlap proof", () => {
  const planner = planRecallQuery({
    query: "What do John and Mary have in common?",
    namespaceId: "personal"
  });
  const queryModeHint = inferQueryModeHint("What do John and Mary have in common?", planner);
  const reflectEligibility = reflectEligibilityForQueryMode(queryModeHint);
  const recovery = assessRecoveryState({
    queryText: "What do John and Mary have in common?",
    planner,
    queryModeHint,
    reflectEligibility,
    sufficiency: "weak",
    subjectMatch: "matched",
    evidenceCount: 3,
    exactDetailExtractionEnabled: false,
    exactDetailResolved: false,
    matchedParticipantCount: 1,
    missingParticipantCount: 1
  });

  assert.equal(queryModeHint, "commonality");
  assert.equal(recovery.adequacyStatus, "missing_overlap_proof");
  assert.equal(recovery.missingInfoType, "overlap_proof_missing");
  assert.equal(shouldEnterReflect(reflectEligibility, recovery), true);
});

test("mismatched subject evidence becomes subject-identity recovery", () => {
  const planner = planRecallQuery({
    query: "What color is Audrey's bike?",
    namespaceId: "personal"
  });
  const queryModeHint = inferQueryModeHint("What color is Audrey's bike?", planner);
  const reflectEligibility = reflectEligibilityForQueryMode(queryModeHint);
  const recovery = assessRecoveryState({
    queryText: "What color is Audrey's bike?",
    planner,
    queryModeHint,
    reflectEligibility,
    sufficiency: "supported",
    subjectMatch: "mismatched",
    evidenceCount: 2,
    exactDetailExtractionEnabled: true,
    exactDetailResolved: false,
    matchedParticipantCount: 0,
    missingParticipantCount: 1
  });

  assert.equal(recovery.adequacyStatus, "missing_subject");
  assert.equal(recovery.missingInfoType, "subject_identity_missing");
});

test("reflect outcome only counts as helped when adequacy becomes adequate", () => {
  const helped = compareReflectOutcome(
    { adequacyStatus: "missing_relation_bridge", missingInfoType: "relation_bridge_missing" },
    { adequacyStatus: "adequate" },
    true
  );
  const noGain = compareReflectOutcome(
    { adequacyStatus: "supported_but_unshapable", missingInfoType: "slot_value_missing" },
    { adequacyStatus: "supported_but_unshapable", missingInfoType: "slot_value_missing" },
    true
  );

  assert.deepEqual(helped, { reflectHelped: true, reflectOutcome: "helped" });
  assert.deepEqual(noGain, { reflectHelped: false, reflectOutcome: "no_gain" });
});
