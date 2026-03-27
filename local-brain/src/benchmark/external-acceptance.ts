import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, withMaintenanceLock } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { upsertNamespaceSelfProfile } from "../identity/service.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { runTemporalNodeArchival, runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  createMonitoredSource,
  deleteMonitoredSource,
  importMonitoredSource,
  listMonitoredSources,
  scanMonitoredSource
} from "../ops/source-service.js";

type Confidence = "confident" | "weak" | "missing";
type FollowUpAction = "none" | "suggest_verification" | "route_to_clarifications";

interface QueryResult {
  readonly name: string;
  readonly passed: boolean;
  readonly confidence: Confidence | null;
  readonly followUpAction: string | null;
  readonly evidenceCount: number;
  readonly sourceLinkCount: number;
  readonly latencyMs: number;
  readonly failures: readonly string[];
}

interface PromptVariantResult extends QueryResult {
  readonly query: string;
}

export interface ExternalAcceptanceReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly source: {
    readonly id: string;
    readonly rootPath: string;
    readonly importedFiles: number;
  };
  readonly anchorGap: QueryResult;
  readonly aliasAdjudication: {
    readonly workSarah: QueryResult;
    readonly familySarah: QueryResult;
    readonly relationships: QueryResult;
    readonly graph: QueryResult;
  };
  readonly exactDetailDescent: QueryResult;
  readonly promptInvariance: {
    readonly expectedTerm: string;
    readonly variants: readonly PromptVariantResult[];
    readonly passed: boolean;
  };
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

function generatedRoot(): string {
  return path.resolve(rootDir(), "benchmark-generated", "external-acceptance", "normalized");
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).toLowerCase().includes(term.toLowerCase());
}

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  return [];
}

function sourceLinkCount(items: readonly any[]): number {
  let count = 0;
  for (const item of items) {
    if (typeof item?.artifactId === "string" && item.artifactId) {
      count += 1;
      continue;
    }
    if (typeof item?.sourceUri === "string" && item.sourceUri) {
      count += 1;
    }
  }
  return count;
}

async function buildCorpus(root: string): Promise<number> {
  await rm(root, { recursive: true, force: true });

  const files = [
    {
      relativePath: "2024/09/10/2024-09-10T09-00-00Z__acceptance__work-sarah-1.md",
      body: "# Atlas Work 1\n\nSteve worked with Sarah Kim, the product designer, on Atlas Rebuild.\n"
    },
    {
      relativePath: "2024/09/17/2024-09-17T09-00-00Z__acceptance__work-sarah-2.md",
      body: "# Atlas Work 2\n\nSteve worked with Sarah Kim again on Atlas Rebuild and reviewed the mockups together.\n"
    },
    {
      relativePath: "2024/09/24/2024-09-24T09-00-00Z__acceptance__work-sarah-3.md",
      body: "# Atlas Work 3\n\nFor the third week in a row, Steve worked with Sarah Kim on Atlas Rebuild.\n"
    },
    {
      relativePath: "2026/02/14/2026-02-14T11-00-00Z__acceptance__family-sarah-1.md",
      body: "# Family Sarah 1\n\nSarah Tietze is Steve's sister. She visited Chiang Mai and stayed near Nimman.\n"
    },
    {
      relativePath: "2026/02/21/2026-02-21T11-00-00Z__acceptance__family-sarah-2.md",
      body: "# Family Sarah 2\n\nSarah Tietze is Steve's sister. She called Steve about their dad and Reno storage.\n"
    },
    {
      relativePath: "2026/02/28/2026-02-28T11-00-00Z__acceptance__family-sarah-3.md",
      body: "# Family Sarah 3\n\nFor the third week this month, Sarah Tietze was still clearly identified as Steve's sister.\n"
    },
    {
      relativePath: "2026/03/12/2026-03-12T20-30-00Z__acceptance__receipt.md",
      body: "# Dinner Receipt\n\nOn March 12 2026, Steve's dinner receipt at Khao Soi Corner was 860 baht total including tip.\n"
    },
    {
      relativePath: "2026/03/13/2026-03-13T10-00-00Z__acceptance__doctor-gap.md",
      body: "# Vague Doctor Note\n\nThe doctor said Steve needs another follow-up after the scan, but Steve never wrote the doctor's name down. The project also slipped, but the project name was not written down either.\n"
    },
    {
      relativePath: "2026/03/14/2026-03-14T09-30-00Z__acceptance__doctor-gap-2.md",
      body: "# Vague Doctor Note 2\n\nSteve mentioned the doctor again, but there is still no real name for the doctor anywhere in these notes.\n"
    },
    {
      relativePath: "2026/03/20/2026-03-20T18-00-00Z__acceptance__tea.md",
      body: "# Evening Tea\n\nSteve prefers sencha tea in the evening now.\n"
    },
    {
      relativePath: "2026/03/31/2026-03-31T21-00-00Z__acceptance__month-recap.md",
      body: "# March Recap\n\nMarch had family calls, Atlas work, food notes, and a few dinners, but this recap does not list exact amounts.\n"
    }
  ] as const;

  for (const file of files) {
    const absolutePath = path.join(root, file.relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.body, "utf8");
  }

  return files.length;
}

async function ensureSource(namespaceId: string, rootPath: string) {
  const existing = (await listMonitoredSources(100)).filter((source) => source.namespaceId === namespaceId);
  for (const source of existing) {
    await deleteMonitoredSource(source.id);
  }
  return createMonitoredSource({
    sourceType: "folder",
    namespaceId,
    label: "External Acceptance Watch",
    rootPath,
    includeSubfolders: true,
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    notes: "External-user production acceptance benchmark.",
    metadata: {
      source_intent: "ongoing_folder_monitor",
      producer: "external_acceptance_benchmark",
      smoke_test: true
    }
  });
}

async function rebuildNamespace(namespaceId: string): Promise<void> {
  await runCandidateConsolidation(namespaceId, 800);
  await runRelationshipAdjudication(namespaceId, {
    limit: 900,
    acceptThreshold: 0.6,
    rejectThreshold: 0.4
  });
  for (const layer of ["day", "week", "month", "year"] as const) {
    await runTemporalSummaryScaffold(namespaceId, { layer, lookbackDays: 800 });
  }
  await runTemporalNodeArchival(namespaceId);
}

async function runSearchCheck(
  namespaceId: string,
  name: string,
  query: string,
  options: {
    readonly expectedTerms?: readonly string[];
    readonly expectedConfidence?: Confidence;
    readonly expectedFollowUpAction?: FollowUpAction;
    readonly minimumEvidence?: number;
    readonly requireSourceLink?: boolean;
  } = {}
): Promise<QueryResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const evidence = evidenceItems(payload);
  const confidence = (payload?.duality?.confidence ?? null) as Confidence | null;
  const followUpAction =
    typeof payload?.duality?.followUpAction === "string"
      ? payload.duality.followUpAction
      : typeof payload?.meta?.answerAssessment?.followUpAction === "string"
        ? payload.meta.answerAssessment.followUpAction
        : null;
  const failures: string[] = [];

  for (const term of options.expectedTerms ?? []) {
    if (!hasTerm(payload, term)) {
      failures.push(`missing term ${term}`);
    }
  }
  if (options.expectedConfidence && confidence !== options.expectedConfidence) {
    failures.push(`expected confidence ${options.expectedConfidence}, got ${confidence ?? "n/a"}`);
  }
  if ((options.expectedFollowUpAction ?? "none") !== (followUpAction ?? "none")) {
    failures.push(`expected followUpAction ${options.expectedFollowUpAction ?? "none"}, got ${followUpAction ?? "none"}`);
  }
  if ((options.minimumEvidence ?? 0) > evidence.length) {
    failures.push(`expected at least ${options.minimumEvidence} evidence rows, got ${evidence.length}`);
  }
  if (options.requireSourceLink && sourceLinkCount(evidence) === 0) {
    failures.push("expected at least one source-linked evidence row");
  }

  return {
    name,
    passed: failures.length === 0,
    confidence,
    followUpAction,
    evidenceCount: evidence.length,
    sourceLinkCount: sourceLinkCount(evidence),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    failures
  };
}

async function runToolCheck(
  toolName: "memory.get_clarifications" | "memory.get_relationships" | "memory.get_graph",
  name: string,
  args: Record<string, unknown>,
  validators: Array<(payload: any) => readonly string[]>
): Promise<QueryResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(toolName, args)) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const failures = validators.flatMap((validator) => [...validator(payload)]);
  const evidence = evidenceItems(payload);

  return {
    name,
    passed: failures.length === 0,
    confidence: (payload?.duality?.confidence ?? null) as Confidence | null,
    followUpAction:
      typeof payload?.duality?.followUpAction === "string"
        ? payload.duality.followUpAction
        : null,
    evidenceCount: evidence.length,
    sourceLinkCount: sourceLinkCount(evidence),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    failures
  };
}

function toMarkdown(report: ExternalAcceptanceReport): string {
  const lines = [
    "# External Acceptance Benchmark",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- importedFiles: ${report.source.importedFiles}`,
    `- passed: ${report.passed}`,
    "",
    "## Anchor Gap",
    "",
    `- ${report.anchorGap.name}: ${report.anchorGap.passed ? "pass" : "fail"} | confidence=${report.anchorGap.confidence ?? "n/a"} | followUp=${report.anchorGap.followUpAction ?? "none"}`
  ];

  for (const failure of report.anchorGap.failures) {
    lines.push(`  - ${failure}`);
  }

  lines.push("", "## Alias Adjudication", "");
  for (const item of [
    report.aliasAdjudication.workSarah,
    report.aliasAdjudication.familySarah,
    report.aliasAdjudication.relationships,
    report.aliasAdjudication.graph
  ]) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"} | confidence=${item.confidence ?? "n/a"} | evidence=${item.evidenceCount} | sourceLinks=${item.sourceLinkCount}`);
    for (const failure of item.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("", "## Exact Detail Descent", "");
  lines.push(`- ${report.exactDetailDescent.name}: ${report.exactDetailDescent.passed ? "pass" : "fail"} | confidence=${report.exactDetailDescent.confidence ?? "n/a"} | evidence=${report.exactDetailDescent.evidenceCount}`);
  for (const failure of report.exactDetailDescent.failures) {
    lines.push(`  - ${failure}`);
  }

  lines.push("", "## Prompt Invariance", "");
  lines.push(`- expectedTerm: ${report.promptInvariance.expectedTerm}`);
  lines.push(`- passed: ${report.promptInvariance.passed}`);
  for (const variant of report.promptInvariance.variants) {
    lines.push(`- ${variant.name}: ${variant.passed ? "pass" : "fail"} | query=${variant.query}`);
    for (const failure of variant.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runExternalAcceptanceBenchmark(
  namespaceId = `external_acceptance_${Date.now().toString(36)}`
): Promise<ExternalAcceptanceReport> {
  return withMaintenanceLock("the external acceptance benchmark", async () => {
    await runMigrations();
    const rootPath = generatedRoot();
    const markdownFiles = await buildCorpus(rootPath);
    await upsertNamespaceSelfProfile({
      namespaceId,
      canonicalName: "Steve Tietze",
      aliases: ["Steve"],
      note: "External acceptance benchmark self anchor."
    });

    const source = await ensureSource(namespaceId, rootPath);
    await scanMonitoredSource(source.id);
    const importResult = await importMonitoredSource(source.id, "onboarding");
    await rebuildNamespace(namespaceId);

    const anchorGap = await runSearchCheck(namespaceId, "anchor_gap_doctor", "who is the doctor?", {
      expectedConfidence: "missing",
      expectedFollowUpAction: "route_to_clarifications",
      minimumEvidence: 0
    });
    const anchorClarifications = await runToolCheck(
      "memory.get_clarifications",
      "anchor_gap_doctor_clarifications",
      { namespace_id: namespaceId, query: "doctor", limit: 10 },
      [
        (payload) => {
          const failures: string[] = [];
          const items = Array.isArray(payload?.items) ? payload.items : [];
          if (items.length < 1) {
            failures.push("expected clarification inbox item for vague doctor");
          }
          return failures;
        }
      ]
    );
    const anchorFailures = [...anchorGap.failures, ...anchorClarifications.failures];
    const anchorGapCombined: QueryResult = {
      ...anchorGap,
      passed: anchorFailures.length === 0,
      failures: anchorFailures
    };

    const workSarah = await runSearchCheck(namespaceId, "alias_work_sarah", "who is Sarah Kim?", {
      expectedTerms: ["Sarah Kim", "designer", "Atlas Rebuild"],
      expectedConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true
    });
    const familySarah = await runSearchCheck(namespaceId, "alias_family_sarah", "who is Sarah Tietze?", {
      expectedTerms: ["Sarah Tietze", "sister"],
      expectedConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true
    });
    const relationshipCheck = await runToolCheck(
      "memory.get_relationships",
      "alias_relationship_surface",
      { namespace_id: namespaceId, entity_name: "Steve Tietze", limit: 24 },
      [
        (payload) => {
          const failures: string[] = [];
          const blob = jsonString(payload);
          if (!blob.includes("Sarah Kim")) {
            failures.push("relationship surface missing Sarah Kim");
          }
          if (!blob.includes("Sarah Tietze")) {
            failures.push("relationship surface missing Sarah Tietze");
          }
          return failures;
        }
      ]
    );
    const graphCheck = await runToolCheck(
      "memory.get_graph",
      "alias_graph_distinct_nodes",
      { namespace_id: namespaceId, entity_name: "Steve Tietze", limit: 48 },
      [
        (payload) => {
          const failures: string[] = [];
          const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
          const labels = nodes.map((node: any) => jsonString(node));
          if (!labels.some((label: string) => label.includes("Sarah Kim"))) {
            failures.push("graph missing Sarah Kim node");
          }
          if (!labels.some((label: string) => label.includes("Sarah Tietze"))) {
            failures.push("graph missing Sarah Tietze node");
          }
          return failures;
        }
      ]
    );

    const exactDetailDescent = await runSearchCheck(
      namespaceId,
      "exact_detail_receipt_amount",
      "how much was the dinner receipt on March 12 2026?",
      {
        expectedTerms: ["860", "baht", "Khao Soi Corner"],
        expectedConfidence: "confident",
        minimumEvidence: 1,
        requireSourceLink: true
      }
    );

    const promptVariants = [
      "what tea should I make Steve tonight?",
      "what does Steve usually drink in the evening now?",
      "if I put on a kettle for Steve later, which tea is right?",
      "remind me what evening tea Steve wants these days"
    ] as const;
    const promptVariantResults: PromptVariantResult[] = [];
    for (const [index, query] of promptVariants.entries()) {
      const result = await runSearchCheck(namespaceId, `prompt_invariance_${index + 1}`, query, {
        expectedTerms: ["sencha"],
        expectedConfidence: "confident",
        minimumEvidence: 1,
        requireSourceLink: true
      });
      promptVariantResults.push({
        ...result,
        query
      });
    }

    const report: ExternalAcceptanceReport = {
      generatedAt: new Date().toISOString(),
      namespaceId,
      source: {
        id: source.id,
        rootPath: source.rootPath,
        importedFiles: importResult.importRun?.filesImported ?? 0
      },
      anchorGap: anchorGapCombined,
      aliasAdjudication: {
        workSarah,
        familySarah,
        relationships: relationshipCheck,
        graph: graphCheck
      },
      exactDetailDescent,
      promptInvariance: {
        expectedTerm: "sencha",
        variants: promptVariantResults,
        passed: promptVariantResults.every((item) => item.passed)
      },
      passed:
        (importResult.importRun?.filesImported ?? 0) >= markdownFiles &&
        anchorGapCombined.passed &&
        workSarah.passed &&
        familySarah.passed &&
        relationshipCheck.passed &&
        graphCheck.passed &&
        exactDetailDescent.passed &&
        promptVariantResults.every((item) => item.passed)
    };

    return report;
  });
}

export async function runAndWriteExternalAcceptanceBenchmark(): Promise<{
  readonly report: ExternalAcceptanceReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runExternalAcceptanceBenchmark();
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `external-acceptance-${stamp}.json`);
    const markdownPath = path.join(dir, `external-acceptance-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return {
      report,
      output: {
        jsonPath,
        markdownPath
      }
    };
  } finally {
    await closePool();
  }
}

export async function runExternalAcceptanceBenchmarkCli(): Promise<void> {
  const result = await runAndWriteExternalAcceptanceBenchmark();
  console.log(JSON.stringify(result, null, 2));
}
