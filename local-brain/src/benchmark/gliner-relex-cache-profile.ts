import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compilerCacheKey } from "../taxonomy-temporal/compiler-cache.js";
import { GLINER_RELEX_MODEL_ID, GLINER_RELEX_SCHEMA_VERSION } from "../relationships/relex-schema.js";

function rootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

export async function runGlinerRelexCacheProfile(): Promise<{
  readonly generatedAt: string;
  readonly mode: "cache_profile";
  readonly keyChanges: Readonly<Record<string, boolean>>;
  readonly passed: boolean;
  readonly artifactPath: string;
}> {
  const base = {
    cacheScope: "relation_ie_scene" as const,
    namespaceId: "cache-profile",
    sourceText: "Audrey prefers chicken and Calvin bought a Ferrari.",
    sourceType: "narrative_scene",
    relationIeMode: "support_and_promote",
    extractorSignature: `gliner_relex_v1:${GLINER_RELEX_MODEL_ID}:${GLINER_RELEX_SCHEMA_VERSION}:0.45:0.45`,
    taxonomyVersion: "memory_taxonomy_v1",
    temporalVersion: "temporal_semantic_v1",
    assistantModelId: null,
    gliner2ModelId: GLINER_RELEX_MODEL_ID,
    schemaVersion: `external_relation_ie_scene_cache_v2:${GLINER_RELEX_SCHEMA_VERSION}`,
    promptVersion: "relation_ie_sidecar_v2"
  };
  const baseKey = compilerCacheKey(base).cacheKey;
  const keyChanges = {
    modelId: compilerCacheKey({ ...base, extractorSignature: base.extractorSignature.replace(GLINER_RELEX_MODEL_ID, "different/model") }).cacheKey !== baseKey,
    relationLabels: compilerCacheKey({ ...base, extractorSignature: `${base.extractorSignature}:labels=v2` }).cacheKey !== baseKey,
    thresholds: compilerCacheKey({ ...base, extractorSignature: base.extractorSignature.replace(":0.45:0.45", ":0.55:0.45") }).cacheKey !== baseKey,
    schemaVersion: compilerCacheKey({ ...base, schemaVersion: "external_relation_ie_scene_cache_v2:relex_relation_schema_v2" }).cacheKey !== baseKey,
    taxonomyVersion: compilerCacheKey({ ...base, taxonomyVersion: "memory_taxonomy_v2" }).cacheKey !== baseKey,
    sourceHash: compilerCacheKey({ ...base, sourceText: "Audrey prefers fish and Calvin bought a Ferrari." }).cacheKey !== baseKey
  };
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "cache_profile" as const,
    keyChanges,
    passed: Object.values(keyChanges).every(Boolean),
    artifactPath: ""
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const artifactPath = path.join(outputDir(), `gliner-relex-cache-profile-${stamp}.json`);
  const fullReport = { ...report, artifactPath };
  await writeFile(artifactPath, `${JSON.stringify(fullReport, null, 2)}\n`, "utf8");
  return fullReport;
}

