import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeOmiExtractionShadowCaseScore } from "../dist/benchmark/omi-extraction-shadow.js";
import { omiExtractionShadowCases } from "../dist/benchmark/omi-extraction-shadow-cases.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

test("OMI extraction shadow scoring rewards useful project extraction", () => {
  const benchmarkCase = omiExtractionShadowCases().find((entry) => entry.name === "memoir_graph_project");
  assert.ok(benchmarkCase);

  const score = computeOmiExtractionShadowCaseScore({
    benchmarkCase,
    extractor: {
      extractor: "gliner2",
      entities: [{ text: "Ben" }, { text: "Postgres" }],
      relations: [],
      classifications: {
        support_family: ["project_focus"],
        narrative_frame: ["fact"]
      },
      structures: {
        project_support: [
          {
            subject: "Ben",
            project: "memoir AI engine",
            context: "knowledge graph on Postgres"
          }
        ]
      },
      warnings: []
    }
  });

  assert.ok(score.entityHits >= 2);
  assert.ok(score.classificationHits >= 2);
  assert.ok(score.structureHits >= 1);
  assert.ok(score.utilityScore > 0);
});

test("OMI extraction shadow scoring penalizes invalid self-relations", () => {
  const benchmarkCase = omiExtractionShadowCases().find((entry) => entry.name === "omi_two_way_role_shift");
  assert.ok(benchmarkCase);

  const score = computeOmiExtractionShadowCaseScore({
    benchmarkCase,
    extractor: {
      extractor: "gliner2",
      entities: [{ text: "Omi" }, { text: "Two Way" }],
      relations: [{ source: "Omi", target: "Omi", relation: "friend_of" }],
      classifications: {
        support_family: ["relationship"],
        narrative_frame: ["relationship"]
      },
      structures: {
        relationship_support: [{ subject: "Omi", other_person: "Omi" }]
      },
      warnings: []
    }
  });

  assert.ok(score.invalidRelationCount >= 1);
  assert.ok(score.utilityScore < score.entityHits + score.classificationHits + score.structureHits * 2);
});

test("OMI extraction shadow scoring penalizes noisy structures", () => {
  const benchmarkCase = omiExtractionShadowCases().find((entry) => entry.name === "movies_and_shows_recently");
  assert.ok(benchmarkCase);

  const score = computeOmiExtractionShadowCaseScore({
    benchmarkCase,
    extractor: {
      extractor: "gliner2",
      entities: [{ text: "Sinners" }, { text: "Slow Horses" }],
      relations: [],
      classifications: {
        support_family: ["media_reference"],
        narrative_frame: ["fact"]
      },
      structures: {
        media_support: [{ title: "Sinners" }],
        project_support: [{ project: "irrelevant side project" }]
      },
      warnings: []
    }
  });

  assert.ok(score.structureHits >= 1);
  assert.equal(score.noisyStructureCount, 1);
});

test("OMI extraction shadow benchmark reports support-only promotion telemetry", () => {
  const source = readFileSync(join(repoRoot, "src/benchmark/omi-extraction-shadow.ts"), "utf8");
  assert.match(source, /relation_ie_mode:\s*"support_only"/u);
  assert.match(source, /promotionRejectionBreakdown/u);
  assert.match(source, /summarizePromotionForShadowCase/u);
});
