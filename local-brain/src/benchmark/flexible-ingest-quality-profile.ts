import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { buildSourceEnvelopeAdapterOutput, type SourceEnvelope, type SourceEnvelopeType } from "../ingest/source-envelope.js";
import { searchMemory } from "../retrieval/service.js";
import { runTaxonomyTemporalCompiler } from "../taxonomy-temporal/compiler.js";
import type { CompilerRunResult, ExtractionAssistantMode } from "../taxonomy-temporal/types.js";

interface SourceFixture {
  readonly id: string;
  readonly envelope: SourceEnvelope;
}

interface SourceQualityResult {
  readonly id: string;
  readonly sourceType: SourceEnvelopeType;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly artifactChunkCount: number;
  readonly extractionUnitCount: number;
  readonly inputTokenP95: number;
  readonly inputTokenMax: number;
  readonly emptyOrBoilerplateChunkCount: number;
  readonly provenanceComplete: boolean;
  readonly jsonValidChunks: number;
  readonly chunkBudgetPassChunks: number;
  readonly taxonomyPassChunks: number;
  readonly temporalPassChunks: number;
  readonly promotionSafetyPassChunks: number;
  readonly llmCalledChunks: number;
  readonly gliner2ErrorChunks: number;
  readonly assistantOutputTokensP95: number;
  readonly assistantOutputTokensMax: number;
  readonly suggestedTaxonomy: readonly string[];
  readonly acceptedEvidenceQuotes: readonly string[];
}

interface BroadProfileSmokeResult {
  readonly query: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly latencyMs: number;
  readonly supportBundleFamily: string | null;
  readonly dominantStage: string | null;
  readonly semanticFallbackUsed: boolean;
  readonly claim: string;
  readonly topEvidence: readonly string[];
}

interface FlexibleIngestQualityProfileReport {
  readonly generatedAt: string;
  readonly benchmark: "flexible_ingest_quality_profile";
  readonly passed: boolean;
  readonly thresholds: {
    readonly sourceAdapterCoverage: number;
    readonly chunkBudgetPassRate: number;
    readonly extractionUnitInputTokensP95: number;
    readonly extractionUnitInputTokensMax: number;
    readonly emptyOrBoilerplateChunkRate: number;
    readonly sourceProvenanceCompleteness: number;
    readonly assistantOutputTokensP95: number;
    readonly assistantOutputTokensMax: number;
    readonly broadProfileSmokePassCount: number;
    readonly unrelatedTopEvidenceCount: number;
    readonly profileReportP95LatencyMs: number;
  };
  readonly metrics: {
    readonly sourceAdapterCoverage: number;
    readonly chunkBudgetPassRate: number;
    readonly extractionUnitInputTokensP95: number;
    readonly extractionUnitInputTokensMax: number;
    readonly emptyOrBoilerplateChunkRate: number;
    readonly sourceProvenanceCompleteness: number;
    readonly jsonValidRate: number;
    readonly taxonomyPassRate: number;
    readonly temporalPassRate: number;
    readonly promotionSafetyPassRate: number;
    readonly assistantOutputTokensP95: number;
    readonly assistantOutputTokensMax: number;
    readonly gliner2ErrorRate: number;
    readonly suggestedTaxonomyCount: number;
    readonly broadProfileSmokePassCount: number;
    readonly unrelatedTopEvidenceCount: number;
    readonly pairBindingPrecision: number;
    readonly profileReportP95LatencyMs: number;
    readonly semanticFallbackWithProfileSupportCount: number;
  };
  readonly failures: readonly string[];
  readonly sources: readonly SourceQualityResult[];
  readonly suggestedTaxonomyRecurrence: Readonly<Record<string, number>>;
  readonly broadProfileSmoke: readonly BroadProfileSmokeResult[];
}

const SOURCE_FIXTURES: readonly SourceFixture[] = [
  {
    id: "omi_voice_note",
    envelope: {
      namespaceId: "benchmark_flexible_ingest",
      sourceType: "omi",
      sourceUri: "omi://voice-note/2026-05-02T09-00-00Z",
      capturedAt: "2026-05-02T09:00:00Z",
      authorHint: "self",
      formatMetadata: { channel: "omi" },
      rawText: "I switched my music service to Spotify, and the home internet speed is 500 Mbps."
    }
  },
  {
    id: "openclaw_markdown",
    envelope: {
      namespaceId: "benchmark_flexible_ingest",
      sourceType: "markdown",
      sourceUri: "openclaw://notes/memoir-engine.md",
      capturedAt: "2026-05-01T12:00:00Z",
      authorHint: "self",
      formatMetadata: { channel: "openclaw" },
      rawText:
        "---\ntitle: Memoir Engine\n---\n# Memoir Engine\n\nThe memoir graph should use Postgres, taxonomy, and a temporal registry.\n\n## Tasks\n\n- Review the taxonomy candidates.\n- Keep source quotes attached."
    }
  },
  {
    id: "pdf_page_text",
    envelope: {
      namespaceId: "benchmark_flexible_ingest",
      sourceType: "pdf",
      sourceUri: "pdf://uploads/lauren-trip-summary.pdf",
      capturedAt: "2026-04-30T00:00:00Z",
      authorHint: "import",
      formatMetadata: { fileName: "lauren-trip-summary.pdf" },
      rawText:
        "Page 1\nLauren left Chiang Mai, Thailand on October 18, 2025 to fly back to Bend, Oregon.\fPage 2\nThe source says this was a relationship transition and should not be upgraded beyond the exact date provided."
    }
  },
  {
    id: "chat_thread",
    envelope: {
      namespaceId: "benchmark_flexible_ingest",
      sourceType: "chat",
      sourceUri: "chat://thread/lauren-dog",
      capturedAt: "2026-04-29T15:00:00Z",
      authorHint: "friend",
      formatMetadata: { platform: "generic_chat" },
      rawText: "Lauren: My dog is a Golden Retriever.\nSteve: Got it, that is Lauren's dog, not mine."
    }
  },
  {
    id: "asr_transcript",
    envelope: {
      namespaceId: "benchmark_flexible_ingest",
      sourceType: "asr",
      sourceUri: "asr://recording/adhd-note",
      capturedAt: "2026-04-28T08:00:00Z",
      authorHint: "self",
      formatMetadata: { transcriptEngine: "generic_asr" },
      rawText: "[00:00] I was diagnosed with ADHD.\n[00:04] It affected how I handled school support."
    }
  },
  {
    id: "task_list",
    envelope: {
      namespaceId: "benchmark_flexible_ingest",
      sourceType: "task_list",
      sourceUri: "tasks://today",
      capturedAt: "2026-04-27T07:00:00Z",
      authorHint: "self",
      formatMetadata: { listType: "todo" },
      rawText: "- Update the roadmap.\n- Check the benchmark task list.\n- Review taxonomy suggestions."
    }
  },
  {
    id: "generic_text",
    envelope: {
      namespaceId: "benchmark_flexible_ingest",
      sourceType: "generic_text",
      sourceUri: "text://scratch/triage-rubric",
      capturedAt: "2026-04-26T07:00:00Z",
      authorHint: "self",
      formatMetadata: {},
      rawText: "The triage rubric is becoming a recurring planning object, but it is not yet a formal taxonomy key."
    }
  }
];

const BROAD_PROFILE_QUERIES: readonly string[] = [
  "Can you query all the information about Lauren and I?",
  "Give me all the info about Lauren and me.",
  "What is the full picture with Lauren and I?",
  "What is the whole story about Lauren and me?",
  "Summarize all information about Lauren and I.",
  "Give me a recap of Lauren and me.",
  "What is my history with Lauren?",
  "What is Steve's history with Lauren?",
  "What is the relationship history with Lauren?",
  "What is everything you know about Lauren and I?",
  "Pull together the full picture about Lauren and me.",
  "What is the summary of my relationship with Lauren?",
  "What is all the relationship info about Lauren and I?",
  "Tell me the history with Lauren.",
  "What is the recap of Lauren and I?",
  "What is the full relationship picture with Lauren?",
  "What do we know about my history with Lauren?",
  "What is the whole relationship story about Lauren and me?",
  "Can you summarize my history with Lauren?",
  "What is all the info about Lauren and me?"
];

function localBrainRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 1;
  }
  return Number((numerator / denominator).toFixed(4));
}

function tokenValue(run: CompilerRunResult, key: "inputTokens" | "outputTokens" | "totalTokens"): number {
  return run.assistant.tokenUsage?.[key] ?? 0;
}

function suggestedTaxonomyKey(run: CompilerRunResult): readonly string[] {
  return run.candidates
    .map((entry) => entry.candidate.suggested_taxonomy?.key ?? entry.candidate.suggested_taxonomy?.label ?? "")
    .map((value) => value.trim())
    .filter(Boolean);
}

function acceptedEvidence(run: CompilerRunResult): readonly string[] {
  return run.candidates
    .filter(
      (entry) =>
        entry.promotionEligible ||
        entry.candidate.taxonomy_status === "needs_taxonomy_review" ||
        entry.candidate.promotion_recommendation === "needs_clarification"
    )
    .map((entry) => String(entry.candidate.evidence_quote ?? "").trim())
    .filter(Boolean);
}

async function sourceQualityResult(spec: SourceFixture, mode: ExtractionAssistantMode): Promise<SourceQualityResult> {
  const adapterOutput = buildSourceEnvelopeAdapterOutput(spec.envelope);
  const runs: CompilerRunResult[] = [];
  for (const input of adapterOutput.extractionInputs) {
    runs.push(...(await runTaxonomyTemporalCompiler(input, { mode })));
  }
  const outputTokens = runs.map((run) => tokenValue(run, "outputTokens"));
  const failures: string[] = [];
  const jsonValidChunks = runs.filter((run) => run.metrics.jsonValidityPass).length;
  const chunkBudgetPassChunks = runs.filter((run) => run.metrics.chunkBudgetPass).length;
  const taxonomyPassChunks = runs.filter((run) => run.metrics.taxonomyCompliancePass).length;
  const temporalPassChunks = runs.filter((run) => run.metrics.temporalNormalizationPass).length;
  const promotionSafetyPassChunks = runs.filter((run) => run.metrics.promotionSafetyPass).length;
  const gliner2ErrorChunks = runs.filter((run) => run.gliner2.error).length;
  if (!adapterOutput.metrics.provenanceComplete) failures.push("source_provenance_incomplete");
  if (adapterOutput.metrics.inputTokenP95 > 1200) failures.push("input_token_p95_exceeded");
  if (adapterOutput.metrics.inputTokenMax > 1800) failures.push("input_token_max_exceeded");
  if (adapterOutput.metrics.emptyOrBoilerplateChunkCount / Math.max(1, adapterOutput.metrics.chunkCount) > 0.02) failures.push("empty_or_boilerplate_chunk_rate_exceeded");
  if (jsonValidChunks !== runs.length) failures.push("json_invalid_chunks");
  if (chunkBudgetPassChunks !== runs.length) failures.push("chunk_budget_failed");
  if (taxonomyPassChunks !== runs.length) failures.push("taxonomy_failed");
  if (temporalPassChunks !== runs.length) failures.push("temporal_failed");
  if (promotionSafetyPassChunks !== runs.length) failures.push("promotion_safety_failed");
  if (gliner2ErrorChunks > 0) failures.push("gliner2_errors");
  if (percentile(outputTokens, 95) > 350) failures.push("assistant_output_p95_exceeded");
  if (Math.max(0, ...outputTokens) > 450) failures.push("assistant_output_max_exceeded");
  return {
    id: spec.id,
    sourceType: spec.envelope.sourceType,
    passed: failures.length === 0,
    failures,
    artifactChunkCount: adapterOutput.artifactChunks.length,
    extractionUnitCount: adapterOutput.extractionUnits.length,
    inputTokenP95: adapterOutput.metrics.inputTokenP95,
    inputTokenMax: adapterOutput.metrics.inputTokenMax,
    emptyOrBoilerplateChunkCount: adapterOutput.metrics.emptyOrBoilerplateChunkCount,
    provenanceComplete: adapterOutput.metrics.provenanceComplete,
    jsonValidChunks,
    chunkBudgetPassChunks,
    taxonomyPassChunks,
    temporalPassChunks,
    promotionSafetyPassChunks,
    llmCalledChunks: runs.filter((run) => run.assistant.provider === "openrouter" && !run.assistant.skippedReason).length,
    gliner2ErrorChunks,
    assistantOutputTokensP95: percentile(outputTokens, 95),
    assistantOutputTokensMax: Math.max(0, ...outputTokens),
    suggestedTaxonomy: [...new Set(runs.flatMap(suggestedTaxonomyKey))],
    acceptedEvidenceQuotes: [...new Set(runs.flatMap(acceptedEvidence))].slice(0, 12)
  };
}

async function broadProfileSmokeResult(query: string): Promise<BroadProfileSmokeResult> {
  const startedAt = Date.now();
  const response = await searchMemory({ namespaceId: "personal", query, limit: 6 });
  const latencyMs = Date.now() - startedAt;
  const claim = response.duality.claim.text;
  const topEvidence = response.evidence.slice(0, 4).map((entry) => entry.snippet).filter(Boolean);
  const supportBundleFamily = response.meta.supportBundleFamily ?? null;
  const dominantStage = response.meta.dominantStage ?? null;
  const semanticFallbackUsed = response.meta.semanticFallbackUsed === true;
  const failures: string[] = [];
  const combined = `${claim} ${topEvidence.join(" ")}`;
  if (!/\bLauren\b/iu.test(combined)) failures.push("lauren_missing");
  if (/\bTink\b/iu.test(topEvidence.join(" "))) failures.push("unrelated_top_evidence");
  if (supportBundleFamily !== "profile_report") failures.push("not_profile_report");
  if (semanticFallbackUsed) failures.push("semantic_fallback_used");
  if (response.duality.confidence === "missing") failures.push("missing_confidence");
  return {
    query,
    passed: failures.length === 0,
    failures,
    latencyMs,
    supportBundleFamily,
    dominantStage,
    semanticFallbackUsed,
    claim,
    topEvidence
  };
}

export async function runFlexibleIngestQualityProfile(): Promise<FlexibleIngestQualityProfileReport> {
  const mode = (process.env.BRAIN_FLEXIBLE_INGEST_ASSISTANT_MODE as ExtractionAssistantMode | undefined) ?? "assist";
  const sources: SourceQualityResult[] = [];
  for (const spec of SOURCE_FIXTURES) {
    sources.push(await sourceQualityResult(spec, mode));
  }
  const broadProfileSmoke: BroadProfileSmokeResult[] = [];
  for (const query of BROAD_PROFILE_QUERIES) {
    broadProfileSmoke.push(await broadProfileSmokeResult(query));
  }
  const sourceTypes = new Set(sources.map((entry) => entry.sourceType));
  const totalUnits = sources.reduce((sum, entry) => sum + entry.extractionUnitCount, 0);
  const totalChunks = sources.reduce((sum, entry) => sum + entry.artifactChunkCount, 0);
  const totalBoilerplate = sources.reduce((sum, entry) => sum + entry.emptyOrBoilerplateChunkCount, 0);
  const outputMaxes = sources.map((entry) => entry.assistantOutputTokensMax);
  const outputP95s = sources.map((entry) => entry.assistantOutputTokensP95);
  const inputP95s = sources.map((entry) => entry.inputTokenP95);
  const inputMaxes = sources.map((entry) => entry.inputTokenMax);
  const suggestedTaxonomyRecurrence = sources
    .flatMap((entry) => entry.suggestedTaxonomy)
    .reduce<Record<string, number>>((accumulator, key) => {
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});
  const thresholds = {
    sourceAdapterCoverage: 5,
    chunkBudgetPassRate: 1,
    extractionUnitInputTokensP95: 1200,
    extractionUnitInputTokensMax: 1800,
    emptyOrBoilerplateChunkRate: 0.02,
    sourceProvenanceCompleteness: 1,
    assistantOutputTokensP95: 350,
    assistantOutputTokensMax: 450,
    broadProfileSmokePassCount: 20,
    unrelatedTopEvidenceCount: 0,
    profileReportP95LatencyMs: 5000
  };
  const broadLatencies = broadProfileSmoke.map((entry) => entry.latencyMs);
  const metrics = {
    sourceAdapterCoverage: sourceTypes.size,
    chunkBudgetPassRate: rate(sources.reduce((sum, entry) => sum + entry.chunkBudgetPassChunks, 0), totalUnits),
    extractionUnitInputTokensP95: Math.max(0, ...inputP95s),
    extractionUnitInputTokensMax: Math.max(0, ...inputMaxes),
    emptyOrBoilerplateChunkRate: rate(totalBoilerplate, totalChunks),
    sourceProvenanceCompleteness: rate(sources.filter((entry) => entry.provenanceComplete).length, sources.length),
    jsonValidRate: rate(sources.reduce((sum, entry) => sum + entry.jsonValidChunks, 0), totalUnits),
    taxonomyPassRate: rate(sources.reduce((sum, entry) => sum + entry.taxonomyPassChunks, 0), totalUnits),
    temporalPassRate: rate(sources.reduce((sum, entry) => sum + entry.temporalPassChunks, 0), totalUnits),
    promotionSafetyPassRate: rate(sources.reduce((sum, entry) => sum + entry.promotionSafetyPassChunks, 0), totalUnits),
    assistantOutputTokensP95: Math.max(0, ...outputP95s),
    assistantOutputTokensMax: Math.max(0, ...outputMaxes),
    gliner2ErrorRate: rate(sources.reduce((sum, entry) => sum + entry.gliner2ErrorChunks, 0), totalUnits),
    suggestedTaxonomyCount: Object.values(suggestedTaxonomyRecurrence).reduce((sum, count) => sum + count, 0),
    broadProfileSmokePassCount: broadProfileSmoke.filter((entry) => entry.passed).length,
    unrelatedTopEvidenceCount: broadProfileSmoke.filter((entry) => entry.failures.includes("unrelated_top_evidence")).length,
    pairBindingPrecision: rate(broadProfileSmoke.filter((entry) => !entry.failures.includes("lauren_missing")).length, broadProfileSmoke.length),
    profileReportP95LatencyMs: percentile(broadLatencies, 95),
    semanticFallbackWithProfileSupportCount: broadProfileSmoke.filter((entry) => entry.semanticFallbackUsed).length
  };
  const failures: string[] = [];
  if (metrics.sourceAdapterCoverage < thresholds.sourceAdapterCoverage) failures.push("source_adapter_coverage_below_threshold");
  if (metrics.chunkBudgetPassRate < thresholds.chunkBudgetPassRate) failures.push("chunk_budget_failures");
  if (metrics.extractionUnitInputTokensP95 > thresholds.extractionUnitInputTokensP95) failures.push("input_token_p95_exceeded");
  if (metrics.extractionUnitInputTokensMax > thresholds.extractionUnitInputTokensMax) failures.push("input_token_max_exceeded");
  if (metrics.emptyOrBoilerplateChunkRate > thresholds.emptyOrBoilerplateChunkRate) failures.push("empty_or_boilerplate_chunk_rate_exceeded");
  if (metrics.sourceProvenanceCompleteness < thresholds.sourceProvenanceCompleteness) failures.push("source_provenance_incomplete");
  if (metrics.jsonValidRate < 1) failures.push("json_invalid_chunks");
  if (metrics.taxonomyPassRate < 1) failures.push("taxonomy_failures");
  if (metrics.temporalPassRate < 1) failures.push("temporal_failures");
  if (metrics.promotionSafetyPassRate < 1) failures.push("promotion_safety_failures");
  if (metrics.assistantOutputTokensP95 > thresholds.assistantOutputTokensP95) failures.push("assistant_output_p95_exceeded");
  if (metrics.assistantOutputTokensMax > thresholds.assistantOutputTokensMax) failures.push("assistant_output_max_exceeded");
  if (metrics.gliner2ErrorRate > 0) failures.push("gliner2_errors");
  if (metrics.broadProfileSmokePassCount < thresholds.broadProfileSmokePassCount) failures.push("broad_profile_smoke_failures");
  if (metrics.unrelatedTopEvidenceCount > thresholds.unrelatedTopEvidenceCount) failures.push("unrelated_top_evidence");
  if (metrics.profileReportP95LatencyMs > thresholds.profileReportP95LatencyMs) failures.push("profile_report_latency_exceeded");
  if (metrics.semanticFallbackWithProfileSupportCount > 0) failures.push("semantic_fallback_with_profile_support");

  return {
    generatedAt: new Date().toISOString(),
    benchmark: "flexible_ingest_quality_profile",
    passed: failures.length === 0 && sources.every((entry) => entry.passed) && broadProfileSmoke.every((entry) => entry.passed),
    thresholds,
    metrics,
    failures,
    sources,
    suggestedTaxonomyRecurrence,
    broadProfileSmoke
  };
}

export async function runAndWriteFlexibleIngestQualityProfile(): Promise<{
  readonly report: FlexibleIngestQualityProfileReport;
  readonly jsonPath: string;
}> {
  const report = await runFlexibleIngestQualityProfile();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `flexible-ingest-quality-profile-${stamp}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, jsonPath };
}

export async function runFlexibleIngestQualityProfileCli(): Promise<void> {
  try {
    const result = await runAndWriteFlexibleIngestQualityProfile();
    console.log(JSON.stringify(result, null, 2));
    if (!result.report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
