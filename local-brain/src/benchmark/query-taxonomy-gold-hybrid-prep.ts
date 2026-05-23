import { queryRows } from "../db/client.js";
import { attachTextDerivation } from "../derivations/service.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { QUERY_GOLD_FIXTURE_NAMESPACE, seedQueryTaxonomyGoldFixture } from "./query-taxonomy-gold-fixtures.js";

interface FixtureChunkRow {
  readonly artifact_id: string;
  readonly artifact_observation_id: string;
  readonly chunk_id: string;
  readonly text_content: string;
}

export async function prepareQueryTaxonomyGoldFixtureForHybrid(
  namespaceId = QUERY_GOLD_FIXTURE_NAMESPACE
): Promise<{ readonly namespaceId: string; readonly derivationsAttached: number }> {
  await seedQueryTaxonomyGoldFixture(namespaceId);
  const chunkRows = await queryRows<FixtureChunkRow>(
    `
      SELECT
        ac.artifact_id::text AS artifact_id,
        ac.artifact_observation_id::text AS artifact_observation_id,
        ac.id::text AS chunk_id,
        ac.text_content
      FROM artifact_chunks ac
      JOIN artifacts a ON a.id = ac.artifact_id
      WHERE a.namespace_id = $1
        AND COALESCE(ac.text_content, '') <> ''
      ORDER BY ac.chunk_index ASC, ac.id ASC
    `,
    [namespaceId]
  );

  let derivationsAttached = 0;
  for (const row of chunkRows) {
    await attachTextDerivation({
      artifactId: row.artifact_id,
      artifactObservationId: row.artifact_observation_id,
      sourceChunkId: row.chunk_id,
      derivationType: "text_proxy",
      text: row.text_content,
      metadata: {
        benchmark_seed: true,
        benchmark_fixture: "query_taxonomy_gold",
        source: "query_taxonomy_gold_hybrid_prep"
      }
    });
    derivationsAttached += 1;
  }

  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });

  return {
    namespaceId,
    derivationsAttached
  };
}
