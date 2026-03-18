import { queryRows } from "../db/client.js";
import { readConfig } from "../config.js";

interface CountRow {
  readonly total: string;
}

interface QueueStatusRow {
  readonly status: string;
  readonly count: string;
}

export interface QueueSummary {
  readonly pending: number;
  readonly processing: number;
  readonly failed: number;
  readonly completed: number;
  readonly nextAttemptAt?: string;
}

export interface OpsOverview {
  readonly lexicalProvider: "fts" | "bm25";
  readonly lexicalFallbackEnabled: boolean;
  readonly queueSummary: {
    readonly derivation: QueueSummary;
    readonly vectorSync: QueueSummary;
  };
  readonly memorySummary: {
    readonly temporalNodes: number;
    readonly relationshipCandidatesPending: number;
    readonly relationshipMemoryActive: number;
    readonly semanticDecayEvents: number;
  };
}

function toCount(rows: readonly CountRow[]): number {
  return Number(rows[0]?.total ?? 0);
}

function summarizeQueues(rows: readonly QueueStatusRow[]): QueueSummary {
  const summary = {
    pending: 0,
    processing: 0,
    failed: 0,
    completed: 0
  };

  for (const row of rows) {
    const value = Number(row.count);

    switch (row.status) {
      case "pending":
        summary.pending = value;
        break;
      case "processing":
        summary.processing = value;
        break;
      case "failed":
        summary.failed = value;
        break;
      case "completed":
      case "synced":
        summary.completed += value;
        break;
      default:
        break;
    }
  }

  return summary;
}

export async function getOpsOverview(): Promise<OpsOverview> {
  const config = readConfig();

  const [
    derivationStatusRows,
    derivationNextAttemptRows,
    vectorStatusRows,
    vectorNextAttemptRows,
    temporalNodeRows,
    relationshipCandidateRows,
    relationshipMemoryRows,
    semanticDecayRows
  ] = await Promise.all([
    queryRows<QueueStatusRow>(
      `
      SELECT status, COUNT(*)::text AS count
      FROM derivation_jobs
      GROUP BY status
      `
    ),
    queryRows<{ readonly next_attempt_at: string }>(
      `
      SELECT next_attempt_at
      FROM derivation_jobs
      WHERE status IN ('pending', 'processing', 'failed')
      ORDER BY next_attempt_at ASC
      LIMIT 1
      `
    ),
    queryRows<QueueStatusRow>(
      `
      SELECT status, COUNT(*)::text AS count
      FROM vector_sync_jobs
      GROUP BY status
      `
    ),
    queryRows<{ readonly next_attempt_at: string }>(
      `
      SELECT next_attempt_at
      FROM vector_sync_jobs
      WHERE status IN ('pending', 'processing', 'failed')
      ORDER BY next_attempt_at ASC
      LIMIT 1
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM temporal_nodes
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM relationship_candidates
      WHERE processed_at IS NULL
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM relationship_memory
      WHERE status = 'active' AND valid_until IS NULL
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM semantic_decay_events
      `
    )
  ]);

  return {
    lexicalProvider: config.lexicalProvider,
    lexicalFallbackEnabled: config.lexicalFallbackEnabled,
    queueSummary: {
      derivation: {
        ...summarizeQueues(derivationStatusRows),
        nextAttemptAt: derivationNextAttemptRows[0]?.next_attempt_at
      },
      vectorSync: {
        ...summarizeQueues(vectorStatusRows),
        nextAttemptAt: vectorNextAttemptRows[0]?.next_attempt_at
      }
    },
    memorySummary: {
      temporalNodes: toCount(temporalNodeRows),
      relationshipCandidatesPending: toCount(relationshipCandidateRows),
      relationshipMemoryActive: toCount(relationshipMemoryRows),
      semanticDecayEvents: toCount(semanticDecayRows)
    }
  };
}
