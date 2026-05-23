import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface DocumentExtractionBlock {
  readonly blockType: "page" | "paragraph" | "table" | "figure" | "ocr_block";
  readonly text: string;
  readonly pageNumber: number | null;
  readonly confidence: number | null;
  readonly metadata: Record<string, unknown>;
}

export interface DocumentExtractionResult {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly extractedText: string;
  readonly blocks: readonly DocumentExtractionBlock[];
  readonly qualityMetrics: {
    readonly hasText: boolean;
    readonly pageCount: number;
    readonly tableCount: number;
    readonly figureCount: number;
    readonly ocrBlockCount: number;
    readonly extractionConfidence: number;
  };
}

export interface DocumentExtractionProvider {
  readonly providerName: string;
  readonly providerVersion: string;
  extract(input: {
    readonly absolutePath: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<DocumentExtractionResult | null>;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

function metadataText(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function blocksFromText(text: string): readonly DocumentExtractionBlock[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const pages = normalized.includes("\f")
    ? normalized.split("\f")
    : normalized.split(/^---?\s*page\s+\d+\s*---?$/gimu);
  return pages
    .map((pageText, index) => normalizeText(pageText))
    .filter(Boolean)
    .map((pageText, index) => ({
      blockType: "page" as const,
      text: pageText,
      pageNumber: index + 1,
      confidence: 1,
      metadata: {}
    }));
}

export const sidecarDocumentExtractionProvider: DocumentExtractionProvider = {
  providerName: "sidecar_text_extraction",
  providerVersion: "1.0.0",
  async extract(input) {
    const inline = metadataText(input.metadata, "extracted_text");
    const explicitPath = metadataText(input.metadata, "extracted_text_path");
    const candidates = [
      inline ? null : explicitPath ? path.resolve(explicitPath) : null,
      inline ? null : `${input.absolutePath}.txt`
    ].filter((value): value is string => Boolean(value));

    let extractedText = inline ?? null;
    for (const candidate of candidates) {
      if (extractedText || !existsSync(candidate)) continue;
      const text = await readFile(candidate, "utf8");
      if (text.trim().length > 0) extractedText = text;
    }
    if (!extractedText) return null;

    const blocks = blocksFromText(extractedText);
    const tableCount = blocks.filter((block) => /\|.+\|/u.test(block.text) || /\btable\b/iu.test(block.text)).length;
    const figureCount = blocks.filter((block) => /\b(?:figure|diagram|image|chart)\b/iu.test(block.text)).length;
    const ocrBlockCount = blocks.filter((block) => /\b(?:ocr|screenshot|image text)\b/iu.test(block.text)).length;
    return {
      providerName: this.providerName,
      providerVersion: this.providerVersion,
      extractedText: normalizeText(extractedText),
      blocks,
      qualityMetrics: {
        hasText: normalizeText(extractedText).length > 0,
        pageCount: Math.max(1, blocks.length),
        tableCount,
        figureCount,
        ocrBlockCount,
        extractionConfidence: 1
      }
    };
  }
};
