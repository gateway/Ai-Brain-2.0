import test from "node:test";
import assert from "node:assert/strict";
import { parseDurationText, parseTemporalWindowText } from "../dist/temporal-events/service.js";

test("parses exact calendar dates into exact windows", () => {
  const parsed = parseTemporalWindowText({
    text: "We went to the pride festival on June 9, 2023.",
    referenceNow: "2023-06-10T00:00:00.000Z"
  });
  assert.ok(parsed);
  assert.equal(parsed.exactness, "exact");
  assert.equal(parsed.answerYear, 2023);
  assert.equal(parsed.answerMonth, 6);
  assert.equal(parsed.answerDay, 9);
});

test("parses coarse temporal phrases into bounded windows", () => {
  const parsed = parseTemporalWindowText({
    text: "I started pottery class last year.",
    referenceNow: "2024-01-05T00:00:00.000Z"
  });
  assert.ok(parsed);
  assert.equal(parsed.exactness === "bounded" || parsed.exactness === "inferred", true);
  assert.equal(parsed.answerYear, 2023);
});

test("parses fuzzy mid-to-late month windows", () => {
  const parsed = parseTemporalWindowText({
    text: "I want to fly to the US in mid to late July.",
    referenceNow: "2026-05-19T00:00:00.000Z"
  });
  assert.ok(parsed);
  assert.equal(parsed.answerYear, 2026);
  assert.equal(parsed.answerMonth, 7);
  assert.equal(parsed.answerDay, null);
  assert.equal(parsed.exactness, "bounded");
  assert.equal(parsed.startAt, "2026-07-11T00:00:00.000Z");
  assert.equal(parsed.endAt, "2026-07-31T23:59:59.999Z");
});

test("parses fuzzy season windows", () => {
  const parsed = parseTemporalWindowText({
    text: "I want to go in late summer.",
    referenceNow: "2026-05-19T00:00:00.000Z"
  });
  assert.ok(parsed);
  assert.equal(parsed.answerYear, 2026);
  assert.equal(parsed.timeGranularity, "season");
  assert.equal(parsed.exactness, "bounded");
});

test("parses approximate month-and-a-half durations", () => {
  const parsed = parseDurationText("Stay in the US for about a month and a half after arriving.");
  assert.ok(parsed);
  assert.equal(parsed.normalizedUnit, "month");
  assert.equal(parsed.approximate, true);
  assert.equal(parsed.approximateSeconds, 45 * 24 * 60 * 60);
});
