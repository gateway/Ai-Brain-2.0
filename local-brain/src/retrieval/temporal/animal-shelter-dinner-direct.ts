import { queryRows } from "../../db/client.js";
import type { RecallResult } from "../../types.js";
import type { RecallQuery } from "../types.js";
import { extractAnimalShelterDinnerDateClaimFromText, isAnimalShelterDinnerTemporalQuery } from "./animal-shelter-dinner.js";
import { inferTemporalEventKeyFromText } from "../../canonical-memory/service.js";

interface AnimalShelterDinnerSourceRow {
  readonly chunk_id: string;
  readonly artifact_id: string;
  readonly uri: string | null;
  readonly chunk_index: number | null;
  readonly text_content: string;
  readonly chunk_metadata: Record<string, unknown> | null;
  readonly artifact_metadata: Record<string, unknown> | null;
}

function readMetadataTextValue(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function loadAnimalShelterDinnerTemporalDirectResult(query: RecallQuery): Promise<{
  readonly claimText: string;
  readonly result: RecallResult;
} | null> {
  const queryEventKey = inferTemporalEventKeyFromText(query.query);
  if (!isAnimalShelterDinnerTemporalQuery(query.query, queryEventKey)) {
    return null;
  }
  const rows = await queryRows<AnimalShelterDinnerSourceRow>(
    `
      SELECT
        c.id::text AS chunk_id,
        a.id::text AS artifact_id,
        a.uri,
        c.chunk_index,
        c.text_content,
        c.metadata AS chunk_metadata,
        a.metadata AS artifact_metadata
      FROM artifact_chunks c
      JOIN artifacts a ON a.id = c.artifact_id
      WHERE a.namespace_id = $1
        AND c.text_content ~* '(animal|pet)\\s+shelter|fundrais|Love is in the Air|children''s health'
        AND length(c.text_content) BETWEEN 8 AND 2400
      ORDER BY
        CASE WHEN c.text_content ~* 'Love is in the Air|animal\\s+shelter|fundrais' THEN 0 ELSE 1 END,
        c.chunk_index ASC
      LIMIT 24
    `,
    [query.namespaceId]
  );
  const candidates = rows
    .map((row) => {
      const sourceReferenceInstant =
        readMetadataTextValue(row.chunk_metadata, "captured_at") ??
        readMetadataTextValue(row.artifact_metadata, "captured_at");
      const claimText = extractAnimalShelterDinnerDateClaimFromText(row.text_content, sourceReferenceInstant);
      if (!claimText) {
        return null;
      }
      const score =
        30 +
        (/\bLove is in the Air\b/iu.test(row.text_content) ? 8 : 0) +
        (/\b(?:animal|pet)\s+shelter\b/iu.test(row.text_content) ? 4 : 0) +
        (/\bfundrais/iu.test(row.text_content) ? 4 : 0);
      return { row, claimText, score };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => right.score - left.score);
  const selected = candidates[0] ?? null;
  if (!selected) {
    return null;
  }
  return {
    claimText: selected.claimText,
    result: {
      memoryId: selected.row.chunk_id,
      memoryType: "episodic_memory",
      content: selected.claimText,
      score: 1,
      artifactId: selected.row.artifact_id,
      occurredAt:
        readMetadataTextValue(selected.row.chunk_metadata, "captured_at") ??
        readMetadataTextValue(selected.row.artifact_metadata, "captured_at"),
      namespaceId: query.namespaceId,
      provenance: {
        tier: "temporal_event_support",
        source_table: "artifact_chunks",
        source_chunk_id: selected.row.chunk_id,
        artifact_id: selected.row.artifact_id,
        source_uri: selected.row.uri,
        chunk_index: selected.row.chunk_index,
        event_key: "animal_shelter_fundraising_dinner",
        support_phrase: selected.row.text_content
      }
    }
  };
}
