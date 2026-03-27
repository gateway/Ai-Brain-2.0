import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closePool, queryRows } from "../db/client.js";
import { readConfig } from "../config.js";
import { ingestArtifact } from "../ingest/worker.js";
import { enqueueDerivationJob } from "../jobs/derivation-queue.js";
import { executeDerivationWorker } from "../ops/runtime-worker-service.js";
import { searchMemory } from "../retrieval/service.js";

type FixtureKind = "image" | "pdf" | "audio" | "video";
const execFileAsync = promisify(execFile);

interface FixtureSpec {
  readonly kind: FixtureKind;
  readonly inputUri: string;
  readonly capturedAt: string;
  readonly sourceChannel: string;
}

interface QueryProbeResult {
  readonly kind: FixtureKind;
  readonly probeQuery: string;
  readonly latencyMs: number;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface MultimodalWorkerSmokeReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly provider: string;
  readonly model: string;
  readonly derivationCount: number;
  readonly externalWorker: {
    readonly claimed: number;
    readonly completed: number;
    readonly failed: number;
    readonly retried: number;
  };
  readonly unsupportedExternalCount: number;
  readonly unsupportedWorker: {
    readonly claimed: number;
    readonly completed: number;
    readonly failed: number;
    readonly retried: number;
  };
  readonly probeResults: readonly QueryProbeResult[];
  readonly failures: readonly string[];
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

function fixtureSpecs(): readonly FixtureSpec[] {
  const repoRoot = path.resolve(rootDir(), "..");
  return [
    {
      kind: "image",
      inputUri: path.join(repoRoot, "artifacts", "the-digital-brain", "infographics", "2026 AI Agent Architecture Blueprint.png"),
      capturedAt: "2026-03-22T09:00:00Z",
      sourceChannel: "multimodal-worker-smoke:image"
    },
    {
      kind: "pdf",
      inputUri: path.join(repoRoot, "artifacts", "the-digital-brain", "slide-decks", "The Multimodal Substrate.pdf"),
      capturedAt: "2026-03-22T09:05:00Z",
      sourceChannel: "multimodal-worker-smoke:pdf"
    },
    {
      kind: "audio",
      inputUri: path.join(repoRoot, "artifacts", "the-digital-brain", "audio", "How AI agents gain permanent memory.mp3"),
      capturedAt: "2026-03-22T09:10:00Z",
      sourceChannel: "multimodal-worker-smoke:audio"
    },
    {
      kind: "video",
      inputUri: path.join(outputDir(), ".multimodal-fixtures", "graph-walkthrough.smoke.mp4"),
      capturedAt: "2026-03-22T09:15:00Z",
      sourceChannel: "multimodal-worker-smoke:video"
    }
  ];
}

async function prepareClippedAudioFixture(sourceUri: string): Promise<string> {
  const clipsDir = path.resolve(outputDir(), ".multimodal-fixtures");
  await mkdir(clipsDir, { recursive: true });
  const clippedUri = path.join(clipsDir, `${path.basename(sourceUri, path.extname(sourceUri))}.smoke-clip.mp3`);

  try {
    const existing = await stat(clippedUri);
    if (existing.size > 0) {
      return clippedUri;
    }
  } catch {
    // create the clip below
  }

  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    "0",
    "-t",
    "5",
    "-i",
    sourceUri,
    "-vn",
    "-c:a",
    "libmp3lame",
    clippedUri
  ]);

  return clippedUri;
}

async function prepareVideoFixture(targetUri: string): Promise<string> {
  await mkdir(path.dirname(targetUri), { recursive: true });
  await writeFile(targetUri, Buffer.from("FAKE-MP4-AI-BRAIN-GRAPH-WALKTHROUGH", "utf8"));
  return targetUri;
}

function buildProbeQuery(content: string): string {
  const tokens = (content.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => !["that", "with", "from", "this", "have", "they", "their", "about", "should", "brain", "agent"].includes(token));
  const picked = [...new Set(tokens)].slice(0, 4);
  return picked.join(" ");
}

async function latestWorkerRun(workerId: string) {
  const rows = await queryRows<{
    readonly status: string;
    readonly error_class: string | null;
    readonly error_message: string | null;
    readonly summary_json: Record<string, unknown>;
  }>(
    `
      SELECT status, error_class, error_message, summary_json
      FROM ops.worker_runs
      WHERE worker_key = 'derivation'
        AND worker_id = $1
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [workerId]
  );
  return rows[0] ?? null;
}

async function waitForLatestWorkerRun(workerId: string, attempts = 5, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await latestWorkerRun(workerId);
    if (row) {
      return row;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

function toMarkdown(report: MultimodalWorkerSmokeReport): string {
  const lines = [
    "# Multimodal Worker Smoke Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Namespace: ${report.namespaceId}`,
    `Provider: ${report.provider}`,
    `Model: ${report.model}`,
    `Derivations: ${report.derivationCount}`,
    `External worker: claimed=${report.externalWorker.claimed} completed=${report.externalWorker.completed} failed=${report.externalWorker.failed} retried=${report.externalWorker.retried}`,
    `Unsupported worker: claimed=${report.unsupportedWorker.claimed} completed=${report.unsupportedWorker.completed} failed=${report.unsupportedWorker.failed} retried=${report.unsupportedWorker.retried}`,
    `Passed: ${report.passed}`,
    "",
    "## Query Probes",
    ""
  ];

  for (const probe of report.probeResults) {
    lines.push(`- ${probe.kind}: ${probe.passed ? "pass" : "fail"} | latency=${probe.latencyMs}ms | query=\`${probe.probeQuery}\``);
    if (probe.failures.length > 0) {
      lines.push(`  failures: ${probe.failures.join("; ")}`);
    }
  }

  if (report.failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runAndWriteMultimodalWorkerSmokeBenchmark(): Promise<{
  readonly report: MultimodalWorkerSmokeReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const config = readConfig();
  const namespaceId = `multimodal_prod_smoke_${Date.now()}`;
  const provider = "external";
  const model = config.externalAiDeriveModel;
  const failures: string[] = [];
  const fixtureResults: Array<{
    readonly kind: FixtureKind;
    readonly artifactId: string;
    readonly observationId: string;
  }> = [];

  try {
    const resolvedFixtures = await Promise.all(
      fixtureSpecs().map(async (fixture) =>
        fixture.kind === "audio"
          ? {
              ...fixture,
              inputUri: await prepareClippedAudioFixture(fixture.inputUri)
            }
          : fixture.kind === "video"
            ? {
                ...fixture,
                inputUri: await prepareVideoFixture(fixture.inputUri)
              }
            : fixture
      )
    );

    for (const fixture of resolvedFixtures) {
      const ingestResult = await ingestArtifact({
        namespaceId,
        sourceType: fixture.kind,
        inputUri: fixture.inputUri,
        capturedAt: fixture.capturedAt,
        sourceChannel: fixture.sourceChannel,
        metadata: {
          benchmark_multimodal_worker_smoke: true,
          source_filename: path.basename(fixture.inputUri)
        }
      });

      if (!ingestResult.artifact.observationId) {
        failures.push(`missing observation id for ${fixture.inputUri}`);
        continue;
      }

      fixtureResults.push({
        kind: fixture.kind,
        artifactId: ingestResult.artifact.artifactId,
        observationId: ingestResult.artifact.observationId
      });

      await enqueueDerivationJob({
        namespaceId,
        artifactId: ingestResult.artifact.artifactId,
        artifactObservationId: ingestResult.artifact.observationId,
        jobKind: fixture.kind === "audio" ? "transcription" : fixture.kind === "video" ? "caption" : "ocr",
        modality: fixture.kind,
        provider,
        model,
        metadata: {
          benchmark_multimodal_worker_smoke: true,
          source_filename: path.basename(fixture.inputUri)
        }
      });
    }

    const externalWorkerId = "multimodal-worker-smoke:external";
    const externalWorker = await executeDerivationWorker({
      namespaceId,
      provider,
      limit: 12,
      triggerType: "repair",
      workerId: externalWorkerId
    });

    const unsupportedWorkerId = "multimodal-worker-smoke:unsupported";
    await enqueueDerivationJob({
      namespaceId,
      artifactId: fixtureResults[0]!.artifactId,
      artifactObservationId: fixtureResults[0]!.observationId,
      jobKind: "ocr",
      modality: "image",
      provider: "gemini",
      model: config.geminiMultimodalModel,
      metadata: {
        benchmark_multimodal_worker_smoke: true,
        unsupported_provider_probe: true
      }
    });
    const unsupportedWorker = await executeDerivationWorker({
      namespaceId,
      provider: "gemini",
      limit: 4,
      triggerType: "repair",
      workerId: unsupportedWorkerId
    });

    const derivations = await queryRows<{
      readonly derivation_type: string;
      readonly content_text: string;
      readonly provider: string | null;
      readonly model: string | null;
    }>(
      `
        SELECT ad.derivation_type, ad.content_text, ad.provider, ad.model
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        WHERE a.namespace_id = $1
        ORDER BY ao.observed_at ASC, ad.created_at ASC
      `,
      [namespaceId]
    );

    if (derivations.length < 1) {
      failures.push("expected at least one live derivation result");
    }

    const probeResults: QueryProbeResult[] = [];
    for (const [index, row] of derivations.entries()) {
      const probeQuery = buildProbeQuery(row.content_text);
      if (!probeQuery) {
        probeResults.push({
          kind: fixtureResults[index]?.kind ?? "image",
          probeQuery: "",
          latencyMs: 0,
          passed: false,
          failures: ["could not build a stable probe query from derivation text"]
        });
        continue;
      }

      const started = performance.now();
      const result = await searchMemory({
        namespaceId,
        query: probeQuery,
        limit: 4
      });
      const latencyMs = Number((performance.now() - started).toFixed(2));
      const probeFailures: string[] = [];
      if (!result.results.some((item) => item.memoryType === "artifact_derivation")) {
        probeFailures.push("artifact derivation did not surface in query results");
      }
      if (result.evidence.length === 0) {
        probeFailures.push("query returned no evidence items");
      }
      probeResults.push({
        kind: fixtureResults[index]?.kind ?? "image",
        probeQuery,
        latencyMs,
        passed: probeFailures.length === 0,
        failures: probeFailures
      });
    }

    const unsupportedExternalCount = Number(externalWorker.failureCategories.provider_unsupported ?? 0);
    if (externalWorker.completed < resolvedFixtures.length) {
      failures.push(`expected ${resolvedFixtures.length} production-backed derivations to complete, got ${externalWorker.completed}`);
    }
    if (unsupportedExternalCount > 0) {
      failures.push(`expected external multimodal worker to drain all queued jobs, got provider_unsupported=${unsupportedExternalCount}`);
    }

    const externalRun = await waitForLatestWorkerRun(externalWorkerId);
    if (!externalRun || !["partial", "succeeded"].includes(externalRun.status)) {
      failures.push(`expected partial or succeeded derivation worker run for ${externalWorkerId}`);
    }
    if (
      externalRun &&
      Number((externalRun.summary_json?.failure_categories as Record<string, unknown> | undefined)?.provider_unsupported ?? 0) !== unsupportedExternalCount
    ) {
      failures.push("external worker run summary did not retain provider_unsupported counts");
    }

    const unsupportedRun = await waitForLatestWorkerRun(unsupportedWorkerId);
    if (!unsupportedRun || unsupportedRun.status !== "failed") {
      failures.push(`expected failed derivation worker run for ${unsupportedWorkerId}`);
    }
    if (
      unsupportedRun &&
      Number((unsupportedRun.summary_json?.failure_categories as Record<string, unknown> | undefined)?.provider_unsupported ?? 0) < 1
    ) {
      failures.push(
        `expected provider_unsupported category for unsupported worker, got ${JSON.stringify(unsupportedRun.summary_json ?? {})}`
      );
    }

    for (const probe of probeResults) {
      failures.push(...probe.failures.map((failure) => `${probe.kind}: ${failure}`));
    }

    const report: MultimodalWorkerSmokeReport = {
      generatedAt: new Date().toISOString(),
      namespaceId,
      provider,
      model,
      derivationCount: derivations.length,
      externalWorker,
      unsupportedExternalCount,
      unsupportedWorker,
      probeResults,
      failures,
      passed: failures.length === 0
    };

    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `multimodal-worker-smoke-${stamp}.json`);
    const markdownPath = path.join(dir, `multimodal-worker-smoke-${stamp}.md`);
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
