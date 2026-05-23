import test from "node:test";
import assert from "node:assert/strict";
import { deriveDailyLifeSummaryClaimText } from "../dist/retrieval/search/claims/profile.js";
import { deriveDepartureClaimText } from "../dist/retrieval/search/claims/source-grounded.js";
import { deriveRelationshipChangeClaimText } from "../dist/retrieval/search/claims/relationship.js";

const HELPERS = {
  isDailyLifeSummaryQuery: () => true,
  isPurchaseSummaryQuery: () => false,
  isRoutineSummaryQuery: () => false,
  isHabitConstraintQueryText: () => false,
  isCurrentProjectQueryText: () => false,
  isContinuityHandoffSearchQueryText: () => false,
  isPersonTimeFactQuery: () => false,
  normalizeWhitespace: (value) => value.trim().replace(/\s+/g, " "),
  uniqueStrings: (values) => [...new Set(values)],
  joinExactDetailValues: (values) => values.join(", "),
  readSourceText: () => null
};

const SOURCE_GROUNDED_HELPERS = {
  isMovieMentionQuery: () => false,
  movieMentionQueryEntity: () => null,
  isProjectIdeaQueryText: () => false,
  isDepartureTimingQuery: () => true,
  isMediaSummaryQuery: () => false,
  isTrustedPersonalSourceUri: () => true,
  readSourceReferenceInstant: () => null,
  inferRelativeTemporalAnswerLabel: () => null,
  formatUtcDayLabel: (value) => value,
  normalizeWhitespace: (value) => value.trim().replace(/\s+/g, " "),
  extractEntityNameHints: () => ["Lauren"],
  extractExplicitMonthDayYearLabel: (value) => {
    const match = value.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(19\d{2}|20\d{2})\b/i);
    return match ? `${match[1]} ${Number(match[2])}, ${match[3]}` : null;
  },
  extractExplicitDateLabel: (value) => {
    const monthFirst = value.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(19\d{2}|20\d{2})\b/i);
    if (monthFirst) {
      return `${monthFirst[1]} ${Number(monthFirst[2])}, ${monthFirst[3]}`;
    }
    const dayFirst = value.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(19\d{2}|20\d{2})\b/i);
    return dayFirst ? `${dayFirst[2]} ${Number(dayFirst[1])}, ${dayFirst[3]}` : null;
  },
  recallResultSourceTexts: () => [],
  uniqueStrings: (values) => [...new Set(values)],
  joinExactDetailValues: (values) => values.join(", "),
  readSourceText: () => null
};

const RELATIONSHIP_HELPERS = {
  isRelationshipProfileQueryText: () => false,
  isRelationshipHistoryRecapQuery: () => false,
  isRelationshipChangeQueryText: () => true,
  isTrustedPersonalSourceUri: () => true,
  extractEntityNameHints: () => ["Lauren"],
  normalizeWhitespace: (value) => value.trim().replace(/\s+/g, " "),
  uniqueStrings: (values) => [...new Set(values)],
  extractSentenceCandidates: (value) =>
    value
      .split(/[.!?]\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  extractEntityRelationshipClauses: () => [],
  extractNumericMonthDayYearLabel: (value) => {
    const match = value.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19\d{2}|20\d{2})\b/);
    if (!match) return null;
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${monthNames[Number(match[1]) - 1]} ${Number(match[2])}, ${match[3]}`;
  },
  extractExplicitMonthDayYearLabel: SOURCE_GROUNDED_HELPERS.extractExplicitMonthDayYearLabel,
  extractExplicitDateLabel: SOURCE_GROUNDED_HELPERS.extractExplicitDateLabel,
  readSourceText: () => null
};

test("daily life summary reducer preserves grounded project recap terms", () => {
  const claim = deriveDailyLifeSummaryClaimText(
    "What did I talk about yesterday?",
    [
      {
        content: "Yesterday I talked about AI Brain, Preset Kitchen, Bumblebee, Well Inked, and Two Way.",
        provenance: {}
      }
    ],
    HELPERS
  );

  assert.ok(claim);
  assert.match(claim, /Yesterday you talked about/i);
  assert.match(claim, /AI Brain/i);
  assert.match(claim, /Preset Kitchen/i);
  assert.match(claim, /Bumblebee/i);
  assert.match(claim, /Well Inked/i);
  assert.match(claim, /Two Way/i);
});

test("departure reducer normalizes day-first dates into month-first labels", () => {
  const claim = deriveDepartureClaimText(
    "When did Lauren leave for the US?",
    [
      {
        content: "Lauren left Thailand for the US on 18 October 2025 and moved back to Bend, Oregon.",
        provenance: {}
      }
    ],
    SOURCE_GROUNDED_HELPERS
  );

  assert.equal(claim, "The best supported date is October 18, 2025.");
});

test("relationship change reducer emits explicit communication-stop phrasing for stop-talking questions", () => {
  const claim = deriveRelationshipChangeClaimText(
    "When did Steve and Lauren stop talking?",
    [
      {
        content:
          "Lauren left Thailand for the US on 10/18/2025. We haven't really talked since.",
        provenance: {
          source_uri: "/tmp/lauren.md"
        }
      }
    ],
    RELATIONSHIP_HELPERS
  );

  assert.match(claim, /October 18, 2025/);
  assert.match(claim, /stopped talking/i);
  assert.match(claim, /haven't really talked since/i);
});
