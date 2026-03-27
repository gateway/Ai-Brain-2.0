import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { readConfig } from "../config.js";

interface SceneSidecarInput {
  readonly sceneIndex: number;
  readonly sceneId: string;
  readonly text: string;
  readonly occurredAt: string;
  readonly sourceMemoryId: string | null;
  readonly sourceChunkId: string | null;
}

interface SidecarEntity {
  readonly text?: string;
  readonly label?: string;
  readonly score?: number;
  readonly start?: number;
  readonly end?: number;
}

interface SidecarRelation {
  readonly source?: string;
  readonly target?: string;
  readonly relation?: string;
  readonly score?: number;
  readonly relationship_kind?: string;
  readonly start?: number;
  readonly end?: number;
}

interface SidecarExtractorResult {
  readonly extractor: string;
  readonly model_id?: string;
  readonly schema_version?: string;
  readonly thresholds?: Record<string, number>;
  readonly entities?: readonly SidecarEntity[];
  readonly relations?: readonly SidecarRelation[];
  readonly warnings?: readonly string[];
}

interface SidecarSceneResult {
  readonly scene_index: number;
  readonly extractors: readonly SidecarExtractorResult[];
}

interface SidecarResponse {
  readonly scenes: readonly SidecarSceneResult[];
  readonly errors?: readonly string[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function repoRoot(): string {
  return path.resolve(thisDir(), "../../..");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeName(value: string): string {
  return normalizeWhitespace(value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")).toLowerCase();
}

function mapEntityType(label: string | undefined): "person" | "place" | "org" | "project" | "media" | null {
  const normalized = normalizeWhitespace((label ?? "").split(/::|:/u)[0] ?? "").toLowerCase();
  if (["person", "per"].includes(normalized)) {
    return "person";
  }
  if (["place", "location", "city", "country", "gpe", "loc"].includes(normalized)) {
    return "place";
  }
  if (["org", "organization", "organisation", "company"].includes(normalized)) {
    return "org";
  }
  if (["project"].includes(normalized)) {
    return "project";
  }
  if (["media", "movie", "film", "work_of_art"].includes(normalized)) {
    return "media";
  }
  return null;
}

function inferEntityTypesFromPredicate(
  predicate: string
): { readonly source: "person" | "place" | "org" | "project" | "media" | null; readonly target: "person" | "place" | "org" | "project" | "media" | null } {
  switch (predicate) {
    case "friend_of":
    case "works_with":
    case "sibling_of":
    case "was_with":
      return { source: "person", target: "person" };
    case "works_at":
    case "worked_at":
    case "member_of":
      return { source: "person", target: "org" };
    case "works_on":
      return { source: "person", target: "project" };
    case "lives_in":
    case "lived_in":
      return { source: "person", target: "place" };
    case "met_through":
      return { source: "person", target: "org" };
    default:
      return { source: null, target: null };
  }
}

function mapPredicate(relation: string | undefined): { predicate: string; metadata: Record<string, unknown> } | null {
  const normalized = normalizeWhitespace((relation ?? "").split(/::|:/u)[0] ?? "").toLowerCase();
  if (!normalized) {
    return null;
  }

  const metadata: Record<string, unknown> = {};
  if (["friend of", "friend", "friends with"].includes(normalized)) {
    return { predicate: "friend_of", metadata };
  }
  if (["works with", "coworker of", "collaborates with"].includes(normalized)) {
    return { predicate: "works_with", metadata };
  }
  if (["works at", "employed by"].includes(normalized)) {
    return { predicate: "works_at", metadata };
  }
  if (["worked at", "previously worked at"].includes(normalized)) {
    return { predicate: "worked_at", metadata };
  }
  if (["works on", "working on"].includes(normalized)) {
    return { predicate: "works_on", metadata };
  }
  if (["member of"].includes(normalized)) {
    return { predicate: "member_of", metadata };
  }
  if (["met through"].includes(normalized)) {
    return { predicate: "met_through", metadata };
  }
  if (["sibling of", "brother of", "sister of"].includes(normalized)) {
    return { predicate: "sibling_of", metadata };
  }
  if (["lives in", "resides in", "currently in"].includes(normalized)) {
    return { predicate: "lives_in", metadata };
  }
  if (["lived in", "used to live in"].includes(normalized)) {
    return { predicate: "lived_in", metadata };
  }
  if (["romantic partner of", "partner of", "dating", "dated", "girlfriend of", "boyfriend of"].includes(normalized)) {
    metadata.relationship_kind = "romantic";
    return { predicate: "was_with", metadata };
  }
  return null;
}

async function upsertEntity(
  client: PoolClient,
  namespaceId: string,
  entityType: string,
  canonicalName: string,
  aliases: readonly string[],
  metadata: Record<string, unknown>
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO entities (
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        last_seen_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, now(), $5::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id
    `,
    [namespaceId, entityType, canonicalName, normalizeName(canonicalName), JSON.stringify(metadata)]
  );

  const entityId = result.rows[0]?.id;
  if (!entityId) {
    throw new Error(`Failed to upsert external IE entity ${canonicalName}`);
  }

  const uniqueAliases = [...new Set([canonicalName, ...aliases].map((value) => normalizeWhitespace(value)).filter(Boolean))];
  for (const alias of uniqueAliases) {
    await client.query(
      `
        INSERT INTO entity_aliases (
          entity_id,
          alias,
          normalized_alias,
          metadata
        )
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (entity_id, normalized_alias)
        DO NOTHING
      `,
      [entityId, alias, normalizeName(alias), JSON.stringify({ source: "external_relation_ie" })]
    );
  }

  return entityId;
}

async function runSidecar(request: {
  readonly scenes: readonly SceneSidecarInput[];
}): Promise<SidecarResponse> {
  const config = readConfig();
  const cwd = repoRoot();

  const payload = {
    device: config.relationIeDevice,
    extractors: config.relationIeExtractors,
    entity_labels: config.relationIeEntityLabels,
    relation_labels: config.relationIeRelationLabels,
    entity_descriptions: config.relationIeEntityDescriptions,
    relation_descriptions: config.relationIeRelationDescriptions,
    thresholds: {
      entity: config.relationIeEntityThreshold,
      adjacency: config.relationIeAdjacencyThreshold,
      relation: config.relationIeRelationThreshold
    },
    models: {
      gliner_relex: config.relationIeGlinerRelexModel,
      gliner2: config.relationIeGliner2Model,
      spacy: config.relationIeSpacyModel,
      span_marker: config.relationIeSpanMarkerModel
    },
    scenes: request.scenes.map((scene) => ({
      scene_index: scene.sceneIndex,
      text: scene.text
    }))
  };

  return new Promise((resolve, reject) => {
    const child = spawn(config.relationIePythonExecutable, [config.relationIeScriptPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`relation-ie sidecar exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as SidecarResponse);
      } catch (error) {
        reject(new Error(`relation-ie sidecar returned invalid JSON: ${String(error)}\n${stdout}`));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function stageExternalRelationCandidatesForScenes(
  client: PoolClient,
  input: {
    readonly namespaceId: string;
    readonly scenes: readonly SceneSidecarInput[];
  }
): Promise<{ readonly stagedCount: number; readonly warningCount: number }> {
  const config = readConfig();
  if (!config.relationIeEnabled || input.scenes.length === 0) {
    return { stagedCount: 0, warningCount: 0 };
  }

  const response = await runSidecar(input);
  const byScene = new Map<number, SceneSidecarInput>(input.scenes.map((scene) => [scene.sceneIndex, scene]));
  let stagedCount = 0;
  let warningCount = 0;

  for (const sceneResult of response.scenes) {
    const scene = byScene.get(sceneResult.scene_index);
    if (!scene) {
      continue;
    }

    const entityCache = new Map<string, { id: string; type: string }>();
    const rawEntityByName = new Map<string, { type: string | null; score: number | null; start: number | null; end: number | null; rawLabel: string | null }>();
    for (const extractor of sceneResult.extractors) {
      warningCount += extractor.warnings?.length ?? 0;
      for (const entity of extractor.entities ?? []) {
        const entityText = normalizeWhitespace(entity.text ?? "");
        if (!entityText) {
          continue;
        }
        const entityType = mapEntityType(entity.label);
        rawEntityByName.set(normalizeName(entityText), {
          type: entityType,
          score: typeof entity.score === "number" ? entity.score : null,
          start: typeof entity.start === "number" ? entity.start : null,
          end: typeof entity.end === "number" ? entity.end : null,
          rawLabel: typeof entity.label === "string" ? entity.label : null
        });
        if (!entityType) {
          continue;
        }
        const cacheKey = `${entityType}:${normalizeName(entityText)}`;
        if (!entityCache.has(cacheKey)) {
          const entityId = await upsertEntity(client, input.namespaceId, entityType, entityText, [entityText], {
            extractor: extractor.extractor,
            model_id: extractor.model_id ?? null,
            schema_version: extractor.schema_version ?? "relation_ie_v1",
            thresholds: extractor.thresholds ?? null,
            external_ie: true
          });
          entityCache.set(cacheKey, { id: entityId, type: entityType });
        }
      }

      for (const relation of extractor.relations ?? []) {
        const sourceText = normalizeWhitespace(relation.source ?? "");
        const targetText = normalizeWhitespace(relation.target ?? "");
        const predicate = mapPredicate(relation.relation);
        if (!sourceText || !targetText || !predicate) {
          continue;
        }

        const inferredTypes = inferEntityTypesFromPredicate(predicate.predicate);
        const sourceObserved = rawEntityByName.get(normalizeName(sourceText));
        const targetObserved = rawEntityByName.get(normalizeName(targetText));
        const sourceTypeHint = sourceObserved?.type ?? inferredTypes.source;
        const targetTypeHint = targetObserved?.type ?? inferredTypes.target;

        if (sourceTypeHint && !entityCache.has(`${sourceTypeHint}:${normalizeName(sourceText)}`)) {
          const sourceId = await upsertEntity(client, input.namespaceId, sourceTypeHint, sourceText, [sourceText], {
            extractor: extractor.extractor,
            model_id: extractor.model_id ?? null,
            schema_version: extractor.schema_version ?? "relation_ie_v1",
            thresholds: extractor.thresholds ?? null,
            external_ie: true,
            inferred_from_relation: true,
            raw_label: sourceObserved?.rawLabel ?? "other",
            span_start: sourceObserved?.start ?? null,
            span_end: sourceObserved?.end ?? null
          });
          entityCache.set(`${sourceTypeHint}:${normalizeName(sourceText)}`, { id: sourceId, type: sourceTypeHint });
        }

        if (targetTypeHint && !entityCache.has(`${targetTypeHint}:${normalizeName(targetText)}`)) {
          const targetId = await upsertEntity(client, input.namespaceId, targetTypeHint, targetText, [targetText], {
            extractor: extractor.extractor,
            model_id: extractor.model_id ?? null,
            schema_version: extractor.schema_version ?? "relation_ie_v1",
            thresholds: extractor.thresholds ?? null,
            external_ie: true,
            inferred_from_relation: true,
            raw_label: targetObserved?.rawLabel ?? "other",
            span_start: targetObserved?.start ?? null,
            span_end: targetObserved?.end ?? null
          });
          entityCache.set(`${targetTypeHint}:${normalizeName(targetText)}`, { id: targetId, type: targetTypeHint });
        }

        const sourceCandidate =
          entityCache.get(`person:${normalizeName(sourceText)}`) ??
          entityCache.get(`org:${normalizeName(sourceText)}`) ??
          entityCache.get(`project:${normalizeName(sourceText)}`) ??
          entityCache.get(`place:${normalizeName(sourceText)}`) ??
          entityCache.get(`media:${normalizeName(sourceText)}`);
        const targetCandidate =
          entityCache.get(`person:${normalizeName(targetText)}`) ??
          entityCache.get(`org:${normalizeName(targetText)}`) ??
          entityCache.get(`project:${normalizeName(targetText)}`) ??
          entityCache.get(`place:${normalizeName(targetText)}`) ??
          entityCache.get(`media:${normalizeName(targetText)}`);

        if (!sourceCandidate || !targetCandidate || sourceCandidate.id === targetCandidate.id) {
          continue;
        }

        const confidence = Math.max(0.4, Math.min(typeof relation.score === "number" ? relation.score : 0.6, 0.95));
        const priorScore = Math.max(0.5, Math.min(confidence - 0.05, 0.9));

        await client.query(
          `
            INSERT INTO relationship_candidates (
              namespace_id,
              subject_entity_id,
              predicate,
              object_entity_id,
              source_scene_id,
              source_memory_id,
              source_chunk_id,
              confidence,
              prior_score,
              prior_reason,
              status,
              valid_from,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12::jsonb)
            ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
            DO UPDATE SET
              confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
              prior_score = GREATEST(relationship_candidates.prior_score, EXCLUDED.prior_score),
              prior_reason = COALESCE(relationship_candidates.prior_reason, EXCLUDED.prior_reason),
              metadata = relationship_candidates.metadata || EXCLUDED.metadata
          `,
          [
            input.namespaceId,
            sourceCandidate.id,
            predicate.predicate,
            targetCandidate.id,
            scene.sceneId,
            scene.sourceMemoryId,
            scene.sourceChunkId,
            confidence,
            priorScore,
            `external_relation_ie:${extractor.extractor}`,
            scene.occurredAt,
            JSON.stringify({
              extractor: extractor.extractor,
              model_id: extractor.model_id ?? null,
              external_ie: true,
              schema_version: extractor.schema_version ?? "relation_ie_v1",
              thresholds: extractor.thresholds ?? null,
              raw_relation: relation.relation ?? null,
              raw_source: sourceText,
              raw_target: targetText,
              raw_source_label: sourceObserved?.rawLabel ?? null,
              raw_target_label: targetObserved?.rawLabel ?? null,
              raw_source_start: sourceObserved?.start ?? null,
              raw_source_end: sourceObserved?.end ?? null,
              raw_target_start: targetObserved?.start ?? null,
              raw_target_end: targetObserved?.end ?? null,
              raw_relation_start: typeof relation.start === "number" ? relation.start : null,
              raw_relation_end: typeof relation.end === "number" ? relation.end : null,
              relation_score: confidence,
              ...predicate.metadata
            })
          ]
        );
        stagedCount += 1;
      }
    }
  }

  return { stagedCount, warningCount };
}

export async function runExternalRelationExtractionShadow(
  scenes: readonly { readonly sceneIndex: number; readonly text: string }[]
): Promise<SidecarResponse> {
  return runSidecar({
    scenes: scenes.map((scene) => ({
      sceneIndex: scene.sceneIndex,
      sceneId: `shadow:${scene.sceneIndex}`,
      text: scene.text,
      occurredAt: new Date().toISOString(),
      sourceMemoryId: null,
      sourceChunkId: null
    }))
  });
}
