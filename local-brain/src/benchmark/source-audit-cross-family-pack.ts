import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { attachStableQueryContractEnvelope } from "../mcp/query-contract-envelope.js";
import { presentHumanReadableQueryResult } from "../mcp/query-presenter.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type ToolName = "memory.search" | "memory.recap" | "memory.extract_tasks" | "memory.extract_calendar";

interface Scenario {
  readonly id: string;
  readonly query: string;
  readonly toolName: ToolName;
  readonly payload: Record<string, unknown>;
  readonly expectedFamilies: readonly string[];
  readonly expectedTerms: readonly string[];
  readonly expectedShape: "source_audit" | "abstention";
  readonly detailMode?: "compact" | "full";
}

export interface SourceAuditCrossFamilyRow {
  readonly id: string;
  readonly query: string;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly unsupportedClaimAuditCount: number;
  readonly sectionCount: number;
  readonly sectionSourceTrailCoverageRate: number;
  readonly citationFaithfulnessScore: number;
  readonly wrongFamily: boolean;
  readonly wrongShape: boolean;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly answer: string;
  readonly missingTerms: readonly string[];
  readonly passed: boolean;
}

export interface SourceAuditCrossFamilyReport {
  readonly generatedAt: string;
  readonly benchmark: "source_audit_cross_family_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly supportedZeroEvidenceCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly claimAuditCoverageRate: number;
    readonly claimAuditUnsupportedCount: number;
    readonly sectionSourceTrailCoverageRate: number;
    readonly citationFaithfulnessScore: number;
    readonly wrongFamilyCount: number;
    readonly wrongShapeCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly results: readonly SourceAuditCrossFamilyRow[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function sourceTrail(sourceUri: string, quote: string, sourceTable = "artifact_derivations", sourceRowId = "fixture-row"): readonly Record<string, unknown>[] {
  return [
    {
      sourceUri,
      artifactId: path.basename(sourceUri),
      sourceTable,
      sourceRowId,
      quote
    }
  ];
}

function evidence(sourceUri: string, snippet: string, sourceTable?: string): Record<string, unknown> {
  return {
    snippet,
    provenance: {
      source_uri: sourceUri,
      source_artifact_id: path.basename(sourceUri),
      source_table: sourceTable ?? "artifact_derivations",
      source_row_id: `${path.basename(sourceUri)}:1`,
      source_quote: snippet
    }
  };
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "relationship_lauren_source_audit",
      query: "Where did the Lauren answer come from?",
      toolName: "memory.search",
      expectedFamilies: ["relationship"],
      expectedTerms: ["Source trail", "Lauren", "relationship"],
      expectedShape: "source_audit",
      payload: {
        answer: "Lauren is represented as a source-backed relationship memory.",
        evidence: [evidence("/fixtures/relationships/lauren.md", "Lauren appears in the relationship notes as a relationship memory.", "relationship_memory")],
        meta: {
          queryContractName: "source_audit",
          queryContractRetrievalDomain: "relationship",
          queryContractAnswerShape: "source_audit",
          finalClaimSource: "relationship_memory"
        }
      }
    },
    {
      id: "career_roles_source_audit",
      query: "Where did the Well Inked and Two-Way roles come from?",
      toolName: "memory.search",
      expectedFamilies: ["career"],
      expectedTerms: ["Source trail", "Well Inked", "Two-Way"],
      expectedShape: "source_audit",
      payload: {
        answer: "Well Inked and Two-Way roles are backed by employment timeline sections.",
        evidence: [
          evidence("/fixtures/career/well-inked.md", "Well Inked role evidence includes owner and creative technology work.", "employment_timeline_projection"),
          evidence("/fixtures/career/two-way.md", "Two-Way role evidence includes forum, SSO, and product engineering work.", "employment_timeline_projection")
        ],
        meta: {
          queryContractName: "work_history_report",
          queryContractRetrievalDomain: "career",
          queryContractAnswerShape: "sectioned_report",
          finalClaimSource: "work_history_report_direct_read_model",
          answerSections: [
            {
              id: "employment_history",
              title: "Employment history",
              text: "Well Inked: owner and creative technology work. Two-Way: forum, SSO, and product engineering work.",
              evidenceCount: 2,
              sourceTrail: [
                ...sourceTrail("/fixtures/career/well-inked.md", "Well Inked role evidence includes owner and creative technology work.", "employment_timeline_projection", "well-inked"),
                ...sourceTrail("/fixtures/career/two-way.md", "Two-Way role evidence includes forum, SSO, and product engineering work.", "employment_timeline_projection", "two-way")
              ]
            }
          ]
        }
      }
    },
    {
      id: "dossier_section_source_audit",
      query: "Show the sources for each section.",
      toolName: "memory.recap",
      expectedFamilies: ["dossier_section"],
      expectedTerms: ["Source trail", "identity", "projects"],
      expectedShape: "source_audit",
      detailMode: "full",
      payload: {
        summaryText: "Lauren dossier sections are source-bound.",
        evidence: [
          evidence("/fixtures/dossiers/lauren-identity.md", "Lauren identity section source note.", "profile_report_projection"),
          evidence("/fixtures/dossiers/lauren-projects.md", "Lauren projects section source note.", "profile_report_projection")
        ],
        meta: {
          queryContractName: "entity_dossier",
          queryContractRetrievalDomain: "dossier",
          queryContractAnswerShape: "sectioned_report",
          finalClaimSource: "entity_dossier_section_bundle",
          answerSections: [
            {
              id: "identity",
              title: "Identity",
              text: "The identity section is grounded in the Lauren identity source note.",
              evidenceCount: 1,
              sourceTrail: sourceTrail("/fixtures/dossiers/lauren-identity.md", "Lauren identity section source note.", "profile_report_projection", "identity")
            },
            {
              id: "projects",
              title: "Projects",
              text: "The projects section is grounded in the Lauren projects source note.",
              evidenceCount: 1,
              sourceTrail: sourceTrail("/fixtures/dossiers/lauren-projects.md", "Lauren projects section source note.", "profile_report_projection", "projects")
            }
          ]
        }
      }
    },
    {
      id: "project_source_topic_audit",
      query: "Where did that project list come from?",
      toolName: "memory.search",
      expectedFamilies: ["source_topic", "project"],
      expectedTerms: ["Source trail", "AI Brain", "project"],
      expectedShape: "source_audit",
      payload: {
        answer: "The active project list came from source-topic artifact derivations.",
        evidence: [evidence("/fixtures/projects/current-projects.md", "AI Brain and Two-Way are listed as active project work.", "artifact_derivations")],
        meta: {
          queryContractName: "source_audit",
          queryContractRetrievalDomain: "source_topic",
          queryContractAnswerShape: "source_audit",
          finalClaimSource: "source_topic_report"
        }
      }
    },
    {
      id: "temporal_travel_source_audit",
      query: "Where did the mid to late July travel answer come from?",
      toolName: "memory.extract_calendar",
      expectedFamilies: ["temporal"],
      expectedTerms: ["Source trail", "mid-to-late July", "travel"],
      expectedShape: "source_audit",
      payload: {
        commitments: [
          {
            title: "Travel to the US",
            timeHint: "mid-to-late July",
            snippet: "Flight from Chiang Mai to the US in mid-to-late July.",
            provenance: {
              source_uri: "/fixtures/omi/2026-05-18-note.md",
              source_artifact_id: "2026-05-18-note.md",
              source_table: "typed_temporal_anchor",
              source_row_id: "travel-july",
              source_quote: "Flight from Chiang Mai to the US in mid-to-late July."
            }
          }
        ],
        meta: {
          queryContractName: "temporal_event",
          queryContractRetrievalDomain: "temporal",
          queryContractAnswerShape: "list",
          finalClaimSource: "typed_temporal_anchor"
        }
      }
    },
    {
      id: "task_travel_source_audit",
      query: "Where did those travel tasks come from?",
      toolName: "memory.extract_tasks",
      expectedFamilies: ["task"],
      expectedTerms: ["Source trail", "Jeep", "task"],
      expectedShape: "source_audit",
      payload: {
        tasks: [
          {
            title: "Store Jeep with Tink",
            snippet: "Task: store the Jeep with Tink before travel.",
            provenance: {
              source_uri: "/fixtures/omi/2026-05-18-note.md",
              source_artifact_id: "2026-05-18-note.md",
              source_table: "task_lifecycle_projection",
              source_row_id: "task-jeep",
              source_quote: "Task: store the Jeep with Tink before travel."
            }
          }
        ],
        meta: {
          queryContractName: "task_list",
          queryContractRetrievalDomain: "task",
          queryContractAnswerShape: "list",
          finalClaimSource: "task_projection"
        }
      }
    },
    {
      id: "unsupported_relationship_abstention_audit",
      query: "Where did the unsupported relationship answer come from?",
      toolName: "memory.search",
      expectedFamilies: ["abstention"],
      expectedTerms: ["Source trail", "Abstention", "no_authoritative_evidence"],
      expectedShape: "abstention",
      payload: {
        answer: "",
        evidence: [],
        meta: {
          queryContractName: "relationship_map",
          queryContractRetrievalDomain: "relationship",
          queryContractAnswerShape: "abstention",
          finalClaimSource: null,
          queryContractFallbackBlockedReason: "no_authoritative_evidence"
        }
      }
    }
  ];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

function missingTerms(text: string, terms: readonly string[]): readonly string[] {
  const normalized = normalizeText(text);
  return terms.filter((term) => !normalized.includes(normalizeText(term)));
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function claimAuditEntries(payload: Record<string, any>): readonly Record<string, any>[] {
  return Array.isArray(payload.claimAudit) ? payload.claimAudit.filter((entry) => entry && typeof entry === "object") : [];
}

function sectionSourceTrailCoverage(payload: Record<string, any>): number {
  const sections = Array.isArray(payload.answerSections) ? payload.answerSections : [];
  if (sections.length === 0) return 1;
  const covered = sections.filter((section: any) => Array.isArray(section?.sourceTrail) && section.sourceTrail.length > 0).length;
  return covered / sections.length;
}

function citationFaithfulness(audit: readonly Record<string, any>[]): number {
  if (audit.length === 0) return 0;
  const verified = audit.filter((entry) => entry.faithfulnessStatus === "verified" || entry.faithfulnessStatus === "unchecked").length;
  return verified / audit.length;
}

async function runScenario(scenario: Scenario): Promise<SourceAuditCrossFamilyRow> {
  const startedAt = performance.now();
  const payload = await attachStableQueryContractEnvelope({
    toolName: scenario.toolName,
    namespaceId: "benchmark_source_audit_cross_family",
    queryText: scenario.query,
    payload: scenario.payload as Record<string, any>
  });
  const rendered = presentHumanReadableQueryResult({
    query: scenario.query,
    payload,
    detailMode: scenario.detailMode ?? "compact"
  });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const audit = claimAuditEntries(payload);
  const families = new Set(audit.map((entry) => String(entry.claimFamily ?? "unknown")));
  const sourceTrailCount = Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
  const evidenceCount = typeof payload.evidenceCount === "number" ? payload.evidenceCount : 0;
  const wrongFamily = !scenario.expectedFamilies.some((family) => families.has(family));
  const wrongShape =
    scenario.expectedShape === "abstention"
      ? !audit.some((entry) => entry.supportStatus === "abstained")
      : !rendered.answer.startsWith("Source trail:");
  const missing = missingTerms(rendered.answer, scenario.expectedTerms);
  const unsupportedClaimAuditCount = audit.filter((entry) => entry.supportStatus === "unsupported").length;
  return {
    id: scenario.id,
    query: scenario.query,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount: audit.length,
    unsupportedClaimAuditCount,
    sectionCount: Array.isArray(payload.answerSections) ? payload.answerSections.length : 0,
    sectionSourceTrailCoverageRate: Number(sectionSourceTrailCoverage(payload).toFixed(4)),
    citationFaithfulnessScore: Number(citationFaithfulness(audit).toFixed(4)),
    wrongFamily,
    wrongShape,
    queryTimeModelCalls: 0,
    latencyMs,
    answer: rendered.answer,
    missingTerms: missing,
    passed: audit.length > 0 && missing.length === 0 && !wrongFamily && !wrongShape && unsupportedClaimAuditCount === 0
  };
}

function summarizeMetrics(results: readonly SourceAuditCrossFamilyRow[]): SourceAuditCrossFamilyReport["metrics"] {
  const supportedRows = results.filter((row) => row.evidenceCount > 0);
  const supportedZeroEvidenceCount = results.filter((row) => !row.id.includes("unsupported") && row.evidenceCount === 0).length;
  const supportedEmptySourceTrailCount = supportedRows.filter((row) => row.sourceTrailCount === 0 && row.sectionSourceTrailCoverageRate < 1).length;
  const rowsWithAudit = results.filter((row) => row.claimAuditCount > 0).length;
  const sectionRows = results.filter((row) => row.sectionCount > 0);
  const sectionCoverage =
    sectionRows.length === 0 ? 1 : sectionRows.reduce((sum, row) => sum + row.sectionSourceTrailCoverageRate, 0) / sectionRows.length;
  const faithfulness = results.reduce((sum, row) => sum + row.citationFaithfulnessScore, 0) / Math.max(1, results.length);
  const latencies = results.map((row) => row.latencyMs);
  return {
    supportedZeroEvidenceCount,
    supportedEmptySourceTrailCount,
    claimAuditCoverageRate: Number((rowsWithAudit / Math.max(1, results.length)).toFixed(4)),
    claimAuditUnsupportedCount: results.reduce((sum, row) => sum + row.unsupportedClaimAuditCount, 0),
    sectionSourceTrailCoverageRate: Number(sectionCoverage.toFixed(4)),
    citationFaithfulnessScore: Number(faithfulness.toFixed(4)),
    wrongFamilyCount: results.filter((row) => row.wrongFamily).length,
    wrongShapeCount: results.filter((row) => row.wrongShape).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(0, ...latencies).toFixed(2))
  };
}

function reportPassed(report: SourceAuditCrossFamilyReport): boolean {
  const metrics = report.metrics;
  return (
    metrics.supportedZeroEvidenceCount === 0 &&
    metrics.supportedEmptySourceTrailCount === 0 &&
    metrics.claimAuditCoverageRate >= 0.98 &&
    metrics.sectionSourceTrailCoverageRate >= 0.95 &&
    metrics.citationFaithfulnessScore >= 0.95 &&
    metrics.wrongFamilyCount === 0 &&
    metrics.wrongShapeCount === 0 &&
    metrics.queryTimeModelCalls === 0 &&
    report.results.every((row) => row.passed)
  );
}

function toMarkdown(report: SourceAuditCrossFamilyReport): string {
  const lines = [
    "# Source Audit Cross-Family Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passed: ${report.passed}`,
    `- supportedZeroEvidenceCount: ${report.metrics.supportedZeroEvidenceCount}`,
    `- supportedEmptySourceTrailCount: ${report.metrics.supportedEmptySourceTrailCount}`,
    `- claimAuditCoverageRate: ${report.metrics.claimAuditCoverageRate}`,
    `- sectionSourceTrailCoverageRate: ${report.metrics.sectionSourceTrailCoverageRate}`,
    `- citationFaithfulnessScore: ${report.metrics.citationFaithfulnessScore}`,
    `- wrongFamilyCount: ${report.metrics.wrongFamilyCount}`,
    `- wrongShapeCount: ${report.metrics.wrongShapeCount}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(`- ${row.id}: passed=${row.passed} familyWrong=${row.wrongFamily} shapeWrong=${row.wrongShape} audit=${row.claimAuditCount}`);
    lines.push(`  - answer: ${row.answer}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteSourceAuditCrossFamilyPack(): Promise<{
  readonly report: SourceAuditCrossFamilyReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const results: SourceAuditCrossFamilyRow[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(scenario));
  }
  const report: SourceAuditCrossFamilyReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "source_audit_cross_family_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length,
        fixtureFirst: true
      }
    }),
    sampleCount: results.length,
    passed: false,
    metrics: summarizeMetrics(results),
    results
  };
  const finalReport = { ...report, passed: reportPassed(report) };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `source-audit-cross-family-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `source-audit-cross-family-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(finalReport), "utf8");
  return { report: finalReport, output: { jsonPath, markdownPath } };
}

export async function runSourceAuditCrossFamilyPackCli(): Promise<void> {
  const { output } = await runAndWriteSourceAuditCrossFamilyPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
