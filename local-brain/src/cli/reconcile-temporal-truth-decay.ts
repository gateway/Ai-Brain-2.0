import { closePool, withClient } from "../db/client.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

const namespaceId = argValue("--namespace-id") ?? "personal";
const dryRun = process.argv.includes("--dry-run");

try {
  const result = await withClient(async (client) => {
    const preview = await client.query<{ readonly count: string }>(
      `
        SELECT count(*)::text AS count
        FROM procedural_memory
        WHERE namespace_id = $1
          AND state_type = 'preference'
          AND valid_until IS NULL
          AND (
            lower(coalesce(state_value->>'target', '')) ~ '^(is like|like)\\y'
            OR lower(coalesce(state_value->>'target', '')) LIKE '%always great%'
            OR lower(coalesce(state_value->>'target', '')) LIKE '%usually like is%'
          )
      `,
      [namespaceId]
    );
    const malformedActivePreferenceCount = Number(preview.rows[0]?.count ?? "0");
    if (dryRun || malformedActivePreferenceCount === 0) {
      return { namespaceId, dryRun, malformedActivePreferenceCount, reconciledCount: 0 };
    }
    const update = await client.query(
      `
        UPDATE procedural_memory
        SET valid_until = now(),
            metadata = metadata || jsonb_build_object(
              'reconciled_by', 'temporal_truth_decay_reconcile_v1',
              'reconciled_at', now(),
              'reconciliation_reason', 'malformed_preference_target'
            )
        WHERE namespace_id = $1
          AND state_type = 'preference'
          AND valid_until IS NULL
          AND (
            lower(coalesce(state_value->>'target', '')) ~ '^(is like|like)\\y'
            OR lower(coalesce(state_value->>'target', '')) LIKE '%always great%'
            OR lower(coalesce(state_value->>'target', '')) LIKE '%usually like is%'
          )
      `,
      [namespaceId]
    );
    return { namespaceId, dryRun, malformedActivePreferenceCount, reconciledCount: update.rowCount ?? 0 };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePool();
}
