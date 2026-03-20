import { readFile } from "node:fs/promises";
import path from "node:path";
import { readConfig } from "../config.js";

export interface AsrTranscriptSegment {
  readonly id?: number;
  readonly start?: number;
  readonly end?: number;
  readonly text?: string;
  readonly speaker?: string;
}

export interface AsrTranscriptWord {
  readonly word?: string;
  readonly start?: number;
  readonly end?: number;
  readonly score?: number;
}

export interface AsrTranscriptResult {
  readonly text: string;
  readonly model: string;
  readonly language?: string;
  readonly durationSeconds?: number;
  readonly segments: readonly AsrTranscriptSegment[];
  readonly words: readonly AsrTranscriptWord[];
  readonly rawResponse: Record<string, unknown>;
}

function buildHeaders(apiKey?: string): HeadersInit {
  if (!apiKey) {
    return {};
  }

  return {
    authorization: `Bearer ${apiKey}`
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function transcribeAudioFile(input: {
  readonly filePath: string;
  readonly mimeType?: string;
  readonly modelId?: string;
}): Promise<AsrTranscriptResult> {
  const config = readConfig();
  const fileBuffer = await readFile(input.filePath);
  const fileName = path.basename(input.filePath);
  const fileType = input.mimeType ?? "application/octet-stream";
  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: fileType });

  form.append("file", blob, fileName);
  form.append("response_format", "json");

  if (input.modelId?.trim()) {
    form.append("model_id", input.modelId.trim());
  }

  const response = await fetch(new URL("/asr/transcribe", config.modelRuntimeBaseUrl), {
    method: "POST",
    headers: buildHeaders(config.modelRuntimeApiKey),
    body: form
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ASR runtime returned ${response.status}: ${errorText.slice(0, 400)}`);
  }

  const rawResponse = asRecord((await response.json()) as unknown);
  const text =
    asString(rawResponse.text) ??
    asString(rawResponse.transcript) ??
    asString(rawResponse.content) ??
    "";

  if (!text) {
    throw new Error("ASR runtime returned no transcript text.");
  }

  return {
    text,
    model: asString(rawResponse.model) ?? input.modelId ?? "unknown",
    language: asString(rawResponse.language),
    durationSeconds: asNumber(rawResponse.duration) ?? asNumber(rawResponse.duration_seconds),
    segments: Array.isArray(rawResponse.segments) ? (rawResponse.segments as readonly AsrTranscriptSegment[]) : [],
    words: Array.isArray(rawResponse.words) ? (rawResponse.words as readonly AsrTranscriptWord[]) : [],
    rawResponse
  };
}
