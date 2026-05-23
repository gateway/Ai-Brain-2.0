import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import { runExternalRelationExtractionShadow } from "../relationships/external-ie.js";
import { analyzeSceneStructuredExactDetailRows } from "../retrieval/exact-detail-fact-keys.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import {
  omiExtractionShadowCases,
  type OmiExtractionShadowCase,
  type OmiExtractionShadowExpectedStructure,
  type OmiExtractionShadowRelation
} from "./omi-extraction-shadow-cases.js";

type ExtractorName = "gliner2" | "gliner_relex" | "spacy";

interface SidecarEntity {
  readonly text?: string;
  readonly label?: string;
}

interface SidecarRelation {
  readonly source?: string;
  readonly target?: string;
  readonly relation?: string;
}

interface SidecarExtractorResult {
  readonly extractor: string;
  readonly model_id?: string;
  readonly entities?: readonly SidecarEntity[];
  readonly relations?: readonly SidecarRelation[];
  readonly classifications?: Readonly<Record<string, unknown>> | null;
  readonly structures?: Readonly<Record<string, unknown>> | null;
  readonly warnings?: readonly string[];
}

export interface OmiExtractionShadowCaseScore {
  readonly entityHits: number;
  readonly entityMisses: number;
  readonly relationHits: number;
  readonly relationMisses: number;
  readonly classificationHits: number;
  readonly classificationMisses: number;
  readonly structureHits: number;
  readonly structureMisses: number;
  readonly invalidRelationCount: number;
  readonly noisyStructureCount: number;
  readonly warningCount: number;
  readonly utilityScore: number;
}

interface OmiExtractionPromotionSummary {
  readonly promotedRowCount: number;
  readonly rejectedCount: number;
  readonly rejectionBreakdown: Readonly<Record<string, number>>;
}

interface OmiExtractionShadowCaseResult {
  readonly name: string;
  readonly category: string;
  readonly sourcePath: string;
  readonly text: string;
  readonly expected: {
    readonly entities: readonly string[];
    readonly relations: readonly string[];
    readonly supportFamilies: readonly string[];
    readonly narrativeFrames: readonly string[];
    readonly structures: readonly string[];
  };
  readonly extractors: readonly {
    readonly extractor: string;
    readonly modelId: string | null;
    readonly entities: readonly string[];
    readonly relations: readonly string[];
    readonly classifications: Readonly<Record<string, unknown>> | null;
    readonly structures: Readonly<Record<string, unknown>> | null;
    readonly warnings: readonly string[];
    readonly score: OmiExtractionShadowCaseScore;
    readonly promotion: OmiExtractionPromotionSummary | null;
  }[];
}

interface OmiExtractionShadowExtractorSummary {
  readonly extractor: string;
  readonly modelId: string | null;
  readonly usefulEntityHits: number;
  readonly usefulRelationHits: number;
  readonly usefulClassificationHits: number;
  readonly usefulStructureHits: number;
  readonly invalidRelationCount: number;
  readonly noisyStructureCount: number;
  readonly warningCount: number;
  readonly utilityScore: number;
  readonly promotedRowCount: number;
  readonly rejectedPromotionCount: number;
  readonly promotionRejectionBreakdown: Readonly<Record<string, number>>;
}

export interface OmiExtractionShadowReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly migration: {
    readonly ieExtractorDefault: string | null;
    readonly gliner2ModelId: string | null;
    readonly gliner2SchemaVersion: string;
    readonly gliner2ShadowComparisonEnabled: boolean;
    readonly comparedExtractors: readonly string[];
  };
  readonly cases: readonly OmiExtractionShadowCaseResult[];
  readonly extractorSummaries: readonly OmiExtractionShadowExtractorSummary[];
  readonly passed: boolean;
}

const SUPPORTED_RELATIONS = new Set([
  "friend_of",
  "works_with",
  "works_at",
  "worked_at",
  "works_on",
  "lives_in",
  "lived_in",
  "member_of",
  "met_through",
  "sibling_of",
  "was_with"
]);

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
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenStrings(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => flattenStrings(entry));
  }
  return [];
}

function hasNonEmptyStructure(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasNonEmptyStructure(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => hasNonEmptyStructure(entry));
  }
  return false;
}

function summarizePromotionForShadowCase(params: {
  readonly benchmarkCase: OmiExtractionShadowCase;
  readonly extractor: SidecarExtractorResult;
}): OmiExtractionPromotionSummary | null {
  if (normalize(params.extractor.extractor) !== "gliner2") {
    return null;
  }
  const analysis = analyzeSceneStructuredExactDetailRows({
    sceneId: `shadow:${params.benchmarkCase.name}`,
    sceneText: params.benchmarkCase.text,
    occurredAt: null,
    selfEntityId: null,
    selfAliases: [],
    sceneMetadata: {
      external_relation_ie: {
        relation_ie_mode: "support_only",
        extractors: [
          {
            extractor: params.extractor.extractor,
            relation_ie_mode: "support_only",
            model_id: params.extractor.model_id ?? null,
            classifications: params.extractor.classifications ?? null,
            structures: params.extractor.structures ?? null,
            warnings: params.extractor.warnings ?? []
          }
        ]
      }
    }
  });
  const rejectionBreakdown = new Map<string, number>();
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.promotionEligible) {
      continue;
    }
    const reason = diagnostic.promotionRejectedReason ?? "unknown";
    rejectionBreakdown.set(reason, (rejectionBreakdown.get(reason) ?? 0) + 1);
  }
  return {
    promotedRowCount: analysis.rows.length,
    rejectedCount: analysis.diagnostics.filter((entry) => !entry.promotionEligible).length,
    rejectionBreakdown: Object.fromEntries(rejectionBreakdown)
  };
}

function canonicalRelationString(tuple: OmiExtractionShadowRelation): string {
  const predicate = normalize(tuple.predicate).replace(/\s+/g, "_");
  const source = normalize(tuple.source);
  const target = normalize(tuple.target);
  if (predicate === "friend_of" || predicate === "sibling_of" || predicate === "works_with") {
    const ordered = [source, target].sort();
    return `${ordered[0]}|${predicate}|${ordered[1]}`;
  }
  return `${source}|${predicate}|${target}`;
}

function relationStrings(relations: readonly SidecarRelation[] | undefined): readonly string[] {
  return (relations ?? [])
    .map((relation) => {
      const predicate = normalize(relation.relation).replace(/\s+/g, "_");
      const source = normalize(relation.source);
      const target = normalize(relation.target);
      if (!predicate || !source || !target) {
        return null;
      }
      if (predicate === "friend_of" || predicate === "sibling_of" || predicate === "works_with") {
        const ordered = [source, target].sort();
        return `${ordered[0]}|${predicate}|${ordered[1]}`;
      }
      return `${source}|${predicate}|${target}`;
    })
    .filter((item): item is string => Boolean(item));
}

function relationInvalidCount(relations: readonly SidecarRelation[] | undefined): number {
  let count = 0;
  for (const relation of relations ?? []) {
    const source = normalize(relation.source);
    const target = normalize(relation.target);
    const predicate = normalize(relation.relation).replace(/\s+/g, "_");
    if (!source || !target || !predicate || source === target || !SUPPORTED_RELATIONS.has(predicate)) {
      count += 1;
    }
  }
  return count;
}

function entityStrings(entities: readonly SidecarEntity[] | undefined): readonly string[] {
  return [...new Set((entities ?? []).map((entity) => normalize(entity.text)).filter(Boolean))];
}

function classificationValues(value: unknown, key: string): readonly string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const raw = (value as Record<string, unknown>)[key];
  if (Array.isArray(raw)) {
    return raw.map((entry) => normalize(entry)).filter(Boolean);
  }
  if (typeof raw === "string") {
    const normalized = normalize(raw);
    return normalized ? [normalized] : [];
  }
  return [];
}

function structureStrings(value: Readonly<Record<string, unknown>> | null, name: string): readonly string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  return flattenStrings((value as Record<string, unknown>)[name]).map((entry) => normalize(entry)).filter(Boolean);
}

function expectedStructureLabel(structure: OmiExtractionShadowExpectedStructure): string {
  return `${structure.name}:${structure.terms.join("|")}`;
}

export function computeOmiExtractionShadowCaseScore(input: {
  readonly benchmarkCase: OmiExtractionShadowCase;
  readonly extractor: SidecarExtractorResult;
}): OmiExtractionShadowCaseScore {
  const predictedEntities = entityStrings(input.extractor.entities);
  const predictedRelations = new Set(relationStrings(input.extractor.relations));
  const supportFamilies = new Set(classificationValues(input.extractor.classifications, "support_family"));
  const narrativeFrames = new Set(classificationValues(input.extractor.classifications, "narrative_frame"));
  const expectedEntities = input.benchmarkCase.expectedEntities.map((entry) => normalize(entry)).filter(Boolean);
  const expectedRelations = input.benchmarkCase.expectedRelations.map((entry) => canonicalRelationString(entry));
  const expectedClassificationCount =
    input.benchmarkCase.expectedSupportFamilies.length + input.benchmarkCase.expectedNarrativeFrames.length;

  const entityHits = expectedEntities.filter((expected) => predictedEntities.some((candidate) => candidate.includes(expected))).length;
  const relationHits = expectedRelations.filter((expected) => predictedRelations.has(expected)).length;
  const supportFamilyHits = input.benchmarkCase.expectedSupportFamilies.filter((expected) => supportFamilies.has(normalize(expected))).length;
  const narrativeFrameHits = input.benchmarkCase.expectedNarrativeFrames.filter((expected) => narrativeFrames.has(normalize(expected))).length;
  const structureHits = input.benchmarkCase.expectedStructures.filter((structure) => {
    const haystack = structureStrings(input.extractor.structures ?? null, structure.name);
    return structure.terms.every((term) => haystack.some((value) => value.includes(normalize(term))));
  }).length;
  const noisyStructureCount = Object.entries(input.extractor.structures ?? {})
    .filter(([name, value]) => hasNonEmptyStructure(value) && !input.benchmarkCase.expectedStructures.some((structure) => structure.name === name))
    .length;
  const invalidRelationCount = relationInvalidCount(input.extractor.relations);
  const warningCount = input.extractor.warnings?.length ?? 0;
  const utilityScore = Number(
    (
      entityHits +
      relationHits * 2 +
      supportFamilyHits +
      narrativeFrameHits +
      structureHits * 2 -
      invalidRelationCount -
      noisyStructureCount -
      warningCount * 0.5
    ).toFixed(2)
  );

  return {
    entityHits,
    entityMisses: Math.max(0, expectedEntities.length - entityHits),
    relationHits,
    relationMisses: Math.max(0, expectedRelations.length - relationHits),
    classificationHits: supportFamilyHits + narrativeFrameHits,
    classificationMisses: Math.max(0, expectedClassificationCount - (supportFamilyHits + narrativeFrameHits)),
    structureHits,
    structureMisses: Math.max(0, input.benchmarkCase.expectedStructures.length - structureHits),
    invalidRelationCount,
    noisyStructureCount,
    warningCount,
    utilityScore
  };
}

function toMarkdown(report: OmiExtractionShadowReport): string {
  const lines = [
    "# OMI Extraction Shadow Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- ieExtractorDefault: ${report.migration.ieExtractorDefault ?? "n/a"}`,
    `- gliner2ModelId: ${report.migration.gliner2ModelId ?? "n/a"}`,
    `- gliner2SchemaVersion: ${report.migration.gliner2SchemaVersion}`,
    `- comparedExtractors: ${report.migration.comparedExtractors.join(", ")}`,
    `- passed: ${report.passed}`,
    "",
    "## Extractor Summaries",
    ""
  ];

  for (const summary of report.extractorSummaries) {
    lines.push(
      `- ${summary.extractor}: utility=${summary.utilityScore} entities=${summary.usefulEntityHits} relations=${summary.usefulRelationHits} classifications=${summary.usefulClassificationHits} structures=${summary.usefulStructureHits} invalidRelations=${summary.invalidRelationCount} noisyStructures=${summary.noisyStructureCount} warnings=${summary.warningCount} model=${summary.modelId ?? "n/a"}`
    );
    if (summary.rejectedPromotionCount > 0 || summary.promotedRowCount > 0) {
      lines.push(
        `  - promotion: promoted=${summary.promotedRowCount} rejected=${summary.rejectedPromotionCount} rejectionBreakdown=${JSON.stringify(summary.promotionRejectionBreakdown)}`
      );
    }
  }

  lines.push("", "## Cases", "");
  for (const benchmarkCase of report.cases) {
    lines.push(`- ${benchmarkCase.name} (${benchmarkCase.category})`);
    lines.push(`  - sourcePath: ${benchmarkCase.sourcePath}`);
    lines.push(`  - expectedEntities: ${benchmarkCase.expected.entities.join(" | ") || "none"}`);
    lines.push(`  - expectedRelations: ${benchmarkCase.expected.relations.join(" | ") || "none"}`);
    lines.push(`  - expectedSupportFamilies: ${benchmarkCase.expected.supportFamilies.join(" | ") || "none"}`);
    lines.push(`  - expectedNarrativeFrames: ${benchmarkCase.expected.narrativeFrames.join(" | ") || "none"}`);
    lines.push(`  - expectedStructures: ${benchmarkCase.expected.structures.join(" | ") || "none"}`);
    for (const extractor of benchmarkCase.extractors) {
      lines.push(
        `  - ${extractor.extractor}: utility=${extractor.score.utilityScore} entities=${extractor.entities.join(" | ") || "none"} relations=${extractor.relations.join(" | ") || "none"} warnings=${extractor.warnings.join(" | ") || "none"}`
      );
      if (extractor.promotion) {
        lines.push(
          `    - promotion: promoted=${extractor.promotion.promotedRowCount} rejected=${extractor.promotion.rejectedCount} rejectionBreakdown=${JSON.stringify(extractor.promotion.rejectionBreakdown)}`
        );
      }
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteOmiExtractionShadowBenchmark(): Promise<{
  readonly report: OmiExtractionShadowReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const config = readConfig();
  const comparedExtractors: readonly ExtractorName[] = ["gliner2", "gliner_relex", "spacy"];
  const cases = omiExtractionShadowCases();
  const shadow = await runExternalRelationExtractionShadow(
    cases.map((entry, index) => ({ sceneIndex: index, text: entry.text })),
    { extractors: comparedExtractors }
  );

  const summaries = new Map<string, OmiExtractionShadowExtractorSummary>();
  const caseResults: OmiExtractionShadowCaseResult[] = [];

  for (const [index, benchmarkCase] of cases.entries()) {
    const scene = shadow.scenes.find((entry) => entry.scene_index === index);
    const extractorResults = (scene?.extractors ?? []).map((extractor) => {
      const score = computeOmiExtractionShadowCaseScore({ benchmarkCase, extractor });
      const promotion = summarizePromotionForShadowCase({ benchmarkCase, extractor });
      const current = summaries.get(extractor.extractor) ?? {
        extractor: extractor.extractor,
        modelId: extractor.model_id ?? null,
        usefulEntityHits: 0,
        usefulRelationHits: 0,
        usefulClassificationHits: 0,
        usefulStructureHits: 0,
        invalidRelationCount: 0,
        noisyStructureCount: 0,
        warningCount: 0,
        utilityScore: 0,
        promotedRowCount: 0,
        rejectedPromotionCount: 0,
        promotionRejectionBreakdown: {}
      };
      const promotionRejectionBreakdown = new Map<string, number>(
        Object.entries(current.promotionRejectionBreakdown ?? {})
      );
      for (const [reason, count] of Object.entries(promotion?.rejectionBreakdown ?? {})) {
        promotionRejectionBreakdown.set(reason, (promotionRejectionBreakdown.get(reason) ?? 0) + count);
      }
      summaries.set(extractor.extractor, {
        extractor: extractor.extractor,
        modelId: current.modelId ?? extractor.model_id ?? null,
        usefulEntityHits: current.usefulEntityHits + score.entityHits,
        usefulRelationHits: current.usefulRelationHits + score.relationHits,
        usefulClassificationHits: current.usefulClassificationHits + score.classificationHits,
        usefulStructureHits: current.usefulStructureHits + score.structureHits,
        invalidRelationCount: current.invalidRelationCount + score.invalidRelationCount,
        noisyStructureCount: current.noisyStructureCount + score.noisyStructureCount,
        warningCount: current.warningCount + score.warningCount,
        utilityScore: Number((current.utilityScore + score.utilityScore).toFixed(2)),
        promotedRowCount: current.promotedRowCount + (promotion?.promotedRowCount ?? 0),
        rejectedPromotionCount: current.rejectedPromotionCount + (promotion?.rejectedCount ?? 0),
        promotionRejectionBreakdown: Object.fromEntries(promotionRejectionBreakdown)
      });

      return {
        extractor: extractor.extractor,
        modelId: extractor.model_id ?? null,
        entities: entityStrings(extractor.entities),
        relations: relationStrings(extractor.relations),
        classifications: extractor.classifications ?? null,
        structures: extractor.structures ?? null,
        warnings: extractor.warnings ?? [],
        score,
        promotion
      };
    });

    caseResults.push({
      name: benchmarkCase.name,
      category: benchmarkCase.category,
      sourcePath: benchmarkCase.sourcePath,
      text: benchmarkCase.text,
      expected: {
        entities: benchmarkCase.expectedEntities,
        relations: benchmarkCase.expectedRelations.map((entry) => canonicalRelationString(entry)),
        supportFamilies: benchmarkCase.expectedSupportFamilies,
        narrativeFrames: benchmarkCase.expectedNarrativeFrames,
        structures: benchmarkCase.expectedStructures.map((entry) => expectedStructureLabel(entry))
      },
      extractors: extractorResults
    });
  }

  const extractorSummaries = [...summaries.values()].sort((left, right) => right.utilityScore - left.utilityScore);
  const gliner2Summary = extractorSummaries.find((entry) => entry.extractor === "gliner2");
  const glinerRelexSummary = extractorSummaries.find((entry) => entry.extractor === "gliner_relex");
  const report: OmiExtractionShadowReport = {
    generatedAt: new Date().toISOString(),
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        benchmark: "omi_extraction_shadow",
        caseCount: cases.length,
        comparedExtractors: comparedExtractors.join(",")
      }
    }),
    migration: {
      ieExtractorDefault: config.relationIeExtractors[0] ?? null,
      gliner2ModelId: config.relationIeGliner2Model,
      gliner2SchemaVersion: "gliner2_shadow_schema_v1",
      gliner2ShadowComparisonEnabled: true,
      comparedExtractors
    },
    cases: caseResults,
    extractorSummaries,
    passed:
      (gliner2Summary?.utilityScore ?? Number.NEGATIVE_INFINITY) >= (glinerRelexSummary?.utilityScore ?? Number.NEGATIVE_INFINITY) &&
      (gliner2Summary?.invalidRelationCount ?? Number.POSITIVE_INFINITY) <= (glinerRelexSummary?.invalidRelationCount ?? Number.POSITIVE_INFINITY)
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `omi-extraction-shadow-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `omi-extraction-shadow-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runOmiExtractionShadowBenchmarkCli(): Promise<void> {
  const result = await runAndWriteOmiExtractionShadowBenchmark();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
