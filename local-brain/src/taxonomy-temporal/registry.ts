import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import type { AssistantCandidate, TaxonomyRegistry, TaxonomyStatus, ValidationIssue } from "./types.js";

function moduleRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export async function loadMemoryTaxonomyRegistry(version = "memory_taxonomy.v1.json"): Promise<TaxonomyRegistry> {
  const filePath = path.resolve(moduleRoot(), "config/taxonomy", version);
  return JSON.parse(await readFile(filePath, "utf8")) as TaxonomyRegistry;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeKey(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

export function allowedTaxonomyPayload(registry: TaxonomyRegistry): {
  readonly object_types: readonly string[];
  readonly domains: readonly string[];
  readonly families: readonly string[];
  readonly subtypes_by_family: Readonly<Record<string, readonly string[]>>;
} {
  return {
    object_types: registry.core_object_types,
    domains: Object.keys(registry.domains),
    families: Object.keys(registry.families),
    subtypes_by_family: Object.fromEntries(
      Object.entries(registry.families).map(([family, entry]) => [family, entry.subtypes])
    )
  };
}

export function compactAllowedTaxonomyPayload(
  registry: TaxonomyRegistry,
  unitText: string
): {
  readonly object_types: readonly string[];
  readonly domains: readonly string[];
  readonly families: readonly string[];
  readonly subtypes_by_family: Readonly<Record<string, readonly string[]>>;
} {
  const text = unitText.toLowerCase();
  const families = new Set<string>([
    "current_state",
    "temporal_event",
    "task_status",
    "task_due",
    "project_support",
    "venue",
    "duration",
    "role",
    "health_status",
    "unclassified_observation"
  ]);
  const domains = new Set<string>(["personal", "task_ops", "project_ops", "daily_life", "unknown"]);

  const add = (domain: string, family: string): void => {
    if (registry.domains[domain]) {
      domains.add(domain);
    }
    if (registry.families[family]) {
      families.add(family);
    }
  };

  if (/\b(?:mbps|gbps|kbps|gb|mb|capacity|storage)\b/u.test(text)) {
    add("technical", "speed");
    add("technical", "capacity");
  }
  if (/\b(?:diagnosed|adhd|anxiety|health|sick|therapy|medical)\b/u.test(text)) {
    add("health", "health_status");
    add("health", "support_or_care");
  }
  if (/\b(?:school|university|ucla|degree|certification|course|program|melbourne)\b/u.test(text)) {
    add("education", "venue");
    add("education", "credential");
    add("education", "completed_on");
  }
  if (/\b(?:shop|store|retailer|ikea|amazon|target|bought|purchased|acquired)\b/u.test(text)) {
    add("personal", "owns");
    add("personal", "purchase");
    add("personal", "venue");
  }
  if (/\b(?:favorite|prefer|prefers|preferred|likes|loves|collects|collection|list|none)\b/u.test(text)) {
    add("personal", "preference");
    add("personal", "explicit_list_set");
    add("media", "preference");
    add("media", "explicit_list_set");
  }
  if (/\b(?:married|single|divorced|engaged|spouse|partner|husband|wife|relationship status)\b/u.test(text)) {
    add("family", "relationship_status");
  }
  if (/\b(?:because|reason|why|lost job|decided|started|business|store)\b/u.test(text)) {
    add("project_ops", "causal_reason");
  }
  if (/\b(?:dream|goal|project|unique|feature|app|business|self-care|self care)\b/u.test(text)) {
    add("project_ops", "project_support");
  }
  if (/\b(?:live|lives|living|reside|resides|moved|settled)\b/u.test(text)) {
    add("travel", "lives_in");
  }
  if (/\b(?:role|job|worked|marketing|cto|advisor|adviser|engineer|manager)\b/u.test(text)) {
    add("work", "role");
    add("work", "current_state");
  }
  if (/\b(?:trip|travel|moved|left|arrived|visited|duration|weeks?|months?|years?|ago|after)\b/u.test(text)) {
    add("travel", "temporal_event");
    add("travel", "visited");
    add("travel", "venue");
  }

  return {
    object_types: registry.core_object_types,
    domains: [...domains].filter((domain) => Boolean(registry.domains[domain])),
    families: [...families].filter((family) => Boolean(registry.families[family])),
    subtypes_by_family: Object.fromEntries(
      [...families]
        .filter((family) => Boolean(registry.families[family]))
        .map((family) => [family, registry.families[family]?.subtypes ?? []])
    )
  };
}

export function validateCandidateTaxonomy(
  registry: TaxonomyRegistry,
  candidate: AssistantCandidate,
  candidateIndex: number
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const objectType = normalizeKey(candidate.object_type);
  const domain = normalizeKey(candidate.domain);
  const family = normalizeKey(candidate.family);
  const subtype = normalizeKey(candidate.subtype);
  const status = normalizeKey(candidate.taxonomy_status) as TaxonomyStatus | null;

  if (!objectType || !registry.core_object_types.includes(objectType)) {
    issues.push({ code: "unknown_object_type", message: `Unknown object_type: ${objectType ?? "null"}`, candidateIndex });
  }
  if (!domain || !Object.prototype.hasOwnProperty.call(registry.domains, domain)) {
    issues.push({ code: "unknown_domain", message: `Unknown domain: ${domain ?? "null"}`, candidateIndex });
  }
  if (!family || !Object.prototype.hasOwnProperty.call(registry.families, family)) {
    issues.push({ code: "unknown_family", message: `Unknown family: ${family ?? "null"}`, candidateIndex });
  }
  if (status && !registry.statuses.includes(status)) {
    issues.push({ code: "unknown_taxonomy_status", message: `Unknown taxonomy_status: ${status}`, candidateIndex });
  }
  if (subtype && family && !registry.families[family]?.subtypes.includes(subtype)) {
    issues.push({ code: "unknown_subtype", message: `Unknown subtype ${subtype} for family ${family}`, candidateIndex });
  }
  if (domain && family && registry.domains[domain] && !registry.domains[domain].families.includes(family)) {
    issues.push({
      code: "domain_family_mismatch",
      message: `Family ${family} is not approved for domain ${domain}.`,
      candidateIndex
    });
  }
  if (status !== "needs_taxonomy_review" && status !== "diagnostic_only") {
    const suggested = candidate.suggested_taxonomy;
    if (suggested?.key && !issues.some((issue) => issue.code === "unknown_family" || issue.code === "unknown_subtype")) {
      issues.push({
        code: "suggested_taxonomy_authoritative_risk",
        message: "Suggested taxonomy is present on an otherwise promotable candidate.",
        candidateIndex
      });
    }
  }
  return issues;
}

export function candidateHasReviewOnlySuggestion(candidate: AssistantCandidate): boolean {
  const key = normalizeKey(candidate.suggested_taxonomy?.key);
  const status = normalizeKey(candidate.taxonomy_status);
  return Boolean(key) && (status === "needs_taxonomy_review" || status === "diagnostic_only" || status === "generic_reviewable");
}

export async function persistTaxonomyReviewItemForClient(
  client: PoolClient,
  params: {
    readonly namespaceId: string;
    readonly registry: TaxonomyRegistry;
    readonly candidate: AssistantCandidate;
    readonly evidenceQuote: string;
    readonly sourceKey: string;
  }
): Promise<void> {
  const suggested = params.candidate.suggested_taxonomy;
  const suggestedKey = normalizeKey(suggested?.key);
  if (!suggestedKey) {
    return;
  }
  await client.query(
    `
      INSERT INTO taxonomy_review_items (
        namespace_id,
        taxonomy_version,
        suggested_key,
        suggested_label,
        proposed_domain,
        proposed_family,
        proposed_subtype,
        mapped_domain,
        mapped_family,
        mapped_subtype,
        example_evidence,
        reason,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      ON CONFLICT (namespace_id, taxonomy_version, suggested_key)
      DO UPDATE SET
        evidence_count = taxonomy_review_items.evidence_count + 1,
        distinct_source_count = taxonomy_review_items.distinct_source_count + CASE
          WHEN taxonomy_review_items.metadata->'source_keys' ? $14 THEN 0
          ELSE 1
        END,
        example_evidence = COALESCE(taxonomy_review_items.example_evidence, EXCLUDED.example_evidence),
        reason = COALESCE(taxonomy_review_items.reason, EXCLUDED.reason),
        metadata = jsonb_set(
          taxonomy_review_items.metadata || EXCLUDED.metadata,
          '{source_keys}',
          COALESCE(taxonomy_review_items.metadata->'source_keys', '[]'::jsonb) || to_jsonb($14::text),
          true
        ),
        updated_at = now()
    `,
    [
      params.namespaceId,
      params.registry.version,
      suggestedKey,
      normalizeKey(suggested?.label),
      normalizeKey(params.candidate.domain),
      normalizeKey(params.candidate.family),
      normalizeKey(params.candidate.subtype),
      normalizeKey(params.candidate.domain),
      normalizeKey(params.candidate.family),
      normalizeKey(params.candidate.subtype),
      params.evidenceQuote,
      normalizeKey(suggested?.reason),
      JSON.stringify({
        source_keys: [params.sourceKey],
        candidate_type: params.candidate.candidate_type ?? null,
        tags: params.candidate.tags ?? []
      }),
      params.sourceKey
    ]
  );
}
