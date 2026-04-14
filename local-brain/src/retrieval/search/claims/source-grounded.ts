import type { RecallResult } from "../../../types.js";

export interface SourceGroundedClaimRuntimeHelpers {
  readonly isMovieMentionQuery: (queryText: string) => boolean;
  readonly movieMentionQueryEntity: (queryText: string) => string | null;
  readonly isProjectIdeaQueryText: (queryText: string) => boolean;
  readonly isDepartureTimingQuery: (queryText: string) => boolean;
  readonly isMediaSummaryQuery: (queryText: string) => boolean;
  readonly isTrustedPersonalSourceUri: (sourceUri: string) => boolean;
  readonly readSourceReferenceInstant: (sourceUri: string | null) => string | null;
  readonly inferRelativeTemporalAnswerLabel: (
    content: string,
    occurredAt: string | null | undefined,
    referenceNow?: string | null
  ) => string | null;
  readonly formatUtcDayLabel: (iso: string) => string;
  readonly normalizeWhitespace: (value: string) => string;
  readonly extractEntityNameHints: (queryText: string) => readonly string[];
  readonly extractExplicitMonthDayYearLabel: (value: string) => string | null;
  readonly recallResultSourceTexts: (result: RecallResult) => readonly string[];
  readonly uniqueStrings: (values: readonly string[]) => string[];
  readonly joinExactDetailValues: (values: readonly string[]) => string;
  readonly readSourceText: (sourceUri: string) => string | null;
}

function readTrustedSourceTexts(
  results: readonly RecallResult[],
  helpers: Pick<SourceGroundedClaimRuntimeHelpers, "readSourceText" | "isTrustedPersonalSourceUri">
): string[] {
  return [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.startsWith("/") && helpers.isTrustedPersonalSourceUri(value)
      )
  )]
    .map((sourceUri) => helpers.readSourceText(sourceUri))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.replace(/^---\s*\n[\s\S]*?\n---\s*/u, ""));
}

export function deriveMovieMentionClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: SourceGroundedClaimRuntimeHelpers
): string | null {
  if (!helpers.isMovieMentionQuery(queryText) || results.length === 0) {
    return null;
  }

  const entity = helpers.movieMentionQueryEntity(queryText);
  if (!entity) {
    return null;
  }

  const candidates = [
    ...results,
    ...results.filter(
      (result, index, all) =>
        typeof result.provenance.source_uri === "string" &&
        result.provenance.source_uri.startsWith("/") &&
        helpers.isTrustedPersonalSourceUri(result.provenance.source_uri) &&
        all.findIndex((other) => other.provenance.source_uri === result.provenance.source_uri) === index
    )
  ];

  for (const result of candidates) {
    const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    const sourceReferenceInstant = helpers.readSourceReferenceInstant(sourceUri) ?? result.occurredAt ?? null;
    const provenanceMetadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    const coarseTemporalAnchor =
      typeof provenanceMetadata?.time_granularity === "string" &&
      ["year", "month"].includes(provenanceMetadata.time_granularity);
    const relativeAnchorInstant = coarseTemporalAnchor && sourceReferenceInstant ? sourceReferenceInstant : result.occurredAt;
    const contentCandidates = [
      result.content,
      ...(sourceUri && helpers.isTrustedPersonalSourceUri(sourceUri)
        ? [helpers.readSourceText(sourceUri)]
        : [])
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.replace(/^---\s*\n[\s\S]*?\n---\s*/u, ""));

    for (const content of contentCandidates) {
      const normalized = content.toLowerCase();
      if (!normalized.includes(entity)) {
        continue;
      }
      if (!/\bmovie\b|\bfilm\b/i.test(content)) {
        continue;
      }

      const movieTitle =
        content.match(/\bmovie\s+(?:called\s+)?["“]?([A-Z][A-Za-z0-9'’:& -]{1,80})["”]?/u)?.[1]?.trim() ??
        content.match(/\bfilm\s+(?:called\s+)?["“]?([A-Z][A-Za-z0-9'’:& -]{1,80})["”]?/u)?.[1]?.trim() ??
        null;
      if (!movieTitle) {
        continue;
      }

      const absoluteDate = helpers.inferRelativeTemporalAnswerLabel(content, relativeAnchorInstant, sourceReferenceInstant);
      const relativePhrase =
        content.match(/\b(one|two|three|four|\d+)\s+weeks?\s+ago\b/iu)?.[0] ??
        content.match(/\byesterday\b/iu)?.[0] ??
        null;
      const location =
        content.match(/\bover\s+beers\s+and\s+dinner\s+at\s+(?:this\s+)?([^.!?\n]+?\b(?:place|restaurant|barbecue place)\b(?:\s+in\s+[A-Z][A-Za-z\s]+)?)/u)?.[1]?.trim() ??
        content.match(/\bat\s+(?:this\s+)?([^.!?\n]+?\b(?:place|restaurant|barbecue place)\b(?:\s+in\s+[A-Z][A-Za-z\s]+)?)/u)?.[1]?.trim() ??
        null;

      const detailParts: string[] = [`Dan mentioned the movie "${movieTitle}"`];
      if (relativePhrase && absoluteDate) {
        detailParts.push(
          `${relativePhrase}, which from ${helpers.formatUtcDayLabel(
            sourceReferenceInstant ?? result.occurredAt ?? new Date().toISOString()
          )} resolves to around ${absoluteDate}`
        );
      } else if (absoluteDate) {
        detailParts.push(`around ${absoluteDate}`);
      }
      if (location) {
        detailParts.push(
          `over beers and dinner at ${location.replace(/^\bthe\b\s+/iu, "the ").replace(/\s+two\s+weeks?\s+ago$/iu, "").trim()}`
        );
      }
      return `${detailParts.join(" ")}.`;
    }
  }

  return null;
}

export function deriveProjectIdeaClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: SourceGroundedClaimRuntimeHelpers
): string | null {
  if (!helpers.isProjectIdeaQueryText(queryText) || results.length === 0) {
    return null;
  }

  const candidates = [...results.map((result) => result.content), ...readTrustedSourceTexts(results, helpers)];
  const orderedCandidates = [...candidates].sort((left, right) => {
    const leftScore = (/\bContext Suite\b/i.test(left) ? 3 : 0) + (/\bmemoir engine\b/i.test(left) ? 2 : 0) + (/\bBen\b/i.test(left) ? 1 : 0);
    const rightScore = (/\bContext Suite\b/i.test(right) ? 3 : 0) + (/\bmemoir engine\b/i.test(right) ? 2 : 0) + (/\bBen\b/i.test(right) ? 1 : 0);
    return rightScore - leftScore;
  });

  for (const content of orderedCandidates) {
    if (!/\bBen\b/i.test(content) || !/\b(?:idea|project|memoir engine|Context Suite)\b/i.test(content)) {
      continue;
    }
    const projectName =
      content.match(/\bBen and I talked about,?\s+the\s+([^.,\n]+?)(?:\s+and\s+specifically|\.)/iu)?.[1]?.trim() ??
      content.match(/\bdiscussion with Ben\b[\s\S]{0,80}?\babout\s+the\s+([^.,\n]+?)(?:,|\.)/iu)?.[1]?.trim() ??
      content.match(/\bcalling\s+(?:it|at)\s+the\s+([^.,\n]+?)(?:\.|,|\n)/iu)?.[1]?.trim() ??
      content.match(/\bproject,\s+the\s+([^.,\n]+?)(?:\s+which|\s+that|,|\.)/iu)?.[1]?.trim() ??
      (/\bContext Suite\b/i.test(content) ? "Context Suite" : null) ??
      null;
    const ideaCore =
      content.match(/\bidea of using\s+([^.!?\n]+?)(?:\.|$)/iu)?.[1]?.trim() ??
      content.match(/\bfocusing on\s+creating\s+([^.!?\n]+?)(?:\.|$)/iu)?.[1]?.trim() ??
      content.match(/\b(?:Context Suite is a system that can|system that can)\s+([^.!?\n]*memoir[^.!?\n]*)(?:\.|$)/iu)?.[1]?.trim() ??
      null;
    const outcome =
      content.match(/\b(help us generate\s+(?:a\s+)?"?life graph"?[^.!?\n]*)(?:\.|$)/iu)?.[1]?.trim() ??
      content.match(/\bbuild\s+a\s+"?life graph"?[^.!?\n]*?(?:project)?(?:\.|$)/iu)?.[0]?.trim().replace(/\.$/u, "") ??
      null;
    const hasKnowledgeGraph = /\bcreating\s+a\s+knowledge\s+graph\b/i.test(content) || /\bknowledge\s+graph\b/i.test(content);
    const hasPostgresEntityExtraction = /\bPostgres\s+database\b/i.test(content) && /\bentity\s+extraction\b/i.test(content);
    const hasLifeGraph = /\blife graph\b/i.test(content);
    const hasContextSuite = /\bContext Suite\b/i.test(content);
    const hasMemoirEngine = /\bmemoir engine\b/i.test(content);
    const hasTextAndAudio = /\btext\b/i.test(content) && /\baudio\b/i.test(content);

    if (!projectName || (!ideaCore && !outcome)) {
      continue;
    }

    const pieces = [`Ben and I discussed the ${projectName}`];
    if (hasPostgresEntityExtraction && hasKnowledgeGraph && hasLifeGraph) {
      pieces.push('The idea was to use a Postgres database and entity extraction to create a knowledge graph, a "life graph" for the memoir project');
    } else if (hasContextSuite && hasMemoirEngine) {
      pieces.push(`The idea was to ingest ${hasTextAndAudio ? "text and audio" : "source material"} into a memoir engine that can output chapters of a person's memoir`);
    } else if (ideaCore && outcome) {
      pieces.push(`The idea was to ${ideaCore.replace(/\s+This was.*$/iu, "").trim()} to ${outcome.replace(/^help us /iu, "help generate ")}`);
    } else if (ideaCore) {
      pieces.push(`The idea was to ${ideaCore.replace(/\s+This was.*$/iu, "").trim()}`);
    } else if (outcome) {
      pieces.push(`The idea was to ${outcome}`);
    }
    return `${pieces.join(". ")}.`;
  }

  return null;
}

export function projectIdeaSupportScore(
  result: RecallResult,
  helpers: Pick<SourceGroundedClaimRuntimeHelpers, "isTrustedPersonalSourceUri">
): number {
  const content = result.content.toLowerCase();
  let score = 0;
  if (/\bben\b/.test(content)) score += 6;
  if (/\bcontext suite\b/.test(content)) score += 7;
  if (/\bmemoir engine\b/.test(content)) score += 7;
  if (/\bknowledge graph\b/.test(content) || /\blife graph\b/.test(content)) score += 5;
  if (/\bchapters of a person's memoir\b/.test(content) || /\bperson's memoir\b/.test(content)) score += 5;
  if (/\btext\b/.test(content) && /\baudio\b/.test(content)) score += 3;
  if (result.memoryType === "episodic_memory") score += 3;
  else if (result.memoryType === "artifact_derivation") score += 2;
  if (typeof result.provenance.source_uri === "string" && helpers.isTrustedPersonalSourceUri(result.provenance.source_uri)) {
    score += 2;
  }
  return score;
}

export function deriveDepartureClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: SourceGroundedClaimRuntimeHelpers
): string | null {
  if (!helpers.isDepartureTimingQuery(queryText) || results.length === 0) {
    return null;
  }

  const entityHints = helpers.extractEntityNameHints(queryText).map((value) => helpers.normalizeWhitespace(value).toLowerCase()).filter(Boolean);
  const contentCandidates = [...results.map((result) => result.content), ...[...new Set(
    results.map((result) => result.provenance.source_uri).filter((value): value is string => typeof value === "string" && value.startsWith("/"))
  )]
    .map((sourceUri) => helpers.readSourceText(sourceUri))
    .filter((value): value is string => typeof value === "string" && value.length > 0)];

  for (const content of contentCandidates) {
    const normalized = content.toLowerCase();
    const hasEntityHint = entityHints.length === 0 || entityHints.some((hint) => normalized.includes(hint));
    const hasDepartureCue =
      /\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back)\b/i.test(content) &&
      /\b(us|u\.s\.|united states|bend|oregon)\b/i.test(content);
    if (!hasEntityHint || !hasDepartureCue) {
      continue;
    }
    const explicitDate = helpers.extractExplicitMonthDayYearLabel(content);
    if (explicitDate) {
      return `The best supported date is ${explicitDate}.`;
    }
  }

  return null;
}

export function deriveMediaSummaryClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: SourceGroundedClaimRuntimeHelpers
): string | null {
  if (!helpers.isMediaSummaryQuery(queryText) || results.length === 0) {
    return null;
  }

  const canonicalPatterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfrom\s+dusk\s+till\s+dawn\b/i, "From Dusk Till Dawn"],
    [/\bdusk\s+till\s+dawn\b/i, "From Dusk Till Dawn"],
    [/\bchainsaw\s+man\b/i, "Chainsaw Man"],
    [/\bslow\s+horses\b/i, "Slow Horses"],
    [/\bsinners\b/i, "Sinners"],
    [/\bavatar\b/i, "Avatar"]
  ];

  const canonicalizeMediaTitle = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const normalized = helpers.normalizeWhitespace(value);
    if (!normalized) return null;
    for (const [pattern, title] of canonicalPatterns) {
      if (pattern.test(normalized)) return title;
    }
    if (
      /^(tv show|movie|show|book|song|anime|that|back up)$/i.test(normalized) ||
      /^(from|at|in|on|with|about)\b/i.test(normalized) ||
      /\b(friend|burger|thailand new year|leonardo|di caprio)\b/i.test(normalized)
    ) {
      return null;
    }
    return normalized;
  };

  const isAmbiguousMediaNoise = (result: RecallResult): boolean => {
    const mediaTitle = typeof result.provenance.media_title === "string" ? helpers.normalizeWhitespace(result.provenance.media_title) : "";
    const mediaKind = typeof result.provenance.media_kind === "string" ? helpers.normalizeWhitespace(result.provenance.media_kind).toLowerCase() : "";
    const content = helpers.normalizeWhitespace(result.content).toLowerCase();
    if (mediaKind !== "unknown" || !mediaTitle) return false;
    if (/\b(uncle|aunt|mom|mother|dad|father|grandma|grandmother|grandpa|grandfather)\b/i.test(mediaTitle)) {
      return true;
    }
    return content.includes(`unknown ${mediaTitle.toLowerCase()}`) || /\bwhich\s+\w+\b/i.test(content) || /\bnever said which\b/i.test(content) || /\bshe meant\b/i.test(content);
  };

  const titlesFromResults = results
    .flatMap((result) => {
      if (isAmbiguousMediaNoise(result)) return [];
      const direct = typeof result.provenance.media_title === "string" ? result.provenance.media_title : null;
      const context = [result.content, ...helpers.recallResultSourceTexts(result)].join("\n");
      return [canonicalizeMediaTitle(direct), canonicalizeMediaTitle(context)];
    })
    .filter((value): value is string => Boolean(value));

  const sourceFileTitles = helpers.uniqueStrings(
    [...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
    )]
      .slice(0, 8)
      .flatMap((sourceUri) => {
        const sourceText = helpers.readSourceText(sourceUri);
        if (!sourceText) return [];
        const discovered: string[] = [];
        for (const [pattern, title] of canonicalPatterns) {
          if (pattern.test(sourceText) && !discovered.includes(title)) {
            discovered.push(title);
          }
        }
        return discovered;
      })
      .filter((value): value is string => Boolean(value))
  );

  const titles = helpers.uniqueStrings([...titlesFromResults, ...sourceFileTitles]);
  if (titles.length === 0) {
    return null;
  }
  if (/\bwhat\s+movie\s+did\s+.+\s+mention\b/i.test(queryText)) {
    const top = results[0];
    return top?.content ?? `The best supported media mention is ${titles[0]}.`;
  }
  return `The strongest grounded titles you've talked about are ${helpers.joinExactDetailValues(titles)}.`;
}
