import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { readConfig } from "../config.js";
import { withTransaction } from "../db/client.js";
import type { ExtractionUnit, ExtractionUnitBuildInput, ExtractionUnitBuildOptions } from "./types.js";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stripCompilerBoilerplate(input: string): string {
  let text = input.replace(/\r\n/gu, "\n");
  if (text.startsWith("---\n")) {
    const endIndex = text.indexOf("\n---", 4);
    if (endIndex >= 0) {
      text = text.slice(endIndex + 4);
    }
  }

  text = text.replace(/\n## Metadata\n[\s\S]*?(?=\n## |\n# |$)/u, "\n");
  return text.trim() || input;
}

function splitSentences(text: string): readonly { readonly text: string; readonly start: number; readonly end: number }[] {
  const normalized = text.replace(/\r\n/gu, "\n");
  const results: Array<{ text: string; start: number; end: number }> = [];
  const sentencePattern = /[^.!?\n]+(?:[.!?]+|\n+|$)/gu;
  for (const match of normalized.matchAll(sentencePattern)) {
    const raw = match[0] ?? "";
    const trimmed = normalizeWhitespace(raw);
    if (!trimmed) {
      continue;
    }
    const rawStart = match.index ?? 0;
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.trimEnd().length;
    results.push({
      text: trimmed,
      start: rawStart + leading,
      end: rawStart + trailing
    });
  }
  if (results.length === 0 && normalizeWhitespace(text)) {
    results.push({ text: normalizeWhitespace(text), start: 0, end: text.length });
  }
  return results;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function clipContext(text: string, maxChars: number, side: "before" | "after"): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return side === "before" ? normalized.slice(-maxChars).trim() : normalized.slice(0, maxChars).trim();
}

export function buildExtractionUnits(input: ExtractionUnitBuildInput, options?: Partial<ExtractionUnitBuildOptions>): readonly ExtractionUnit[] {
  const config = readConfig();
  const maxUnitChars = options?.maxUnitChars ?? config.extractionUnitMaxChars;
  const maxContextChars = options?.maxContextChars ?? config.extractionUnitContextChars;
  const overlapSentences = options?.overlapSentences ?? config.extractionUnitOverlapSentences;
  const compilerText = stripCompilerBoilerplate(input.text);
  const sentences = splitSentences(compilerText);

  if (sentences.length === 0) {
    return [
      {
        unitId: randomUUID(),
        namespaceId: input.namespaceId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceMemoryId: input.sourceMemoryId,
        sourceChunkId: input.sourceChunkId,
        sourceSceneId: input.sourceSceneId,
        capturedAt: input.capturedAt,
        speaker: input.speaker,
        unitIndex: 0,
        charStart: 0,
        charEnd: 0,
        unitText: "",
        contextBefore: "",
        contextAfter: "",
        tokenEstimate: 0,
        chunkingStatus: "empty",
        splitReason: "empty_source",
        metadata: input.metadata
      }
    ];
  }

  const units: ExtractionUnit[] = [];
  let cursor = 0;
  while (cursor < sentences.length) {
    const startIndex = cursor;
    let endIndex = cursor;
    let unitText = "";
    while (endIndex < sentences.length) {
      const nextText = unitText ? `${unitText} ${sentences[endIndex]?.text ?? ""}` : sentences[endIndex]?.text ?? "";
      if (unitText && nextText.length > maxUnitChars) {
        break;
      }
      unitText = nextText;
      endIndex += 1;
      if (unitText.length >= Math.floor(maxUnitChars * 0.72)) {
        break;
      }
    }

    if (!unitText) {
      unitText = sentences[cursor]?.text ?? "";
      endIndex = cursor + 1;
    }

    const start = sentences[startIndex]?.start ?? 0;
    const end = sentences[Math.max(startIndex, endIndex - 1)]?.end ?? start + unitText.length;
    const contextBefore = clipContext(compilerText.slice(0, start), maxContextChars, "before");
    const contextAfter = clipContext(compilerText.slice(end), maxContextChars, "after");
    const oversized = unitText.length > maxUnitChars;

    units.push({
      unitId: randomUUID(),
      namespaceId: input.namespaceId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceMemoryId: input.sourceMemoryId,
      sourceChunkId: input.sourceChunkId,
      sourceSceneId: input.sourceSceneId,
      capturedAt: input.capturedAt,
      speaker: input.speaker,
      unitIndex: units.length,
      charStart: start,
      charEnd: end,
      unitText: normalizeWhitespace(unitText),
      contextBefore,
      contextAfter,
      tokenEstimate: estimateTokens(unitText),
      chunkingStatus: oversized ? "needs_split_review" : "ready",
      splitReason: oversized ? "single_sentence_exceeded_budget" : "sentence_budget",
      metadata: {
        ...(input.metadata ?? {}),
        compiler_boilerplate_stripped: compilerText !== input.text
      }
    });

    cursor = Math.max(endIndex - overlapSentences, cursor + 1);
  }

  return units;
}

export async function persistExtractionUnits(units: readonly ExtractionUnit[]): Promise<number> {
  if (units.length === 0) {
    return 0;
  }
  return withTransaction(async (client) => persistExtractionUnitsForClient(client, units));
}

export async function persistExtractionUnitsForClient(client: PoolClient, units: readonly ExtractionUnit[]): Promise<number> {
  let written = 0;
  for (const unit of units) {
    await client.query(
      `
        INSERT INTO extraction_units (
          id, namespace_id, source_type, source_id, source_memory_id, source_chunk_id, source_scene_id,
          captured_at, speaker, unit_index, char_start, char_end, unit_text, context_before, context_after,
          token_estimate, chunking_status, split_reason, metadata
        )
        VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::timestamptz, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)
        ON CONFLICT (namespace_id, source_id, source_memory_id, source_chunk_id, source_scene_id, unit_index)
        DO UPDATE SET
          unit_text = EXCLUDED.unit_text,
          context_before = EXCLUDED.context_before,
          context_after = EXCLUDED.context_after,
          token_estimate = EXCLUDED.token_estimate,
          chunking_status = EXCLUDED.chunking_status,
          split_reason = EXCLUDED.split_reason,
          metadata = extraction_units.metadata || EXCLUDED.metadata
      `,
      [
        unit.unitId,
        unit.namespaceId,
        unit.sourceType,
        unit.sourceId ?? null,
        unit.sourceMemoryId ?? null,
        unit.sourceChunkId ?? null,
        unit.sourceSceneId ?? null,
        unit.capturedAt ?? null,
        unit.speaker ?? null,
        unit.unitIndex,
        unit.charStart,
        unit.charEnd,
        unit.unitText,
        unit.contextBefore,
        unit.contextAfter,
        unit.tokenEstimate,
        unit.chunkingStatus,
        unit.splitReason,
        JSON.stringify(unit.metadata ?? {})
      ]
    );
    written += 1;
  }
  return written;
}
