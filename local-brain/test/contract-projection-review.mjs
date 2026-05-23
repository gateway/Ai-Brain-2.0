import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveProjectionSupportState,
  extractAliasCurrentStateProjectionCandidatesForTest,
  extractContinuityCurrentStateProjectionCandidatesForTest,
  extractCurrentStatePurchaseProjectionValuesForTest,
  mapCanonicalEntityReportKindToContract,
  mapCanonicalSetMetadataToContract
} from "../dist/contract-projections/service.js";

test("maps canonical report kinds into projection contracts", () => {
  assert.equal(mapCanonicalEntityReportKindToContract("identity_report"), "identity_profile");
  assert.equal(mapCanonicalEntityReportKindToContract("support_report"), "reasoned_profile_judgment");
  assert.equal(mapCanonicalEntityReportKindToContract("shared_history_report"), null);
});

test("maps canonical set metadata into deterministic list contracts", () => {
  assert.equal(mapCanonicalSetMetadataToContract({ set_kind: "media_mentions", media_kind: "book" }), "book_list");
  assert.equal(mapCanonicalSetMetadataToContract({ set_kind: "transaction_items" }), "inventory_list");
  assert.equal(mapCanonicalSetMetadataToContract({ set_kind: "preference_facts" }), null);
});

test("derives projection completeness without question-shaped logic", () => {
  const listState = deriveProjectionSupportState({
    contractName: "book_list",
    projectionKind: "list",
    entries: [{ displayValue: "Charlotte's Web" }]
  });
  assert.equal(listState.complete, true);
  assert.deepEqual(listState.requiredFields, ["entries"]);

  const reportState = deriveProjectionSupportState({
    contractName: "reasoned_profile_judgment",
    projectionKind: "report",
    summaryText: "She would still pursue counseling because support shaped her goal."
  });
  assert.equal(reportState.complete, true);
  assert.deepEqual(reportState.requiredFields, ["reason_value"]);

  const scalarState = deriveProjectionSupportState({
    contractName: "value_slot",
    projectionKind: "scalar",
    answerPayload: { answer_value: "Spotify" }
  });
  assert.equal(scalarState.complete, true);
  assert.deepEqual(scalarState.requiredFields, ["answer_value"]);
});

test("extracts source-bound current-state purchase projection values", () => {
  const extracted = extractCurrentStatePurchaseProjectionValuesForTest(
    "The speaker reviews everything they bought in Thailand that day, including snacks (a Snickers bar, jelly vitamin C pack), meals (breakfast burrito with fries, caramel latte, an iced latte), and various items from 7-Eleven (toilet paper, yogurt, two bananas, coffee, a sponge, a vitamin C mineral drink, electrolytes pack, and water), plus gas for their scooter. The total spending for the day was 780 baht, approximately 24 USD."
  );

  assert.ok(extracted.itemValues.includes("Snickers bar"));
  assert.ok(extracted.itemValues.includes("toilet paper"));
  assert.ok(extracted.itemValues.includes("gas for your scooter"));
  assert.ok(extracted.totalValues.includes("780 baht"));
  assert.ok(extracted.totalValues.includes("24 USD"));
});

test("extracts source-bound continuity current-state projection candidates", () => {
  const extracted = extractContinuityCurrentStateProjectionCandidatesForTest(
    "So yesterday, I've been working on my AI brain, my Preset Kitchen website, and Bumblebee at Well Inked. My current daily routine is coffee, AI news on Reddit, email, tasks, then work around 10 AM. I need to finish the Preset Kitchen site and protect personal time."
  );
  const values = extracted.map((entry) => `${entry.family}:${entry.value}`);

  assert.ok(values.some((entry) => entry.includes("current_focus") && entry.includes("AI Brain")));
  assert.ok(values.some((entry) => entry.includes("recent_work_recap") && entry.includes("Preset Kitchen")));
  assert.ok(values.some((entry) => entry.includes("daily_routine") && entry.includes("Reddit")));
  assert.ok(values.some((entry) => entry.includes("next_action") && entry.includes("Preset Kitchen")));
  assert.ok(values.some((entry) => entry.includes("current_constraint") && entry.includes("personal time")));
});

test("extracts media titles without promoting non-media called entities", () => {
  const extracted = extractAliasCurrentStateProjectionCandidatesForTest(
    "The speakers chat informally about movies and shows they watched in the past year. They mention watching a vampire-themed film called Sinners, enjoying the TV series Slow Horses, and wanting to see the last Avatar movie. They also talked about a place called Beast Burger and a project called Preset Kitchen."
  );
  const mediaValues = extracted.filter((entry) => entry.family === "media_title_list").map((entry) => entry.value);

  assert.ok(mediaValues.includes("Sinners"));
  assert.ok(mediaValues.includes("Slow Horses"));
  assert.ok(mediaValues.includes("Avatar"));
  assert.ok(!mediaValues.includes("Beast Burger"));
  assert.ok(!mediaValues.includes("Preset Kitchen"));
});

test("extracts food preferences across neighboring sentences and folds spicy food into preference profile", () => {
  const extracted = extractAliasCurrentStateProjectionCandidatesForTest(
    "Two speakers casually discuss their favorite foods and Thai beers. One mentions liking steak, nachos, and burgers, while the other enjoys pad krapow and spicy food. They also rank Thai beers, preferring Leo first, followed by Singha and Chang."
  );
  const foodValues = extracted.filter((entry) => entry.family === "food_preference_list").map((entry) => entry.value);
  const preferenceValues = extracted.filter((entry) => entry.family === "preference_profile_list").map((entry) => entry.value);

  assert.ok(foodValues.includes("nachos"));
  assert.ok(foodValues.includes("spicy food"));
  assert.ok(preferenceValues.includes("spicy food"));
});
