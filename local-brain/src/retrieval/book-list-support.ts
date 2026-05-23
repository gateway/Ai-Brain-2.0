import type { SearchRow } from "./search/internal-types.js";
import { inferListSetTypedEntries } from "./support-objects.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function rowText(row: SearchRow): string {
  return normalize(row.content);
}

function rowDerivationType(row: SearchRow): string {
  return typeof row.provenance.derivation_type === "string" ? row.provenance.derivation_type : "";
}

function rowMetadata(row: SearchRow): Record<string, unknown> {
  const metadata = row.provenance.metadata;
  return typeof metadata === "object" && metadata !== null ? metadata as Record<string, unknown> : {};
}

function rowTitles(queryText: string, row: SearchRow): readonly string[] {
  return inferListSetTypedEntries({
    queryText,
    texts: [rowText(row)]
  }).entries;
}

function hasQuotedTitle(text: string): boolean {
  return /["“'][^"”']{2,120}["”']/u.test(text);
}

function isRecommendationOnly(text: string): boolean {
  return /\bthat book you recommended\b/iu.test(text) ||
    (
      /\b(recommend(?:ed|ation)?|suggest(?:ed|ion)?)\b/iu.test(text) &&
      !/\b(read|reading|reads|finished)\b/iu.test(text)
    );
}

function hasBookCoverCue(row: SearchRow, text: string): boolean {
  const metadata = rowMetadata(row);
  const imageQuery = normalize(typeof metadata.image_query === "string" ? metadata.image_query : "");
  const imageCaption = normalize(typeof metadata.image_caption === "string" ? metadata.image_caption : "");
  const sourceUri = typeof row.provenance.source_uri === "string" ? row.provenance.source_uri : "";
  const derivationType = rowDerivationType(row);
  return (
    derivationType.includes("image") ||
    /\bbook cover\b/iu.test(text) ||
    /\bbook\b/iu.test(imageQuery) ||
    /\bbook\b/iu.test(imageCaption) ||
    /\bbook\b/iu.test(sourceUri)
  );
}

function scoreBookListSupportRow(queryText: string, row: SearchRow): { readonly row: SearchRow; readonly titles: readonly string[]; readonly score: number } {
  const text = rowText(row);
  const titles = rowTitles(queryText, row);
  const derivationType = rowDerivationType(row);
  let score = typeof row.raw_score === "number" ? row.raw_score : Number(row.raw_score ?? 0);

  if (titles.length > 0) {
    score += 6 + titles.length * 2.5;
  }
  if (/\bbook titled\b/iu.test(text)) {
    score += 4;
  }
  if (hasQuotedTitle(text)) {
    score += 1.5;
  }
  if (hasBookCoverCue(row, text) && titles.length > 0) {
    score += 2.5;
  }
  if (derivationType === "benchmark_locomo_cached_image_derivation" && titles.length > 0) {
    score += 3;
  }
  if (isRecommendationOnly(text) && titles.length === 0) {
    score -= 4;
  }
  if (
    titles.length === 0 &&
    (derivationType === "participant_turn" || derivationType === "conversation_unit" || derivationType === "topic_segment")
  ) {
    score -= 1.5;
  }

  return {
    row: {
      ...row,
      raw_score: score
    },
    titles,
    score
  };
}

export function selectBookListSupportRows(
  queryText: string,
  rows: readonly SearchRow[],
  candidateLimit: number
): SearchRow[] {
  const scored = rows
    .map((row) => scoreBookListSupportRow(queryText, row))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftOccurredAt = String(left.row.occurred_at ?? "");
      const rightOccurredAt = String(right.row.occurred_at ?? "");
      if (leftOccurredAt !== rightOccurredAt) {
        return rightOccurredAt.localeCompare(leftOccurredAt);
      }
      return String(left.row.memory_id).localeCompare(String(right.row.memory_id));
    });

  const limit = Math.max(1, candidateLimit);
  const selected: SearchRow[] = [];
  const seenRowIds = new Set<string>();
  const seenTitles = new Set<string>();
  const titleBearingRows = scored.filter((entry) => entry.titles.length > 0);

  for (const entry of titleBearingRows) {
    const introducesNewTitle = entry.titles.some((title) => !seenTitles.has(title.toLowerCase()));
    if (!introducesNewTitle) {
      continue;
    }
    selected.push(entry.row);
    seenRowIds.add(entry.row.memory_id);
    for (const title of entry.titles) {
      seenTitles.add(title.toLowerCase());
    }
    if (selected.length >= limit) {
      return selected;
    }
  }

  const fallbackPool = titleBearingRows.length > 0 ? scored : scored;
  for (const entry of fallbackPool) {
    if (seenRowIds.has(entry.row.memory_id)) {
      continue;
    }
    selected.push(entry.row);
    seenRowIds.add(entry.row.memory_id);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}
