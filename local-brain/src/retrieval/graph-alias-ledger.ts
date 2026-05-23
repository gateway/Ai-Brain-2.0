import { queryRows } from "../db/client.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import { loadEntityRoleResolutionMap } from "../identity/entity-role-resolution.js";
import { manualGraphAliasInventory, type AliasInventoryEntry } from "./place-aliases.js";

export type GraphAliasEntityRole = "person" | "place" | "project" | "org" | "venue";
export type GraphAliasPromotionStatus = "manual_seed" | "candidate_review_required" | "benchmarked_promotable";

export interface GraphAliasCandidate {
  readonly canonical: string;
  readonly alias: string;
  readonly entityRole: GraphAliasEntityRole;
  readonly aliasType: AliasInventoryEntry["aliasType"] | "observed_entity_alias" | "source_cooccurrence";
  readonly ownerSubject: string | null;
  readonly confidence: number;
  readonly evidenceCount: number;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly sourceUris: readonly string[];
  readonly sourceQuotes: readonly string[];
  readonly promotionStatus: GraphAliasPromotionStatus;
  readonly authoritative: boolean;
}

interface EntityAliasRow {
  readonly canonical_name: string;
  readonly entity_type: string;
  readonly alias: string;
  readonly alias_type: string;
  readonly evidence_count: number | null;
  readonly first_seen_at: string | null;
  readonly last_seen_at: string | null;
}

interface SourceMentionRow {
  readonly alias: string;
  readonly first_seen_at: string | null;
  readonly last_seen_at: string | null;
  readonly evidence_count: string;
  readonly source_uris: readonly string[] | null;
  readonly quotes: readonly string[] | null;
}

const MANUAL_CANONICAL_OVERRIDES = new Map<string, { readonly canonical: string; readonly role: GraphAliasEntityRole }>(
  manualGraphAliasInventory().map((entry) => [normalizeKey(entry.alias), { canonical: entry.canonical, role: entry.entityRole }])
);

function normalizeKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function canonicalRole(entityType: string): GraphAliasEntityRole {
  const normalized = entityType.toLowerCase();
  if (["person", "place", "project", "org"].includes(normalized)) {
    return normalized as GraphAliasEntityRole;
  }
  return "project";
}

function candidateKey(candidate: Pick<GraphAliasCandidate, "canonical" | "alias" | "entityRole">): string {
  return `${normalizeKey(candidate.entityRole)}|${normalizeKey(candidate.canonical)}|${normalizeKey(candidate.alias)}`;
}

function mergeCandidate(existing: GraphAliasCandidate, incoming: GraphAliasCandidate): GraphAliasCandidate {
  return {
    ...existing,
    confidence: Math.max(existing.confidence, incoming.confidence),
    evidenceCount: existing.evidenceCount + incoming.evidenceCount,
    firstSeenAt: [existing.firstSeenAt, incoming.firstSeenAt].filter(Boolean).sort()[0] ?? null,
    lastSeenAt: [existing.lastSeenAt, incoming.lastSeenAt].filter(Boolean).sort().at(-1) ?? null,
    sourceUris: [...new Set([...existing.sourceUris, ...incoming.sourceUris])].slice(0, 8),
    sourceQuotes: [...new Set([...existing.sourceQuotes, ...incoming.sourceQuotes])].slice(0, 6),
    promotionStatus:
      existing.promotionStatus === "manual_seed" || incoming.promotionStatus === "manual_seed"
        ? "manual_seed"
        : existing.evidenceCount + incoming.evidenceCount >= 2
          ? "benchmarked_promotable"
          : "candidate_review_required",
    authoritative: existing.authoritative && incoming.authoritative
  };
}

function addCandidate(map: Map<string, GraphAliasCandidate>, candidate: GraphAliasCandidate): void {
  const key = candidateKey(candidate);
  const existing = map.get(key);
  map.set(key, existing ? mergeCandidate(existing, candidate) : candidate);
}

function manualCandidates(): readonly GraphAliasCandidate[] {
  return manualGraphAliasInventory().map((entry) => ({
    canonical: entry.canonical,
    alias: entry.alias,
    entityRole: entry.entityRole,
    aliasType: entry.aliasType,
    ownerSubject: entry.ownerSubject,
    confidence: entry.confidence,
    evidenceCount: 1,
    firstSeenAt: null,
    lastSeenAt: null,
    sourceUris: [],
    sourceQuotes: [],
    promotionStatus: "manual_seed",
    authoritative: true
  }));
}

function sourceMentionAliases(): readonly string[] {
  return [
    "Gumi",
    "Gummi",
    "Gumee",
    "Omi Gummi",
    "Ben",
    "Ben Williams",
    "Tim",
    "Dan",
    "Chiang Mai",
    "CMU",
    "Weave Artisan Society",
    "Canass Hotel",
    "Living a Dream",
    "Two Way",
    "Two-Way",
    "2Way",
    "Well Inked",
    "Preset Kitchen",
    "AI Brain"
  ];
}

function sourceMentionPattern(): string {
  return sourceMentionAliases().map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
}

function sourceMentionCanonical(alias: string): { readonly canonical: string; readonly role: GraphAliasEntityRole } {
  const manual = MANUAL_CANONICAL_OVERRIDES.get(normalizeKey(alias));
  if (manual) {
    return manual;
  }
  return { canonical: alias, role: /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/u.test(alias) ? "person" : "project" };
}

export async function buildGraphAliasLedger(namespaceId: string): Promise<readonly GraphAliasCandidate[]> {
  const candidates = new Map<string, GraphAliasCandidate>();
  for (const candidate of manualCandidates()) {
    addCandidate(candidates, candidate);
  }

  const entityRows = await queryRows<EntityAliasRow>(
    `
      SELECT
        e.canonical_name,
        e.entity_type,
        ea.alias,
        ea.alias_type,
        NULLIF(ea.evidence_count, 0) AS evidence_count,
        ea.created_at::text AS first_seen_at,
        ea.last_seen_at::text AS last_seen_at
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.namespace_id = $1
        AND lower(ea.alias) = ANY($2::text[])
      ORDER BY ea.last_seen_at DESC
      LIMIT 200
    `,
    [namespaceId, sourceMentionAliases().map((alias) => alias.toLowerCase())]
  );
  const roleResolutionMap = await loadEntityRoleResolutionMap(namespaceId);
  for (const row of entityRows) {
    const override = sourceMentionCanonical(row.alias);
    const role = override.role === "venue" ? "place" : override.role;
    const observedRole = canonicalRole(row.entity_type);
    const resolved = roleResolutionMap.get(normalizeKey(row.canonical_name));
    if (resolved && !resolved.resolvedRoles.includes(observedRole)) {
      continue;
    }
    if (role !== observedRole && !["org", "project"].includes(row.entity_type.toLowerCase())) {
      continue;
    }
    addCandidate(candidates, {
      canonical: override.canonical,
      alias: row.alias,
      entityRole: override.role,
      aliasType: "observed_entity_alias",
      ownerSubject: "Steve Tietze",
      confidence: row.alias_type === "manual" || row.alias_type === "derived" ? 0.9 : 0.82,
      evidenceCount: row.evidence_count ?? 1,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      sourceUris: [],
      sourceQuotes: [],
      promotionStatus: "candidate_review_required",
      authoritative: false
    });
  }

  const mentionRows = await queryRows<SourceMentionRow>(
    `
      WITH aliases AS (
        SELECT unnest($2::text[]) AS alias
      ),
      matches AS (
        SELECT
          aliases.alias,
          em.occurred_at,
          COALESCE(a.uri, '') AS source_uri,
          left(regexp_replace(em.content, '\\s+', ' ', 'g'), 320) AS quote
        FROM aliases
        JOIN episodic_memory em
          ON em.namespace_id = $1
         AND em.content ~* ('\\m' || regexp_replace(aliases.alias, '([\\W])', '\\\\\\1', 'g') || '\\M')
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
        LIMIT 500
      )
      SELECT
        alias,
        min(occurred_at)::text AS first_seen_at,
        max(occurred_at)::text AS last_seen_at,
        count(*)::text AS evidence_count,
        array_remove(array_agg(DISTINCT source_uri), '') AS source_uris,
        (array_agg(DISTINCT quote))[1:4] AS quotes
      FROM matches
      GROUP BY alias
    `,
    [namespaceId, sourceMentionAliases()]
  );
  for (const row of mentionRows) {
    const target = sourceMentionCanonical(row.alias);
    const evidenceCount = Number.parseInt(row.evidence_count, 10);
    addCandidate(candidates, {
      canonical: target.canonical,
      alias: row.alias,
      entityRole: target.role,
      aliasType: "source_cooccurrence",
      ownerSubject: "Steve Tietze",
      confidence: evidenceCount >= 2 ? 0.88 : 0.78,
      evidenceCount: Number.isFinite(evidenceCount) ? evidenceCount : 1,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      sourceUris: row.source_uris ?? [],
      sourceQuotes: row.quotes ?? [],
      promotionStatus: evidenceCount >= 2 ? "benchmarked_promotable" : "candidate_review_required",
      authoritative: false
    });
  }

  return [...candidates.values()].sort((left, right) =>
    left.entityRole.localeCompare(right.entityRole) ||
    left.canonical.localeCompare(right.canonical) ||
    left.alias.localeCompare(right.alias)
  );
}
