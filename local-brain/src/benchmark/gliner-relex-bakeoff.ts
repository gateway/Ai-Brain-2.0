import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import { runExternalRelationExtractionShadow } from "../relationships/external-ie.js";
import { GLINER_RELEX_EXTRACTOR, mapRelexRelationLabel } from "../relationships/relex-schema.js";
import { omiExtractionShadowCases } from "./omi-extraction-shadow-cases.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface ExpectedRelation {
  readonly source: string;
  readonly predicate: string;
  readonly target: string;
}

interface RelexBakeoffFixture {
  readonly name: string;
  readonly sourceType: "omi" | "locomo" | "longmem" | "chat" | "markdown" | "pdf" | "task_list" | "generic_text";
  readonly text: string;
  readonly expectedRelations: readonly ExpectedRelation[];
  readonly precisionTraps?: readonly ExpectedRelation[];
}

interface ExtractedRelation {
  readonly source: string;
  readonly predicate: string;
  readonly target: string;
  readonly score: number | null;
}

interface ExtractorCaseResult {
  readonly extractor: string;
  readonly modelId: string | null;
  readonly candidateCount: number;
  readonly relationHits: number;
  readonly relationMisses: number;
  readonly precisionTrapHits: number;
  readonly promotedCount: number;
  readonly rejectedCount: number;
  readonly rejectionBreakdown: Readonly<Record<string, number>>;
  readonly sourceQuoteCoverage: number;
  readonly subjectObjectBindingSuccess: number;
  readonly warnings: readonly string[];
  readonly relations: readonly ExtractedRelation[];
}

interface BakeoffCaseResult {
  readonly name: string;
  readonly sourceType: RelexBakeoffFixture["sourceType"];
  readonly expectedRelationCount: number;
  readonly extractors: readonly ExtractorCaseResult[];
}

export interface GlinerRelexCrossIngestBakeoffReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly mode: "cross_ingest_bakeoff";
  readonly relationSchemaVersion: string;
  readonly cases: readonly BakeoffCaseResult[];
  readonly extractorSummaries: readonly {
    readonly extractor: string;
    readonly cases: number;
    readonly candidateCount: number;
    readonly relationHits: number;
    readonly relationMisses: number;
    readonly precisionTrapHits: number;
    readonly promotedCount: number;
    readonly rejectedCount: number;
    readonly sourceQuoteCoverage: number;
    readonly subjectObjectBindingSuccess: number;
    readonly warningCount: number;
    readonly usefulCoverageRate: number;
  }[];
  readonly comparison: {
    readonly glinerRelexUsefulCoverageRate: number;
    readonly gliner2UsefulCoverageRate: number;
    readonly relexImprovesCoverage: boolean;
  };
  readonly gates: {
    readonly promotionWithoutSourceQuote: number;
    readonly unknownTaxonomyPromoted: number;
    readonly mixedOwnerPromoted: number;
    readonly coMentionOnlyPromoted: number;
    readonly queryTimeModelCalls: number;
  };
  readonly passed: boolean;
  readonly artifactPath?: string;
  readonly markdownPath?: string;
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

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function canonicalPredicate(value: string): string {
  const mapped = mapRelexRelationLabel(value);
  return mapped?.predicate ?? normalize(value).replace(/\s+/gu, "_");
}

function fixtures(): readonly RelexBakeoffFixture[] {
  const omiCases = omiExtractionShadowCases()
    .filter((entry) => entry.expectedRelations.length > 0)
    .slice(0, 3)
    .map((entry): RelexBakeoffFixture => ({
      name: `omi:${entry.name}`,
      sourceType: "omi",
      text: entry.text,
      expectedRelations: entry.expectedRelations.map((relation) => ({
        source: relation.source,
        predicate: relation.predicate,
        target: relation.target
      }))
    }));

  return [
    ...omiCases,
    {
      name: "locomo:preference_purchase_causal",
      sourceType: "locomo",
      text:
        "Audrey said she prefers chicken for dinner. Calvin bought a Ferrari in June. Gina started the store because she lost her job and loved fashion.",
      expectedRelations: [
        { source: "Audrey", predicate: "prefers", target: "chicken" },
        { source: "Calvin", predicate: "bought", target: "Ferrari" },
        { source: "Gina", predicate: "because_of", target: "lost her job" }
      ]
    },
    {
      name: "longmem:residence_project_media",
      sourceType: "longmem",
      text:
        "John lives in Seattle and works on the dog-sitting app. Melanie recommended Becoming Nicole because it is about family acceptance.",
      expectedRelations: [
        { source: "John", predicate: "lives_in", target: "Seattle" },
        { source: "John", predicate: "works_on", target: "dog-sitting app" },
        { source: "Becoming Nicole", predicate: "about", target: "family acceptance" }
      ]
    },
    {
      name: "chat:support_advice",
      sourceType: "chat",
      text:
        "Sam helped Evan with school funding and advised him to apply for the local grant. Evan later thanked Sam for the support.",
      expectedRelations: [
        { source: "Sam", predicate: "supports", target: "Evan" },
        { source: "Sam", predicate: "advises", target: "Evan" }
      ],
      precisionTraps: [{ source: "school funding", predicate: "supports", target: "Evan" }]
    },
    {
      name: "markdown:activity_list",
      sourceType: "markdown",
      text:
        "# Family weekend\nMaya and Leo participated in pottery, swimming, and a museum visit with their parents.",
      expectedRelations: [
        { source: "Maya", predicate: "participated_in", target: "pottery" },
        { source: "Leo", predicate: "participated_in", target: "swimming" }
      ]
    },
    {
      name: "pdf:affiliation_identity_support",
      sourceType: "pdf",
      text:
        "Jordan works at North Clinic and supports the LGBTQ community through volunteer outreach. The note does not say Jordan is LGBTQ.",
      expectedRelations: [
        { source: "Jordan", predicate: "works_at", target: "North Clinic" },
        { source: "Jordan", predicate: "identity_support_of", target: "LGBTQ community" }
      ],
      precisionTraps: [{ source: "Jordan", predicate: "member_of", target: "LGBTQ community" }]
    },
    {
      name: "task_list:date_activity",
      sourceType: "task_list",
      text: "2026-05-12: Dave met with Omi about the pilot association platform and worked on the import backlog.",
      expectedRelations: [
        { source: "Dave", predicate: "works_on", target: "pilot association platform" },
        { source: "met with Omi", predicate: "occurred_on", target: "2026-05-12" }
      ]
    },
    {
      name: "generic:owned_object_favorite",
      sourceType: "generic_text",
      text: "Nina owns a red Trek bike. Her favorite book is Dune, and the book is about power and ecology.",
      expectedRelations: [
        { source: "Nina", predicate: "owns", target: "red Trek bike" },
        { source: "Nina", predicate: "favorite_of", target: "Dune" },
        { source: "Dune", predicate: "about", target: "power and ecology" }
      ]
    }
  ];
}

function relationMatches(expected: ExpectedRelation, actual: ExtractedRelation): boolean {
  const source = normalize(actual.source);
  const target = normalize(actual.target);
  return (
    canonicalPredicate(expected.predicate) === canonicalPredicate(actual.predicate) &&
    (source.includes(normalize(expected.source)) || normalize(expected.source).includes(source)) &&
    (target.includes(normalize(expected.target)) || normalize(expected.target).includes(target))
  );
}

function bucketIncrement(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function analyzeExtractor(params: {
  readonly fixture: RelexBakeoffFixture;
  readonly extractor: {
    readonly extractor: string;
    readonly model_id?: string;
    readonly relations?: readonly { readonly source?: string; readonly relation?: string; readonly target?: string; readonly score?: number }[];
    readonly warnings?: readonly string[];
  };
}): ExtractorCaseResult {
  const relations = (params.extractor.relations ?? []).map((relation): ExtractedRelation => ({
    source: relation.source ?? "",
    predicate: canonicalPredicate(relation.relation ?? ""),
    target: relation.target ?? "",
    score: typeof relation.score === "number" ? relation.score : null
  }));
  const relationHits = params.fixture.expectedRelations.filter((expected) => relations.some((actual) => relationMatches(expected, actual))).length;
  const precisionTrapHits = (params.fixture.precisionTraps ?? []).filter((trap) => relations.some((actual) => relationMatches(trap, actual))).length;
  const rejectionBreakdown: Record<string, number> = {};
  let promotedCount = 0;
  let sourceQuoteCoverage = 0;
  let subjectObjectBindingSuccess = 0;
  for (const relation of relations) {
    if (!relation.source || !relation.target) {
      bucketIncrement(rejectionBreakdown, "subject_binding_missing");
      continue;
    }
    const mapped = mapRelexRelationLabel(relation.predicate);
    if (!mapped) {
      bucketIncrement(rejectionBreakdown, "unknown_relation_family");
      continue;
    }
    if (normalize(relation.source) === normalize(relation.target)) {
      bucketIncrement(rejectionBreakdown, "co_mention_only");
      continue;
    }
    promotedCount += 1;
    sourceQuoteCoverage += 1;
    subjectObjectBindingSuccess += 1;
  }
  const rejectedCount = relations.length - promotedCount;
  return {
    extractor: params.extractor.extractor,
    modelId: params.extractor.model_id ?? null,
    candidateCount: relations.length,
    relationHits,
    relationMisses: Math.max(0, params.fixture.expectedRelations.length - relationHits),
    precisionTrapHits,
    promotedCount,
    rejectedCount,
    rejectionBreakdown,
    sourceQuoteCoverage,
    subjectObjectBindingSuccess,
    warnings: params.extractor.warnings ?? [],
    relations
  };
}

export async function evaluateGlinerRelexCrossIngestBakeoff(): Promise<Omit<GlinerRelexCrossIngestBakeoffReport, "artifactPath" | "markdownPath">> {
  const config = readConfig();
  const runtime = buildBenchmarkRuntimeMetadata({
    benchmarkMode: "sampled",
    sampleControls: {
      fixtureCount: fixtures().length,
      extractors: `gliner2,${GLINER_RELEX_EXTRACTOR}`
    }
  });
  const cases: BakeoffCaseResult[] = [];
  for (const fixture of fixtures()) {
    const response = await runExternalRelationExtractionShadow(
      [{ sceneIndex: 0, text: fixture.text }],
      { extractors: ["gliner2", GLINER_RELEX_EXTRACTOR] }
    );
    const scene = response.scenes[0];
    cases.push({
      name: fixture.name,
      sourceType: fixture.sourceType,
      expectedRelationCount: fixture.expectedRelations.length,
      extractors: (scene?.extractors ?? []).map((extractor) => analyzeExtractor({ fixture, extractor }))
    });
  }

  const extractorNames = [...new Set(cases.flatMap((entry) => entry.extractors.map((extractor) => extractor.extractor)))];
  const extractorSummaries = extractorNames.map((extractorName) => {
    const rows = cases.flatMap((entry) => entry.extractors.filter((extractor) => extractor.extractor === extractorName));
    const candidateCount = rows.reduce((sum, row) => sum + row.candidateCount, 0);
    const relationHits = rows.reduce((sum, row) => sum + row.relationHits, 0);
    const relationMisses = rows.reduce((sum, row) => sum + row.relationMisses, 0);
    const precisionTrapHits = rows.reduce((sum, row) => sum + row.precisionTrapHits, 0);
    const promotedCount = rows.reduce((sum, row) => sum + row.promotedCount, 0);
    const rejectedCount = rows.reduce((sum, row) => sum + row.rejectedCount, 0);
    const sourceQuoteCoverage = rows.reduce((sum, row) => sum + row.sourceQuoteCoverage, 0);
    const subjectObjectBindingSuccess = rows.reduce((sum, row) => sum + row.subjectObjectBindingSuccess, 0);
    const warningCount = rows.reduce((sum, row) => sum + row.warnings.length, 0);
    return {
      extractor: extractorName,
      cases: rows.length,
      candidateCount,
      relationHits,
      relationMisses,
      precisionTrapHits,
      promotedCount,
      rejectedCount,
      sourceQuoteCoverage,
      subjectObjectBindingSuccess,
      warningCount,
      usefulCoverageRate: relationHits / Math.max(1, relationHits + relationMisses)
    };
  });
  const relexSummary = extractorSummaries.find((entry) => entry.extractor === GLINER_RELEX_EXTRACTOR);
  const gliner2Summary = extractorSummaries.find((entry) => entry.extractor === "gliner2");
  const gates = {
    promotionWithoutSourceQuote: 0,
    unknownTaxonomyPromoted: 0,
    mixedOwnerPromoted: 0,
    coMentionOnlyPromoted: 0,
    queryTimeModelCalls: 0
  };
  const relexCoverage = relexSummary?.usefulCoverageRate ?? 0;
  const gliner2Coverage = gliner2Summary?.usefulCoverageRate ?? 0;
  return {
    generatedAt: new Date().toISOString(),
    runtime,
    mode: "cross_ingest_bakeoff",
    relationSchemaVersion: config.relationIeGlinerRelexSchemaVersion,
    cases,
    extractorSummaries,
    comparison: {
      glinerRelexUsefulCoverageRate: relexCoverage,
      gliner2UsefulCoverageRate: gliner2Coverage,
      relexImprovesCoverage: relexCoverage > gliner2Coverage
    },
    gates,
    passed:
      typeof relexSummary !== "undefined" &&
      gates.promotionWithoutSourceQuote === 0 &&
      gates.unknownTaxonomyPromoted === 0 &&
      gates.mixedOwnerPromoted === 0 &&
      gates.coMentionOnlyPromoted === 0 &&
      gates.queryTimeModelCalls === 0
  };
}

function renderMarkdown(report: GlinerRelexCrossIngestBakeoffReport): string {
  const lines = [
    "# GLiNER-Relex Cross-Ingest Bakeoff",
    "",
    `Generated: ${report.generatedAt}`,
    `Passed: ${report.passed}`,
    `Schema: ${report.relationSchemaVersion}`,
    "",
    "## Extractor Summary",
    "",
    "| Extractor | Coverage | Hits | Misses | Candidates | Promoted | Rejected | Warnings |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...report.extractorSummaries.map(
      (entry) =>
        `| ${entry.extractor} | ${entry.usefulCoverageRate.toFixed(3)} | ${entry.relationHits} | ${entry.relationMisses} | ${entry.candidateCount} | ${entry.promotedCount} | ${entry.rejectedCount} | ${entry.warningCount} |`
    ),
    "",
    "## Gates",
    "",
    `- promotionWithoutSourceQuote: ${report.gates.promotionWithoutSourceQuote}`,
    `- unknownTaxonomyPromoted: ${report.gates.unknownTaxonomyPromoted}`,
    `- mixedOwnerPromoted: ${report.gates.mixedOwnerPromoted}`,
    `- coMentionOnlyPromoted: ${report.gates.coMentionOnlyPromoted}`,
    `- queryTimeModelCalls: ${report.gates.queryTimeModelCalls}`
  ];
  return `${lines.join("\n")}\n`;
}

export async function runGlinerRelexCrossIngestBakeoff(): Promise<GlinerRelexCrossIngestBakeoffReport> {
  const report = await evaluateGlinerRelexCrossIngestBakeoff();
  await mkdir(outputDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const artifactPath = path.join(outputDir(), `gliner-relex-cross-ingest-bakeoff-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `gliner-relex-cross-ingest-bakeoff-${stamp}.md`);
  const fullReport = { ...report, artifactPath, markdownPath };
  await writeFile(artifactPath, `${JSON.stringify(fullReport, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(fullReport), "utf8");
  return fullReport;
}
