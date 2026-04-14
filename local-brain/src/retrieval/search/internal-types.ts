import type { RecallResult } from "../../types.js";

export interface SearchRow {
  readonly memory_id: string;
  readonly memory_type: RecallResult["memoryType"];
  readonly content: string;
  readonly raw_score: number | string | null;
  readonly artifact_id: string | null;
  readonly occurred_at: string | Date | null;
  readonly namespace_id: string;
  readonly provenance: Record<string, unknown>;
}

export interface RankedSearchRow extends SearchRow {
  readonly scoreValue: number;
}

export interface SqlFusedRankingRow {
  readonly row: SearchRow;
  readonly lexicalRank?: number;
  readonly vectorRank?: number;
  readonly lexicalRawScore?: number;
  readonly vectorDistance?: number;
  readonly rrfScore: number;
  readonly appScore?: number;
  readonly appSignals?: {
    readonly lexical: number;
    readonly temporal: number;
    readonly participant: number;
    readonly cluster: number;
    readonly leaf: number;
    readonly modeSpecific: number;
    readonly source: number;
  };
}
