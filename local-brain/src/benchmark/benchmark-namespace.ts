import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withClient } from "../db/client.js";

export interface BenchmarkNamespaceState {
  readonly namespaceId: string;
  readonly stateHash: string;
  readonly counts: Readonly<Record<string, number>>;
}

export interface BenchmarkNamespaceMutationSummary {
  readonly namespaceId: string;
  readonly preState: BenchmarkNamespaceState;
  readonly postState: BenchmarkNamespaceState;
  readonly changedTables: readonly string[];
}

export interface BenchmarkNamespaceLockResult<T> {
  readonly lockStatus: "acquired";
  readonly namespaceId: string;
  readonly preState: BenchmarkNamespaceState;
  readonly postState: BenchmarkNamespaceState;
  readonly mutationSummary: BenchmarkNamespaceMutationSummary;
  readonly result: T;
}

const STATE_TABLES = [
  "artifacts",
  "artifact_chunks",
  "episodic_memory",
  "relationship_candidates",
  "compiled_relationship_observations",
  "compiled_fact_observations",
  "contract_projection_heads",
  "contract_projection_entries",
  "exact_detail_fact_keys"
] as const;

function stableInt(value: string): number {
  const hash = createHash("sha256").update(value).digest();
  return hash.readInt32BE(0);
}

function stateHash(namespaceId: string, counts: Readonly<Record<string, number>>): string {
  return createHash("sha256")
    .update(JSON.stringify({ namespaceId, counts: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))) }))
    .digest("hex");
}

async function tableExists(client: PoolClient, tableName: string): Promise<boolean> {
  const result = await client.query<{ readonly exists: boolean }>(
    "SELECT to_regclass($1)::text IS NOT NULL AS exists",
    [`public.${tableName}`]
  );
  return result.rows[0]?.exists === true;
}

async function tableHasNamespaceId(client: PoolClient, tableName: string): Promise<boolean> {
  const result = await client.query<{ readonly exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = 'namespace_id'
      ) AS exists
    `,
    [tableName]
  );
  return result.rows[0]?.exists === true;
}

export async function loadBenchmarkNamespaceState(client: PoolClient, namespaceId: string): Promise<BenchmarkNamespaceState> {
  const counts: Record<string, number> = {};
  for (const tableName of STATE_TABLES) {
    if (!(await tableExists(client, tableName)) || !(await tableHasNamespaceId(client, tableName))) {
      continue;
    }
    const result = await client.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM ${tableName} WHERE namespace_id = $1`,
      [namespaceId]
    );
    counts[tableName] = Number(result.rows[0]?.count ?? 0);
  }
  return {
    namespaceId,
    counts,
    stateHash: stateHash(namespaceId, counts)
  };
}

export function benchmarkRunId(prefix: string): string {
  return `${prefix}_${new Date().toISOString().replace(/[^0-9A-Za-z]+/gu, "_").replace(/_$/u, "")}`;
}

export function benchmarkNamespaceId(benchmarkId: string, runId = benchmarkRunId(benchmarkId)): string {
  return `benchmark_${benchmarkId.replace(/[^a-z0-9]+/giu, "_").toLowerCase()}_${runId.replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`.slice(0, 180);
}

export async function withBenchmarkNamespaceLock<T>(
  namespaceId: string,
  benchmarkId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<BenchmarkNamespaceLockResult<T>> {
  return withClient(async (client) => {
    const keyA = stableInt(`benchmark:${benchmarkId}`);
    const keyB = stableInt(`namespace:${namespaceId}`);
    const lockResult = await client.query<{ readonly acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [keyA, keyB]
    );
    if (lockResult.rows[0]?.acquired !== true) {
      throw new Error(`namespace_lock_conflict:${benchmarkId}:${namespaceId}`);
    }
    try {
      const preState = await loadBenchmarkNamespaceState(client, namespaceId);
      const result = await fn(client);
      const postState = await loadBenchmarkNamespaceState(client, namespaceId);
      const changedTables = Object.keys({ ...preState.counts, ...postState.counts })
        .filter((tableName) => preState.counts[tableName] !== postState.counts[tableName])
        .sort();
      return {
        lockStatus: "acquired" as const,
        namespaceId,
        preState,
        postState,
        mutationSummary: {
          namespaceId,
          preState,
          postState,
          changedTables
        },
        result
      };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [keyA, keyB]);
    }
  });
}
