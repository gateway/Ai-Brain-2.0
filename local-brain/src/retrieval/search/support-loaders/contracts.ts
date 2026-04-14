import type { SearchRow } from "../internal-types.js";

export interface FocusedLikeMatchClause {
  readonly clause: string;
  readonly scoreExpression: string;
  readonly values: readonly string[];
}

export interface SupportLoaderHelpers {
  readonly buildFocusedLikeMatchClause: (
    parameterOffset: number,
    terms: readonly string[],
    documentExpression: string
  ) => FocusedLikeMatchClause;
  readonly artifactDerivationContentExpression: () => string;
  readonly extractEntityNameHints: (queryText: string) => readonly string[];
  readonly normalizeWhitespace: (value: string) => string;
  readonly queryRows: <T>(sqlText: string, values?: readonly unknown[]) => Promise<T[]>;
  readonly toIsoString: (value: unknown) => string | null;
  readonly toNumber: (value: unknown) => number;
}

export function mergeAndLimitSearchRowsByScore(
  rows: readonly SearchRow[],
  candidateLimit: number,
  helpers: Pick<SupportLoaderHelpers, "toIsoString" | "toNumber">
): SearchRow[] {
  return rows
    .slice()
    .sort((left, right) => {
      const rightScore = helpers.toNumber(right.raw_score);
      const leftScore = helpers.toNumber(left.raw_score);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      const leftIso = helpers.toIsoString(left.occurred_at);
      const rightIso = helpers.toIsoString(right.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
    })
    .slice(0, Math.max(candidateLimit, 10));
}
