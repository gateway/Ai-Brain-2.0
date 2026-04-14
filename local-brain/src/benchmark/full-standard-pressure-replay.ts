import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { cleanupPublicBenchmarkNamespaces } from "./public-benchmark-cleanup.js";
import { parseLoCoMoSessionDateTimeToIso } from "./public-memory-date-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface TurnRecord {
  readonly speaker: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
}

interface LocomoConversation {
  readonly sample_id: string;
  readonly conversation: Record<string, string | readonly TurnRecord[]>;
  readonly qa: readonly {
    readonly question: string;
    readonly answer?: string | number;
    readonly category: number;
  }[];
}

export interface FullStandardPressureReplayOptions {
  readonly sampleId: string;
  readonly question: string;
  readonly limit?: number;
  readonly keepNamespace?: boolean;
}

export interface FullStandardPressureReplayArtifact {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleId: string;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly namespaceId: string;
  readonly keptNamespace: boolean;
  readonly latencyMs: number;
  readonly payload: unknown;
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "full-standard-pressure-replay");
}

function searchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`request failed for ${url}: ${response.statusCode}`));
        response.resume();
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    }).on("error", reject);
  });
}

async function downloadCached(url: string, fileName: string): Promise<string> {
  const destination = path.join(generatedRoot(), "raw", fileName);
  try {
    return await readFile(destination, "utf8");
  } catch {
    await mkdir(path.dirname(destination), { recursive: true });
    const body = await searchText(url);
    await writeFile(destination, body, "utf8");
    return body;
  }
}

function benchmarkExpectedAnswer(qa: { readonly answer?: string | number; readonly category: number }): string {
  if (typeof qa.answer === "string" && qa.answer.trim().length > 0) {
    return qa.answer;
  }
  if (typeof qa.answer === "number" && Number.isFinite(qa.answer)) {
    return String(qa.answer);
  }
  return qa.category === 5 ? "None" : "";
}

function formatConversationSession(sample: LocomoConversation, sessionKey: string, turns: readonly TurnRecord[]): string {
  const dateTime = typeof sample.conversation[`${sessionKey}_date_time`] === "string" ? sample.conversation[`${sessionKey}_date_time`] : "";
  const canonicalCapturedAt = typeof dateTime === "string" && dateTime ? parseLoCoMoSessionDateTimeToIso(dateTime) : null;
  const speakerA = typeof sample.conversation.speaker_a === "string" ? sample.conversation.speaker_a : "Speaker A";
  const speakerB = typeof sample.conversation.speaker_b === "string" ? sample.conversation.speaker_b : "Speaker B";
  const lines: string[] = [];
  if (canonicalCapturedAt) {
    lines.push(`Captured: ${canonicalCapturedAt}`, "");
  } else if (dateTime) {
    lines.push(`Captured: ${dateTime}`, "");
  }
  lines.push(`Conversation between ${speakerA} and ${speakerB}`);
  for (const turn of turns) {
    const caption = typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0 ? ` [image: ${turn.blip_caption.trim()}]` : "";
    lines.push(`${turn.speaker}: ${(turn.text ?? "").trim()}${caption}`);
    if (typeof turn.query === "string" && turn.query.trim().length > 0) {
      lines.push(`--- image_query: ${turn.query.trim()}`);
    }
    if (typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0) {
      lines.push(`--- image_caption: ${turn.blip_caption.trim()}`);
    }
  }
  return lines.join("\n");
}

function toMarkdown(artifact: FullStandardPressureReplayArtifact): string {
  const payload = artifact.payload as any;
  const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
  const lines = [
    "# Full Standard Pressure Replay",
    "",
    `- generatedAt: ${artifact.generatedAt}`,
    `- sampleId: ${artifact.sampleId}`,
    `- question: ${artifact.question}`,
    `- expectedAnswer: ${artifact.expectedAnswer}`,
    `- namespaceId: ${artifact.namespaceId}`,
    `- keptNamespace: ${artifact.keptNamespace}`,
    `- latencyMs: ${artifact.latencyMs}`,
    `- answer: ${payload?.duality?.claim?.text ?? payload?.summaryText ?? payload?.explanation ?? "None."}`,
    "",
    "## Meta",
    "",
    "```json",
    JSON.stringify(payload?.meta ?? {}, null, 2),
    "```",
    "",
    "## Evidence",
    ""
  ];
  for (const item of evidence) {
    lines.push(
      `- ${JSON.stringify({
        snippet: item?.snippet ?? null,
        sourceUri: item?.sourceUri ?? null,
        artifactId: item?.artifactId ?? null,
        capturedAt: item?.capturedAt ?? null
      })}`
    );
  }
  lines.push("", "## Payload", "", "```json", JSON.stringify(payload, null, 2), "```", "");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteFullStandardPressureReplay(
  options: FullStandardPressureReplayOptions
): Promise<{ readonly artifact: FullStandardPressureReplayArtifact; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const runtime = buildBenchmarkRuntimeMetadata({
    benchmarkMode: "sampled",
    sampleControls: {
      suite: "full_standard_pressure_replay",
      sampleId: options.sampleId,
      question: options.question
    }
  });
  const raw = await downloadCached(
    "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    "locomo10.json"
  );
  const dataset = JSON.parse(raw) as readonly LocomoConversation[];
  const sample = dataset.find((entry) => entry.sample_id === options.sampleId);
  if (!sample) {
    throw new Error(`Missing LoCoMo sample ${options.sampleId}`);
  }
  const qa = sample.qa.find((candidate) => candidate.question === options.question);
  if (!qa) {
    throw new Error(`Missing QA pair for ${options.sampleId}: ${options.question}`);
  }

  await mkdir(outputDir(), { recursive: true });
  await mkdir(generatedRoot(), { recursive: true });

  const namespaceId = `benchmark_pressure_replay_${stamp}_${sample.sample_id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
  const sampleRoot = path.join(generatedRoot(), namespaceId);
  await mkdir(sampleRoot, { recursive: true });

  try {
    const sessionEntries = Object.entries(sample.conversation).filter(
      ([key, value]) => key.startsWith("session_") && Array.isArray(value)
    ) as Array<[string, readonly TurnRecord[]]>;

    for (const [sessionKey, turns] of sessionEntries) {
      const sessionPath = path.join(sampleRoot, `${sample.sample_id}-${sessionKey}.md`);
      const sessionDateTime =
        typeof sample.conversation[`${sessionKey}_date_time`] === "string"
          ? parseLoCoMoSessionDateTimeToIso(sample.conversation[`${sessionKey}_date_time`] as string)
          : null;
      await writeFile(sessionPath, formatConversationSession(sample, sessionKey, turns), "utf8");
      await ingestArtifact({
        namespaceId,
        sourceType: "markdown",
        inputUri: sessionPath,
        capturedAt: sessionDateTime ?? new Date().toISOString(),
        metadata: {
          benchmark: "full_standard_pressure_replay",
          sample_id: sample.sample_id,
          session_key: sessionKey
        },
        sourceChannel: "benchmark:full_standard_pressure_replay"
      });
    }

    await rebuildTypedMemoryNamespace(namespaceId);

    const startedAt = performance.now();
    const wrapped = (await executeMcpTool("memory.search", {
      namespace_id: namespaceId,
      query: options.question,
      limit: options.limit ?? 8
    })) as { readonly structuredContent?: unknown };
    const latencyMs = Number((performance.now() - startedAt).toFixed(2));

    const artifact: FullStandardPressureReplayArtifact = {
      generatedAt,
      runtime,
      sampleId: options.sampleId,
      question: options.question,
      expectedAnswer: benchmarkExpectedAnswer(qa),
      namespaceId,
      keptNamespace: options.keepNamespace === true,
      latencyMs,
      payload: wrapped.structuredContent ?? null
    };

    const jsonPath = path.join(outputDir(), `full-standard-pressure-replay-${stamp}.json`);
    const markdownPath = path.join(outputDir(), `full-standard-pressure-replay-${stamp}.md`);
    await writeFile(jsonPath, JSON.stringify(artifact, null, 2), "utf8");
    await writeFile(markdownPath, toMarkdown(artifact), "utf8");
    return { artifact, output: { jsonPath, markdownPath } };
  } finally {
    if (!options.keepNamespace) {
      await cleanupPublicBenchmarkNamespaces([namespaceId], {
        namespaceChunkSize: 1,
        statementTimeoutMs: 60_000,
        lockTimeoutMs: 2_000
      }).catch(() => {});
    }
  }
}

function parseCliArgs(argv: readonly string[]): FullStandardPressureReplayOptions {
  let sampleId = "";
  let question = "";
  let limit: number | undefined;
  let keepNamespace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sample" || arg === "--sample-id") {
      sampleId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--question") {
      question = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const parsed = Number(argv[index + 1] ?? "");
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      index += 1;
      continue;
    }
    if (arg === "--keep-namespace") {
      keepNamespace = true;
    }
  }
  if (!sampleId || !question) {
    throw new Error("Usage: benchmark-full-standard-pressure-replay --sample <sampleId> --question <question> [--limit <n>] [--keep-namespace]");
  }
  return { sampleId, question, limit, keepNamespace };
}

export async function runFullStandardPressureReplayCli(argv = process.argv.slice(2)): Promise<void> {
  try {
    const options = parseCliArgs(argv);
    const { artifact, output } = await runAndWriteFullStandardPressureReplay(options);
    process.stdout.write(`${JSON.stringify({ output, namespaceId: artifact.namespaceId, keptNamespace: artifact.keptNamespace }, null, 2)}\n`);
  } finally {
    await closePool().catch(() => {});
  }
}
