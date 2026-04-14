import type { PoolClient } from "pg";
import { queryRows, withClient, withTransaction } from "../db/client.js";

const DEFAULT_NAMESPACE_CHUNK_SIZE = 25;
const DEFAULT_EPISODIC_DELETE_BATCH_SIZE = 100;
const DEFAULT_ARTIFACT_DELETE_BATCH_SIZE = 10;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const normalizedSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += normalizedSize) {
    chunks.push(items.slice(index, index + normalizedSize));
  }
  return chunks;
}

export async function cleanupPublicBenchmarkNamespaces(
  namespaceIds: readonly string[],
  options?: {
    readonly namespaceChunkSize?: number;
    readonly statementTimeoutMs?: number;
    readonly lockTimeoutMs?: number;
    readonly logger?: (message: string) => void;
  }
): Promise<void> {
  const normalizedNamespaceIds = [...new Set(namespaceIds.map((namespaceId) => namespaceId.trim()).filter(Boolean))];
  if (normalizedNamespaceIds.length === 0) {
    return;
  }

  const namespaceChunks = chunked(
    normalizedNamespaceIds,
    options?.namespaceChunkSize ?? DEFAULT_NAMESPACE_CHUNK_SIZE
  );
  const statementTimeoutMs = Math.max(1_000, Math.floor(options?.statementTimeoutMs ?? 15_000));
  const lockTimeoutMs = Math.max(250, Math.floor(options?.lockTimeoutMs ?? 2_000));
  const logger = options?.logger ?? (() => {});

  const configureCleanupSession = async (client: Pick<PoolClient, "query">): Promise<void> => {
    await client.query(`SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0`);
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
  };

  const runCleanupStage = async (
    label: string,
    fn: (client: PoolClient) => Promise<void>
  ): Promise<void> => {
    logger(`cleanup stage start ${label}`);
    await withTransaction(async (client) => {
      await configureCleanupSession(client);
      await fn(client);
    });
    logger(`cleanup stage complete ${label}`);
  };

  const runCleanupBatches = async (
    label: string,
    ids: readonly string[],
    batchSize: number,
    fn: (client: PoolClient, batch: readonly string[]) => Promise<void>
  ): Promise<void> => {
    const batches = chunked(ids, batchSize);
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index] ?? [];
      await runCleanupStage(`${label} batch=${index + 1}/${batches.length} size=${batch.length}`, async (client) => {
        await fn(client, batch);
      });
    }
  };

  for (const namespaceChunk of namespaceChunks) {
    logger(`cleanup chunk start namespaces=${namespaceChunk.join(",")}`);
    logger(`cleanup chunk configured statementTimeoutMs=${statementTimeoutMs} lockTimeoutMs=${lockTimeoutMs}`);
    const { artifactIds, episodicIds } = await withClient(async (client) => {
      await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
      await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
      const artifactRows = await client.query<{ readonly artifact_id: string }>(
        `
          SELECT ao.artifact_id
          FROM artifact_observations ao
          JOIN artifacts a ON a.id = ao.artifact_id
          WHERE a.namespace_id = ANY($1::text[])
        `,
        [namespaceChunk]
      );
      const artifactIds = [...new Set(artifactRows.rows.map((row) => row.artifact_id))];
      logger(`cleanup chunk artifactIds=${artifactIds.length}`);
      const episodicRows = await client.query<{ readonly id: string }>(
        `SELECT id FROM episodic_memory WHERE namespace_id = ANY($1::text[])`,
        [namespaceChunk]
      );
      const episodicIds = [...new Set(episodicRows.rows.map((row) => row.id))];
      logger(`cleanup chunk episodicIds=${episodicIds.length}`);
      return { artifactIds, episodicIds };
    });

    await runCleanupStage(`namespace scoped tables namespaces=${namespaceChunk.join(",")}`, async (client) => {
      await client.query(`DELETE FROM procedural_memory WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM relationship_memory WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM temporal_nodes WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM semantic_memory WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM memory_candidates WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM relationship_candidates WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM claim_candidates WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM narrative_event_members WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM narrative_events WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM narrative_scenes WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM answerable_units WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
    });

    if (episodicIds.length > 0) {
      await runCleanupBatches(
        `episodic_memory namespaces=${namespaceChunk.join(",")}`,
        episodicIds,
        DEFAULT_EPISODIC_DELETE_BATCH_SIZE,
        async (client, batch) => {
          await client.query(`DELETE FROM episodic_memory WHERE id = ANY($1::uuid[])`, [batch]);
        }
      );
    }

    if (artifactIds.length > 0) {
      await runCleanupBatches(
        `artifacts namespaces=${namespaceChunk.join(",")}`,
        artifactIds,
        DEFAULT_ARTIFACT_DELETE_BATCH_SIZE,
        async (client, batch) => {
          await client.query(`DELETE FROM artifacts WHERE id = ANY($1::uuid[])`, [batch]);
        }
      );
    }

    logger(`cleanup chunk complete namespaces=${namespaceChunk.join(",")}`);
  }
}

export async function listResidualBenchmarkNamespaces(prefix = "benchmark_"): Promise<readonly string[]> {
  const rows = await queryRows<{ readonly namespace_id: string }>(
    `
      WITH namespaces AS (
        SELECT namespace_id
        FROM artifacts
        WHERE namespace_id LIKE $1
        UNION
        SELECT namespace_id
        FROM episodic_memory
        WHERE namespace_id LIKE $1
      )
      SELECT namespace_id
      FROM namespaces
      ORDER BY namespace_id ASC
    `,
    [`${prefix}%`]
  );
  return rows.map((row) => row.namespace_id);
}

export interface ScrubResidualBenchmarkNamespacesResult {
  readonly prefix: string;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly cleanedNamespaces: readonly string[];
  readonly remainingNamespaces: readonly string[];
}

export async function scrubResidualBenchmarkNamespaces(
  prefix = "benchmark_",
  options?: {
    readonly namespaceChunkSize?: number;
    readonly statementTimeoutMs?: number;
    readonly lockTimeoutMs?: number;
    readonly logger?: (message: string) => void;
  }
): Promise<ScrubResidualBenchmarkNamespacesResult> {
  const cleanedNamespaces = await listResidualBenchmarkNamespaces(prefix);
  if (cleanedNamespaces.length > 0) {
    await cleanupPublicBenchmarkNamespaces(cleanedNamespaces, options);
  }
  const remainingNamespaces = await listResidualBenchmarkNamespaces(prefix);
  return {
    prefix,
    beforeCount: cleanedNamespaces.length,
    afterCount: remainingNamespaces.length,
    cleanedNamespaces,
    remainingNamespaces
  };
}
