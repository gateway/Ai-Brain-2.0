import { closePool, queryRows, withMaintenanceLock, withTransaction } from "../db/client.js";
import { fileURLToPath } from "node:url";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

interface CountRow {
  readonly count: string;
}

interface SourceRow {
  readonly id: string;
}

async function deleteCount(client: { query: (text: string, values?: readonly unknown[]) => Promise<{ rowCount: number | null }> }, text: string, values: readonly unknown[]): Promise<number> {
  const result = await client.query(text, values);
  return result.rowCount ?? 0;
}

async function countArtifacts(namespaceId: string): Promise<number> {
  const rows = await queryRows<CountRow>("SELECT COUNT(*)::text AS count FROM artifacts WHERE namespace_id = $1", [namespaceId]);
  return Number(rows[0]?.count ?? "0");
}

export async function resetNamespaceData(
  namespaceId: string,
  options: {
    readonly resetOwnerProfile?: boolean;
  } = {}
): Promise<{
  readonly namespaceId: string;
  readonly sourceCount: number;
  readonly artifactsBefore: number;
  readonly deleted: Record<string, number>;
}> {
  const resetOwnerProfile = options.resetOwnerProfile === true;
  const beforeArtifacts = await countArtifacts(namespaceId);
  const sourceRows = await queryRows<SourceRow>(
    "SELECT id FROM ops.monitored_sources WHERE namespace_id = $1 ORDER BY created_at ASC",
    [namespaceId]
  );
  const sourceIds = sourceRows.map((row) => row.id);

  const result = await withMaintenanceLock(`reset namespace ${namespaceId}`, async () =>
    withTransaction(async (client) => {
      const counts: Record<string, number> = {};

      if (sourceIds.length > 0) {
        counts.ops_source_import_runs = await deleteCount(
          client,
          "DELETE FROM ops.source_import_runs WHERE source_id = ANY($1::uuid[])",
          [sourceIds]
        );
        counts.ops_source_scan_runs = await deleteCount(
          client,
          "DELETE FROM ops.source_scan_runs WHERE source_id = ANY($1::uuid[])",
          [sourceIds]
        );
        counts.ops_monitored_source_files = await deleteCount(
          client,
          "DELETE FROM ops.monitored_source_files WHERE source_id = ANY($1::uuid[])",
          [sourceIds]
        );
      } else {
        counts.ops_source_import_runs = 0;
        counts.ops_source_scan_runs = 0;
        counts.ops_monitored_source_files = 0;
      }

      counts.memory_graph_edges = await deleteCount(client, "DELETE FROM memory_graph_edges WHERE namespace_id = $1", [namespaceId]);
      counts.entity_rebuild_runs = await deleteCount(client, "DELETE FROM entity_rebuild_runs WHERE namespace_id = $1", [namespaceId]);
      counts.clarification_resolutions = 0;
      counts.answerable_units = await deleteCount(client, "DELETE FROM answerable_units WHERE namespace_id = $1", [namespaceId]);
      counts.task_items = await deleteCount(client, "DELETE FROM task_items WHERE namespace_id = $1", [namespaceId]);
      counts.project_items = await deleteCount(client, "DELETE FROM project_items WHERE namespace_id = $1", [namespaceId]);
      counts.date_time_spans = await deleteCount(client, "DELETE FROM date_time_spans WHERE namespace_id = $1", [namespaceId]);
      counts.transaction_items = await deleteCount(client, "DELETE FROM transaction_items WHERE namespace_id = $1", [namespaceId]);
      counts.media_mentions = await deleteCount(client, "DELETE FROM media_mentions WHERE namespace_id = $1", [namespaceId]);
      counts.preference_facts = await deleteCount(client, "DELETE FROM preference_facts WHERE namespace_id = $1", [namespaceId]);
      counts.person_time_facts = await deleteCount(client, "DELETE FROM person_time_facts WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_rebuild_runs = await deleteCount(client, "DELETE FROM canonical_rebuild_runs WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_ambiguities = await deleteCount(client, "DELETE FROM canonical_ambiguities WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_pair_reports = await deleteCount(client, "DELETE FROM canonical_pair_reports WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_entity_reports = await deleteCount(client, "DELETE FROM canonical_entity_reports WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_collection_facts = await deleteCount(client, "DELETE FROM canonical_collection_facts WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_narrative_provenance = await deleteCount(client, "DELETE FROM canonical_narrative_provenance WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_narratives = await deleteCount(client, "DELETE FROM canonical_narratives WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_set_entries = await deleteCount(client, "DELETE FROM canonical_set_entries WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_sets = await deleteCount(client, "DELETE FROM canonical_sets WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_fact_provenance = await deleteCount(client, "DELETE FROM canonical_fact_provenance WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_temporal_facts = await deleteCount(client, "DELETE FROM canonical_temporal_facts WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_states = await deleteCount(client, "DELETE FROM canonical_states WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_subject_states = await deleteCount(client, "DELETE FROM canonical_subject_states WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_facts = await deleteCount(client, "DELETE FROM canonical_facts WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_subject_aliases = await deleteCount(client, "DELETE FROM canonical_subject_aliases WHERE namespace_id = $1", [namespaceId]);
      counts.canonical_subjects = await deleteCount(client, "DELETE FROM canonical_subjects WHERE namespace_id = $1", [namespaceId]);
      counts.semantic_decay_events = await deleteCount(client, "DELETE FROM semantic_decay_events WHERE namespace_id = $1", [namespaceId]);
      counts.relationship_adjudication_events = await deleteCount(client, "DELETE FROM relationship_adjudication_events WHERE namespace_id = $1", [namespaceId]);
      counts.temporal_node_members = await deleteCount(client, "DELETE FROM temporal_node_members WHERE namespace_id = $1", [namespaceId]);
      counts.narrative_event_members = await deleteCount(client, "DELETE FROM narrative_event_members WHERE namespace_id = $1", [namespaceId]);
      counts.claim_candidates = await deleteCount(client, "DELETE FROM claim_candidates WHERE namespace_id = $1", [namespaceId]);
      counts.relationship_memory = await deleteCount(client, "DELETE FROM relationship_memory WHERE namespace_id = $1", [namespaceId]);
      counts.relationship_candidates = await deleteCount(client, "DELETE FROM relationship_candidates WHERE namespace_id = $1", [namespaceId]);
      counts.memory_entity_mentions = await deleteCount(client, "DELETE FROM memory_entity_mentions WHERE namespace_id = $1", [namespaceId]);
      counts.temporal_nodes = await deleteCount(client, "DELETE FROM temporal_nodes WHERE namespace_id = $1", [namespaceId]);
      counts.memory_candidates = await deleteCount(client, "DELETE FROM memory_candidates WHERE namespace_id = $1", [namespaceId]);
      counts.semantic_memory = await deleteCount(client, "DELETE FROM semantic_memory WHERE namespace_id = $1", [namespaceId]);
      counts.procedural_memory = await deleteCount(client, "DELETE FROM procedural_memory WHERE namespace_id = $1", [namespaceId]);
      counts.narrative_events = await deleteCount(client, "DELETE FROM narrative_events WHERE namespace_id = $1", [namespaceId]);
      counts.narrative_scenes = await deleteCount(client, "DELETE FROM narrative_scenes WHERE namespace_id = $1", [namespaceId]);
      counts.namespace_self_bindings = resetOwnerProfile
        ? await deleteCount(client, "DELETE FROM namespace_self_bindings WHERE namespace_id = $1", [namespaceId])
        : 0;
      counts.entities = await deleteCount(client, "DELETE FROM entities WHERE namespace_id = $1", [namespaceId]);
      counts.episodic_memory = await deleteCount(client, "DELETE FROM episodic_memory WHERE namespace_id = $1", [namespaceId]);
      counts.artifacts = await deleteCount(client, "DELETE FROM artifacts WHERE namespace_id = $1", [namespaceId]);
      counts.orphan_identity_profiles = resetOwnerProfile
        ? await deleteCount(
            client,
            "DELETE FROM identity_profiles ip WHERE NOT EXISTS (SELECT 1 FROM namespace_self_bindings nsb WHERE nsb.identity_profile_id = ip.id)",
            []
          )
        : 0;

      return counts;
    })
  );

  return {
    namespaceId,
    sourceCount: sourceIds.length,
    artifactsBefore: beforeArtifacts,
    deleted: result
  };
}

async function main(): Promise<void> {
  const namespaceId = readFlag("--namespace-id");
  if (!namespaceId) {
    throw new Error("Usage: reset-namespace --namespace-id <namespace-id> [--reset-owner-profile]");
  }

  try {
    const result = await resetNamespaceData(namespaceId, {
      resetOwnerProfile: process.argv.includes("--reset-owner-profile")
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
