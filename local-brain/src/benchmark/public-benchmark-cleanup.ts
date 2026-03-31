import { withTransaction } from "../db/client.js";

const DEFAULT_NAMESPACE_CHUNK_SIZE = 25;

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

  for (const namespaceChunk of namespaceChunks) {
    await withTransaction(async (client) => {
      logger(`cleanup chunk start namespaces=${namespaceChunk.join(",")}`);
      await client.query(`SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0`);
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      logger(`cleanup chunk configured statementTimeoutMs=${statementTimeoutMs} lockTimeoutMs=${lockTimeoutMs}`);
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
      const observationRows = await client.query<{ readonly id: string }>(
        `
          SELECT ao.id
          FROM artifact_observations ao
          JOIN artifacts a ON a.id = ao.artifact_id
          WHERE a.namespace_id = ANY($1::text[])
        `,
        [namespaceChunk]
      );
      const observationIds = [...new Set(observationRows.rows.map((row) => row.id))];
      logger(`cleanup chunk observationIds=${observationIds.length}`);
      const episodicRows = await client.query<{ readonly id: string }>(
        `SELECT id FROM episodic_memory WHERE namespace_id = ANY($1::text[])`,
        [namespaceChunk]
      );
      const episodicIds = [...new Set(episodicRows.rows.map((row) => row.id))];
      logger(`cleanup chunk episodicIds=${episodicIds.length}`);

      await client.query(`DELETE FROM procedural_memory WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM relationship_memory WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM temporal_nodes WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM semantic_memory WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM memory_candidates WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      await client.query(`DELETE FROM relationship_candidates WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      if (episodicIds.length > 0) {
        await client.query(
          `
            DELETE FROM claim_candidates
            WHERE namespace_id = ANY($1::text[])
              AND coalesce(source_memory_id::text, '') = ANY($2::text[])
          `,
          [namespaceChunk, episodicIds]
        );
      }
      await client.query(`DELETE FROM episodic_memory WHERE namespace_id = ANY($1::text[])`, [namespaceChunk]);
      if (observationIds.length > 0) {
        await client.query(`DELETE FROM narrative_scenes WHERE artifact_observation_id = ANY($1::uuid[])`, [observationIds]);
        await client.query(`DELETE FROM narrative_events WHERE artifact_observation_id = ANY($1::uuid[])`, [observationIds]);
        await client.query(`DELETE FROM artifact_chunks WHERE artifact_observation_id = ANY($1::uuid[])`, [observationIds]);
      }
      if (artifactIds.length > 0) {
        await client.query(`DELETE FROM artifact_observations WHERE artifact_id = ANY($1::uuid[])`, [artifactIds]);
        await client.query(`DELETE FROM artifacts WHERE id = ANY($1::uuid[])`, [artifactIds]);
      }
      logger(`cleanup chunk complete namespaces=${namespaceChunk.join(",")}`);
    });
  }
}
