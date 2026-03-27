import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { answerableUnitFixtures, previewUnitsForFixture, toAnswerableUnitMocks } from "./answerable-unit-fixtures.js";
import { scoreAnswerableUnitsForQuery } from "../retrieval/answerable-unit-retrieval.js";
import { selectReaderResult } from "../retrieval/answerable-unit-reader.js";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function benchmarkResultsDir(): string {
  return path.resolve(process.cwd(), "benchmark-results");
}

export async function runAnswerableUnitReviewBenchmark(): Promise<{
  readonly passed: boolean;
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const fixtures = answerableUnitFixtures();
  const results = fixtures.map((fixture) => {
    const previewUnits = previewUnitsForFixture(fixture);
    const candidates = scoreAnswerableUnitsForQuery(fixture.query, toAnswerableUnitMocks(previewUnits), []);
    const reader = selectReaderResult(fixture.query, candidates);
    const passed =
      fixture.expectedApplied === false
        ? candidates.length === 0 && reader.applied === false
        : reader.applied === true &&
          reader.decision === fixture.expectedDecision &&
          (!fixture.expectedClaimIncludes ||
            (reader.claimText ?? "").toLowerCase().includes(fixture.expectedClaimIncludes.toLowerCase()));
    return {
      name: fixture.name,
      query: fixture.query,
      previewUnitCount: previewUnits.length,
      candidateCount: candidates.length,
      readerApplied: reader.applied,
      readerDecision: reader.decision,
      claimText: reader.claimText,
      passed
    };
  });

  const passed = results.every((result) => result.passed);
  const dir = benchmarkResultsDir();
  await mkdir(dir, { recursive: true });
  const runStamp = stamp();
  const jsonPath = path.join(dir, `answerable-unit-review-${runStamp}.json`);
  const markdownPath = path.join(dir, `answerable-unit-review-${runStamp}.md`);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "answerable_unit_review",
    passed,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length
    },
    results
  };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Answerable Unit Review",
      "",
      `- passed: ${passed}`,
      `- total: ${results.length}`,
      `- failed: ${results.filter((result) => !result.passed).length}`,
      "",
      ...results.map((result) => `- ${result.name}: ${result.passed ? "pass" : "fail"} (${result.readerDecision})`)
    ].join("\n"),
    "utf8"
  );

  return {
    passed,
    jsonPath,
    markdownPath
  };
}
