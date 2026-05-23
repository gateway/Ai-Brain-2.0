import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { expandEntityLookupCandidates, normalizeEntityLookupName } from "../dist/identity/canonicalization.js";
import { withTransaction } from "../dist/db/client.js";
import { resolveCanonicalEntityReference } from "../dist/identity/service.js";

test("entity lookup normalization folds punctuation, diacritics, possessives, and ampersands", () => {
  assert.equal(normalizeEntityLookupName(" Café del Mar "), "cafe del mar");
  assert.equal(normalizeEntityLookupName("Jon's Studio"), "jon studio");
  assert.equal(normalizeEntityLookupName("Research & Development"), "research and development");
  assert.equal(normalizeEntityLookupName("Preset-Kitchen"), "preset kitchen");
});

test("entity lookup candidates preserve generic article stripping and curated alias families", () => {
  const articleCandidates = expandEntityLookupCandidates("The Samui Experience");
  assert.ok(articleCandidates.includes("samui experience"));

  const curatedCandidates = expandEntityLookupCandidates("Kozimui");
  assert.ok(curatedCandidates.includes("koh samui"));
});

test("canonical entity resolution abstains on ambiguous exact aliases", async () => {
  const namespaceId = `test_entity_resolution_${randomUUID()}`;
  const entityIds = [];

  try {
    await withTransaction(async (client) => {
      const first = await client.query(
        `
          INSERT INTO entities (
            namespace_id,
            entity_type,
            canonical_name,
            normalized_name,
            metadata
          )
          VALUES ($1, 'person', 'Alex Johnson', 'alex johnson', '{}'::jsonb)
          RETURNING id
        `,
        [namespaceId]
      );
      const second = await client.query(
        `
          INSERT INTO entities (
            namespace_id,
            entity_type,
            canonical_name,
            normalized_name,
            metadata
          )
          VALUES ($1, 'person', 'Alex Rivera', 'alex rivera', '{}'::jsonb)
          RETURNING id
        `,
        [namespaceId]
      );
      const firstId = first.rows[0]?.id;
      const secondId = second.rows[0]?.id;
      assert.ok(firstId);
      assert.ok(secondId);
      entityIds.push(firstId, secondId);

      for (const entityId of entityIds) {
        await client.query(
          `
            INSERT INTO entity_aliases (
              entity_id,
              alias,
              normalized_alias,
              alias_type,
              is_user_verified,
              metadata
            )
            VALUES ($1, 'Alex', 'alex', 'observed', false, '{}'::jsonb)
          `,
          [entityId]
        );
      }
    });

    const ambiguous = await resolveCanonicalEntityReference(namespaceId, "Alex", {
      entityTypes: ["person"]
    });
    assert.equal(ambiguous, null);

    const exact = await resolveCanonicalEntityReference(namespaceId, "Alex Johnson", {
      entityTypes: ["person"]
    });
    assert.ok(exact);
    assert.equal(exact?.canonicalName, "Alex Johnson");
  } finally {
    await withTransaction(async (client) => {
      await client.query("DELETE FROM entity_aliases WHERE entity_id = ANY($1::uuid[])", [entityIds]);
      await client.query("DELETE FROM entities WHERE namespace_id = $1", [namespaceId]);
    });
  }
});
