export interface BenchmarkCatalogRowInput {
  readonly id: string;
  readonly passed: boolean;
  readonly normalizedPassed?: boolean;
  readonly failureClass?: string | null;
  readonly queryBehavior?: string | null;
  readonly finalClaimSource?: string | null;
  readonly latencyMs: number;
}

export interface BenchmarkCatalogSlowRow {
  readonly id: string;
  readonly latencyMs: number;
  readonly failureClass: string | null;
  readonly queryBehavior: string | null;
  readonly finalClaimSource: string | null;
}

export interface BenchmarkCatalog {
  readonly counts: {
    readonly pass: number;
    readonly normalizedFail: number;
    readonly hardFail: number;
  };
  readonly buckets: {
    readonly failureClass: Readonly<Record<string, number>>;
    readonly queryBehavior: Readonly<Record<string, number>>;
    readonly finalClaimSource: Readonly<Record<string, number>>;
  };
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly slowPassRows: readonly BenchmarkCatalogSlowRow[];
  readonly slowFailRows: readonly BenchmarkCatalogSlowRow[];
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function max(values: readonly number[]): number {
  return values.length > 0 ? Number(Math.max(...values).toFixed(2)) : 0;
}

function countBy(values: readonly (string | null | undefined)[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function toSlowRow(row: BenchmarkCatalogRowInput): BenchmarkCatalogSlowRow {
  return {
    id: row.id,
    latencyMs: row.latencyMs,
    failureClass: row.failureClass ?? null,
    queryBehavior: row.queryBehavior ?? null,
    finalClaimSource: row.finalClaimSource ?? null
  };
}

export function buildBenchmarkCatalog(rows: readonly BenchmarkCatalogRowInput[]): BenchmarkCatalog {
  const latencies = rows.map((row) => row.latencyMs);
  const normalizedFailCount = rows.filter((row) => row.normalizedPassed === false).length;
  const hardFailCount = rows.filter((row) => row.passed === false).length;
  const slowPassRows = rows
    .filter((row) => row.passed)
    .sort((left, right) => right.latencyMs - left.latencyMs)
    .slice(0, 5)
    .map(toSlowRow);
  const slowFailRows = rows
    .filter((row) => !row.passed || row.normalizedPassed === false)
    .sort((left, right) => right.latencyMs - left.latencyMs)
    .slice(0, 5)
    .map(toSlowRow);

  return {
    counts: {
      pass: rows.filter((row) => row.passed).length,
      normalizedFail: normalizedFailCount,
      hardFail: hardFailCount
    },
    buckets: {
      failureClass: countBy(rows.map((row) => row.failureClass)),
      queryBehavior: countBy(rows.map((row) => row.queryBehavior)),
      finalClaimSource: countBy(rows.map((row) => row.finalClaimSource))
    },
    latency: {
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: max(latencies)
    },
    slowPassRows,
    slowFailRows
  };
}
