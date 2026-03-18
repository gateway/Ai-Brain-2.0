import assert from "node:assert/strict";
import test from "node:test";

import { planRecallQuery } from "../dist/retrieval/planner.js";

test("planner keeps year-only historical queries broad and summary-biased", () => {
  const plan = planRecallQuery({
    query: "Who was I with in Japan in 2025?",
    namespaceId: "personal"
  });

  assert.equal(plan.intent, "complex");
  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2025-01-01T00:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2025-12-31T23:59:59.999Z");
  assert.equal(plan.branchPreference, "episodic_then_temporal");
  assert.equal(plan.candidateLimitMultiplier, 6);
  assert.ok(plan.temporalSummaryWeight > plan.episodicWeight);
});

test("planner narrows month-level queries to the month and keeps episodic recall dominant", () => {
  const plan = planRecallQuery({
    query: "What did I do in June 2025?",
    namespaceId: "personal"
  });

  assert.equal(plan.intent, "complex");
  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2025-06-01T00:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2025-06-30T23:59:59.999Z");
  assert.equal(plan.branchPreference, "episodic_then_temporal");
  assert.equal(plan.candidateLimitMultiplier, 4);
  assert.ok(plan.episodicWeight > plan.temporalSummaryWeight);
});

test("planner narrows day-level queries to the day window", () => {
  const plan = planRecallQuery({
    query: "What happened on June 12 2025?",
    namespaceId: "personal"
  });

  assert.equal(plan.intent, "complex");
  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2025-06-12T00:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2025-06-12T23:59:59.999Z");
  assert.equal(plan.candidateLimitMultiplier, 4);
  assert.equal(plan.branchPreference, "episodic_then_temporal");
});

test("planner leaves non-temporal queries in the simple lexical path", () => {
  const plan = planRecallQuery({
    query: "Tell me about OpenClaw markdown ingestion",
    namespaceId: "personal"
  });

  assert.equal(plan.intent, "simple");
  assert.equal(plan.temporalFocus, false);
  assert.equal(plan.branchPreference, "lexical_first");
  assert.equal(plan.candidateLimitMultiplier, 4);
  assert.equal(plan.inferredTimeStart, undefined);
  assert.equal(plan.inferredTimeEnd, undefined);
});
