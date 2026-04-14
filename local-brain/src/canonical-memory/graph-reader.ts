import { queryRows } from "../db/client.js";
import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import type { CanonicalPredicateFamily, PairGraphPlan } from "../retrieval/types.js";

interface AliasRow {
  readonly normalized_alias_text: string;
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly confidence: number;
}

interface CanonicalSetRow {
  readonly id?: string;
  readonly subject_entity_id: string;
  readonly predicate_family: string;
  readonly item_values: unknown;
  readonly metadata: Record<string, unknown> | null;
}

interface CanonicalSetEntryRow {
  readonly canonical_set_id: string;
  readonly subject_entity_id: string;
  readonly normalized_value: string;
  readonly display_value: string;
  readonly value_type: string;
}

interface RelationshipNeighborRow {
  readonly subject_entity_id: string;
  readonly object_name: string;
}

interface PairNeighborhoodLookup {
  readonly bindingStatus: "resolved" | "ambiguous" | "unresolved";
  readonly subjectEntityIds: readonly string[];
  readonly subjectNames: readonly string[];
  readonly sharedValues: readonly string[];
  readonly relationshipJoinKinds: readonly string[];
  readonly reason: string;
}

interface PairAliasResolution {
  readonly resolved: Map<string, AliasRow>;
  readonly status: "resolved" | "ambiguous" | "unresolved";
}

function normalize(value: string | null | undefined): string {
  return normalizeEntityLookupName(String(value ?? ""));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

const COUNTRY_VALUES = new Set([
  "united states",
  "usa",
  "us",
  "canada",
  "mexico",
  "france",
  "germany",
  "italy",
  "spain",
  "thailand",
  "japan",
  "china",
  "india",
  "australia",
  "brazil",
  "argentina",
  "england",
  "united kingdom",
  "uk"
]);

function parseStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return [];
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function compatibilityKey(row: CanonicalSetRow): string {
  return [
    normalize(metadataString(row.metadata, "set_kind")),
    normalize(metadataString(row.metadata, "domain")),
    normalize(metadataString(row.metadata, "predicate")),
    normalize(metadataString(row.metadata, "media_kind")),
    normalize(metadataString(row.metadata, "mention_kind"))
  ].join("::");
}

function categoryLabels(row: CanonicalSetRow): readonly string[] {
  return uniqueStrings([
    metadataString(row.metadata, "domain"),
    metadataString(row.metadata, "predicate"),
    metadataString(row.metadata, "media_kind")
  ]).filter((value) => value.length >= 3);
}

function isCountryLike(value: string): boolean {
  const normalized = normalize(value);
  return COUNTRY_VALUES.has(normalized);
}

function filterSharedValuesForQuery(queryText: string, values: readonly string[]): readonly string[] {
  const normalizedQuery = normalize(queryText);
  if (values.length === 0) {
    return values;
  }
  if (/\bcountry\b/u.test(normalizedQuery)) {
    const filtered = values.filter((value) => isCountryLike(value));
    return filtered.length > 0 ? filtered : values;
  }
  if (/\bsymbolic gifts?\b|\bgifts?\b/u.test(normalizedQuery)) {
    const filtered = values.filter((value) => /\bpendants?\b|\bnecklace\b|\blocking?\b|\bbracelet\b|\bgift\b|\bkeepsake\b/u.test(value));
    return filtered.length > 0 ? filtered : values;
  }
  if (/\bplanned to meet at\b|\bplaces or events\b|\bmeet at\b/u.test(normalizedQuery)) {
    const filtered = values.filter((value) =>
      /\b(cafe|restaurant|park|beach|festival|concert|conference|museum|stadium|arena|mall|market|lake|event|show)\b/i.test(value) ||
      /[A-Z][a-z]+/.test(value)
    );
    return filtered.length > 0 ? filtered : values;
  }
  return values;
}

function intersectEntryRows(rowsBySubject: readonly (readonly CanonicalSetEntryRow[])[], queryText: string): readonly string[] {
  if (rowsBySubject.length < 2 || rowsBySubject.some((rows) => rows.length === 0)) {
    return [];
  }
  const requestedType =
    /\bcountry\b/u.test(normalize(queryText))
      ? "country"
      : /\bsymbolic gifts?\b|\bgifts?\b/u.test(normalize(queryText))
        ? "gift"
        : /\bplanned to meet at\b|\bplaces or events\b|\bmeet at\b/u.test(normalize(queryText))
          ? "venue"
          : null;
  const grouped = rowsBySubject.map((rows) => {
    const values = requestedType ? rows.filter((row) => row.value_type === requestedType) : rows;
    return new Map(values.map((row) => [row.normalized_value, row.display_value]));
  });
  const sharedKeys = [...grouped[0]!.keys()].filter((value) => grouped.every((subjectRows) => subjectRows.has(value)));
  if (sharedKeys.length === 0) {
    return [];
  }
  return sharedKeys.map((key) => grouped[0]!.get(key) ?? key);
}

function intersectRows(rowsBySubject: readonly (readonly CanonicalSetRow[])[]): readonly string[] {
  if (rowsBySubject.length < 2 || rowsBySubject.some((rows) => rows.length === 0)) {
    return [];
  }
  const grouped = rowsBySubject.map((rows) => {
    const byKey = new Map<string, CanonicalSetRow[]>();
    for (const row of rows) {
      const key = compatibilityKey(row);
      const bucket = byKey.get(key) ?? [];
      bucket.push(row);
      byKey.set(key, bucket);
    }
    return byKey;
  });
  const sharedKeys = [...grouped[0]!.keys()].filter((key) => grouped.every((subjectRows) => subjectRows.has(key)));
  const exact = new Map<string, string>();
  const category = new Map<string, string>();
  for (const key of sharedKeys) {
    const exactSets = grouped.map((subjectRows) => {
      const values = (subjectRows.get(key) ?? []).flatMap((row) => parseStringArray(row.item_values));
      return new Map(values.map((value) => [normalize(value), value]));
    });
    const exactKeys = [...exactSets[0]!.keys()].filter((value) => exactSets.every((setMap) => setMap.has(value)));
    for (const exactKey of exactKeys) {
      exact.set(exactKey, exactSets[0]!.get(exactKey) ?? exactKey);
    }
    const categorySets = grouped.map((subjectRows) => {
      const values = (subjectRows.get(key) ?? []).flatMap((row) => categoryLabels(row));
      return new Map(values.map((value) => [normalize(value), value]));
    });
    const categoryKeys = [...categorySets[0]!.keys()].filter((value) => categorySets.every((setMap) => setMap.has(value)));
    for (const categoryKey of categoryKeys) {
      category.set(categoryKey, categorySets[0]!.get(categoryKey) ?? categoryKey);
    }
  }
  return exact.size > 0 ? [...exact.values()] : [...category.values()];
}

async function resolveSubjects(namespaceId: string, subjectNames: readonly string[]): Promise<PairNeighborhoodLookup> {
  const normalizedNames = uniqueStrings(subjectNames.map(normalize).filter(Boolean));
  if (normalizedNames.length < 2) {
    return {
      bindingStatus: "unresolved",
      subjectEntityIds: [],
      subjectNames: [],
      sharedValues: [],
      relationshipJoinKinds: [],
      reason: "Pair neighborhood lookup requires two names."
    };
  }

  const aliasRows = await queryRows<AliasRow>(
    `
      SELECT
        csa.normalized_alias_text,
        csa.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        MAX(csa.confidence) AS confidence
      FROM canonical_subject_aliases csa
      JOIN canonical_subjects cs
        ON cs.namespace_id = csa.namespace_id
       AND cs.entity_id = csa.subject_entity_id
      WHERE csa.namespace_id = $1
        AND csa.normalized_alias_text = ANY($2::text[])
      GROUP BY csa.normalized_alias_text, csa.subject_entity_id, cs.canonical_name
      ORDER BY MAX(csa.confidence) DESC, cs.canonical_name ASC
    `,
    [namespaceId, normalizedNames]
  );

  const resolution = resolvePairSubjectsFromAliasRows(normalizedNames, aliasRows);
  if (resolution.resolved.size < 2) {
    return {
      bindingStatus: resolution.status,
      subjectEntityIds: [],
      subjectNames: uniqueStrings(aliasRows.map((row) => row.canonical_name)),
      sharedValues: [],
      relationshipJoinKinds: [],
      reason: "Pair neighborhood lookup could not resolve both canonical subjects cleanly."
    };
  }

  return {
    bindingStatus: "resolved",
    subjectEntityIds: [...resolution.resolved.values()].map((row) => row.subject_entity_id),
    subjectNames: [...resolution.resolved.values()].map((row) => row.canonical_name),
    sharedValues: [],
    relationshipJoinKinds: [],
    reason: "Pair neighborhood subjects resolved from canonical aliases."
  };
}

export function resolvePairSubjectsFromAliasRows(
  normalizedNames: readonly string[],
  aliasRows: readonly AliasRow[]
): PairAliasResolution {
  const resolved = new Map<string, AliasRow>();
  for (const normalizedName of normalizedNames) {
    const aliasMatches = aliasRows.filter((row) => row.normalized_alias_text === normalizedName);
    const exactCanonicalMatches = aliasMatches.filter((row) => normalize(row.canonical_name) === normalizedName);
    if (exactCanonicalMatches.length === 1) {
      resolved.set(normalizedName, exactCanonicalMatches[0]!);
      continue;
    }
    if (aliasMatches.length === 1) {
      resolved.set(normalizedName, aliasMatches[0]!);
      continue;
    }
    const top = aliasMatches[0] ?? null;
    const second = aliasMatches[1] ?? null;
    if (top && top.confidence >= 0.8 && (!second || top.confidence - second.confidence >= 0.1)) {
      resolved.set(normalizedName, top);
    }
  }
  return {
    resolved,
    status: aliasRows.length === 0 ? "unresolved" : resolved.size >= 2 ? "resolved" : "ambiguous"
  };
}

export async function lookupCanonicalPairNeighborhood(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly subjectNames: readonly string[];
}): Promise<PairNeighborhoodLookup> {
  const resolved = await resolveSubjects(params.namespaceId, params.subjectNames);
  if (resolved.bindingStatus !== "resolved") {
    return resolved;
  }

  const setRows = await Promise.all(
    resolved.subjectEntityIds.map((subjectEntityId) =>
      queryRows<CanonicalSetRow>(
        `
          SELECT
            id::text AS id,
            subject_entity_id::text AS subject_entity_id,
            predicate_family,
            item_values,
            metadata
          FROM canonical_sets
          WHERE namespace_id = $1
            AND subject_entity_id = $2::uuid
          ORDER BY created_at DESC
        `,
        [params.namespaceId, subjectEntityId]
      )
    )
  );
  const setEntryRows = await Promise.all(
    resolved.subjectEntityIds.map((subjectEntityId) =>
      queryRows<CanonicalSetEntryRow>(
        `
          SELECT
            cse.canonical_set_id::text AS canonical_set_id,
            cse.subject_entity_id::text AS subject_entity_id,
            cse.normalized_value,
            cse.display_value,
            cse.value_type
          FROM canonical_set_entries cse
          WHERE cse.namespace_id = $1
            AND cse.subject_entity_id = $2::uuid
          ORDER BY cse.created_at DESC, cse.entry_index ASC
        `,
        [params.namespaceId, subjectEntityId]
      )
    )
  );
  const sharedSetValues = intersectRows(setRows);
  const sharedEntryValues = intersectEntryRows(setEntryRows, params.queryText);

  const relationshipRows = await queryRows<RelationshipNeighborRow>(
    `
      SELECT
        rm.subject_entity_id::text AS subject_entity_id,
        object_root.canonical_name AS object_name
      FROM relationship_memory rm
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      JOIN entities object_root ON object_root.id = COALESCE(object_entity.merged_into_entity_id, object_entity.id)
      WHERE rm.namespace_id = $1
        AND rm.subject_entity_id = ANY($2::uuid[])
      ORDER BY rm.created_at DESC
    `,
    [params.namespaceId, resolved.subjectEntityIds]
  );
  const neighborCounts = new Map<string, number>();
  for (const row of relationshipRows) {
    const key = normalize(row.object_name);
    neighborCounts.set(key, (neighborCounts.get(key) ?? 0) + 1);
  }
  const sharedNeighbors = [...neighborCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([name]) => relationshipRows.find((row) => normalize(row.object_name) === name)?.object_name ?? name);
  const filteredSharedValues = filterSharedValuesForQuery(
    params.queryText,
    uniqueStrings([...sharedEntryValues, ...sharedSetValues, ...sharedNeighbors])
  );

  return {
    bindingStatus: "resolved",
    subjectEntityIds: resolved.subjectEntityIds,
    subjectNames: resolved.subjectNames,
    sharedValues: filteredSharedValues,
    relationshipJoinKinds: sharedNeighbors.length > 0 ? ["relationship_memory"] : ["canonical_sets"],
    reason: "Pair neighborhood lookup resolved through canonical set intersection and relationship neighbors."
  };
}

export function asPairGraphPlan(result: PairNeighborhoodLookup): PairGraphPlan {
  return {
    pairPlanUsed: result.subjectEntityIds.length >= 2,
    subjectEntityIds: result.subjectEntityIds,
    subjectNames: result.subjectNames,
    sharedNeighborhoodValues: result.sharedValues,
    relationshipJoinKinds: result.relationshipJoinKinds,
    exclusionApplied: true,
    reason: result.reason
  };
}
