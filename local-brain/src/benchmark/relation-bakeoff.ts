import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runExternalRelationExtractionShadow } from "../relationships/external-ie.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface RelationTuple {
  readonly source: string;
  readonly predicate: string;
  readonly target: string;
}

interface BakeoffCase {
  readonly name: string;
  readonly sourceTag: "replay" | "omi" | "synthetic" | "public";
  readonly text: string;
  readonly expected: readonly RelationTuple[];
}

interface ExtractorScore {
  readonly extractor: string;
  readonly modelId: string | null;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly warningCount: number;
}

interface CaseResult {
  readonly name: string;
  readonly sourceTag: string;
  readonly expected: readonly string[];
  readonly baselinePredicted: readonly string[];
  readonly extractorPredicted: Record<string, readonly string[]>;
}

export interface RelationBakeoffReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly extractorScores: readonly ExtractorScore[];
  readonly caseResults: readonly CaseResult[];
  readonly passed: boolean;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function normalize(value: string | undefined | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function canonicalTuple(tuple: RelationTuple): string {
  const symmetric = new Set(["friend_of", "sibling_of", "works_with"]);
  const source = normalize(tuple.source);
  const target = normalize(tuple.target);
  if (symmetric.has(tuple.predicate)) {
    const ordered = [source, target].sort();
    return `${ordered[0]}|${tuple.predicate}|${ordered[1]}`;
  }
  return `${source}|${tuple.predicate}|${target}`;
}

function baselineRelations(text: string): readonly RelationTuple[] {
  const relations: RelationTuple[] = [];
  const pairMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b.*?\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/u);
  if (/\bfriend|friends|buddy\b/i.test(text) && pairMatch) {
    relations.push({ source: pairMatch[1]!, predicate: "friend_of", target: pairMatch[2]! });
  }
  if (/\bwork(?:ed|ing)? with|coworker|colleague\b/i.test(text) && pairMatch) {
    relations.push({ source: pairMatch[1]!, predicate: "works_with", target: pairMatch[2]! });
  }
  const worksAt = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b.*?\bworks? at\b.*?\b([A-Z][A-Za-z0-9-]+(?:\s+[A-Z][A-Za-z0-9-]+)*)\b/u);
  if (worksAt) {
    relations.push({ source: worksAt[1]!, predicate: "works_at", target: worksAt[2]! });
  }
  const livesIn = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b.*?\blives? in\b.*?\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\b/u);
  if (livesIn) {
    relations.push({ source: livesIn[1]!, predicate: "lives_in", target: livesIn[2]! });
  }
  const workedAt = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b.*?\bworked at\b.*?\b([A-Z][A-Za-z0-9-]+(?:\s+[A-Z][A-Za-z0-9-]+)*)\b/u);
  if (workedAt) {
    relations.push({ source: workedAt[1]!, predicate: "worked_at", target: workedAt[2]! });
  }
  const romantic = text.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b.*?\b(?:dated|partner|romantic)\b.*?\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/u
  );
  if (romantic) {
    relations.push({ source: romantic[1]!, predicate: "was_with", target: romantic[2]! });
  }
  return relations;
}

function bakeoffCases(): readonly BakeoffCase[] {
  return [
    {
      name: "replay_social_friendship",
      sourceTag: "replay",
      text: "Steve and Dan grabbed beers after coworking and both described each other as close friends.",
      expected: [{ source: "Steve", predicate: "friend_of", target: "Dan" }]
    },
    {
      name: "omi_coworking_colleagues",
      sourceTag: "omi",
      text: "Steve was joking with Dan and Rhonda after coworking. Dan is one of Steve's coworkers.",
      expected: [{ source: "Steve", predicate: "works_with", target: "Dan" }]
    },
    {
      name: "synthetic_employer_project",
      sourceTag: "synthetic",
      text: "Steve works at Two-Way and works with Omar on Project Atlas in Chiang Mai.",
      expected: [
        { source: "Steve", predicate: "works_at", target: "Two-Way" },
        { source: "Steve", predicate: "works_with", target: "Omar" },
        { source: "Steve", predicate: "works_on", target: "Project Atlas" }
      ]
    },
    {
      name: "public_profile_residence",
      sourceTag: "public",
      text: "Martin Mark lives in Columbus and works at Northwind Health with Daniel Martinez.",
      expected: [
        { source: "Martin Mark", predicate: "lives_in", target: "Columbus" },
        { source: "Martin Mark", predicate: "works_at", target: "Northwind Health" },
        { source: "Martin Mark", predicate: "works_with", target: "Daniel Martinez" }
      ]
    },
    {
      name: "relationship_transition_historical",
      sourceTag: "synthetic",
      text: "Lauren and Steve dated before, but they are not partners now.",
      expected: [{ source: "Lauren", predicate: "was_with", target: "Steve" }]
    },
    {
      name: "same_name_collision",
      sourceTag: "replay",
      text: "Sarah Kim works with Steve at Two-Way, but Sarah Jones is Steve's sister.",
      expected: [
        { source: "Sarah Kim", predicate: "works_with", target: "Steve" },
        { source: "Sarah Jones", predicate: "sibling_of", target: "Steve" }
      ]
    },
    {
      name: "identity_and_role_phrase",
      sourceTag: "public",
      text: "Caroline is a transgender woman and wants to work with trans people as a counselor.",
      expected: [{ source: "Caroline", predicate: "works_on", target: "trans people" }]
    },
    {
      name: "other_entity_relation_inference",
      sourceTag: "synthetic",
      text: "Milo started mentoring artists through Lantern House after leaving Northwind.",
      expected: [
        { source: "Milo", predicate: "member_of", target: "Lantern House" },
        { source: "Milo", predicate: "worked_at", target: "Northwind" }
      ]
    },
    {
      name: "shared_life_business_overlap",
      sourceTag: "public",
      text: "Jon lost his job as a banker and started a dance studio. Gina lost her job at Door Dash and opened an online clothing store.",
      expected: [
        { source: "Jon", predicate: "works_on", target: "dance studio" },
        { source: "Gina", predicate: "works_on", target: "online clothing store" }
      ]
    },
    {
      name: "causal_motive_language",
      sourceTag: "public",
      text: "After losing his job, Jon decided to start a dance studio because dancing is his passion and he wants to share it with others.",
      expected: [{ source: "Jon", predicate: "works_on", target: "dance studio" }]
    }
  ];
}

function precisionRecallF1(predicted: readonly string[], expected: readonly string[]): { precision: number; recall: number; f1: number } {
  const predictedSet = new Set(predicted);
  const expectedSet = new Set(expected);
  let hits = 0;
  for (const item of predictedSet) {
    if (expectedSet.has(item)) {
      hits += 1;
    }
  }
  const precision = predictedSet.size === 0 ? 0 : hits / predictedSet.size;
  const recall = expectedSet.size === 0 ? 1 : hits / expectedSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3))
  };
}

function toMarkdown(report: RelationBakeoffReport): string {
  const lines = [
    "# Relation Bakeoff Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- relationIeSchemaVersion: ${report.runtime.relationIeSchemaVersion}`,
    `- passed: ${report.passed}`,
    "",
    "## Extractors",
    ""
  ];
  for (const score of report.extractorScores) {
    lines.push(
      `- ${score.extractor}: f1=${score.f1} precision=${score.precision} recall=${score.recall} warnings=${score.warningCount} model=${score.modelId ?? "n/a"}`
    );
  }
  lines.push("", "## Cases", "");
  for (const result of report.caseResults) {
    lines.push(`- ${result.name} (${result.sourceTag})`);
    lines.push(`  - expected: ${result.expected.join(" | ")}`);
    lines.push(`  - baseline: ${result.baselinePredicted.join(" | ") || "none"}`);
    for (const [extractor, predicted] of Object.entries(result.extractorPredicted)) {
      lines.push(`  - ${extractor}: ${predicted.join(" | ") || "none"}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteRelationBakeoffBenchmark(): Promise<{
  readonly report: RelationBakeoffReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const cases = bakeoffCases();
  const shadow = await runExternalRelationExtractionShadow(
    cases.map((entry, index) => ({ sceneIndex: index, text: entry.text }))
  );

  const extractorPredictions = new Map<string, string[]>();
  const extractorWarnings = new Map<string, number>();
  const extractorModels = new Map<string, string | null>();
  const caseResults: CaseResult[] = [];

  for (const [index, entry] of cases.entries()) {
    const sceneResult = shadow.scenes.find((scene) => scene.scene_index === index);
    const expected = entry.expected.map(canonicalTuple);
    const baselinePredicted = baselineRelations(entry.text).map(canonicalTuple);
    const extractorPredicted: Record<string, readonly string[]> = {};

    for (const extractor of sceneResult?.extractors ?? []) {
      const predicted = (extractor.relations ?? [])
        .map((relation) => {
          const source = typeof relation.source === "string" ? relation.source : "";
          const target = typeof relation.target === "string" ? relation.target : "";
          const predicate = typeof relation.relation === "string" ? relation.relation : "";
          if (!source || !target || !predicate) {
            return null;
          }
          const mapped = predicate
            .toLowerCase()
            .replace("romantic partner of", "was_with")
            .replace("friend of", "friend_of")
            .replace("works with", "works_with")
            .replace("works at", "works_at")
            .replace("worked at", "worked_at")
            .replace("works on", "works_on")
            .replace("lives in", "lives_in")
            .replace("lived in", "lived_in")
            .replace("sibling of", "sibling_of")
            .replace("member of", "member_of")
            .replace("met through", "met_through");
          return canonicalTuple({ source, predicate: mapped, target });
        })
        .filter((item): item is string => item !== null);

      extractorPredicted[extractor.extractor] = predicted;
      extractorPredictions.set(extractor.extractor, [...(extractorPredictions.get(extractor.extractor) ?? []), ...predicted]);
      extractorWarnings.set(
        extractor.extractor,
        (extractorWarnings.get(extractor.extractor) ?? 0) + (extractor.warnings?.length ?? 0)
      );
      extractorModels.set(extractor.extractor, extractor.model_id ?? null);
    }

    caseResults.push({
      name: entry.name,
      sourceTag: entry.sourceTag,
      expected,
      baselinePredicted,
      extractorPredicted
    });
  }

  const extractorScores: ExtractorScore[] = [];
  const allExpected = cases.flatMap((entry) => entry.expected.map(canonicalTuple));
  for (const [extractor, predicted] of extractorPredictions.entries()) {
    const metrics = precisionRecallF1(predicted, allExpected);
    extractorScores.push({
      extractor,
      modelId: extractorModels.get(extractor) ?? null,
      warningCount: extractorWarnings.get(extractor) ?? 0,
      ...metrics
    });
  }
  extractorScores.sort((left, right) => right.f1 - left.f1);

  const report: RelationBakeoffReport = {
    generatedAt: new Date().toISOString(),
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        caseCount: cases.length,
        benchmark: "relation_bakeoff"
      }
    }),
    extractorScores,
    caseResults,
    passed: extractorScores.some((score) => score.f1 >= 0.3)
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir(), `relation-bakeoff-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `relation-bakeoff-${stamp}.md`);
  await mkdir(outputDir(), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: { jsonPath, markdownPath }
  };
}

export async function runRelationBakeoffBenchmarkCli(): Promise<void> {
  const { output } = await runAndWriteRelationBakeoffBenchmark();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
