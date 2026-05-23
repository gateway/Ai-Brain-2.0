import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestArtifact } from "../ingest/worker.js";
import { parseLoCoMoSessionDateTimeToIso } from "./public-memory-date-utils.js";

export interface LongMemEvalEntryFixture {
  readonly question_id: string;
  readonly question: string;
  readonly answer: string;
  readonly question_type: string;
  readonly haystack_sessions: readonly (readonly { readonly role: string; readonly content: string }[])[];
  readonly haystack_dates?: readonly string[];
}

export interface LoCoMoTurnRecordFixture {
  readonly speaker: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
}

export interface LoCoMoConversationFixture {
  readonly sample_id: string;
  readonly conversation: Record<string, string | readonly LoCoMoTurnRecordFixture[]>;
  readonly qa?: readonly {
    readonly question: string;
    readonly answer?: string;
    readonly adversarial_answer?: string;
    readonly category: number;
  }[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function rawDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-compare", "raw");
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-benchmark-fixtures");
}

function formatLongMemSession(
  turns: readonly { readonly role: string; readonly content: string }[],
  date: string | undefined
): string {
  const lines: string[] = [];
  if (date) {
    lines.push(`[${date}]`);
  }
  for (const turn of turns) {
    lines.push(`${turn.role}: ${turn.content}`);
  }
  return lines.join("\n");
}

function formatLoCoMoSession(
  sample: LoCoMoConversationFixture,
  sessionKey: string,
  turns: readonly LoCoMoTurnRecordFixture[]
): string {
  const dateTime = typeof sample.conversation[`${sessionKey}_date_time`] === "string" ? sample.conversation[`${sessionKey}_date_time`] : "";
  const canonicalCapturedAt = typeof dateTime === "string" && dateTime ? parseLoCoMoSessionDateTimeToIso(dateTime) : null;
  const speakerA = typeof sample.conversation.speaker_a === "string" ? sample.conversation.speaker_a : "Speaker A";
  const speakerB = typeof sample.conversation.speaker_b === "string" ? sample.conversation.speaker_b : "Speaker B";
  const lines: string[] = [];
  if (canonicalCapturedAt) {
    lines.push(`Captured: ${canonicalCapturedAt}`);
    lines.push("");
  } else if (dateTime) {
    lines.push(`Captured: ${dateTime}`);
    lines.push("");
  }
  lines.push(`Conversation between ${speakerA} and ${speakerB}`);
  for (const turn of turns) {
    const caption =
      typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0 ? ` [image: ${turn.blip_caption.trim()}]` : "";
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

export async function loadLongMemEvalEntryFixture(questionId: string): Promise<LongMemEvalEntryFixture> {
  const parsed = JSON.parse(await readFile(path.join(rawDir(), "longmemeval_s_cleaned.json"), "utf8")) as readonly LongMemEvalEntryFixture[];
  const entry = parsed.find((item) => item.question_id === questionId);
  if (!entry) {
    throw new Error(`LongMemEval entry ${questionId} not found.`);
  }
  return entry;
}

export async function loadLoCoMoConversationFixture(sampleId: string): Promise<LoCoMoConversationFixture> {
  const parsed = JSON.parse(await readFile(path.join(rawDir(), "locomo10.json"), "utf8")) as readonly LoCoMoConversationFixture[];
  const entry = parsed.find((item) => item.sample_id === sampleId);
  if (!entry) {
    throw new Error(`LoCoMo sample ${sampleId} not found.`);
  }
  return entry;
}

export async function ingestLongMemEvalEntryFixture(namespaceId: string, entry: LongMemEvalEntryFixture): Promise<void> {
  const corpusRoot = path.join(generatedRoot(), namespaceId);
  await mkdir(corpusRoot, { recursive: true });
  for (const [sessionIndex, session] of entry.haystack_sessions.entries()) {
    const sessionPath = path.join(corpusRoot, `${entry.question_id}-session-${sessionIndex + 1}.md`);
    await writeFile(sessionPath, formatLongMemSession(session, entry.haystack_dates?.[sessionIndex]), "utf8");
    await ingestArtifact({
      namespaceId,
      sourceType: "markdown",
      inputUri: sessionPath,
      capturedAt: entry.haystack_dates?.[sessionIndex] ?? new Date().toISOString(),
      metadata: {
        benchmark: "public_memory_benchmark_fixture",
        source_dataset: "longmemeval",
        question_id: entry.question_id
      },
      sourceChannel: "benchmark:public_memory_fixture"
    });
  }
}

export async function ingestLoCoMoConversationFixture(namespaceId: string, sample: LoCoMoConversationFixture): Promise<void> {
  const corpusRoot = path.join(generatedRoot(), namespaceId);
  await mkdir(corpusRoot, { recursive: true });
  const sessionEntries = Object.entries(sample.conversation).filter(
    ([key, value]) => key.startsWith("session_") && Array.isArray(value)
  ) as Array<[string, readonly LoCoMoTurnRecordFixture[]]>;
  for (const [sessionKey, turns] of sessionEntries) {
    const sessionPath = path.join(corpusRoot, `${sample.sample_id}-${sessionKey}.md`);
    const sessionDateTime =
      typeof sample.conversation[`${sessionKey}_date_time`] === "string"
        ? parseLoCoMoSessionDateTimeToIso(sample.conversation[`${sessionKey}_date_time`] as string)
        : null;
    await writeFile(sessionPath, formatLoCoMoSession(sample, sessionKey, turns), "utf8");
    await ingestArtifact({
      namespaceId,
      sourceType: "markdown",
      inputUri: sessionPath,
      capturedAt: sessionDateTime ?? new Date().toISOString(),
      metadata: {
        benchmark: "public_memory_benchmark_fixture",
        source_dataset: "locomo",
        sample_id: sample.sample_id,
        session_key: sessionKey
      },
      sourceChannel: "benchmark:public_memory_fixture"
    });
  }
}
