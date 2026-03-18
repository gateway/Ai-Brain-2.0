import { readdir } from "node:fs/promises";
import path from "node:path";
import { ingestArtifact } from "./worker.js";
import type { IngestResult } from "./types.js";
import type { SourceType } from "../types.js";

interface ReconcileOptions {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly sourceType: SourceType;
  readonly sourceChannel?: string;
  readonly capturedAt?: string;
}

export interface ReconcileReport {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly scannedFiles: number;
  readonly ingestedFiles: number;
  readonly failedFiles: number;
  readonly results: readonly {
    readonly inputUri: string;
    readonly ok: boolean;
    readonly result?: {
      readonly artifactId: string;
      readonly observationId?: string;
      readonly fragments: number;
      readonly candidateWrites: number;
      readonly episodicInsertCount: number;
    };
    readonly error?: string;
  }[];
}

type ReconcileResultRow = ReconcileReport["results"][number];

const DEFAULT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

async function walkFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...(await walkFiles(fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!DEFAULT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    results.push(fullPath);
  }

  return results.sort((left, right) => left.localeCompare(right));
}

function toCompactResult(result: IngestResult): {
  readonly artifactId: string;
  readonly observationId?: string;
  readonly fragments: number;
  readonly candidateWrites: number;
  readonly episodicInsertCount: number;
} {
  return {
    artifactId: result.artifact.artifactId,
    observationId: result.artifact.observationId,
    fragments: result.fragments.length,
    candidateWrites: result.candidateWrites.length,
    episodicInsertCount: result.episodicInsertCount
  };
}

export async function reconcileDirectory(options: ReconcileOptions): Promise<ReconcileReport> {
  const files = await walkFiles(path.resolve(options.rootDir));
  const results: ReconcileResultRow[] = [];
  let ingestedFiles = 0;
  let failedFiles = 0;

  for (const filePath of files) {
    try {
      const result = await ingestArtifact({
        inputUri: filePath,
        namespaceId: options.namespaceId,
        sourceType: options.sourceType,
        sourceChannel: options.sourceChannel,
        capturedAt: options.capturedAt ?? new Date().toISOString()
      });

      ingestedFiles += 1;
      results.push({
        inputUri: filePath,
        ok: true,
        result: toCompactResult(result)
      });
    } catch (error) {
      failedFiles += 1;
      results.push({
        inputUri: filePath,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    rootDir: path.resolve(options.rootDir),
    namespaceId: options.namespaceId,
    scannedFiles: files.length,
    ingestedFiles,
    failedFiles,
    results
  };
}
