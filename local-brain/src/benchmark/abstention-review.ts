import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type Confidence = "confident" | "weak" | "missing";
type Verdict = "pass" | "warning" | "fail";

interface ScenarioDefinition {
  readonly name: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly description: string;
  readonly expectedTerms: readonly string[];
  readonly expectedConfidence: Confidence;
  readonly minimumEvidence: number;
  readonly expectedSubjectMatch?: "matched" | "mixed" | "mismatched" | "unknown";
}

interface ScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly latencyMs: number;
  readonly confidence: string | null;
  readonly sufficiency: string | null;
  readonly subjectMatch: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly answerSnippet: string | null;
  readonly verdict: Verdict;
  readonly failureClass: string;
  readonly failures: readonly string[];
}

export interface AbstentionReviewReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaces: readonly string[];
  readonly scenarios: readonly ScenarioResult[];
  readonly summary: {
    readonly pass: number;
    readonly warning: number;
    readonly fail: number;
  };
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

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "abstention-review");
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null).toLowerCase();
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).includes(term.toLowerCase());
}

function trimSnippet(value: unknown, max = 220): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function sourceCount(payload: any): number {
  const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
  return new Set(
    evidence
      .map((item: any) =>
        typeof item?.sourceUri === "string" && item.sourceUri
          ? item.sourceUri
          : typeof item?.artifactId === "string" && item.artifactId
            ? item.artifactId
            : null
      )
      .filter((value: string | null): value is string => typeof value === "string" && value.length > 0)
  ).size;
}

async function ingestSyntheticMarkdown(namespaceId: string, name: string, body: string, capturedAt: string): Promise<void> {
  const corpusRoot = path.join(generatedRoot(), namespaceId);
  await mkdir(corpusRoot, { recursive: true });
  const filePath = path.join(corpusRoot, `${name}.md`);
  await writeFile(filePath, body, "utf8");
  await ingestArtifact({
    namespaceId,
    sourceType: "markdown",
    inputUri: filePath,
    capturedAt,
    metadata: {
      benchmark: "abstention_review",
      scenario: name
    },
    sourceChannel: "benchmark:abstention_review"
  });
}

function classifyFailure(result: { readonly confidence: string | null; readonly subjectMatch: string | null; readonly failures: readonly string[] }): string {
  if (result.failures.some((failure) => failure.includes("subject match"))) {
    return "alias_or_subject_leakage";
  }
  if (result.failures.some((failure) => failure.includes("missing term"))) {
    return "answer_shaping";
  }
  if (result.confidence === "confident") {
    return "abstention_failure";
  }
  if (result.subjectMatch === "mismatched") {
    return "wrong_person_transfer";
  }
  return "sufficiency_gap";
}

function toMarkdown(report: AbstentionReviewReport): string {
  const lines = [
    "# Abstention Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- relationIeSchemaVersion: ${report.runtime.relationIeSchemaVersion}`,
    `- iterativeScanMode: ${report.runtime.iterativeScanMode}`,
    "",
    "## Scenarios",
    ""
  ];

  for (const scenario of report.scenarios) {
    lines.push(
      `- ${scenario.name}: ${scenario.verdict} | confidence=${scenario.confidence ?? "n/a"} | sufficiency=${scenario.sufficiency ?? "n/a"} | subjectMatch=${scenario.subjectMatch ?? "n/a"} | failureClass=${scenario.failureClass} | latencyMs=${scenario.latencyMs}`
    );
    lines.push(`  - q: ${scenario.query}`);
    if (scenario.answerSnippet) {
      lines.push(`  - answer: ${scenario.answerSnippet}`);
    }
    for (const failure of scenario.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function runScenario(definition: ScenarioDefinition): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: definition.namespaceId,
    query: definition.query,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const confidence = typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : null;
  const sufficiency = typeof payload?.meta?.answerAssessment?.sufficiency === "string" ? payload.meta.answerAssessment.sufficiency : null;
  const subjectMatch = typeof payload?.meta?.answerAssessment?.subjectMatch === "string" ? payload.meta.answerAssessment.subjectMatch : null;
  const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
  const failures: string[] = [];

  for (const term of definition.expectedTerms) {
    if (!hasTerm(payload, term)) {
      failures.push(`missing term ${term}`);
    }
  }
  if (confidence !== definition.expectedConfidence) {
    failures.push(`expected confidence ${definition.expectedConfidence}, got ${confidence ?? "n/a"}`);
  }
  if (evidence.length < definition.minimumEvidence) {
    failures.push(`expected at least ${definition.minimumEvidence} evidence rows, got ${evidence.length}`);
  }
  if (definition.expectedSubjectMatch && subjectMatch !== definition.expectedSubjectMatch) {
    failures.push(`expected subject match ${definition.expectedSubjectMatch}, got ${subjectMatch ?? "n/a"}`);
  }

  const verdict: Verdict = failures.length === 0 ? "pass" : confidence === "missing" || confidence === "weak" ? "warning" : "fail";
  return {
    name: definition.name,
    description: definition.description,
    namespaceId: definition.namespaceId,
    query: definition.query,
    latencyMs,
    confidence,
    sufficiency,
    subjectMatch,
    evidenceCount: evidence.length,
    sourceCount: sourceCount(payload),
    answerSnippet: trimSnippet(payload?.duality?.claim?.text ?? payload?.summaryText ?? payload?.explanation),
    verdict,
    failureClass: classifyFailure({ confidence, subjectMatch, failures }),
    failures
  };
}

export async function runAndWriteAbstentionReviewBenchmark(): Promise<{
  readonly report: AbstentionReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const namespaces = {
    profile: `benchmark_abstention_profile_${stamp}`,
    relationship: `benchmark_abstention_relationship_${stamp}`,
    shared: `benchmark_abstention_shared_${stamp}`,
    causal: `benchmark_abstention_causal_${stamp}`
  } as const;

  await ingestSyntheticMarkdown(
    namespaces.profile,
    "profile_support_maya",
    [
      "2026-03-20",
      "Maya has been reading about psychology programs and wants to work in counseling.",
      "Maya said counseling and mental health work feel like the right path."
    ].join("\n"),
    "2026-03-20T09:00:00.000Z"
  );
  await ingestSyntheticMarkdown(
    namespaces.profile,
    "profile_noise_leo",
    [
      "2026-03-20",
      "Leo wants to open a bike shop someday.",
      "Leo has not picked an academic field."
    ].join("\n"),
    "2026-03-20T10:00:00.000Z"
  );
  await ingestSyntheticMarkdown(
    namespaces.relationship,
    "relationship_support",
    [
      "2026-03-22",
      "Ava told Ben she was grateful for their marriage.",
      "Carla said she works with Ben on the logistics team."
    ].join("\n"),
    "2026-03-22T13:00:00.000Z"
  );
  await ingestSyntheticMarkdown(
    namespaces.shared,
    "shared_guardrail",
    [
      "2026-03-18",
      "Nina relaxes by doing yoga and cooking.",
      "Omar relaxes by playing chess and reading science fiction."
    ].join("\n"),
    "2026-03-18T08:15:00.000Z"
  );
  await ingestSyntheticMarkdown(
    namespaces.causal,
    "causal_support",
    [
      "2026-03-21",
      "Project Atlas changed direction after repeated sync failures in low-connectivity environments.",
      "Steve decided to move Atlas toward offline-first capture to prevent data loss."
    ].join("\n"),
    "2026-03-21T12:45:00.000Z"
  );

  const definitions: readonly ScenarioDefinition[] = [
    {
      name: "profile_supported_subject_bound",
      namespaceId: namespaces.profile,
      query: "What field is Maya likely to pursue in her education?",
      description: "Positive control for repeated profile support.",
      expectedTerms: ["psychology", "counseling"],
      expectedConfidence: "confident",
      minimumEvidence: 2,
      expectedSubjectMatch: "matched"
    },
    {
      name: "wrong_person_profile_transfer",
      namespaceId: namespaces.profile,
      query: "What field is Leo likely to pursue in his education?",
      description: "Should abstain instead of borrowing Maya's counseling evidence.",
      expectedTerms: [],
      expectedConfidence: "missing",
      minimumEvidence: 0
    },
    {
      name: "wrong_person_relationship_transfer",
      namespaceId: namespaces.relationship,
      query: "Who is Carla married to?",
      description: "Should not transfer Ava's marriage to Carla.",
      expectedTerms: [],
      expectedConfidence: "missing",
      minimumEvidence: 0
    },
    {
      name: "unsupported_commonality_none",
      namespaceId: namespaces.shared,
      query: "What do Nina and Omar both do to relax?",
      description: "Should return no shared evidence instead of inventing overlap.",
      expectedTerms: [],
      expectedConfidence: "missing",
      minimumEvidence: 0,
      expectedSubjectMatch: "matched"
    },
    {
      name: "wrong_project_causal_transfer",
      namespaceId: namespaces.causal,
      query: "Why did Project Borealis change direction?",
      description: "Should abstain instead of reusing Atlas rationale for another project.",
      expectedTerms: [],
      expectedConfidence: "missing",
      minimumEvidence: 0
    }
  ];

  const scenarios: ScenarioResult[] = [];
  for (const definition of definitions) {
    scenarios.push(await runScenario(definition));
  }

  const report: AbstentionReviewReport = {
    generatedAt,
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: definitions.length,
        negativeScenarioCount: definitions.filter((item) => item.expectedConfidence === "missing").length
      }
    }),
    namespaces: Object.values(namespaces),
    scenarios,
    summary: {
      pass: scenarios.filter((scenario) => scenario.verdict === "pass").length,
      warning: scenarios.filter((scenario) => scenario.verdict === "warning").length,
      fail: scenarios.filter((scenario) => scenario.verdict === "fail").length
    }
  };

  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `abstention-review-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `abstention-review-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runAbstentionReviewBenchmarkCli(): Promise<void> {
  const { output, report } = await runAndWriteAbstentionReviewBenchmark();
  process.stdout.write(`${JSON.stringify({ summary: report.summary, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  await closePool();
}
