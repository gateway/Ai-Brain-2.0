import { queryRows, withTransaction } from "../db/client.js";
import { normalizeWhitespace } from "./canonicalization.js";
import { manualGraphAliasInventory } from "../retrieval/place-aliases.js";

export type EntityRole = "person" | "place" | "project" | "org" | "venue";
export type RoleResolutionAction =
  | "canonicalize_role"
  | "split_identity"
  | "allow_multi_role"
  | "needs_review"
  | "retire_invalid_role";
export type RoleResolutionStatus = "resolved" | "allowed" | "needs_review";

export interface EntityRoleConflictProjectionRow {
  readonly namespaceId: string;
  readonly surfaceName: string;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly observedRoles: readonly EntityRole[];
  readonly resolvedRoles: readonly EntityRole[];
  readonly invalidRoles: readonly EntityRole[];
  readonly roleEvidenceCounts: Readonly<Record<string, number>>;
  readonly roleSourceTrails: Readonly<Record<string, readonly RoleSourceTrailEntry[]>>;
  readonly roleConfidence: Readonly<Record<string, number>>;
  readonly compatibleRoleGroups: readonly (readonly EntityRole[])[];
  readonly recommendedAction: RoleResolutionAction;
  readonly resolutionStatus: RoleResolutionStatus;
  readonly targetRole: EntityRole | null;
  readonly decisionIds: readonly string[];
}

export interface RoleSourceTrailEntry {
  readonly sourceUri: string | null;
  readonly quote: string | null;
  readonly supportKind: "entity_alias" | "entity_mention" | "manual_alias_inventory" | "relationship_memory" | "procedural_memory";
}

interface EntityRoleEvidenceRow {
  readonly entity_id: string;
  readonly canonical_name: string;
  readonly normalized_name: string;
  readonly entity_type: string;
  readonly alias_evidence_count: number | string | null;
  readonly mention_count: number | string | null;
  readonly relationship_count: number | string | null;
  readonly procedural_count: number | string | null;
  readonly source_uris: readonly string[] | null;
  readonly quotes: readonly string[] | null;
}

interface ExistingDecisionRow {
  readonly id: string;
  readonly from_role: string;
  readonly to_role: string | null;
  readonly action: RoleResolutionAction;
  readonly confidence: number;
}

const ROLE_PRIORITY: readonly EntityRole[] = ["person", "place", "project", "org", "venue"];
const COMPATIBLE_ROLE_GROUPS: readonly (readonly EntityRole[])[] = [
  ["project", "org"],
  ["place", "venue"],
  ["person"]
];

function normalizeKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function toEntityRole(value: string): EntityRole | null {
  const normalized = value.toLowerCase();
  return ROLE_PRIORITY.includes(normalized as EntityRole) ? (normalized as EntityRole) : null;
}

function roleSort(roles: Iterable<EntityRole>): EntityRole[] {
  return [...new Set(roles)].sort((left, right) => ROLE_PRIORITY.indexOf(left) - ROLE_PRIORITY.indexOf(right));
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compatibleGroupFor(roles: readonly EntityRole[]): readonly EntityRole[] | null {
  return COMPATIBLE_ROLE_GROUPS.find((group) => roles.every((role) => group.includes(role))) ?? null;
}

export function areEntityRolesCompatible(roles: readonly EntityRole[]): boolean {
  return compatibleGroupFor(roles) !== null;
}

function manualRolePriors(surfaceName: string, canonicalName: string): readonly { readonly role: EntityRole; readonly trail: RoleSourceTrailEntry }[] {
  const normalizedSurface = normalizeKey(surfaceName);
  const normalizedCanonical = normalizeKey(canonicalName);
  return manualGraphAliasInventory()
    .filter((entry) => normalizeKey(entry.alias) === normalizedSurface || normalizeKey(entry.canonical) === normalizedCanonical)
    .map((entry) => ({
      role: entry.entityRole === "venue" ? "place" : entry.entityRole,
      trail: {
        sourceUri: "manual://graph-alias-inventory",
        quote: `${entry.alias} is seeded as ${entry.entityRole} for ${entry.canonical}.`,
        supportKind: "manual_alias_inventory" as const
      }
    }));
}

function confidenceFromScores(roleScores: Readonly<Record<string, number>>, role: EntityRole): number {
  const values = Object.values(roleScores);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return 0;
  }
  return Number(Math.min(0.99, roleScores[role] / total).toFixed(4));
}

function strongestRole(roleScores: Readonly<Record<string, number>>): EntityRole | null {
  const sorted = roleSort(Object.keys(roleScores).map((role) => toEntityRole(role)).filter((role): role is EntityRole => role !== null))
    .sort((left, right) => (roleScores[right] ?? 0) - (roleScores[left] ?? 0));
  return sorted[0] ?? null;
}

async function loadRoleEvidence(namespaceId: string): Promise<readonly EntityRoleEvidenceRow[]> {
  return queryRows<EntityRoleEvidenceRow>(
    `
      WITH conflict_names AS (
        SELECT lower(canonical_name) AS normalized_name
        FROM entities
        WHERE namespace_id = $1
          AND entity_type IN ('person', 'place', 'project', 'org')
        GROUP BY lower(canonical_name)
        HAVING count(DISTINCT entity_type) > 1
      )
      SELECT
        e.id::text AS entity_id,
        e.canonical_name,
        lower(e.canonical_name) AS normalized_name,
        e.entity_type,
        COALESCE(sum(NULLIF(ea.evidence_count, 0)), 0)::text AS alias_evidence_count,
        count(DISTINCT mem.id)::text AS mention_count,
        count(DISTINCT rm.id)::text AS relationship_count,
        count(DISTINCT pm.id)::text AS procedural_count,
        array_remove(array_agg(DISTINCT a.uri), NULL) AS source_uris,
        (array_agg(DISTINCT left(regexp_replace(em.content, '\\s+', ' ', 'g'), 320)) FILTER (WHERE em.content IS NOT NULL))[1:6] AS quotes
      FROM entities e
      JOIN conflict_names cn ON cn.normalized_name = lower(e.canonical_name)
      LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
      LEFT JOIN memory_entity_mentions mem ON mem.entity_id = e.id
      LEFT JOIN episodic_memory em ON em.id = mem.source_memory_id
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      LEFT JOIN relationship_memory rm ON rm.namespace_id = e.namespace_id AND (rm.subject_entity_id = e.id OR rm.object_entity_id = e.id)
      LEFT JOIN procedural_memory pm ON pm.namespace_id = e.namespace_id AND pm.state_value::text ILIKE '%' || e.canonical_name || '%'
      WHERE e.namespace_id = $1
        AND e.entity_type IN ('person', 'place', 'project', 'org')
      GROUP BY e.id, e.canonical_name, e.entity_type
      ORDER BY lower(e.canonical_name), e.entity_type
    `,
    [namespaceId]
  );
}

async function loadExistingDecisions(namespaceId: string): Promise<Map<string, ExistingDecisionRow[]>> {
  const rows = await queryRows<ExistingDecisionRow & { readonly normalized_name: string }>(
    `
      SELECT id::text, normalized_name, from_role, to_role, action, confidence
      FROM entity_role_resolution_decisions
      WHERE namespace_id = $1
      ORDER BY decided_at DESC
    `,
    [namespaceId]
  );
  const result = new Map<string, ExistingDecisionRow[]>();
  for (const row of rows) {
    const existing = result.get(row.normalized_name) ?? [];
    result.set(row.normalized_name, [...existing, row]);
  }
  return result;
}

function buildProjectionForGroup(namespaceId: string, rows: readonly EntityRoleEvidenceRow[], existingDecisions: readonly ExistingDecisionRow[]): Omit<EntityRoleConflictProjectionRow, "decisionIds"> {
  const canonicalName = rows[0]?.canonical_name ?? "";
  const normalizedName = rows[0]?.normalized_name ?? normalizeKey(canonicalName);
  const observedRoles = roleSort(rows.map((row) => toEntityRole(row.entity_type)).filter((role): role is EntityRole => role !== null));
  const roleEvidenceCounts: Record<string, number> = {};
  const roleSourceTrails: Record<string, RoleSourceTrailEntry[]> = {};

  for (const row of rows) {
    const role = toEntityRole(row.entity_type);
    if (!role) {
      continue;
    }
    const evidenceCount = 1 + numeric(row.alias_evidence_count) + numeric(row.mention_count) + numeric(row.relationship_count) + numeric(row.procedural_count);
    roleEvidenceCounts[role] = (roleEvidenceCounts[role] ?? 0) + evidenceCount;
    const trails = roleSourceTrails[role] ?? [];
    for (const uri of row.source_uris ?? []) {
      trails.push({ sourceUri: uri, quote: null, supportKind: "entity_mention" });
    }
    for (const quote of row.quotes ?? []) {
      trails.push({ sourceUri: null, quote, supportKind: "entity_mention" });
    }
    if (numeric(row.alias_evidence_count) > 0) {
      trails.push({ sourceUri: "db://entity_aliases", quote: `${canonicalName} has alias evidence for role ${role}.`, supportKind: "entity_alias" });
    }
    if (trails.length === 0) {
      trails.push({
        sourceUri: `db://entities/${row.entity_id}`,
        quote: `${row.canonical_name} is observed as ${role} in the canonical entity table.`,
        supportKind: "entity_alias"
      });
    }
    roleSourceTrails[role] = trails.slice(0, 8);
  }

  for (const prior of manualRolePriors(canonicalName, canonicalName)) {
    roleEvidenceCounts[prior.role] = (roleEvidenceCounts[prior.role] ?? 0) + 100;
    roleSourceTrails[prior.role] = [...(roleSourceTrails[prior.role] ?? []), prior.trail].slice(0, 8);
  }

  const compatibleRoleGroups = COMPATIBLE_ROLE_GROUPS.filter((group) => observedRoles.some((role) => group.includes(role)));
  const roleConfidence = Object.fromEntries(observedRoles.map((role) => [role, confidenceFromScores(roleEvidenceCounts, role)]));

  const manualAllow = existingDecisions.find((decision) => decision.action === "allow_multi_role");
  const compatible = areEntityRolesCompatible(observedRoles);
  if (manualAllow || compatible) {
    return {
      namespaceId,
      surfaceName: canonicalName,
      canonicalName,
      normalizedName,
      observedRoles,
      resolvedRoles: observedRoles,
      invalidRoles: [],
      roleEvidenceCounts,
      roleSourceTrails,
      roleConfidence,
      compatibleRoleGroups,
      recommendedAction: "allow_multi_role",
      resolutionStatus: "allowed",
      targetRole: null
    };
  }

  const manualCanonicalize = existingDecisions.find((decision) => decision.action === "canonicalize_role" && decision.to_role && toEntityRole(decision.to_role));
  const targetRole = manualCanonicalize?.to_role ? toEntityRole(manualCanonicalize.to_role) : strongestRole(roleEvidenceCounts);
  if (!targetRole) {
    return {
      namespaceId,
      surfaceName: canonicalName,
      canonicalName,
      normalizedName,
      observedRoles,
      resolvedRoles: [],
      invalidRoles: observedRoles,
      roleEvidenceCounts,
      roleSourceTrails,
      roleConfidence,
      compatibleRoleGroups,
      recommendedAction: "needs_review",
      resolutionStatus: "needs_review",
      targetRole: null
    };
  }

  const invalidRoles = observedRoles.filter((role) => role !== targetRole);
  const confidence = roleConfidence[targetRole] ?? 0;
  return {
    namespaceId,
    surfaceName: canonicalName,
    canonicalName,
    normalizedName,
    observedRoles,
    resolvedRoles: [targetRole],
    invalidRoles,
    roleEvidenceCounts,
    roleSourceTrails,
    roleConfidence,
    compatibleRoleGroups,
    recommendedAction: confidence >= 0.55 ? "canonicalize_role" : "needs_review",
    resolutionStatus: confidence >= 0.55 ? "resolved" : "needs_review",
    targetRole
  };
}

async function upsertDecision(
  client: { query: (queryText: string, values?: readonly unknown[]) => Promise<{ rows: readonly { readonly id: string }[] }> },
  projection: Omit<EntityRoleConflictProjectionRow, "decisionIds">,
  fromRole: EntityRole,
  action: RoleResolutionAction,
  toRole: EntityRole | null
): Promise<string> {
  const sourceTrail = projection.roleSourceTrails[fromRole] ?? projection.roleSourceTrails[toRole ?? ""] ?? [];
  const result = await client.query(
    `
      INSERT INTO entity_role_resolution_decisions (
        namespace_id,
        surface_name,
        canonical_name,
        normalized_name,
        from_role,
        to_role,
        action,
        confidence,
        evidence_count,
        source_trail,
        decided_by,
        notes,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'auto_projection_v1', $11, $12::jsonb)
      ON CONFLICT (namespace_id, normalized_name, from_role, action)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        to_role = EXCLUDED.to_role,
        confidence = GREATEST(entity_role_resolution_decisions.confidence, EXCLUDED.confidence),
        evidence_count = GREATEST(entity_role_resolution_decisions.evidence_count, EXCLUDED.evidence_count),
        source_trail = EXCLUDED.source_trail,
        decided_at = now(),
        notes = EXCLUDED.notes,
        metadata = entity_role_resolution_decisions.metadata || EXCLUDED.metadata
      RETURNING id::text
    `,
    [
      projection.namespaceId,
      projection.surfaceName,
      projection.canonicalName,
      projection.normalizedName,
      fromRole,
      toRole,
      action,
      toRole ? projection.roleConfidence[toRole] ?? 0 : Math.max(...Object.values(projection.roleConfidence), 0),
      projection.roleEvidenceCounts[fromRole] ?? 0,
      JSON.stringify(sourceTrail.slice(0, 8)),
      `${projection.canonicalName}: ${action}${toRole ? ` ${fromRole} -> ${toRole}` : ""}`,
      JSON.stringify({
        observedRoles: projection.observedRoles,
        resolvedRoles: projection.resolvedRoles,
        invalidRoles: projection.invalidRoles
      })
    ]
  );
  return result.rows[0]?.id ?? "";
}

export async function rebuildEntityRoleConflictProjection(namespaceId = "personal"): Promise<readonly EntityRoleConflictProjectionRow[]> {
  const evidenceRows = await loadRoleEvidence(namespaceId);
  const existingDecisions = await loadExistingDecisions(namespaceId);
  const groups = new Map<string, EntityRoleEvidenceRow[]>();
  for (const row of evidenceRows) {
    groups.set(row.normalized_name, [...(groups.get(row.normalized_name) ?? []), row]);
  }

  const projections: EntityRoleConflictProjectionRow[] = [];
  await withTransaction(async (client) => {
    await client.query("DELETE FROM entity_role_conflict_projection WHERE namespace_id = $1", [namespaceId]);

    for (const rows of groups.values()) {
      const initial = buildProjectionForGroup(namespaceId, rows, existingDecisions.get(rows[0]?.normalized_name ?? "") ?? []);
      const decisionIds: string[] = [];
      if (initial.recommendedAction === "allow_multi_role") {
        for (const role of initial.resolvedRoles) {
          decisionIds.push(await upsertDecision(client, initial, role, "allow_multi_role", null));
        }
      } else if (initial.targetRole) {
        decisionIds.push(await upsertDecision(client, initial, initial.targetRole, "canonicalize_role", initial.targetRole));
        for (const invalidRole of initial.invalidRoles) {
          decisionIds.push(await upsertDecision(client, initial, invalidRole, "retire_invalid_role", initial.targetRole));
        }
      } else {
        for (const role of initial.observedRoles) {
          decisionIds.push(await upsertDecision(client, initial, role, "needs_review", null));
        }
      }

      await client.query(
        `
          INSERT INTO entity_role_conflict_projection (
            namespace_id,
            surface_name,
            canonical_name,
            normalized_name,
            observed_roles,
            resolved_roles,
            invalid_roles,
            role_evidence_counts,
            role_source_trails,
            role_confidence,
            compatible_role_groups,
            recommended_action,
            resolution_status,
            target_role,
            decision_ids,
            metadata,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7::text[], $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15::uuid[], $16::jsonb, now())
          ON CONFLICT (namespace_id, normalized_name)
          DO UPDATE SET
            surface_name = EXCLUDED.surface_name,
            canonical_name = EXCLUDED.canonical_name,
            observed_roles = EXCLUDED.observed_roles,
            resolved_roles = EXCLUDED.resolved_roles,
            invalid_roles = EXCLUDED.invalid_roles,
            role_evidence_counts = EXCLUDED.role_evidence_counts,
            role_source_trails = EXCLUDED.role_source_trails,
            role_confidence = EXCLUDED.role_confidence,
            compatible_role_groups = EXCLUDED.compatible_role_groups,
            recommended_action = EXCLUDED.recommended_action,
            resolution_status = EXCLUDED.resolution_status,
            target_role = EXCLUDED.target_role,
            decision_ids = EXCLUDED.decision_ids,
            metadata = EXCLUDED.metadata,
            updated_at = now()
        `,
        [
          initial.namespaceId,
          initial.surfaceName,
          initial.canonicalName,
          initial.normalizedName,
          initial.observedRoles,
          initial.resolvedRoles,
          initial.invalidRoles,
          JSON.stringify(initial.roleEvidenceCounts),
          JSON.stringify(initial.roleSourceTrails),
          JSON.stringify(initial.roleConfidence),
          JSON.stringify(initial.compatibleRoleGroups),
          initial.recommendedAction,
          initial.resolutionStatus,
          initial.targetRole,
          decisionIds.filter(Boolean),
          JSON.stringify({ projectionVersion: "entity_role_resolution_v1" })
        ]
      );
      projections.push({ ...initial, decisionIds: decisionIds.filter(Boolean) });
    }
  });

  return projections.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));
}

export async function loadEntityRoleConflictProjection(namespaceId = "personal"): Promise<readonly EntityRoleConflictProjectionRow[]> {
  const rows = await queryRows<{
    readonly namespace_id: string;
    readonly surface_name: string;
    readonly canonical_name: string;
    readonly normalized_name: string;
    readonly observed_roles: readonly string[];
    readonly resolved_roles: readonly string[];
    readonly invalid_roles: readonly string[];
    readonly role_evidence_counts: Record<string, number>;
    readonly role_source_trails: Record<string, readonly RoleSourceTrailEntry[]>;
    readonly role_confidence: Record<string, number>;
    readonly compatible_role_groups: readonly (readonly string[])[];
    readonly recommended_action: RoleResolutionAction;
    readonly resolution_status: RoleResolutionStatus;
    readonly target_role: string | null;
    readonly decision_ids: readonly string[];
  }>(
    `
      SELECT
        namespace_id,
        surface_name,
        canonical_name,
        normalized_name,
        observed_roles,
        resolved_roles,
        invalid_roles,
        role_evidence_counts,
        role_source_trails,
        role_confidence,
        compatible_role_groups,
        recommended_action,
        resolution_status,
        target_role,
        decision_ids
      FROM entity_role_conflict_projection
      WHERE namespace_id = $1
      ORDER BY normalized_name
    `,
    [namespaceId]
  );
  return rows.map((row) => ({
    namespaceId: row.namespace_id,
    surfaceName: row.surface_name,
    canonicalName: row.canonical_name,
    normalizedName: row.normalized_name,
    observedRoles: roleSort(row.observed_roles.map((role) => toEntityRole(role)).filter((role): role is EntityRole => role !== null)),
    resolvedRoles: roleSort(row.resolved_roles.map((role) => toEntityRole(role)).filter((role): role is EntityRole => role !== null)),
    invalidRoles: roleSort(row.invalid_roles.map((role) => toEntityRole(role)).filter((role): role is EntityRole => role !== null)),
    roleEvidenceCounts: row.role_evidence_counts,
    roleSourceTrails: row.role_source_trails,
    roleConfidence: row.role_confidence,
    compatibleRoleGroups: row.compatible_role_groups.map((group) => roleSort(group.map((role) => toEntityRole(role)).filter((role): role is EntityRole => role !== null))),
    recommendedAction: row.recommended_action,
    resolutionStatus: row.resolution_status,
    targetRole: row.target_role ? toEntityRole(row.target_role) : null,
    decisionIds: row.decision_ids
  }));
}

export async function loadEntityRoleResolutionMap(namespaceId = "personal"): Promise<Map<string, { readonly resolvedRoles: readonly EntityRole[]; readonly invalidRoles: readonly EntityRole[] }>> {
  const projections = await loadEntityRoleConflictProjection(namespaceId);
  return new Map(
    projections.map((projection) => [
      projection.normalizedName,
      {
        resolvedRoles: projection.resolvedRoles,
        invalidRoles: projection.invalidRoles
      }
    ])
  );
}
