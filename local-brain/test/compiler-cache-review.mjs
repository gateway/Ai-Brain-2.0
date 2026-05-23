import assert from "node:assert/strict";
import test from "node:test";
import { loadCompilerCacheEntry } from "../dist/taxonomy-temporal/compiler-cache.js";

const IDENTITY = {
  cacheScope: "relation_ie_scene",
  namespaceId: "personal",
  sourceText: "John Carmack was starting to work on the editor for PC.",
  sourceType: "narrative_scene",
  relationIeMode: "support_and_promote",
  extractorSignature: "gliner2:test",
  taxonomyVersion: "memory_taxonomy_v1",
  temporalVersion: "temporal_semantic_v1",
  assistantModelId: null,
  gliner2ModelId: "fastino/gliner2-base-v1",
  schemaVersion: "external_relation_ie_scene_cache_v2:test",
  promptVersion: "relation_ie_sidecar_v2"
};

test("transactional compiler cache reads do not mutate hit counters by default", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      return {
        rows: [
          {
            response_payload: { ok: true },
            metrics: { cache: "hit" },
            hit_count: 7
          }
        ]
      };
    }
  };

  const entry = await loadCompilerCacheEntry(client, IDENTITY);
  assert.equal(entry?.hitCount, 7);
  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? "", /\bSELECT\b/iu);
  assert.doesNotMatch(queries[0] ?? "", /\bUPDATE\b/iu);
});

test("non-transactional compiler cache reads can still track hits explicitly", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      return {
        rows: [
          {
            response_payload: { ok: true },
            metrics: { cache: "hit" },
            hit_count: 8
          }
        ]
      };
    }
  };

  const entry = await loadCompilerCacheEntry(client, IDENTITY, { trackHit: true });
  assert.equal(entry?.hitCount, 8);
  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? "", /\bUPDATE\b/iu);
});
