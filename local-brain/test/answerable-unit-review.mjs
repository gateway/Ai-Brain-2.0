import test from "node:test";
import assert from "node:assert/strict";
import {
  answerableUnitFixtures,
  previewUnitsForFixture,
  toAnswerableUnitMocks
} from "../dist/benchmark/answerable-unit-fixtures.js";
import { scoreAnswerableUnitsForQuery } from "../dist/retrieval/answerable-unit-retrieval.js";
import { selectReaderResult } from "../dist/retrieval/answerable-unit-reader.js";

test("answerable unit fixtures construct expected unit families", () => {
  const fixture = answerableUnitFixtures().find((entry) => entry.name === "audrey_dogs_year");
  const units = previewUnitsForFixture(fixture);
  assert.ok(units.some((unit) => unit.unitType === "participant_turn"));
  assert.ok(units.some((unit) => unit.unitType === "source_sentence"));
  assert.ok(units.some((unit) => unit.unitType === "date_span"));
});

test("reader resolves and abstains on frozen fixtures", () => {
  for (const fixture of answerableUnitFixtures()) {
    const units = previewUnitsForFixture(fixture);
    const candidates = scoreAnswerableUnitsForQuery(fixture.query, toAnswerableUnitMocks(units), []);
    const reader = selectReaderResult(fixture.query, candidates);

    if (!fixture.expectedApplied) {
      assert.equal(candidates.length, 0, `${fixture.name}: candidate count`);
      assert.equal(reader.applied, false, `${fixture.name}: reader applied`);
      continue;
    }

    assert.ok(candidates.length > 0, `${fixture.name}: candidate count`);
    assert.equal(reader.applied, true, `${fixture.name}: reader applied`);
    assert.equal(reader.decision, fixture.expectedDecision, `${fixture.name}: reader decision`);
    if (fixture.expectedClaimIncludes) {
      assert.match((reader.claimText ?? "").toLowerCase(), new RegExp(fixture.expectedClaimIncludes.toLowerCase()));
    }
  }
});
