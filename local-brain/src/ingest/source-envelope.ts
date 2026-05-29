import { createHash } from "node:crypto";
import { buildExtractionUnits } from "../taxonomy-temporal/extraction-units.js";
import type { ExtractionUnit, ExtractionUnitBuildInput } from "../taxonomy-temporal/types.js";

export type SourceEnvelopeType = "omi" | "markdown" | "pdf" | "asr" | "chat" | "task_list" | "calendar" | "generic_text";

export interface SourceEnvelope {
  readonly namespaceId: string;
  readonly sourceType: SourceEnvelopeType;
  readonly sourceUri: string;
  readonly capturedAt: string | null;
  readonly authorHint: string | null;
  readonly formatMetadata: Record<string, unknown>;
  readonly rawText: string;
}

export interface SourceEnvelopeChunk {
  readonly sourceId: string;
  readonly sourceType: SourceEnvelopeType;
  readonly sourceUri: string;
  readonly chunkIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
  readonly textHash: string;
  readonly capturedAt: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface SourceEnvelopeAdapterOutput {
  readonly envelope: SourceEnvelope;
  readonly sourceId: string;
  readonly artifactChunks: readonly SourceEnvelopeChunk[];
  readonly extractionInputs: readonly ExtractionUnitBuildInput[];
  readonly extractionUnits: readonly ExtractionUnit[];
  readonly metrics: {
    readonly sourceType: SourceEnvelopeType;
    readonly chunkCount: number;
    readonly extractionUnitCount: number;
    readonly inputTokenP95: number;
    readonly inputTokenMax: number;
    readonly emptyOrBoilerplateChunkCount: number;
    readonly provenanceComplete: boolean;
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceId(envelope: SourceEnvelope): string {
  return `${envelope.sourceType}:${stableHash(`${envelope.sourceUri}\n${envelope.capturedAt ?? ""}\n${envelope.rawText}`).slice(0, 24)}`;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function isBoilerplate(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    normalized.length < 12 ||
    /^(?:metadata|created_at|started_at|finished_at|conversation id|page\s+\d+)\s*:?$/iu.test(normalized)
  );
}

type RawSourceChunk = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly metadata: {
    readonly heading?: string | null;
    readonly page?: number;
    readonly ocr_risk?: boolean;
  };
};

function splitByBudget(text: string, maxChars: number): readonly { readonly text: string; readonly start: number; readonly end: number }[] {
  const normalized = text.replace(/\r\n/gu, "\n");
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const hardEnd = Math.min(normalized.length, cursor + maxChars);
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      const breakAt = Math.max(
        normalized.lastIndexOf("\n\n", hardEnd),
        normalized.lastIndexOf("\n", hardEnd),
        normalized.lastIndexOf(". ", hardEnd)
      );
      if (breakAt > cursor + Math.floor(maxChars * 0.45)) {
        end = breakAt + (normalized[breakAt] === "." ? 1 : 0);
      }
    }
    const raw = normalized.slice(cursor, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.trimEnd().length;
    const cleaned = normalizeWhitespace(raw);
    if (cleaned) {
      chunks.push({ text: cleaned, start: cursor + leading, end: cursor + trailing });
    }
    cursor = Math.max(end, cursor + 1);
  }
  return chunks.length > 0 ? chunks : [{ text: "", start: 0, end: 0 }];
}

function stripMarkdownFrontmatter(text: string): { readonly text: string; readonly metadata: Record<string, unknown> } {
  if (!text.startsWith("---\n")) {
    return { text, metadata: {} };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) {
    return { text, metadata: {} };
  }
  return {
    text: text.slice(end + 4),
    metadata: {
      frontmatter_present: true,
      frontmatter_hash: stableHash(text.slice(0, end + 4)).slice(0, 16)
    }
  };
}

function markdownSections(text: string): readonly { readonly text: string; readonly start: number; readonly end: number; readonly heading: string | null }[] {
  const stripped = stripMarkdownFrontmatter(text);
  const source = stripped.text;
  const headingMatches = [...source.matchAll(/^#{1,6}\s+(.+)$/gmu)];
  if (headingMatches.length === 0) {
    return splitByBudget(source, 4200).map((chunk) => ({ ...chunk, heading: null }));
  }
  return headingMatches.map((match, index) => {
    const start = match.index ?? 0;
    const nextStart = headingMatches[index + 1]?.index ?? source.length;
    return {
      text: normalizeWhitespace(source.slice(start, nextStart)),
      start,
      end: nextStart,
      heading: normalizeWhitespace(match[1] ?? "")
    };
  });
}

function pdfPages(text: string): readonly { readonly text: string; readonly start: number; readonly end: number; readonly page: number }[] {
  const formFeedParts = text.split("\f");
  if (formFeedParts.length > 1) {
    let offset = 0;
    return formFeedParts.map((part, index) => {
      const start = offset;
      const end = offset + part.length;
      offset = end + 1;
      return { text: normalizeWhitespace(part), start, end, page: index + 1 };
    });
  }
  const pagePattern = /^-{0,3}\s*page\s+(\d+)\s*-{0,3}$/gimu;
  const matches = [...text.matchAll(pagePattern)];
  if (matches.length === 0) {
    return splitByBudget(text, 3600).map((chunk, index) => ({ ...chunk, page: index + 1 }));
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const nextStart = matches[index + 1]?.index ?? text.length;
    const page = Number(match[1] ?? index + 1);
    return { text: normalizeWhitespace(text.slice(start, nextStart)), start, end: nextStart, page };
  });
}

function lineRecordChunks(text: string): readonly { readonly text: string; readonly start: number; readonly end: number }[] {
  const records: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  let buffer = "";
  let bufferStart = 0;
  for (const line of text.replace(/\r\n/gu, "\n").split("\n")) {
    const withNewline = `${line}\n`;
    const next = buffer ? `${buffer}${withNewline}` : withNewline;
    if (buffer && next.length > 3000) {
      records.push({ text: normalizeWhitespace(buffer), start: bufferStart, end: offset });
      buffer = withNewline;
      bufferStart = offset;
    } else {
      buffer = next;
    }
    offset += withNewline.length;
  }
  if (normalizeWhitespace(buffer)) {
    records.push({ text: normalizeWhitespace(buffer), start: bufferStart, end: text.length });
  }
  return records.length > 0 ? records : [{ text: "", start: 0, end: 0 }];
}

function rawChunksForEnvelope(envelope: SourceEnvelope): readonly SourceEnvelopeChunk[] {
  const id = sourceId(envelope);
  const rawText = normalizeWhitespace(envelope.rawText);
  const chunkingStrategy =
    envelope.sourceType === "markdown"
      ? "markdown_heading_section_v1"
      : envelope.sourceType === "pdf"
        ? "pdf_page_section_v1"
        : envelope.sourceType === "generic_text" && String(envelope.formatMetadata.source_kind_family ?? "").toLowerCase().includes("ocr")
          ? "ocr_block_section_v1"
          : envelope.sourceType === "task_list"
            ? "task_export_record_v1"
            : envelope.sourceType === "calendar"
              ? "calendar_export_event_v1"
              : "bounded_text_chunk_v1";
  const parserProvider =
    typeof envelope.formatMetadata.document_extraction_provider === "string"
      ? envelope.formatMetadata.document_extraction_provider
      : envelope.sourceType === "pdf" || chunkingStrategy === "ocr_block_section_v1"
        ? "text_proxy"
        : "native_text";
  const baseMetadata = {
    ...envelope.formatMetadata,
    source_envelope_version: "source_envelope_v1",
    author_hint: envelope.authorHint,
    document_parser_provider: parserProvider,
    document_parser_version:
      typeof envelope.formatMetadata.document_extraction_provider_version === "string"
        ? envelope.formatMetadata.document_extraction_provider_version
        : parserProvider === "native_text"
          ? "native_text_v1"
          : "unknown",
    document_chunking_strategy: chunkingStrategy,
    document_parent_strategy: "source_uri_section_v1"
  };
  const sourceChunks: readonly RawSourceChunk[] =
    envelope.sourceType === "markdown"
      ? markdownSections(envelope.rawText).map((entry) => ({ ...entry, metadata: { heading: entry.heading } }))
      : envelope.sourceType === "pdf"
        ? pdfPages(envelope.rawText).map((entry) => ({ ...entry, metadata: { page: entry.page, ocr_risk: !entry.text } }))
      : envelope.sourceType === "chat" || envelope.sourceType === "asr" || envelope.sourceType === "task_list" || envelope.sourceType === "calendar"
          ? lineRecordChunks(envelope.rawText).map((entry) => ({ ...entry, metadata: {} }))
          : splitByBudget(rawText, 3600).map((entry) => ({ ...entry, metadata: {} }));

  return sourceChunks.map((chunk, index) => ({
    sourceId: id,
    sourceType: envelope.sourceType,
    sourceUri: envelope.sourceUri,
    chunkIndex: index,
    charStart: chunk.start,
    charEnd: chunk.end,
    text: chunk.text,
    textHash: stableHash(chunk.text),
    capturedAt: envelope.capturedAt,
    metadata: {
      ...baseMetadata,
      ...chunk.metadata,
      char_start: chunk.start,
      char_end: chunk.end,
      source_uri: envelope.sourceUri,
      source_envelope_chunk_id: `${id}:chunk:${index}`,
      child_chunk_id: `${id}:chunk:${index}`,
      parent_source_section_id:
        typeof chunk.metadata.heading === "string" && chunk.metadata.heading.length > 0
          ? `source_section:${stableHash(`${envelope.sourceUri}#${chunk.metadata.heading}`).slice(0, 16)}`
          : typeof chunk.metadata.page === "number"
            ? `source_section:${stableHash(`${envelope.sourceUri}#page:${chunk.metadata.page}`).slice(0, 16)}`
            : `source_section:${stableHash(envelope.sourceUri).slice(0, 16)}`,
      parent_source_uri: envelope.sourceUri,
      section_heading: typeof chunk.metadata.heading === "string" ? chunk.metadata.heading : undefined,
      page_number: typeof chunk.metadata.page === "number" ? chunk.metadata.page : undefined,
      layout_warning_kinds: [
        chunk.metadata.ocr_risk === true ? "ocr_text_missing_or_low_confidence" : "",
        /\btable\b|\|.+\|/iu.test(chunk.text) ? "table_detected" : "",
        /\b(?:figure|diagram|image|chart|screenshot|ocr)\b/iu.test(chunk.text) ? "layout_or_ocr_region_detected" : ""
      ].filter(Boolean),
      layout_warning_count: [
        chunk.metadata.ocr_risk === true,
        /\btable\b|\|.+\|/iu.test(chunk.text),
        /\b(?:figure|diagram|image|chart|screenshot|ocr)\b/iu.test(chunk.text)
      ].filter(Boolean).length
    }
  }));
}

function chunkToExtractionInput(envelope: SourceEnvelope, chunk: SourceEnvelopeChunk): ExtractionUnitBuildInput {
  return {
    namespaceId: envelope.namespaceId,
    sourceType: envelope.sourceType,
    sourceId: chunk.sourceId,
    capturedAt: envelope.capturedAt,
    speaker: envelope.authorHint,
    text: chunk.text,
    metadata: {
      ...chunk.metadata,
      source_text_hash: chunk.textHash,
      chunk_index: chunk.chunkIndex,
      source_type: chunk.sourceType,
      source_uri: chunk.sourceUri
    }
  };
}

export function buildSourceEnvelopeAdapterOutput(envelope: SourceEnvelope): SourceEnvelopeAdapterOutput {
  const chunks = rawChunksForEnvelope(envelope);
  const extractionInputs = chunks.map((chunk) => chunkToExtractionInput(envelope, chunk));
  const extractionUnits = extractionInputs.flatMap((input) => [...buildExtractionUnits(input)]);
  const tokenEstimates = extractionUnits.map((unit) => unit.tokenEstimate);
  const emptyOrBoilerplateChunkCount = chunks.filter((chunk) => isBoilerplate(chunk.text)).length;
  const provenanceComplete = chunks.every(
    (chunk) =>
      Boolean(chunk.sourceId) &&
      Boolean(chunk.sourceUri) &&
      Boolean(chunk.textHash) &&
      Number.isInteger(chunk.chunkIndex) &&
      chunk.charStart >= 0 &&
      chunk.charEnd >= chunk.charStart
  );
  return {
    envelope,
    sourceId: sourceId(envelope),
    artifactChunks: chunks,
    extractionInputs,
    extractionUnits,
    metrics: {
      sourceType: envelope.sourceType,
      chunkCount: chunks.length,
      extractionUnitCount: extractionUnits.length,
      inputTokenP95: percentile(tokenEstimates, 95),
      inputTokenMax: Math.max(0, ...tokenEstimates),
      emptyOrBoilerplateChunkCount,
      provenanceComplete
    }
  };
}
