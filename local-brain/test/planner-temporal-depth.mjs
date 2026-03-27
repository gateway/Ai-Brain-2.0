import assert from "node:assert/strict";
import test from "node:test";

import { planRecallQuery } from "../dist/retrieval/planner.js";

test("planner keeps year-only historical queries broad and summary-biased", () => {
  const plan = planRecallQuery({
    query: "Who was I with in Chiang Mai in 2026?",
    namespaceId: "personal"
  });

  assert.equal(plan.intent, "complex");
  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2026-01-01T00:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2026-12-31T23:59:59.999Z");
  assert.equal(plan.branchPreference, "episodic_then_temporal");
  assert.equal(plan.candidateLimitMultiplier, 6);
  assert.ok(plan.temporalSummaryWeight > plan.episodicWeight);
  assert.deepEqual(plan.descendantExpansionOrder, ["month", "week", "day"]);
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
  assert.deepEqual(plan.descendantExpansionOrder, ["week", "day"]);
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
  assert.deepEqual(plan.descendantExpansionOrder, []);
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
  assert.deepEqual(plan.descendantExpansionOrder, ["day"]);
});

test("planner resolves earlier-this-month queries against the reference clock", () => {
  const plan = planRecallQuery({
    query: "What happened earlier this month?",
    namespaceId: "personal",
    referenceNow: "2026-03-23T12:00:00Z"
  });

  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2026-02-28T17:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2026-03-23T12:00:00.000Z");
});

test("planner resolves weekend-before-last relative windows", () => {
  const plan = planRecallQuery({
    query: "What did Steve do the weekend before last?",
    namespaceId: "personal",
    referenceNow: "2026-04-06T12:00:00Z"
  });

  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2026-03-27T17:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2026-03-29T16:59:59.999Z");
});

test("planner resolves explicit season windows", () => {
  const plan = planRecallQuery({
    query: "What happened in summer 2025?",
    namespaceId: "personal"
  });

  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2025-06-01T00:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2025-08-31T23:59:59.999Z");
});

test("planner resolves offset windows after explicit day anchors", () => {
  const plan = planRecallQuery({
    query: "What happened two weeks after March 21 2026?",
    namespaceId: "personal"
  });

  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2026-04-04T00:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2026-04-04T23:59:59.999Z");
});

test("planner keeps later-that-night queries anchored to the explicit day window", () => {
  const plan = planRecallQuery({
    query: "Where did Steve and Jules go later that night after karaoke on March 21 2026?",
    namespaceId: "personal"
  });

  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2026-03-21T00:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2026-03-21T23:59:59.999Z");
});

test("planner preserves day granularity for explicit externally resolved windows", () => {
  const plan = planRecallQuery({
    query: "Where did Steve go the night he met Dan?",
    namespaceId: "personal",
    timeStart: "2026-04-10T00:00:00.000Z",
    timeEnd: "2026-04-10T23:59:59.999Z"
  });

  assert.equal(plan.temporalFocus, true);
  assert.equal(plan.inferredTimeStart, "2026-04-10T00:00:00.000Z");
  assert.equal(plan.inferredTimeEnd, "2026-04-10T23:59:59.999Z");
  assert.deepEqual(plan.descendantExpansionOrder, []);
});
