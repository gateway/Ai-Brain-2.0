import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import type { ConsolidationAction, ConsolidationDecision, JobRunContext } from "./types.js";

interface CandidateRow {
  readonly candidate_id: string;
  readonly namespace_id: string;
  readonly candidate_type: string;
  readonly content: string;
  readonly created_at: string;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_artifact_observation_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly occurred_at: string | null;
}

interface ClaimCandidateRow {
  readonly candidate_id: string;
  readonly namespace_id: string;
  readonly claim_type: string;
  readonly source_memory_id: string | null;
  readonly subject_entity_id: string | null;
  readonly object_entity_id: string | null;
  readonly subject_text: string | null;
  readonly predicate: string;
  readonly object_text: string | null;
  readonly confidence: number;
  readonly occurred_at: string;
  readonly metadata: Record<string, unknown>;
  readonly created_at: string;
}

interface PreferenceStatement {
  readonly polarity: "like" | "dislike";
  readonly target: string;
  readonly canonicalKey: string;
  readonly category?: string;
}

interface WatchlistStatement {
  readonly title: string;
  readonly canonicalKey: string;
  readonly category?: string;
}

interface DecisionStatement {
  readonly summary: string;
  readonly canonicalKey: string;
}

interface ConstraintStatement {
  readonly rule: string;
  readonly canonicalKey: string;
  readonly modality: "always" | "never" | "clarify";
}

interface StyleSpecStatement {
  readonly rule: string;
  readonly canonicalKey: string;
  readonly scope: "response_style" | "workflow" | "retrieval_style";
}

interface GoalStatement {
  readonly summary: string;
  readonly canonicalKey: string;
}

interface PlanStatement {
  readonly summary: string;
  readonly canonicalKey: string;
  readonly projectHint?: string;
}

interface BeliefStatement {
  readonly topic: string;
  readonly summary: string;
  readonly canonicalKey: string;
}

type TypedPreferenceEntityType = "activity" | "media" | "skill" | "decision" | "constraint" | "routine" | "style_spec" | "goal" | "plan" | "belief";

interface RoutinePatternRow {
  readonly person_name: string;
  readonly activity_name: string;
  readonly location_name: string | null;
  readonly weekday_name: string;
  readonly day_part: string;
  readonly week_count: number;
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly representative_memory_id: string | null;
}

interface HeuristicEvidenceRow {
  readonly memory_id: string;
  readonly content: string;
  readonly occurred_at: string | null;
  readonly source_chunk_id: string | null;
}

interface TypedPreferenceEntity {
  readonly entityType: TypedPreferenceEntityType;
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
  readonly parentCanonicalName?: string;
  readonly parentEntityType?: TypedPreferenceEntityType;
  readonly metadata?: Record<string, unknown>;
}

type PlaceSpecificityDecision = "keep_current" | "replace_with_new" | "independent";

const ACTIVITY_CANONICALS = new Map<string, {
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
  readonly parentCanonicalName?: string;
  readonly parentEntityType?: TypedPreferenceEntityType;
}>([
  ["snowboard", { canonicalName: "Snowboarding", aliases: ["Snowboard"], parentCanonicalName: "Mountain Sports", parentEntityType: "activity" }],
  ["snowboarding", { canonicalName: "Snowboarding", aliases: ["Snowboard"], parentCanonicalName: "Mountain Sports", parentEntityType: "activity" }],
  ["hike", { canonicalName: "Hiking", aliases: ["Hike"], parentCanonicalName: "Mountain Sports", parentEntityType: "activity" }],
  ["hiking", { canonicalName: "Hiking", aliases: ["Hike"], parentCanonicalName: "Mountain Sports", parentEntityType: "activity" }]
]);

const MEDIA_CATEGORY_PARENTS = new Map<string, string>([
  ["movie", "Movies"],
  ["film", "Movies"]
]);

const SKILL_CANONICALS = new Map<string, {
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
  readonly parentCanonicalName?: string;
  readonly parentEntityType?: TypedPreferenceEntityType;
}>([
  ["full-stack web development", { canonicalName: "Full-Stack Web Development", parentCanonicalName: "Software Development", parentEntityType: "skill" }],
  ["drone operations", { canonicalName: "Drone Operations", aliases: ["Drone Capture"], parentCanonicalName: "Aerial Capture", parentEntityType: "skill" }],
  ["photogrammetry", { canonicalName: "Photogrammetry", parentCanonicalName: "Aerial Capture", parentEntityType: "skill" }],
  ["stable diffusion", { canonicalName: "Stable Diffusion", parentCanonicalName: "Generative AI", parentEntityType: "skill" }],
  ["comfyui", { canonicalName: "ComfyUI", parentCanonicalName: "Generative AI", parentEntityType: "skill" }],
  ["deforum", { canonicalName: "Deforum", parentCanonicalName: "Generative AI", parentEntityType: "skill" }],
  ["animatediff", { canonicalName: "AnimateDiff", parentCanonicalName: "Generative AI", parentEntityType: "skill" }]
]);

const CONSTRAINT_CANONICALS = new Map<string, {
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
}>([
  ["return ground-truth source document with search results", { canonicalName: "Return Ground-Truth Source Document With Search Results" }],
  ["never silently rewrite raw source truth", { canonicalName: "Never Silently Rewrite Raw Source Truth" }],
  ["ask for clarification instead of guessing", { canonicalName: "Ask For Clarification Instead Of Guessing" }],
  ["ask for clarification of guessing", { canonicalName: "Ask For Clarification Instead Of Guessing" }],
  ["never order peanuts for my dinner", {
    canonicalName: "Peanuts are an absolute dietary blocker for Steve",
    aliases: ["Never Order Peanuts For My Dinner"]
  }],
  ["peanuts are an absolute dietary blocker for steve", { canonicalName: "Peanuts are an absolute dietary blocker for Steve" }]
]);

const STYLE_SPEC_CANONICALS = new Map<string, {
  readonly canonicalName: string;
  readonly scope: StyleSpecStatement["scope"];
  readonly aliases?: readonly string[];
}>([
  ["keep responses concise", { canonicalName: "Keep Responses Concise", scope: "response_style" }],
  ["keep replies concise", { canonicalName: "Keep Responses Concise", scope: "response_style", aliases: ["Keep Replies Concise"] }],
  ["prefer concise responses", { canonicalName: "Keep Responses Concise", scope: "response_style" }],
  ["ask notebooklm first before changing ontology", { canonicalName: "Ask NotebookLM First Before Changing Ontology", scope: "workflow" }],
  ["ask notebooklm first", { canonicalName: "Ask NotebookLM First Before Changing Ontology", scope: "workflow" }],
  ["wipe and replay the database after each slice", { canonicalName: "Wipe And Replay The Database After Each Slice", scope: "workflow" }],
  ["wipe and replay the db after each slice", { canonicalName: "Wipe And Replay The Database After Each Slice", scope: "workflow" }],
  ["wipe and replay the database", { canonicalName: "Wipe And Replay The Database After Each Slice", scope: "workflow" }],
  ["prefer natural-language queryability", { canonicalName: "Prefer Natural-Language Queryability", scope: "retrieval_style" }],
  ["natural-language queryability matters more than clever internal complexity", { canonicalName: "Prefer Natural-Language Queryability", scope: "retrieval_style" }]
]);

export interface ConsolidationRunSummary {
  readonly context: JobRunContext;
  readonly scannedCandidates: number;
  readonly processedCandidates: number;
  readonly promotedMemories: number;
  readonly supersededMemories: number;
  readonly decisions: readonly ConsolidationDecision[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizePreferenceTarget(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/\b(?:that|the|a|an)\b/gu, " ")
      .replace(/\b(?:instead|now|today|currently|really|very|said)\b/gu, " ")
      .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
  );
}

function buildCanonicalPreferenceKey(target: string): string {
  return `preference:${target}`;
}

function buildCanonicalWatchlistKey(target: string): string {
  return `watchlist:${target}`;
}

function buildCanonicalDecisionKey(target: string): string {
  return `decision:${target}`;
}

function buildCanonicalConstraintKey(target: string): string {
  return `constraint:${target}`;
}

function buildCanonicalRoutineKey(target: string): string {
  return `routine:${target}`;
}

function buildCanonicalStyleSpecKey(target: string): string {
  return `style_spec:${target}`;
}

function buildCanonicalGoalKey(target: string): string {
  return `goal:${target}`;
}

function buildCanonicalPlanKey(target: string): string {
  return `plan:${target}`;
}

function buildCanonicalBeliefKey(target: string): string {
  return `belief:${target}`;
}

function normalizeBeliefTopicKey(value: string): string {
  return normalizePreferenceTarget(
    value
      .replace(/^\s*using\s+/iu, "")
      .replace(/\bfor\b/giu, " ")
      .replace(/\b(?:my|our)\s+(?:stance|opinion)\s+on\s+/iu, "")
  ).replace(/\s+/gu, "_");
}

function normalizeProjectKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^\p{L}\p{N}\s:-]+/gu, "").replace(/\s+/gu, "_");
}

function normalizeListItem(value: string): string {
  return normalizeWhitespace(value.replace(/^[-*]+\s*/u, "").replace(/[.;,]+$/u, ""));
}

function capitalizeToken(value: string): string {
  if (!value) {
    return value;
  }
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function splitPreferenceTargets(value: string, category?: string): readonly string[] {
  const cleaned = normalizeListItem(value);
  if (!cleaned) {
    return [];
  }

  const activityLike = category === "sport" || /\b(?:snowboard(?:ing)?|hike|hiking)\b/iu.test(cleaned);
  if (!activityLike && !/[,&]|\band\b/iu.test(cleaned)) {
    return [cleaned];
  }

  const segments = cleaned
    .split(/\s*,\s*|\s+(?:and|&)\s+/iu)
    .map((segment) => normalizeListItem(segment).replace(/^to\s+/iu, ""))
    .filter(Boolean);

  if (segments.length <= 1) {
    return [cleaned];
  }

  if (activityLike || segments.every((segment) => segment.split(/\s+/u).length <= 3)) {
    return segments;
  }

  return [cleaned];
}

function resolveActivityEntity(value: string): TypedPreferenceEntity | null {
  const normalized = normalizePreferenceTarget(value);
  const matched = ACTIVITY_CANONICALS.get(normalized);
  if (!matched) {
    return null;
  }

  return {
    entityType: "activity",
    canonicalName: matched.canonicalName,
    aliases: matched.aliases,
    parentCanonicalName: matched.parentCanonicalName,
    parentEntityType: matched.parentEntityType,
    metadata: {
      ontology_phase: "phase4",
      source_kind: "preference"
    }
  };
}

function resolveTypedPreferenceEntity(target: string, category?: string): TypedPreferenceEntity | null {
  const activity = resolveActivityEntity(target);
  if (activity) {
    return activity;
  }

  if (category === "movie" || category === "film") {
    const canonicalName = normalizeListItem(target);
    if (!canonicalName) {
      return null;
    }

    return {
      entityType: "media",
      canonicalName,
      parentCanonicalName: MEDIA_CATEGORY_PARENTS.get(category) ?? "Movies",
      parentEntityType: "media",
      metadata: {
        media_category: category,
        ontology_phase: "phase4",
        source_kind: "preference"
      }
    };
  }

  return null;
}

function resolveTypedWatchlistEntity(title: string, category?: string): TypedPreferenceEntity | null {
  return resolveTypedPreferenceEntity(title, category ?? "movie");
}

function resolveTypedSkillEntity(target: string): TypedPreferenceEntity | null {
  const normalized = normalizePreferenceTarget(target);
  const matched = SKILL_CANONICALS.get(normalized);
  if (!matched) {
    if (normalized.includes("full-stack web")) {
      return resolveTypedSkillEntity("full-stack web development");
    }
    if (normalized.includes("photogrammetry")) {
      return resolveTypedSkillEntity("photogrammetry");
    }
    if (normalized.includes("drone")) {
      return resolveTypedSkillEntity("drone operations");
    }
    return null;
  }

  return {
    entityType: "skill",
    canonicalName: matched.canonicalName,
    aliases: matched.aliases,
    parentCanonicalName: matched.parentCanonicalName,
    parentEntityType: matched.parentEntityType,
    metadata: {
      ontology_phase: "phase4",
      source_kind: "skill"
    }
  };
}

function toDisplayPhrase(value: string): string {
  const cleaned = normalizeWhitespace(value)
    .replace(/\bbrain 2\.0\b/giu, "Brain 2.0")
    .replace(/\bpostgres\b/giu, "Postgres");

  if (!cleaned) {
    return "";
  }

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function resolveTypedDecisionEntity(target: string): TypedPreferenceEntity | null {
  const normalized = normalizePreferenceTarget(target);
  if (!normalized) {
    return null;
  }

  return {
    entityType: "decision",
    canonicalName: toDisplayPhrase(target),
    metadata: {
      ontology_phase: "phase4",
      source_kind: "decision"
    }
  };
}

function resolveTypedConstraintEntity(target: string): TypedPreferenceEntity | null {
  const normalized = normalizePreferenceTarget(target);
  if (!normalized) {
    return null;
  }

  const matched = CONSTRAINT_CANONICALS.get(normalized);
  return {
    entityType: "constraint",
    canonicalName: matched?.canonicalName ?? toDisplayPhrase(target),
    aliases: matched?.aliases,
    metadata: {
      ontology_phase: "phase4",
      source_kind: "constraint"
    }
  };
}

function resolveTypedStyleSpecEntity(target: string, scope: StyleSpecStatement["scope"]): TypedPreferenceEntity | null {
  const normalized = normalizePreferenceTarget(target);
  if (!normalized) {
    return null;
  }

  const matched = STYLE_SPEC_CANONICALS.get(normalized);
  return {
    entityType: "style_spec",
    canonicalName: matched?.canonicalName ?? toDisplayPhrase(target),
    aliases: matched?.aliases,
    metadata: {
      ontology_phase: "phase4",
      source_kind: "style_spec",
      scope: matched?.scope ?? scope
    }
  };
}

function resolveTypedGoalEntity(target: string): TypedPreferenceEntity | null {
  const normalized = normalizePreferenceTarget(target);
  if (!normalized) {
    return null;
  }

  return {
    entityType: "goal",
    canonicalName: toDisplayPhrase(target),
    metadata: {
      ontology_phase: "phase4",
      source_kind: "goal"
    }
  };
}

function resolveTypedPlanEntity(target: string): TypedPreferenceEntity | null {
  const normalized = normalizePreferenceTarget(target);
  if (!normalized) {
    return null;
  }

  return {
    entityType: "plan",
    canonicalName: toDisplayPhrase(target),
    metadata: {
      ontology_phase: "phase4",
      source_kind: "plan"
    }
  };
}

function resolveTypedBeliefEntity(target: string): TypedPreferenceEntity | null {
  const normalized = normalizePreferenceTarget(target);
  if (!normalized) {
    return null;
  }

  return {
    entityType: "belief",
    canonicalName: toDisplayPhrase(target),
    metadata: {
      ontology_phase: "phase6",
      source_kind: "belief"
    }
  };
}

function buildRoutineSummary(pattern: Pick<RoutinePatternRow, "weekday_name" | "day_part" | "activity_name" | "location_name">): string {
  const weekday = capitalizeToken(pattern.weekday_name);
  const activity = normalizeWhitespace(pattern.activity_name);
  const location = pattern.location_name ? ` at ${pattern.location_name}` : "";
  return `${weekday} ${activity}${location}`;
}

function resolveTypedRoutineEntity(summary: string): TypedPreferenceEntity {
  return {
    entityType: "routine",
    canonicalName: summary,
    metadata: {
      ontology_phase: "phase6",
      source_kind: "derived_routine"
    }
  };
}

interface SkillStatement {
  readonly name: string;
  readonly canonicalKey: string;
  readonly category?: string;
}

function detectPreferenceCategory(header: string): string | undefined {
  const normalized = normalizeWhitespace(header).toLowerCase();
  if (/\b(?:movie|movies|film|films)\b/u.test(normalized)) {
    return "movie";
  }
  if (/\b(?:sport|sports)\b/u.test(normalized)) {
    return "sport";
  }
  if (/\b(?:food|foods)\b/u.test(normalized)) {
    return "food";
  }
  if (/\b(?:book|books)\b/u.test(normalized)) {
    return "book";
  }
  return undefined;
}

function extractListStatements(content: string): {
  readonly preferences: PreferenceStatement[];
  readonly watchlist: WatchlistStatement[];
} {
  const preferences: PreferenceStatement[] = [];
  const watchlist: WatchlistStatement[] = [];
  const lines = content.split(/\r?\n/u).map((line) => line.trim());
  let mode: "favorite" | "watchlist" | null = null;
  let category: string | undefined;

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (/\b(?:favorite|favourite)\b/iu.test(line)) {
      mode = "favorite";
      category = detectPreferenceCategory(line);
      const inlineParts = line.split(/\s+-\s+/u).map((part) => normalizeWhitespace(part)).filter(Boolean);
      if (inlineParts.length > 1) {
        for (const part of inlineParts.slice(1)) {
          for (const fragment of splitPreferenceTargets(part, category)) {
            const displayTarget = resolveActivityEntity(fragment)?.canonicalName ?? normalizeListItem(fragment);
            const normalizedTarget = normalizePreferenceTarget(displayTarget);
            if (!normalizedTarget) {
              continue;
            }
            preferences.push({
              polarity: "like",
              target: displayTarget,
              canonicalKey: buildCanonicalPreferenceKey(normalizedTarget),
              category
            });
          }
        }
        mode = null;
        category = undefined;
      }
      continue;
    }

    if (/\b(?:wants?\s+to\s+(?:watch|see)|watch\s*list)\b/iu.test(line)) {
      mode = "watchlist";
      category = detectPreferenceCategory(line) ?? "movie";
      const inlineParts = line.split(/\s+-\s+/u).map((part) => normalizeWhitespace(part)).filter(Boolean);
      if (inlineParts.length > 1) {
        for (const part of inlineParts.slice(1)) {
          const normalizedTarget = normalizePreferenceTarget(part);
          if (!normalizedTarget) {
            continue;
          }
          watchlist.push({
            title: normalizeListItem(part),
            canonicalKey: buildCanonicalWatchlistKey(normalizedTarget),
            category
          });
        }
        mode = null;
        category = undefined;
      }
      continue;
    }

    const bulletMatch = line.match(/^[-*]{1,2}\s*(.+)$/u);
    if (!bulletMatch || !mode) {
      mode = null;
      category = undefined;
      continue;
    }

    if (mode === "favorite") {
      for (const fragment of splitPreferenceTargets(bulletMatch[1] ?? "", category)) {
        const displayTarget = resolveActivityEntity(fragment)?.canonicalName ?? normalizeListItem(fragment);
        const normalizedTarget = normalizePreferenceTarget(displayTarget);
        if (!displayTarget || !normalizedTarget) {
          continue;
        }
        preferences.push({
          polarity: "like",
          target: displayTarget,
          canonicalKey: buildCanonicalPreferenceKey(normalizedTarget),
          category
        });
      }
      continue;
    }

    const item = normalizeListItem(bulletMatch[1] ?? "");
    const normalizedTarget = normalizePreferenceTarget(item);
    if (!item || !normalizedTarget) {
      continue;
    }

    watchlist.push({
      title: item,
      canonicalKey: buildCanonicalWatchlistKey(normalizedTarget),
      category
    });
  }

  return { preferences, watchlist };
}

function extractPreferenceStatements(content: string): PreferenceStatement[] {
  const statements: PreferenceStatement[] = [...extractListStatements(content).preferences];
  const normalizedContent = content.replace(
    /\band\s+(?=(?:(?:i|user)\s+)?(?:prefer|like|love|enjoy|hate|dislike)\b)/giu,
    ". "
  );
  const clauses = normalizedContent
    .split(/[.!?\n]+/u)
    .map((clause) => normalizeWhitespace(clause))
    .filter(Boolean);

  for (const clause of clauses) {
    const firstPersonPreferenceContext =
      /\b(?:i|user)\b/iu.test(clause) || /\bmy\s+(?:personal\s+)?preferences?\b/iu.test(clause);

    const favoriteMatch = clause.match(/\b(?:(?:my|user(?:'s)?|steve(?:'s)?)\s+)?favorite\s+(.+?)\s+is\s+(.+)$/iu);
    if (favoriteMatch) {
      const category = detectPreferenceCategory(favoriteMatch[1] ?? "");
      for (const fragment of splitPreferenceTargets(favoriteMatch[2] ?? "", category)) {
        const target = resolveActivityEntity(fragment)?.canonicalName ?? normalizeListItem(fragment);
        const canonicalTarget = normalizePreferenceTarget(target);
        if (!canonicalTarget) {
          continue;
        }
        statements.push({
          polarity: "like",
          target,
          canonicalKey: buildCanonicalPreferenceKey(canonicalTarget),
          category
        });
      }
      continue;
    }

    const comparativePreferenceMatch = clause.match(
      /\b(?:(?:i|user)\s+)?prefer\s+(.+?)\s+over\s+(.+)$/iu
    );
    if (comparativePreferenceMatch && firstPersonPreferenceContext) {
      const preferredTarget = normalizePreferenceTarget(comparativePreferenceMatch[1] ?? "");
      const replacedTarget = normalizePreferenceTarget(comparativePreferenceMatch[2] ?? "");
      if (preferredTarget) {
        statements.push({
          polarity: "like",
          target: preferredTarget,
          canonicalKey: buildCanonicalPreferenceKey(preferredTarget)
        });
      }
      if (replacedTarget) {
        statements.push({
          polarity: "dislike",
          target: replacedTarget,
          canonicalKey: buildCanonicalPreferenceKey(replacedTarget)
        });
      }
      continue;
    }

    const switchedPreferenceMatch = clause.match(
      /\b(?:(?:i|user)\s+)?(?:switched|switching)\s+from\s+(.+?)\s+to\s+(.+)$/iu
    );
    if (switchedPreferenceMatch && firstPersonPreferenceContext) {
      const previousTarget = normalizePreferenceTarget(switchedPreferenceMatch[1] ?? "");
      const nextTarget = normalizePreferenceTarget(switchedPreferenceMatch[2] ?? "");
      if (nextTarget) {
        statements.push({
          polarity: "like",
          target: nextTarget,
          canonicalKey: buildCanonicalPreferenceKey(nextTarget)
        });
      }
      if (previousTarget) {
        statements.push({
          polarity: "dislike",
          target: previousTarget,
          canonicalKey: buildCanonicalPreferenceKey(previousTarget)
        });
      }
      continue;
    }

    const dontLikeMatch = clause.match(/\b(?:(?:i|user)\s+)?(?:do\s+not|don't)\s+like\s+(.+)$/iu);
    if (dontLikeMatch && firstPersonPreferenceContext) {
      for (const fragment of splitPreferenceTargets(dontLikeMatch[1] ?? "")) {
        const target = resolveActivityEntity(fragment)?.canonicalName ?? normalizeListItem(fragment);
        const canonicalTarget = normalizePreferenceTarget(target);
        if (!canonicalTarget) {
          continue;
        }
        statements.push({
          polarity: "dislike",
          target,
          canonicalKey: buildCanonicalPreferenceKey(canonicalTarget)
        });
      }
      continue;
    }

    const negativeMatch = clause.match(/\b(?:(?:i|user)\s+)?(?:said\s+that\s+)?(?:really\s+)?(?:hate|dislike)\s+(.+)$/iu);
    if (negativeMatch && firstPersonPreferenceContext) {
      for (const fragment of splitPreferenceTargets(negativeMatch[1] ?? "")) {
        const target = resolveActivityEntity(fragment)?.canonicalName ?? normalizeListItem(fragment);
        const canonicalTarget = normalizePreferenceTarget(target);
        if (!canonicalTarget) {
          continue;
        }
        statements.push({
          polarity: "dislike",
          target,
          canonicalKey: buildCanonicalPreferenceKey(canonicalTarget)
        });
      }
      continue;
    }

    const positiveMatch = clause.match(/\b(?:(?:i|user)\s+)?(?:said\s+that\s+)?(?:really\s+)?(?:like|love|prefer|enjoy)\s+(.+)$/iu);
    if (positiveMatch && firstPersonPreferenceContext) {
      for (const fragment of splitPreferenceTargets(positiveMatch[1] ?? "")) {
        const activityEntity = resolveActivityEntity(fragment);
        const target = activityEntity?.canonicalName ?? normalizeListItem(fragment);
        const canonicalTarget = normalizePreferenceTarget(target);
        if (!canonicalTarget) {
          continue;
        }
        statements.push({
          polarity: "like",
          target,
          canonicalKey: buildCanonicalPreferenceKey(canonicalTarget),
          category: activityEntity ? "sport" : undefined
        });
      }
    }
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey && candidate.polarity === statement.polarity) === index
  );
}

function extractWatchlistStatements(content: string): WatchlistStatement[] {
  const statements = [...extractListStatements(content).watchlist];
  const clauses = content
    .split(/[.!?\n]+/u)
    .map((clause) => normalizeWhitespace(clause))
    .filter(Boolean);

  for (const clause of clauses) {
    const explicitWatchMatch = clause.match(/\b(?:(?:i|user|steve)\s+)?(?:want|wants|wanted|would\s+like)\s+to\s+(?:watch|see)\s+(.+)$/iu);
    if (!explicitWatchMatch) {
      continue;
    }

    const fragments = (explicitWatchMatch[1] ?? "")
      .split(/\s+-\s+|(?:\r?\n)+[-*]?\s*/u)
      .map((value) => normalizeListItem(value))
      .filter(Boolean);

    for (const fragment of fragments) {
      const canonicalTarget = normalizePreferenceTarget(fragment);
      if (!canonicalTarget) {
        continue;
      }

      statements.push({
        title: fragment,
        canonicalKey: buildCanonicalWatchlistKey(canonicalTarget),
        category: "movie"
      });
    }
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey) === index
  );
}

function extractSkillStatements(content: string): SkillStatement[] {
  const statements: SkillStatement[] = [];
  const normalized = normalizeWhitespace(content);

  const explicitPhrases = [
    ...normalized.matchAll(/\bself-taught\s+([A-Za-z][A-Za-z0-9 +./-]{3,80})/giu),
    ...normalized.matchAll(/\bbuilt expertise in\s+([A-Za-z][A-Za-z0-9 +./-]{3,80})/giu),
    ...normalized.matchAll(/\bFAA Part 107\b/giu)
  ];

  for (const match of explicitPhrases) {
    const raw = normalizeWhitespace(match[1] ?? match[0] ?? "");
    if (!raw) {
      continue;
    }

    if (/^faa part 107$/iu.test(raw)) {
      statements.push({
        name: "Drone Operations",
        canonicalKey: "skill:drone_operations"
      });
      continue;
    }

    const resolved = resolveTypedSkillEntity(raw);
    if (resolved) {
      statements.push({
        name: resolved.canonicalName,
        canonicalKey: `skill:${normalizePreferenceTarget(resolved.canonicalName).replace(/\s+/gu, "_")}`
      });
    }
  }

  if (/\bdrone\b/iu.test(normalized) && /\bspecialist\b/iu.test(normalized)) {
    statements.push({
      name: "Drone Operations",
      canonicalKey: "skill:drone_operations"
    });
  }

  if (/\bphotogrammetry\b/iu.test(normalized) && /\b(?:expertise|specialist|using|built)\b/iu.test(normalized)) {
    statements.push({
      name: "Photogrammetry",
      canonicalKey: "skill:photogrammetry"
    });
  }

  if (/\bStable Diffusion\b/iu.test(normalized)) {
    statements.push({
      name: "Stable Diffusion",
      canonicalKey: "skill:stable_diffusion"
    });
  }

  if (/\bComfyUI\b/u.test(normalized)) {
    statements.push({
      name: "ComfyUI",
      canonicalKey: "skill:comfyui"
    });
  }

  if (/\bDeforum\b/u.test(normalized)) {
    statements.push({
      name: "Deforum",
      canonicalKey: "skill:deforum"
    });
  }

  if (/\bAnimateDiff\b/u.test(normalized)) {
    statements.push({
      name: "AnimateDiff",
      canonicalKey: "skill:animatediff"
    });
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey) === index
  );
}

function extractDecisionStatements(content: string): DecisionStatement[] {
  const statements: DecisionStatement[] = [];
  const matches = [
    ...content.matchAll(/\b(?:i|we)\s+(?:decided|choose|chose)\s+to\s+(.+?)(?:[!?]\s+|\n+|$)/giu),
    ...content.matchAll(/\bdecision\s*:\s*(.+?)(?:[!?]\s+|\n+|$)/giu)
  ];

  for (const match of matches) {
    const actionText = normalizeWhitespace((match[1] ?? "").split(/\s+(?:so|because)\s+/iu)[0] ?? "");
    if (!actionText) {
      continue;
    }

    const summary = toDisplayPhrase(actionText.replace(/^to\s+/iu, "").replace(/[.]+$/u, ""));
    const normalizedKey = normalizePreferenceTarget(summary).replace(/\s+/gu, "_");
    if (!normalizedKey) {
      continue;
    }

    statements.push({
      summary,
      canonicalKey: buildCanonicalDecisionKey(normalizedKey)
    });
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey) === index
  );
}

function extractConstraintStatements(content: string): ConstraintStatement[] {
  const statements: ConstraintStatement[] = [];
  const alwaysMatches = [
    ...content.matchAll(/(?:^|\n)\s*(?:for\s+the\s+brain,\s*)?always\s+(.+?)(?:[.!?]\s+|\n+|$)/giu),
    ...content.matchAll(/\b(?:the\s+brain|this\s+brain|the\s+system|our\s+system)\s+should\s+always\s+(.+?)(?:[.!?]\s+|\n+|$)/giu)
  ];
  const neverMatches = [
    ...content.matchAll(/(?:^|\n)\s*never\s+(.+?)(?:[.!?]\s+|\n+|$)/giu),
    ...content.matchAll(/\b(?:the\s+brain|this\s+brain|the\s+system|our\s+system)\s+should\s+never\s+(.+?)(?:[.!?]\s+|\n+|$)/giu)
  ];
  const clarifyMatches = [...content.matchAll(/\bask\s+for\s+clarification\s+instead\s+of\s+guessing\b/giu)];

  for (const match of alwaysMatches) {
    const rule = normalizeWhitespace((match[1] ?? "").replace(/[.]+$/u, ""));
    if (!rule) {
      continue;
    }
    const displayRule = toDisplayPhrase(rule);
    const normalizedKey = normalizePreferenceTarget(displayRule).replace(/\s+/gu, "_");
    if (!normalizedKey) {
      continue;
    }

    statements.push({
      rule: displayRule,
      canonicalKey: buildCanonicalConstraintKey(normalizedKey),
      modality: "always"
    });
  }

  for (const match of neverMatches) {
    const ruleBody = normalizeWhitespace((match[1] ?? "").replace(/[.]+$/u, ""));
    if (!ruleBody) {
      continue;
    }
    const displayRule = toDisplayPhrase(`never ${ruleBody}`);
    const normalizedKey = normalizePreferenceTarget(displayRule).replace(/\s+/gu, "_");
    if (!normalizedKey) {
      continue;
    }

    statements.push({
      rule: displayRule,
      canonicalKey: buildCanonicalConstraintKey(normalizedKey),
      modality: "never"
    });
  }

  for (const _ of clarifyMatches) {
    const displayRule = toDisplayPhrase("ask for clarification instead of guessing");
    const normalizedKey = normalizePreferenceTarget(displayRule).replace(/\s+/gu, "_");
    if (!normalizedKey) {
      continue;
    }

    statements.push({
      rule: displayRule,
      canonicalKey: buildCanonicalConstraintKey(normalizedKey),
      modality: "clarify"
    });
  }

  for (const match of content.matchAll(/\b(peanuts?)\s+(?:are|is)\s+an?\s+absolute\s+dietary\s+blocker\s+for\s+(?:me|Steve(?:\s+Tietze)?)(?:\s+now)?\b/giu)) {
    const subject = toDisplayPhrase(match[1] ?? "Peanuts");
    const displayRule = `${subject} are an absolute dietary blocker for Steve`;
    const normalizedKey = normalizePreferenceTarget(displayRule).replace(/\s+/gu, "_");
    if (!normalizedKey) {
      continue;
    }
    statements.push({
      rule: displayRule,
      canonicalKey: buildCanonicalConstraintKey(normalizedKey),
      modality: "never"
    });
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey) === index
  );
}

function extractStyleSpecStatements(content: string): StyleSpecStatement[] {
  const statements: StyleSpecStatement[] = [];
  const register = (rule: string, scope: StyleSpecStatement["scope"]): void => {
    const displayRule = toDisplayPhrase(rule);
    const normalized = normalizePreferenceTarget(displayRule);
    if (!normalized) {
      return;
    }
    const matched = STYLE_SPEC_CANONICALS.get(normalized);
    const canonicalName = matched?.canonicalName ?? displayRule;
    const canonicalScope = matched?.scope ?? scope;
    const canonicalKey = buildCanonicalStyleSpecKey(
      normalizePreferenceTarget(canonicalName).replace(/\s+/gu, "_")
    );
    statements.push({
      rule: canonicalName,
      canonicalKey,
      scope: canonicalScope
    });
  };

  if (/\bkeep\s+(?:responses?|replies?)\s+concise\b/iu.test(content) || /\b(?:prefers?|preferred)\s+concise\s+(?:responses?|replies?)\b/iu.test(content)) {
    register("Keep Responses Concise", "response_style");
  }

  if (/\bask\s+notebooklm\s+first(?:\s+before\s+(?:changing|patching)\s+(?:the\s+)?ontology)?\b/iu.test(content)) {
    register("Ask NotebookLM First Before Changing Ontology", "workflow");
  }

  if (/\bwipe\s+and\s+replay\s+the\s+(?:db|database)(?:\s+after\s+each\s+slice)?\b/iu.test(content)) {
    register("Wipe And Replay The Database After Each Slice", "workflow");
  }

  if (
    /\bprefer\s+natural-?language\s+queryability\b/iu.test(content) ||
    /\bnatural-?language\s+queryability\s+matters\b/iu.test(content)
  ) {
    register("Prefer Natural-Language Queryability", "retrieval_style");
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey) === index
  );
}

function extractGoalStatements(content: string): GoalStatement[] {
  const statements: GoalStatement[] = [];
  const matches = [
    ...content.matchAll(/\b(?:that'?s|that is|my|our|current)\s+goal\s*:?\s*(.+?)(?:[.!?]\s+|\n+|$)/giu),
    ...content.matchAll(/\bgoal\s*:\s*(.+?)(?:[.!?]\s+|\n+|$)/giu)
  ];

  for (const match of matches) {
    let summary = normalizeWhitespace((match[1] ?? "").replace(/^to\s+/iu, "").replace(/[.]+$/u, ""));
    if (!summary) {
      continue;
    }

    if (/^stay\s+here$/iu.test(summary) && /\bThailand\b/u.test(content)) {
      summary = "Stay in Thailand";
    }

    const displaySummary = toDisplayPhrase(summary);
    const normalizedKey = normalizePreferenceTarget(displaySummary).replace(/\s+/gu, "_");
    if (!normalizedKey) {
      continue;
    }

    statements.push({
      summary: displaySummary,
      canonicalKey: buildCanonicalGoalKey(normalizedKey)
    });
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey) === index
  );
}

function extractPlanStatements(content: string): PlanStatement[] {
  const statements: PlanStatement[] = [];
  const conferenceMatch = content.match(/\b(?:i|we)\s+(?:am|are|'m|'re)\s+going\s+to\s+go\s+to\s+a\s+conference\s+in\s+([A-Z][A-Za-z]+)\b/iu);
  if (conferenceMatch) {
    const location = normalizeWhitespace(conferenceMatch[1] ?? "");
    const projectHint = /\bTwo-Way\b/u.test(content) ? "Two-Way" : /\bplatform\b/iu.test(content) ? "platform" : undefined;
    const summary = projectHint
      ? `Attend conference in ${location} for ${projectHint}`
      : `Attend conference in ${location}`;
    const normalizedKey = normalizePreferenceTarget(summary).replace(/\s+/gu, "_");
    if (normalizedKey) {
      statements.push({
        summary,
        canonicalKey: buildCanonicalPlanKey(normalizedKey),
        projectHint
      });
    }
  }

  const explicitPlanMatches = [...content.matchAll(/\bplan\s*:\s*(.+?)(?:[.!?]\s+|\n+|$)/giu)];
  for (const match of explicitPlanMatches) {
    const summary = normalizeWhitespace((match[1] ?? "").replace(/^to\s+/iu, "").replace(/[.]+$/u, ""));
    if (!summary) {
      continue;
    }
    const displaySummary = toDisplayPhrase(summary);
    const normalizedKey = normalizePreferenceTarget(displaySummary).replace(/\s+/gu, "_");
    if (!normalizedKey) {
      continue;
    }
    statements.push({
      summary: displaySummary,
      canonicalKey: buildCanonicalPlanKey(normalizedKey)
    });
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey) === index
  );
}

function inferBeliefTopic(explicitTopic: string | null, summary: string): string {
  if (explicitTopic) {
    return explicitTopic;
  }

  if (/\b(?:hosted|local-first|local)\s+(?:infrastructure|architecture|embeddings)\b/iu.test(summary)) {
    return "Infrastructure";
  }

  const sovereigntyMatch = summary.match(/\b(data sovereignty)\b/iu);
  if (sovereigntyMatch) {
    return toDisplayPhrase(sovereigntyMatch[1] ?? "Data Sovereignty");
  }

  const genericMatch = summary.match(/^([A-Za-z0-9][A-Za-z0-9\s-]{2,40}?)\s+(?:matters|is|are|should)\b/u);
  if (genericMatch?.[1]) {
    return toDisplayPhrase(genericMatch[1]);
  }

  return "General Belief";
}

function extractBeliefStatements(content: string): BeliefStatement[] {
  const statements: BeliefStatement[] = [];

  const register = (topicInput: string | null, summaryInput: string) => {
    const summary = toDisplayPhrase(normalizeWhitespace(summaryInput.replace(/[.]+$/u, "")));
    if (!summary) {
      return;
    }
    const topic = inferBeliefTopic(
      topicInput ? toDisplayPhrase(normalizeWhitespace(topicInput)) : null,
      summary
    );
    const normalizedKey = normalizeBeliefTopicKey(topic);
    if (!normalizedKey) {
      return;
    }
    statements.push({
      topic,
      summary,
      canonicalKey: buildCanonicalBeliefKey(normalizedKey)
    });
  };

  for (const match of content.matchAll(/\b(?:my|our)\s+(?:stance|opinion)\s+on\s+(.+?)\s+is(?:\s+now)?(?:\s+that)?\s+(.+?)(?:[.!?]\s+|\n+|$)/giu)) {
    register(match[1] ?? null, match[2] ?? "");
  }

  for (const match of content.matchAll(/\b(?:i|we)\s+(?:now\s+)?believe\s+(.+?)(?:[.!?]\s+|\n+|$)/giu)) {
    register(null, match[1] ?? "");
  }

  for (const match of content.matchAll(/\bin\s+my\s+view\s+(.+?)(?:[.!?]\s+|\n+|$)/giu)) {
    register(null, match[1] ?? "");
  }

  return statements.filter((statement, index, values) =>
    values.findIndex((candidate) => candidate.canonicalKey === statement.canonicalKey && candidate.summary === statement.summary) === index
  );
}

function buildDecision(
  action: ConsolidationAction,
  reason: string,
  confidence: number,
  supersedesId?: string
): ConsolidationDecision {
  return {
    action,
    reason,
    confidence,
    supersedesId
  };
}

async function resolvePlaceSpecificity(
  client: PoolClient,
  namespaceId: string,
  currentPlaceEntityId: string,
  nextPlaceEntityId: string
): Promise<PlaceSpecificityDecision> {
  if (currentPlaceEntityId === nextPlaceEntityId) {
    return "keep_current";
  }

  const currentUnderNext = await client.query<{ matches: boolean }>(
    `
      WITH RECURSIVE containment(subject_entity_id, object_entity_id, hops, path) AS (
        SELECT e.id AS subject_entity_id, e.parent_entity_id AS object_entity_id, 1, ARRAY[e.id, e.parent_entity_id]::uuid[]
        FROM entities e
        WHERE e.namespace_id = $1
          AND e.id = $2::uuid
          AND e.parent_entity_id IS NOT NULL

        UNION ALL

        SELECT containment.subject_entity_id, e.parent_entity_id AS object_entity_id, containment.hops + 1, containment.path || e.parent_entity_id
        FROM containment
        JOIN entities e
          ON e.namespace_id = $1
         AND e.id = containment.object_entity_id
         AND e.parent_entity_id IS NOT NULL
        WHERE containment.hops < 6
          AND NOT (e.parent_entity_id = ANY(containment.path))
      )
      SELECT EXISTS(
        SELECT 1
        FROM containment
        WHERE subject_entity_id = $2::uuid
          AND object_entity_id = $3::uuid
      ) AS matches
    `,
    [namespaceId, currentPlaceEntityId, nextPlaceEntityId]
  );

  if (currentUnderNext.rows[0]?.matches) {
    return "keep_current";
  }

  const nextUnderCurrent = await client.query<{ matches: boolean }>(
    `
      WITH RECURSIVE containment(subject_entity_id, object_entity_id, hops, path) AS (
        SELECT e.id AS subject_entity_id, e.parent_entity_id AS object_entity_id, 1, ARRAY[e.id, e.parent_entity_id]::uuid[]
        FROM entities e
        WHERE e.namespace_id = $1
          AND e.id = $2::uuid
          AND e.parent_entity_id IS NOT NULL

        UNION ALL

        SELECT containment.subject_entity_id, e.parent_entity_id AS object_entity_id, containment.hops + 1, containment.path || e.parent_entity_id
        FROM containment
        JOIN entities e
          ON e.namespace_id = $1
         AND e.id = containment.object_entity_id
         AND e.parent_entity_id IS NOT NULL
        WHERE containment.hops < 6
          AND NOT (e.parent_entity_id = ANY(containment.path))
      )
      SELECT EXISTS(
        SELECT 1
        FROM containment
        WHERE subject_entity_id = $2::uuid
          AND object_entity_id = $3::uuid
      ) AS matches
    `,
    [namespaceId, nextPlaceEntityId, currentPlaceEntityId]
  );

  if (nextUnderCurrent.rows[0]?.matches) {
    return "replace_with_new";
  }

  return "independent";
}

async function markCandidate(
  client: PoolClient,
  options: {
    readonly candidateId: string;
    readonly status: "accepted" | "rejected" | "superseded";
    readonly decisionReason: string;
    readonly canonicalKey?: string;
    readonly normalizedValue?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      UPDATE memory_candidates
      SET
        status = $2,
        processed_at = now(),
        decision_reason = $3,
        canonical_key = COALESCE($4, canonical_key),
        normalized_value = CASE
          WHEN $5::jsonb IS NULL THEN normalized_value
          ELSE $5::jsonb
        END
      WHERE id = $1
    `,
    [
      options.candidateId,
      options.status,
      options.decisionReason,
      options.canonicalKey ?? null,
      options.normalizedValue ? JSON.stringify(options.normalizedValue) : null
    ]
  );
}

async function markClaimCandidate(
  client: PoolClient,
  options: {
    readonly candidateId: string;
    readonly status: "accepted" | "rejected" | "promoted";
    readonly reason: string;
  }
): Promise<void> {
  await client.query(
    `
      UPDATE claim_candidates
      SET
        status = $2,
        metadata = claim_candidates.metadata || $3::jsonb
      WHERE id = $1
    `,
    [
      options.candidateId,
      options.status,
      JSON.stringify({
        promotion_reason: options.reason,
        promoted_at: new Date().toISOString()
      })
    ]
  );
}

async function upsertTypedEntity(
  client: PoolClient,
  namespaceId: string,
  descriptor: TypedPreferenceEntity
): Promise<string> {
  let parentEntityId: string | null = null;
  if (descriptor.parentCanonicalName && descriptor.parentEntityType) {
    parentEntityId = await upsertTypedEntity(client, namespaceId, {
      entityType: descriptor.parentEntityType,
      canonicalName: descriptor.parentCanonicalName,
      metadata: {
        source: "ontology_parent_seed",
        ontology_phase: "phase4"
      }
    });
  }

  const result = await client.query<{ id: string }>(
    `
      INSERT INTO entities (
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        last_seen_at,
        parent_entity_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, now(), $5, $6::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        parent_entity_id = COALESCE(EXCLUDED.parent_entity_id, entities.parent_entity_id),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id
    `,
    [
      namespaceId,
      descriptor.entityType,
      descriptor.canonicalName,
      normalizePreferenceTarget(descriptor.canonicalName),
      parentEntityId,
      JSON.stringify(descriptor.metadata ?? {})
    ]
  );

  const entityId = result.rows[0]?.id;
  if (!entityId) {
    throw new Error(`Failed to upsert typed entity ${descriptor.canonicalName}`);
  }

  const aliases = [descriptor.canonicalName, ...(descriptor.aliases ?? [])]
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);
  for (const alias of new Set(aliases)) {
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
        DO UPDATE SET metadata = entity_aliases.metadata || EXCLUDED.metadata
      `,
      [
        entityId,
        alias,
        normalizePreferenceTarget(alias),
        JSON.stringify({
          source: "candidate_consolidation",
          ontology_phase: "phase4"
        })
      ]
    );
  }

  return entityId;
}

async function upsertTypedEntityMention(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly entityId: string;
    readonly sourceMemoryId: string | null;
    readonly sourceChunkId: string | null;
    readonly mentionText: string;
    readonly occurredAt: string;
    readonly metadata: Record<string, unknown>;
  }
): Promise<void> {
  if (!options.sourceMemoryId && !options.sourceChunkId) {
    return;
  }

  await client.query(
    `
      INSERT INTO memory_entity_mentions (
        namespace_id,
        entity_id,
        source_memory_id,
        source_chunk_id,
        mention_text,
        mention_role,
        confidence,
        occurred_at,
        metadata
      )
      VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, 'mentioned', 0.82, $6, $7::jsonb)
      ON CONFLICT DO NOTHING
    `,
    [
      options.namespaceId,
      options.entityId,
      options.sourceMemoryId,
      options.sourceChunkId,
      options.mentionText,
      options.occurredAt,
      JSON.stringify(options.metadata)
    ]
  );
}

async function loadNamespacePersonLabel(
  client: PoolClient,
  namespaceId: string,
  content: string
): Promise<string> {
  const explicitMatch = content.match(/\bSteve(?:\s+Tietze)?\b/u);
  if (explicitMatch) {
    return normalizeWhitespace(explicitMatch[0] ?? "Steve");
  }

  const result = await client.query<{ canonical_name: string }>(
    `
      SELECT canonical_name
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = 'self'
      ORDER BY last_seen_at DESC
      LIMIT 1
    `,
    [namespaceId]
  );

  return result.rows[0]?.canonical_name ?? "User";
}

async function resolveCandidateSourceMemoryId(
  client: PoolClient,
  candidate: Pick<CandidateRow, "namespace_id" | "source_memory_id" | "source_artifact_observation_id">
): Promise<string | null> {
  if (candidate.source_memory_id) {
    return candidate.source_memory_id;
  }

  if (!candidate.source_artifact_observation_id) {
    return null;
  }

  const rows = await client.query<{ id: string }>(
    `
      SELECT id
      FROM episodic_memory
      WHERE namespace_id = $1
        AND artifact_observation_id = $2
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `,
    [candidate.namespace_id, candidate.source_artifact_observation_id]
  );

  return rows.rows[0]?.id ?? null;
}

async function upsertProceduralState(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly stateType: string;
    readonly stateKey: string;
    readonly stateValue: Record<string, unknown>;
    readonly occurredAt: string;
    readonly sourceMemoryId?: string | null;
    readonly metadata: Record<string, unknown>;
    readonly supersessionMode?: "replace" | "append" | "specificity_guarded";
  }
): Promise<{ promoted: boolean; superseded: boolean }> {
  const stateValue = {
    ...options.stateValue,
    source_memory_id: options.sourceMemoryId ?? null
  };
  const replaceExisting = options.supersessionMode !== "append";
  const activeState = await client.query<{ id: string; version: number; state_value: Record<string, unknown> }>(
    `
      SELECT id, version, state_value
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = $2
        AND state_key = $3
        AND valid_until IS NULL
      ORDER BY version DESC
      LIMIT 1
    `,
    [options.namespaceId, options.stateType, options.stateKey]
  );

  const activeRow = activeState.rows[0];
  if (activeRow && JSON.stringify(activeRow.state_value) === JSON.stringify(stateValue)) {
    await client.query(
      `
        UPDATE procedural_memory
        SET metadata = procedural_memory.metadata || $2::jsonb
        WHERE id = $1
      `,
      [activeRow.id, JSON.stringify(options.metadata)]
    );
    return { promoted: false, superseded: false };
  }

  if (activeRow && replaceExisting) {
    await client.query(
      `
        UPDATE procedural_memory
        SET valid_until = $2
        WHERE id = $1
      `,
      [activeRow.id, options.occurredAt]
    );
  }

  await client.query(
    `
      INSERT INTO procedural_memory (
        namespace_id,
        state_type,
        state_key,
        state_value,
        version,
        updated_at,
        valid_from,
        valid_until,
        supersedes_id,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6, NULL, $7, $8::jsonb)
    `,
    [
      options.namespaceId,
      options.stateType,
      options.stateKey,
      JSON.stringify(stateValue),
      (activeRow?.version ?? 0) + 1,
      options.occurredAt,
      replaceExisting ? activeRow?.id ?? null : null,
      JSON.stringify(options.metadata)
    ]
  );

  return { promoted: true, superseded: replaceExisting && Boolean(activeRow) };
}

async function upsertProceduralPreference(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly canonicalKey: string;
    readonly person?: string;
    readonly target: string;
    readonly polarity: "like" | "dislike";
    readonly category?: string;
    readonly entityId?: string | null;
    readonly entityType?: TypedPreferenceEntityType | null;
    readonly occurredAt: string;
    readonly sourceMemoryId: string | null;
    readonly semanticId: string;
  }
): Promise<void> {
  const activeState = await client.query<{
    id: string;
    version: number;
  }>(
    `
      SELECT id, version
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = 'preference'
        AND state_key = $2
        AND valid_until IS NULL
      ORDER BY version DESC
      LIMIT 1
    `,
    [options.namespaceId, options.canonicalKey]
  );

  const activeRow = activeState.rows[0];
  if (activeRow) {
    await client.query(
      `
        UPDATE procedural_memory
        SET valid_until = $2
        WHERE id = $1
      `,
      [activeRow.id, options.occurredAt]
    );
  }

  const nextVersion = (activeRow?.version ?? 0) + 1;
  await client.query(
    `
      INSERT INTO procedural_memory (
        namespace_id,
        state_type,
        state_key,
        state_value,
        version,
        updated_at,
        valid_from,
        valid_until,
        supersedes_id,
        metadata
      )
      VALUES ($1, 'preference', $2, $3::jsonb, $4, $5, $5, NULL, $6, $7::jsonb)
    `,
    [
      options.namespaceId,
      options.canonicalKey,
      JSON.stringify({
        person: options.person ?? null,
        target: options.target,
        polarity: options.polarity,
        category: options.category ?? null,
        entity_id: options.entityId ?? null,
        entity_type: options.entityType ?? null,
        semantic_memory_id: options.semanticId,
        source_memory_id: options.sourceMemoryId
      }),
      nextVersion,
      options.occurredAt,
      activeRow?.id ?? null,
      JSON.stringify({
        source: "candidate_consolidation"
        ,
        is_anchor: true,
        memory_temperature: "hot"
      })
    ]
  );
}

async function promotePreferenceCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractPreferenceStatements(candidate.content);
  const watchlistStatements = extractWatchlistStatements(candidate.content);

  if (statements.length === 0 && watchlistStatements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic preference or watchlist statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic preference or watchlist statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const decisions: ConsolidationDecision[] = [];
  let promotedCount = 0;
  let supersededCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;
  const personLabel = await loadNamespacePersonLabel(client, candidate.namespace_id, candidate.content);
  const sourceMemoryId = await resolveCandidateSourceMemoryId(client, candidate);

  for (const statement of statements) {
    const typedEntity = resolveTypedPreferenceEntity(statement.target, statement.category);
    const typedEntityId = typedEntity
      ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity)
      : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.target,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          polarity: statement.polarity,
          category: statement.category ?? null
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      target: statement.target,
      polarity: statement.polarity,
      category: statement.category ?? null,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    const activeRows = await client.query<{
      id: string;
      normalized_value: Record<string, unknown>;
    }>(
      `
        SELECT id, normalized_value
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [candidate.namespace_id, statement.canonicalKey]
    );

    const activeRow = activeRows.rows[0];
    const activePolarity =
      typeof activeRow?.normalized_value?.polarity === "string"
        ? activeRow.normalized_value.polarity
        : null;

    if (activeRow && activePolarity === statement.polarity) {
      await client.query(
        `
          UPDATE semantic_memory
          SET metadata = semantic_memory.metadata || $2::jsonb
          WHERE id = $1
        `,
        [
          activeRow.id,
          JSON.stringify({
            last_confirmed_at: occurredAt,
            last_candidate_id: candidate.candidate_id
          })
        ]
      );

      decisions.push(buildDecision("UPDATE", `Reinforced active preference ${statement.canonicalKey}.`, 0.72, activeRow.id));
      continue;
    }

    const insertResult = await client.query<{ id: string }>(
      `
      INSERT INTO semantic_memory (
        namespace_id,
        content_abstract,
        importance_score,
        valid_from,
        valid_until,
        status,
        is_anchor,
        source_episodic_id,
        source_chunk_id,
        source_artifact_observation_id,
        memory_kind,
        canonical_key,
        normalized_value,
        metadata,
        decay_exempt
      )
      VALUES ($1, $2, $3, $4, NULL, 'active', true, $5, $6, $7, 'preference', $8, $9::jsonb, $10::jsonb, true)
      RETURNING id
      `,
      [
        candidate.namespace_id,
        `${personLabel} ${statement.polarity === "like" ? "likes" : "dislikes"} ${statement.category ? `${statement.category} ` : ""}${statement.target}.`,
        statement.category ? 0.84 : 0.82,
        occurredAt,
        sourceMemoryId,
        candidate.source_chunk_id,
        candidate.source_artifact_observation_id,
        statement.canonicalKey,
        JSON.stringify(lastNormalizedValue),
        JSON.stringify({
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          is_anchor: true,
          memory_temperature: "hot"
        })
      ]
    );

    const semanticId = insertResult.rows[0]?.id;
    if (!semanticId) {
      throw new Error("Failed to insert semantic preference memory");
    }

    promotedCount += 1;

    if (activeRow) {
      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = $2,
            status = 'superseded',
            superseded_by_id = $3
          WHERE id = $1
        `,
        [activeRow.id, occurredAt, semanticId]
      );

      supersededCount += 1;
      decisions.push(
        buildDecision("SUPERSEDE", `Superseded ${statement.canonicalKey} with new preference evidence.`, 0.88, activeRow.id)
      );
    } else {
      decisions.push(buildDecision("ADD", `Added new preference ${statement.canonicalKey}.`, 0.84));
    }

    await upsertProceduralPreference(client, {
      namespaceId: candidate.namespace_id,
      canonicalKey: statement.canonicalKey,
      person: personLabel,
      target: statement.target,
      polarity: statement.polarity,
      category: statement.category,
      entityId: typedEntityId,
      entityType: typedEntity?.entityType ?? null,
      occurredAt,
      sourceMemoryId,
      semanticId
    });
  }

  for (const statement of watchlistStatements) {
    const typedEntity = resolveTypedWatchlistEntity(statement.title, statement.category);
    const typedEntityId = typedEntity
      ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity)
      : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.title,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          state_type: "watchlist_item",
          category: statement.category ?? null
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      title: statement.title,
      category: statement.category ?? null,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    const result = await upsertProceduralState(client, {
      namespaceId: candidate.namespace_id,
      stateType: "watchlist_item",
      stateKey: statement.canonicalKey,
      stateValue: {
        title: statement.title,
        category: statement.category ?? "movie",
        person: personLabel,
        status: "to_watch",
        source_memory_id: sourceMemoryId,
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null
      },
      occurredAt,
      sourceMemoryId,
      metadata: {
        source: "candidate_consolidation",
        candidate_id: candidate.candidate_id,
        is_anchor: true,
        memory_temperature: "warm"
      },
      supersessionMode: "replace"
    });

    promotedCount += result.promoted ? 1 : 0;
    supersededCount += result.superseded ? 1 : 0;
    decisions.push(
      buildDecision(
        result.superseded ? "SUPERSEDE" : "ADD",
        `Tracked watchlist item ${statement.title}.`,
        0.8
      )
    );
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} preference statement(s) and ${watchlistStatements.length} watchlist item(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount
  };
}

async function promoteSkillCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractSkillStatements(candidate.content);

  if (statements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic skill statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic skill statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const personLabel = await loadNamespacePersonLabel(client, candidate.namespace_id, candidate.content);
  const sourceMemoryId = await resolveCandidateSourceMemoryId(client, candidate);
  const decisions: ConsolidationDecision[] = [];
  let promotedCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;

  for (const statement of statements) {
    const typedEntity = resolveTypedSkillEntity(statement.name);
    const typedEntityId = typedEntity
      ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity)
      : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.name,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          state_type: "skill"
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      skill: statement.name,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    const semanticRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [candidate.namespace_id, statement.canonicalKey]
    );

    const semanticRow = semanticRows.rows[0];
    if (!semanticRow) {
      await client.query(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            source_chunk_id,
            source_artifact_observation_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.83, $3, NULL, 'active', true, $4, $5, $6, 'skill', $7, $8::jsonb, $9::jsonb, true)
        `,
        [
          candidate.namespace_id,
          `${personLabel} has skill ${statement.name}.`,
          occurredAt,
          sourceMemoryId,
          candidate.source_chunk_id,
          candidate.source_artifact_observation_id,
          statement.canonicalKey,
          JSON.stringify(lastNormalizedValue),
          JSON.stringify({
            source: "candidate_consolidation",
            candidate_id: candidate.candidate_id,
            ontology_phase: "phase4",
            is_anchor: true
          })
        ]
      );
      promotedCount += 1;
      decisions.push(buildDecision("ADD", `Added skill ${statement.name}.`, 0.82));
    } else {
      decisions.push(buildDecision("UPDATE", `Reinforced skill ${statement.name}.`, 0.74, semanticRow.id));
    }

    const result = await upsertProceduralState(client, {
      namespaceId: candidate.namespace_id,
      stateType: "skill",
      stateKey: statement.canonicalKey,
      stateValue: {
        person: personLabel,
        skill: statement.name,
        status: "active",
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null,
        source_memory_id: sourceMemoryId
      },
      occurredAt,
      sourceMemoryId,
      metadata: {
        source: "candidate_consolidation",
        candidate_id: candidate.candidate_id,
        ontology_phase: "phase4",
        is_anchor: true
      },
      supersessionMode: "replace"
    });

    promotedCount += result.promoted ? 1 : 0;
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} skill statement(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount: 0
  };
}

async function promoteDecisionCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractDecisionStatements(candidate.content);

  if (statements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic decision statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic decision statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const personLabel = await loadNamespacePersonLabel(client, candidate.namespace_id, candidate.content);
  const sourceMemoryId = await resolveCandidateSourceMemoryId(client, candidate);
  const decisions: ConsolidationDecision[] = [];
  let promotedCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;

  for (const statement of statements) {
    const typedEntity = resolveTypedDecisionEntity(statement.summary);
    const typedEntityId = typedEntity ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity) : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.summary,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          state_type: "decision"
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      decision: statement.summary,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    const semanticRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [candidate.namespace_id, statement.canonicalKey]
    );

    const semanticRow = semanticRows.rows[0];
    if (!semanticRow) {
      await client.query(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            source_chunk_id,
            source_artifact_observation_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.84, $3, NULL, 'active', true, $4, $5, $6, 'decision', $7, $8::jsonb, $9::jsonb, true)
        `,
        [
          candidate.namespace_id,
          `${personLabel} decided to ${statement.summary.charAt(0).toLowerCase()}${statement.summary.slice(1)}.`,
          occurredAt,
          sourceMemoryId,
          candidate.source_chunk_id,
          candidate.source_artifact_observation_id,
          statement.canonicalKey,
          JSON.stringify(lastNormalizedValue),
          JSON.stringify({
            source: "candidate_consolidation",
            candidate_id: candidate.candidate_id,
            ontology_phase: "phase4",
            is_anchor: true
          })
        ]
      );
      promotedCount += 1;
      decisions.push(buildDecision("ADD", `Added decision ${statement.summary}.`, 0.82));
    } else {
      decisions.push(buildDecision("UPDATE", `Reinforced decision ${statement.summary}.`, 0.74, semanticRow.id));
    }

    const result = await upsertProceduralState(client, {
      namespaceId: candidate.namespace_id,
      stateType: "decision",
      stateKey: statement.canonicalKey,
      stateValue: {
        person: personLabel,
        decision: statement.summary,
        status: "active",
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null,
        source_memory_id: sourceMemoryId
      },
      occurredAt,
      sourceMemoryId,
      metadata: {
        source: "candidate_consolidation",
        candidate_id: candidate.candidate_id,
        ontology_phase: "phase4",
        is_anchor: true
      },
      supersessionMode: "replace"
    });

    promotedCount += result.promoted ? 1 : 0;
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} decision statement(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount: 0
  };
}

async function promoteConstraintCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractConstraintStatements(candidate.content);

  if (statements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic constraint statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic constraint statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const decisions: ConsolidationDecision[] = [];
  const sourceMemoryId = await resolveCandidateSourceMemoryId(client, candidate);
  let promotedCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;

  for (const statement of statements) {
    const typedEntity = resolveTypedConstraintEntity(statement.rule);
    const typedEntityId = typedEntity ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity) : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.rule,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          state_type: "constraint"
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      constraint: statement.rule,
      modality: statement.modality,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    const semanticRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [candidate.namespace_id, statement.canonicalKey]
    );

    const semanticRow = semanticRows.rows[0];
    if (!semanticRow) {
      await client.query(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            source_chunk_id,
            source_artifact_observation_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.84, $3, NULL, 'active', true, $4, $5, $6, 'constraint', $7, $8::jsonb, $9::jsonb, true)
        `,
        [
          candidate.namespace_id,
          `Constraint: ${statement.rule}.`,
          occurredAt,
          sourceMemoryId,
          candidate.source_chunk_id,
          candidate.source_artifact_observation_id,
          statement.canonicalKey,
          JSON.stringify(lastNormalizedValue),
          JSON.stringify({
            source: "candidate_consolidation",
            candidate_id: candidate.candidate_id,
            ontology_phase: "phase4",
            is_anchor: true
          })
        ]
      );
      promotedCount += 1;
      decisions.push(buildDecision("ADD", `Added constraint ${statement.rule}.`, 0.82));
    } else {
      decisions.push(buildDecision("UPDATE", `Reinforced constraint ${statement.rule}.`, 0.74, semanticRow.id));
    }

    const result = await upsertProceduralState(client, {
      namespaceId: candidate.namespace_id,
      stateType: "constraint",
      stateKey: statement.canonicalKey,
      stateValue: {
        subject: "brain",
        constraint: statement.rule,
        modality: statement.modality,
        status: "active",
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null,
        source_memory_id: sourceMemoryId
      },
      occurredAt,
      sourceMemoryId,
      metadata: {
        source: "candidate_consolidation",
        candidate_id: candidate.candidate_id,
        ontology_phase: "phase4",
        is_anchor: true
      },
      supersessionMode: "replace"
    });

    promotedCount += result.promoted ? 1 : 0;
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} constraint statement(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount: 0
  };
}

async function promoteStyleSpecCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractStyleSpecStatements(candidate.content);

  if (statements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic style spec statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic style spec statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const decisions: ConsolidationDecision[] = [];
  const sourceMemoryId = await resolveCandidateSourceMemoryId(client, candidate);
  const personLabel = await loadNamespacePersonLabel(client, candidate.namespace_id, candidate.content);
  let promotedCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;

  for (const statement of statements) {
    const typedEntity = resolveTypedStyleSpecEntity(statement.rule, statement.scope);
    const typedEntityId = typedEntity ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity) : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.rule,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          state_type: "style_spec"
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      style_spec: statement.rule,
      scope: statement.scope,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    const semanticRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [candidate.namespace_id, statement.canonicalKey]
    );

    const semanticRow = semanticRows.rows[0];
    if (!semanticRow) {
      await client.query(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            source_chunk_id,
            source_artifact_observation_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.84, $3, NULL, 'active', true, $4, $5, $6, 'style_spec', $7, $8::jsonb, $9::jsonb, true)
        `,
        [
          candidate.namespace_id,
          `${personLabel} style spec: ${statement.rule}.`,
          occurredAt,
          sourceMemoryId,
          candidate.source_chunk_id,
          candidate.source_artifact_observation_id,
          statement.canonicalKey,
          JSON.stringify(lastNormalizedValue),
          JSON.stringify({
            source: "candidate_consolidation",
            candidate_id: candidate.candidate_id,
            ontology_phase: "phase4",
            is_anchor: true
          })
        ]
      );
      promotedCount += 1;
      decisions.push(buildDecision("ADD", `Added style spec ${statement.rule}.`, 0.82));
    } else {
      decisions.push(buildDecision("UPDATE", `Reinforced style spec ${statement.rule}.`, 0.74, semanticRow.id));
    }

    const result = await upsertProceduralState(client, {
      namespaceId: candidate.namespace_id,
      stateType: "style_spec",
      stateKey: statement.canonicalKey,
      stateValue: {
        person: personLabel,
        style_spec: statement.rule,
        scope: statement.scope,
        status: "active",
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null,
        source_memory_id: sourceMemoryId
      },
      occurredAt,
      sourceMemoryId,
      metadata: {
        source: "candidate_consolidation",
        candidate_id: candidate.candidate_id,
        ontology_phase: "phase4",
        is_anchor: true
      },
      supersessionMode: "replace"
    });

    promotedCount += result.promoted ? 1 : 0;
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} style spec statement(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount: 0
  };
}

async function promoteGoalCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractGoalStatements(candidate.content);

  if (statements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic goal statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic goal statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const personLabel = await loadNamespacePersonLabel(client, candidate.namespace_id, candidate.content);
  const sourceMemoryId = await resolveCandidateSourceMemoryId(client, candidate);
  const decisions: ConsolidationDecision[] = [];
  let promotedCount = 0;
  let supersededCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;

  for (const statement of statements) {
    const typedEntity = resolveTypedGoalEntity(statement.summary);
    const typedEntityId = typedEntity ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity) : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.summary,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          state_type: "goal"
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      goal: statement.summary,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    const semanticRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [candidate.namespace_id, statement.canonicalKey]
    );

    const semanticRow = semanticRows.rows[0];
    if (!semanticRow) {
      await client.query(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            source_chunk_id,
            source_artifact_observation_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.84, $3, NULL, 'active', true, $4, $5, $6, 'goal', $7, $8::jsonb, $9::jsonb, true)
        `,
        [
          candidate.namespace_id,
          `${personLabel} current goal is ${statement.summary.charAt(0).toLowerCase()}${statement.summary.slice(1)}.`,
          occurredAt,
          sourceMemoryId,
          candidate.source_chunk_id,
          candidate.source_artifact_observation_id,
          statement.canonicalKey,
          JSON.stringify(lastNormalizedValue),
          JSON.stringify({
            source: "candidate_consolidation",
            candidate_id: candidate.candidate_id,
            ontology_phase: "phase4",
            is_anchor: true
          })
        ]
      );
      promotedCount += 1;
      decisions.push(buildDecision("ADD", `Added goal ${statement.summary}.`, 0.82));
    } else {
      decisions.push(buildDecision("UPDATE", `Reinforced goal ${statement.summary}.`, 0.74, semanticRow.id));
    }

    const priorGoalRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM procedural_memory
        WHERE namespace_id = $1
          AND state_type = 'goal'
          AND valid_until IS NULL
        ORDER BY updated_at DESC
      `,
      [candidate.namespace_id]
    );

    for (const row of priorGoalRows.rows) {
      await client.query(
        `
          UPDATE procedural_memory
          SET valid_until = $2
          WHERE id = $1
        `,
        [row.id, occurredAt]
      );
      supersededCount += 1;
    }

    await client.query(
      `
        INSERT INTO procedural_memory (
          namespace_id,
          state_type,
          state_key,
          state_value,
          version,
          updated_at,
          valid_from,
          valid_until,
          supersedes_id,
          metadata
        )
        VALUES ($1, 'goal', 'current_primary_goal', $2::jsonb, 1, $3, $3, NULL, $4, $5::jsonb)
      `,
      [
        candidate.namespace_id,
        JSON.stringify({
          person: personLabel,
          goal: statement.summary,
          status: "active",
          entity_id: typedEntityId,
          entity_type: typedEntity?.entityType ?? null,
          source_memory_id: sourceMemoryId
        }),
        occurredAt,
        priorGoalRows.rows[0]?.id ?? null,
        JSON.stringify({
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          ontology_phase: "phase4",
          is_anchor: true
        })
      ]
    );
    promotedCount += 1;
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} goal statement(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount
  };
}

async function promotePlanCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractPlanStatements(candidate.content);

  if (statements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic plan statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic plan statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const personLabel = await loadNamespacePersonLabel(client, candidate.namespace_id, candidate.content);
  const sourceMemoryId = await resolveCandidateSourceMemoryId(client, candidate);
  const decisions: ConsolidationDecision[] = [];
  let promotedCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;

  for (const statement of statements) {
    const typedEntity = resolveTypedPlanEntity(statement.summary);
    const typedEntityId = typedEntity ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity) : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.summary,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          state_type: "plan"
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      plan: statement.summary,
      project_hint: statement.projectHint ?? null,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    const semanticRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [candidate.namespace_id, statement.canonicalKey]
    );

    const semanticRow = semanticRows.rows[0];
    if (!semanticRow) {
      await client.query(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            source_chunk_id,
            source_artifact_observation_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.82, $3, NULL, 'active', true, $4, $5, $6, 'plan', $7, $8::jsonb, $9::jsonb, true)
        `,
        [
          candidate.namespace_id,
          `${personLabel} has plan ${statement.summary.charAt(0).toLowerCase()}${statement.summary.slice(1)}.`,
          occurredAt,
          sourceMemoryId,
          candidate.source_chunk_id,
          candidate.source_artifact_observation_id,
          statement.canonicalKey,
          JSON.stringify(lastNormalizedValue),
          JSON.stringify({
            source: "candidate_consolidation",
            candidate_id: candidate.candidate_id,
            ontology_phase: "phase4",
            is_anchor: true
          })
        ]
      );
      promotedCount += 1;
      decisions.push(buildDecision("ADD", `Added plan ${statement.summary}.`, 0.8));
    } else {
      decisions.push(buildDecision("UPDATE", `Reinforced plan ${statement.summary}.`, 0.72, semanticRow.id));
    }

    const result = await upsertProceduralState(client, {
      namespaceId: candidate.namespace_id,
      stateType: "plan",
      stateKey: statement.canonicalKey,
      stateValue: {
        person: personLabel,
        plan: statement.summary,
        project_hint: statement.projectHint ?? null,
        status: "active",
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null,
        source_memory_id: sourceMemoryId
      },
      occurredAt,
      sourceMemoryId,
      metadata: {
        source: "candidate_consolidation",
        candidate_id: candidate.candidate_id,
        ontology_phase: "phase4",
        is_anchor: true
      },
      supersessionMode: "replace"
    });

    promotedCount += result.promoted ? 1 : 0;
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} plan statement(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount: 0
  };
}

async function promoteBeliefCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractBeliefStatements(candidate.content);

  if (statements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic belief statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic belief statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const personLabel = await loadNamespacePersonLabel(client, candidate.namespace_id, candidate.content);
  const sourceMemoryId = await resolveCandidateSourceMemoryId(client, candidate);
  const decisions: ConsolidationDecision[] = [];
  let promotedCount = 0;
  let supersededCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;

  for (const statement of statements) {
    const typedEntity = resolveTypedBeliefEntity(statement.summary);
    const typedEntityId = typedEntity ? await upsertTypedEntity(client, candidate.namespace_id, typedEntity) : null;

    if (typedEntityId) {
      await upsertTypedEntityMention(client, {
        namespaceId: candidate.namespace_id,
        entityId: typedEntityId,
        sourceMemoryId,
        sourceChunkId: candidate.source_chunk_id,
        mentionText: statement.summary,
        occurredAt,
        metadata: {
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          state_type: "belief"
        }
      });
    }

    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      topic: statement.topic,
      belief: statement.summary,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null
    };

    await client.query(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          source_chunk_id,
          source_artifact_observation_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.8, $3, NULL, 'active', true, $4, $5, $6, 'belief', $7, $8::jsonb, $9::jsonb, true)
      `,
      [
        candidate.namespace_id,
        `${personLabel} belief about ${statement.topic.toLowerCase()} is ${statement.summary.charAt(0).toLowerCase()}${statement.summary.slice(1)}.`,
        occurredAt,
        sourceMemoryId,
        candidate.source_chunk_id,
        candidate.source_artifact_observation_id,
        `${statement.canonicalKey}:${normalizePreferenceTarget(statement.summary).replace(/\s+/gu, "_")}`,
        JSON.stringify(lastNormalizedValue),
        JSON.stringify({
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id,
          ontology_phase: "phase6",
          is_anchor: true
        })
      ]
    );

    const result = await upsertProceduralState(client, {
      namespaceId: candidate.namespace_id,
      stateType: "belief",
      stateKey: statement.canonicalKey,
      stateValue: {
        person: personLabel,
        topic: statement.topic,
        belief: statement.summary,
        status: "active",
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null
      },
      occurredAt,
      sourceMemoryId,
      metadata: {
        source: "candidate_consolidation",
        candidate_id: candidate.candidate_id,
        ontology_phase: "phase6",
        is_anchor: true
      },
      supersessionMode: "replace"
    });

    promotedCount += result.promoted ? 1 : 0;
    supersededCount += result.superseded ? 1 : 0;
    decisions.push(
      buildDecision(
        result.superseded ? "SUPERSEDE" : "ADD",
        `${result.superseded ? "Updated" : "Added"} belief on ${statement.topic}: ${statement.summary}.`,
        result.superseded ? 0.8 : 0.76
      )
    );
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} belief statement(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount
  };
}

async function syncDerivedRoutines(
  client: PoolClient,
  namespaceId: string
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const namespacePersonLabel = await loadNamespacePersonLabel(client, namespaceId, "");
  const patternRows = await client.query<RoutinePatternRow>(
    `
      WITH event_patterns AS (
        SELECT
          coalesce(subject_entity.canonical_name, $2) AS person_name,
          coalesce(nullif(ne.metadata->>'activity', ''), ne.event_kind) AS activity_name,
          coalesce(location_entity.canonical_name, nullif(ne.metadata->>'location_text', '')) AS location_name,
          lower(trim(to_char(coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC', 'FMDay'))) AS weekday_name,
          CASE
            WHEN lower(coalesce(ne.time_expression_text, '')) LIKE '%morning%' THEN 'morning'
            WHEN lower(coalesce(ne.time_expression_text, '')) LIKE '%afternoon%' THEN 'afternoon'
            WHEN lower(coalesce(ne.time_expression_text, '')) LIKE '%evening%' THEN 'evening'
            WHEN lower(coalesce(ne.time_expression_text, '')) LIKE '%night%' THEN 'night'
            WHEN EXTRACT(HOUR FROM coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC') BETWEEN 5 AND 11 THEN 'morning'
            WHEN EXTRACT(HOUR FROM coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC') BETWEEN 12 AND 16 THEN 'afternoon'
            WHEN EXTRACT(HOUR FROM coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC') BETWEEN 17 AND 21 THEN 'evening'
            ELSE 'night'
          END AS day_part,
          COUNT(DISTINCT date_trunc('week', coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC'))::int AS week_count,
          min(coalesce(ne.time_start, em.occurred_at, ne.created_at))::text AS first_observed_at,
          max(coalesce(ne.time_start, em.occurred_at, ne.created_at))::text AS last_observed_at,
          (
            ARRAY_AGG(em.id::text ORDER BY coalesce(ne.time_start, em.occurred_at, ne.created_at) DESC)
            FILTER (WHERE em.id IS NOT NULL)
          )[1] AS representative_memory_id
        FROM narrative_events ne
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        LEFT JOIN episodic_memory em
          ON em.namespace_id = ne.namespace_id
         AND em.artifact_id = ne.artifact_id
        WHERE ne.namespace_id = $1
          AND coalesce(ne.metadata->>'activity', '') <> ''
          AND coalesce(ne.time_start, em.occurred_at, ne.created_at) >= now() - interval '90 days'
        GROUP BY
          coalesce(subject_entity.canonical_name, $2),
          coalesce(nullif(ne.metadata->>'activity', ''), ne.event_kind),
          coalesce(location_entity.canonical_name, nullif(ne.metadata->>'location_text', '')),
          lower(trim(to_char(coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC', 'FMDay'))),
          CASE
            WHEN lower(coalesce(ne.time_expression_text, '')) LIKE '%morning%' THEN 'morning'
            WHEN lower(coalesce(ne.time_expression_text, '')) LIKE '%afternoon%' THEN 'afternoon'
            WHEN lower(coalesce(ne.time_expression_text, '')) LIKE '%evening%' THEN 'evening'
            WHEN lower(coalesce(ne.time_expression_text, '')) LIKE '%night%' THEN 'night'
            WHEN EXTRACT(HOUR FROM coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC') BETWEEN 5 AND 11 THEN 'morning'
            WHEN EXTRACT(HOUR FROM coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC') BETWEEN 12 AND 16 THEN 'afternoon'
            WHEN EXTRACT(HOUR FROM coalesce(ne.time_start, em.occurred_at, ne.created_at) AT TIME ZONE 'UTC') BETWEEN 17 AND 21 THEN 'evening'
            ELSE 'night'
          END
      )
      SELECT
        person_name,
        activity_name,
        location_name,
        weekday_name,
        day_part,
        week_count,
        first_observed_at,
        last_observed_at,
        representative_memory_id
      FROM event_patterns
      WHERE week_count >= 3
      ORDER BY last_observed_at DESC, person_name, activity_name
    `,
    [namespaceId, namespacePersonLabel]
  );

  const activeRoutineRows = await client.query<{ id: string; state_key: string }>(
    `
      SELECT id, state_key
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = 'routine'
        AND valid_until IS NULL
      ORDER BY valid_from DESC
    `,
    [namespaceId]
  );

  const desiredKeys = new Set<string>();
  const decisions: ConsolidationDecision[] = [];
  let promotedCount = 0;
  let supersededCount = 0;

  for (const pattern of patternRows.rows) {
    const summary = buildRoutineSummary(pattern);
    const stateKey = buildCanonicalRoutineKey(normalizePreferenceTarget(summary));
    desiredKeys.add(stateKey);

    const typedEntityId = await upsertTypedEntity(client, namespaceId, resolveTypedRoutineEntity(summary));
    const result = await upsertProceduralState(client, {
      namespaceId,
      stateType: "routine",
      stateKey,
      stateValue: {
        person: pattern.person_name,
        routine: summary,
        cadence: "weekly",
        weekday: pattern.weekday_name,
        day_part: pattern.day_part,
        activity: pattern.activity_name,
        location: pattern.location_name,
        week_count: pattern.week_count,
        first_observed_at: pattern.first_observed_at,
        last_observed_at: pattern.last_observed_at,
        entity_id: typedEntityId,
        entity_type: "routine"
      },
      occurredAt: pattern.last_observed_at,
      sourceMemoryId: pattern.representative_memory_id,
      metadata: {
        source: "routine_derivation",
        ontology_phase: "phase6",
        promotion_threshold: "3_weeks_in_90_days",
        week_count: pattern.week_count
      },
      supersessionMode: "replace"
    });

    promotedCount += result.promoted ? 1 : 0;
    supersededCount += result.superseded ? 1 : 0;
    decisions.push(buildDecision(result.promoted ? "ADD" : "UPDATE", `Derived routine ${summary}.`, 0.78));
  }

  for (const row of activeRoutineRows.rows) {
    if (desiredKeys.has(row.state_key)) {
      continue;
    }

    await client.query(
      `
        UPDATE procedural_memory
        SET valid_until = now()
        WHERE id = $1
      `,
      [row.id]
    );
    supersededCount += 1;
    decisions.push(buildDecision("SUPERSEDE", `Retired routine ${row.state_key}.`, 0.62));
  }

  return {
    decisions,
    promotedCount,
    supersededCount
  };
}

async function syncOperationalHeuristics(
  client: PoolClient,
  namespaceId: string
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const evidenceRows = await client.query<HeuristicEvidenceRow>(
    `
      SELECT
        em.id AS memory_id,
        em.content,
        em.occurred_at,
        em.source_chunk_id
      FROM episodic_memory em
      WHERE em.namespace_id = $1
      ORDER BY em.occurred_at ASC NULLS LAST, em.id ASC
    `,
    [namespaceId]
  );
  const patterns = [
    {
      heuristicKind: "replay_integrity",
      statement: {
        rule: "Wipe And Replay The Database After Each Slice",
        canonicalKey: buildCanonicalStyleSpecKey("wipe_and_replay_database_after_each_slice"),
        scope: "workflow"
      } satisfies StyleSpecStatement,
      summary: "Operational heuristic: wipe and replay the database after each implementation slice before moving on.",
      decisionText: "Induced replay-integrity workflow heuristic from repeated evidence.",
      matchers: [
        /wipe and replay the database/iu,
        /operational protocol.+wipe and replay/iu,
        /replay goes red.+self-heal/iu
      ]
    },
    {
      heuristicKind: "large_pdf_protocol",
      statement: {
        rule: "Chunk Large PDF Uploads Before Processing",
        canonicalKey: buildCanonicalStyleSpecKey("chunk_large_pdf_uploads_before_processing"),
        scope: "workflow"
      } satisfies StyleSpecStatement,
      summary: "Operational heuristic: chunk or defer PDF uploads over 50MB before processing them.",
      decisionText: "Induced large-PDF handling heuristic from repeated failure evidence.",
      matchers: [
        /pdf uploads?.+50mb/iu,
        /pdfs? over 50mb/iu,
        /chunk(?:ed|ing).+pdf/iu,
        /large pdf.+before processing/iu
      ]
    }
  ] as const;

  let promotedCount = 0;
  let supersededCount = 0;
  const decisions: ConsolidationDecision[] = [];
  const namespacePersonLabel = await loadNamespacePersonLabel(client, namespaceId, "");

  for (const pattern of patterns) {
    const matchedRows = evidenceRows.rows.filter((row) => pattern.matchers.some((matcher) => matcher.test(row.content)));
    const distinctDays = new Set(
      matchedRows
        .map((row) => {
          if (!row.occurred_at) {
            return null;
          }
          const iso = new Date(row.occurred_at).toISOString();
          return Number.isNaN(Date.parse(iso)) ? null : iso.slice(0, 10);
        })
        .filter((value): value is string => Boolean(value))
    );

    if (distinctDays.size < 3) {
      continue;
    }

    const typedEntity = resolveTypedStyleSpecEntity(pattern.statement.rule, pattern.statement.scope);
    const typedEntityId = typedEntity ? await upsertTypedEntity(client, namespaceId, typedEntity) : null;
    const sourceMemoryIds = matchedRows.map((row) => row.memory_id);
    const sourceMemoryId = sourceMemoryIds[0] ?? null;
    const occurredAt = matchedRows.at(-1)?.occurred_at ?? new Date().toISOString();
    const metadata = {
      source: "heuristic_induction",
      heuristic_kind: pattern.heuristicKind,
      promotion_gate: "rule_of_3_distinct_days",
      evidence_memory_ids: sourceMemoryIds,
      evidence_count: sourceMemoryIds.length,
      ontology_phase: "phase6"
    };

    if (typedEntityId) {
      for (const row of matchedRows) {
        await upsertTypedEntityMention(client, {
          namespaceId,
          entityId: typedEntityId,
          sourceMemoryId: row.memory_id,
          sourceChunkId: row.source_chunk_id,
          mentionText: row.content,
          occurredAt: row.occurred_at ?? occurredAt,
          metadata: {
            source: "heuristic_induction",
            heuristic_kind: pattern.heuristicKind,
            promotion_gate: "rule_of_3_distinct_days"
          }
        });
      }
    }

    const semanticRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [namespaceId, pattern.statement.canonicalKey]
    );

    const semanticRow = semanticRows.rows[0];
    const normalizedValue = {
      style_spec: pattern.statement.rule,
      scope: pattern.statement.scope,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null,
      support_memory_ids: sourceMemoryIds,
      induced: true
    };

    if (!semanticRow) {
      await client.query(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            source_chunk_id,
            source_artifact_observation_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.9, $3, NULL, 'active', true, $4, NULL, NULL, 'style_spec', $5, $6::jsonb, $7::jsonb, true)
        `,
        [
          namespaceId,
          pattern.summary,
          occurredAt,
          sourceMemoryId,
          pattern.statement.canonicalKey,
          JSON.stringify(normalizedValue),
          JSON.stringify(metadata)
        ]
      );
      promotedCount += 1;
    } else {
      await client.query(
        `
          UPDATE semantic_memory
          SET normalized_value = normalized_value || $2::jsonb,
              metadata = metadata || $3::jsonb
          WHERE id = $1
        `,
        [semanticRow.id, JSON.stringify(normalizedValue), JSON.stringify(metadata)]
      );
    }

    const proceduralResult = await upsertProceduralState(client, {
      namespaceId,
      stateType: "style_spec",
      stateKey: pattern.statement.canonicalKey,
      stateValue: {
        person: namespacePersonLabel,
        style_spec: pattern.statement.rule,
        scope: pattern.statement.scope,
        status: "active",
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null,
        support_memory_ids: sourceMemoryIds,
        induced: true
      },
      occurredAt,
      sourceMemoryId,
      metadata,
      supersessionMode: "replace"
    });

    promotedCount += proceduralResult.promoted ? 1 : 0;
    supersededCount += proceduralResult.superseded ? 1 : 0;
    decisions.push(
      buildDecision(
        proceduralResult.superseded || semanticRow ? "UPDATE" : "ADD",
        pattern.decisionText,
        0.86
      )
    );
  }

  const constraintPatterns = [
    {
      heuristicKind: "clarify_unknown_identity",
      statement: {
        rule: "Ask For Clarification Instead Of Guessing",
        canonicalKey: buildCanonicalConstraintKey("ask_for_clarification_instead_of_guessing"),
        modality: "clarify"
      } satisfies ConstraintStatement,
      summary: "Operational heuristic: when identity or grounding is unclear, ask for clarification instead of guessing.",
      decisionText: "Induced clarification-first constraint from repeated ambiguity-handling evidence.",
      matchers: [
        /ask for clarification instead of guessing/iu,
        /if we don't know.+ask for clarification/iu,
        /unknown (?:identity|kinship|place).+don't guess/iu,
        /when (?:identity|grounding) is unclear.+clarification/iu
      ]
    }
  ] as const;

  for (const pattern of constraintPatterns) {
    const matchedRows = evidenceRows.rows.filter((row) => pattern.matchers.some((matcher) => matcher.test(row.content)));
    const distinctDays = new Set(
      matchedRows
        .map((row) => {
          if (!row.occurred_at) {
            return null;
          }
          const iso = new Date(row.occurred_at).toISOString();
          return Number.isNaN(Date.parse(iso)) ? null : iso.slice(0, 10);
        })
        .filter((value): value is string => Boolean(value))
    );

    if (distinctDays.size < 3) {
      continue;
    }

    const typedEntity = resolveTypedConstraintEntity(pattern.statement.rule);
    const typedEntityId = typedEntity ? await upsertTypedEntity(client, namespaceId, typedEntity) : null;
    const sourceMemoryIds = matchedRows.map((row) => row.memory_id);
    const sourceMemoryId = sourceMemoryIds[0] ?? null;
    const occurredAt = matchedRows.at(-1)?.occurred_at ?? new Date().toISOString();
    const metadata = {
      source: "heuristic_induction",
      heuristic_kind: pattern.heuristicKind,
      promotion_gate: "rule_of_3_distinct_days",
      evidence_memory_ids: sourceMemoryIds,
      evidence_count: sourceMemoryIds.length,
      ontology_phase: "phase6"
    };

    if (typedEntityId) {
      for (const row of matchedRows) {
        await upsertTypedEntityMention(client, {
          namespaceId,
          entityId: typedEntityId,
          sourceMemoryId: row.memory_id,
          sourceChunkId: row.source_chunk_id,
          mentionText: row.content,
          occurredAt: row.occurred_at ?? occurredAt,
          metadata: {
            source: "heuristic_induction",
            heuristic_kind: pattern.heuristicKind,
            promotion_gate: "rule_of_3_distinct_days"
          }
        });
      }
    }

    const semanticRows = await client.query<{ id: string }>(
      `
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [namespaceId, pattern.statement.canonicalKey]
    );

    const semanticRow = semanticRows.rows[0];
    const normalizedValue = {
      constraint: pattern.statement.rule,
      modality: pattern.statement.modality,
      entity_id: typedEntityId,
      entity_type: typedEntity?.entityType ?? null,
      support_memory_ids: sourceMemoryIds,
      induced: true
    };

    if (!semanticRow) {
      await client.query(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            source_chunk_id,
            source_artifact_observation_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.9, $3, NULL, 'active', true, $4, NULL, NULL, 'constraint', $5, $6::jsonb, $7::jsonb, true)
        `,
        [
          namespaceId,
          pattern.summary,
          occurredAt,
          sourceMemoryId,
          pattern.statement.canonicalKey,
          JSON.stringify(normalizedValue),
          JSON.stringify(metadata)
        ]
      );
      promotedCount += 1;
    } else {
      await client.query(
        `
          UPDATE semantic_memory
          SET normalized_value = normalized_value || $2::jsonb,
              metadata = metadata || $3::jsonb
          WHERE id = $1
        `,
        [semanticRow.id, JSON.stringify(normalizedValue), JSON.stringify(metadata)]
      );
    }

    const proceduralResult = await upsertProceduralState(client, {
      namespaceId,
      stateType: "constraint",
      stateKey: pattern.statement.canonicalKey,
      stateValue: {
        person: namespacePersonLabel,
        constraint: pattern.statement.rule,
        modality: pattern.statement.modality,
        status: "active",
        entity_id: typedEntityId,
        entity_type: typedEntity?.entityType ?? null,
        support_memory_ids: sourceMemoryIds,
        induced: true
      },
      occurredAt,
      sourceMemoryId,
      metadata,
      supersessionMode: "replace"
    });

    promotedCount += proceduralResult.promoted ? 1 : 0;
    supersededCount += proceduralResult.superseded ? 1 : 0;
    decisions.push(
      buildDecision(
        proceduralResult.superseded || semanticRow ? "UPDATE" : "ADD",
        pattern.decisionText,
        0.86
      )
    );
  }

  return {
    decisions,
    promotedCount,
    supersededCount
  };
}

async function promoteProjectClaimCandidate(
  client: PoolClient,
  candidate: ClaimCandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const decisions: ConsolidationDecision[] = [];
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const metadata = candidate.metadata ?? {};
  const projectName =
    typeof metadata.project_name === "string"
      ? metadata.project_name
      : candidate.claim_type === "employment"
        ? candidate.object_text
        : candidate.claim_type === "project_engagement"
        ? candidate.object_text
        : candidate.predicate === "project_role"
        ? candidate.object_text
        : candidate.subject_text;
  const projectKeyRaw =
    typeof metadata.project_key === "string" && metadata.project_key
      ? metadata.project_key
      : projectName;

  if (!projectName || !projectKeyRaw) {
    await markClaimCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      reason: "Project claim missing project identity."
    });
    return {
      decisions: [buildDecision("IGNORE", "Project claim missing project identity.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  let stateType: string | null = null;
  let stateKey = normalizeProjectKey(projectKeyRaw);
  let stateValue: Record<string, unknown> | null = null;
  let supersessionMode: "replace" | "append" | "specificity_guarded" = "append";
  const routeFamily = typeof metadata.route_family === "string" ? metadata.route_family : null;
  const routedStateType = typeof metadata.state_type === "string" ? metadata.state_type : null;
  const routedStateKey = typeof metadata.state_key === "string" ? metadata.state_key : null;
  const routedSupersessionMode =
    metadata.supersession_mode === "replace" || metadata.supersession_mode === "append" || metadata.supersession_mode === "specificity_guarded"
      ? metadata.supersession_mode
      : null;

  if (routedStateKey) {
    stateKey = routedStateKey;
  }

  if (routeFamily === "procedural_historical") {
    await markClaimCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "promoted",
      reason: "Historical typed claim remains in relationship/semantic memory without active procedural promotion."
    });
    return {
      decisions: [buildDecision("UPDATE", "Historical typed claim retained outside active procedural truth.", Math.max(0.6, candidate.confidence))],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  if ((candidate.claim_type === "project_status_changed" || candidate.predicate === "project_status") || routedStateType === "project_status") {
    stateType = "project_status";
    supersessionMode = routedSupersessionMode ?? "replace";
    stateValue = {
      project: projectName,
      status: typeof metadata.status_value === "string" ? metadata.status_value : candidate.object_text
    };
  } else if ((candidate.claim_type === "deadline_changed" || candidate.predicate === "project_deadline") || routedStateType === "project_deadline") {
    stateType = "project_deadline";
    supersessionMode = routedSupersessionMode ?? "replace";
    stateValue = {
      project: projectName,
      deadline: typeof metadata.deadline_text === "string" ? metadata.deadline_text : candidate.object_text
    };
  } else if ((candidate.claim_type === "project_spec_changed" || candidate.predicate === "project_focus") || routedStateType === "project_spec") {
    stateType = "project_spec";
    supersessionMode = routedSupersessionMode ?? "replace";
    stateValue = {
      project: projectName,
      summary: typeof metadata.spec_summary === "string" ? metadata.spec_summary : candidate.object_text
    };
  } else if (
    candidate.claim_type === "role_assigned" ||
    (candidate.claim_type === "employment" && typeof metadata.role === "string" && metadata.role) ||
    routedStateType === "project_role"
  ) {
    const personName = candidate.subject_text;
    const role = typeof metadata.role === "string" ? metadata.role : null;
    if (personName && role) {
      stateType = "project_role";
      supersessionMode = routedSupersessionMode ?? "replace";
      stateKey = `${normalizeProjectKey(projectKeyRaw)}:${normalizeProjectKey(personName)}`;
      stateValue = {
        project: projectName,
        person: personName,
        role
      };
    }
  } else if (candidate.claim_type === "project_engagement" || candidate.predicate === "works_on" || routedStateType === "current_project") {
    const personName = candidate.subject_text;
    if (personName && projectName) {
      stateType = "current_project";
      supersessionMode = routedSupersessionMode ?? "append";
      stateKey = `${normalizeProjectKey(personName)}:${normalizeProjectKey(projectKeyRaw)}`;
      stateValue = {
        person: personName,
        project: projectName
      };
    }
  } else if (routedStateType === "current_employer") {
    if (candidate.subject_text && candidate.object_text) {
      stateType = "current_employer";
      supersessionMode = routedSupersessionMode ?? "replace";
      stateKey = normalizeProjectKey(candidate.subject_text);
      stateValue = {
        person: candidate.subject_text,
        organization: candidate.object_text
      };
    }
  } else if (candidate.predicate === "works_at" || routedStateType === "active_affiliation") {
    if (candidate.subject_text && candidate.object_text) {
      stateType = "active_affiliation";
      supersessionMode = routedSupersessionMode ?? "append";
      stateKey = `${normalizeProjectKey(candidate.subject_text)}:${normalizeProjectKey(candidate.object_text)}`;
      stateValue = {
        person: candidate.subject_text,
        organization: candidate.object_text
      };
    }
  } else if (candidate.predicate === "member_of" || routedStateType === "active_membership") {
    if (candidate.subject_text && candidate.object_text) {
      stateType = "active_membership";
      supersessionMode = routedSupersessionMode ?? "append";
      stateKey = `${normalizeProjectKey(candidate.subject_text)}:${normalizeProjectKey(candidate.object_text)}`;
      stateValue = {
        person: candidate.subject_text,
        organization: candidate.object_text
      };
    }
  } else if (candidate.predicate === "created_by" || candidate.predicate === "runs" || routedStateType === "active_ownership") {
    if (candidate.subject_text && candidate.object_text) {
      stateType = "active_ownership";
      supersessionMode = routedSupersessionMode ?? "append";
      stateKey = `${normalizeProjectKey(candidate.subject_text)}:${normalizeProjectKey(candidate.object_text)}`;
      stateValue = {
        person: candidate.subject_text,
        asset: candidate.object_text,
        predicate: candidate.predicate
      };
    }
  } else if (
    candidate.claim_type === "current_location" ||
    candidate.predicate === "currently_in" ||
    candidate.predicate === "lives_in" ||
    routedStateType === "current_location"
  ) {
    const personName = candidate.subject_text;
    if (personName && candidate.object_text) {
      stateType = "current_location";
      supersessionMode = routedSupersessionMode ?? "specificity_guarded";
      stateKey = normalizeProjectKey(personName);
      stateValue = {
        person: personName,
        place: candidate.object_text,
        predicate: candidate.predicate,
        place_entity_id: candidate.object_entity_id
      };
    }
  }

  if (!stateType || !stateValue) {
    await markClaimCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      reason: "No supported deterministic project promotion rule."
    });
    return {
      decisions: [buildDecision("IGNORE", "No supported deterministic project promotion rule.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  if (stateType === "current_location") {
    const activeCurrentLocation = await client.query<{
      id: string;
      state_value: Record<string, unknown>;
    }>(
      `
        SELECT id, state_value
        FROM procedural_memory
        WHERE namespace_id = $1
          AND state_type = 'current_location'
          AND state_key = $2
          AND valid_until IS NULL
        ORDER BY version DESC
        LIMIT 1
      `,
      [candidate.namespace_id, stateKey]
    );

    const activeRow = activeCurrentLocation.rows[0];
    const currentPlaceEntityId =
      activeRow && typeof activeRow.state_value?.place_entity_id === "string"
        ? activeRow.state_value.place_entity_id
        : null;
    const nextPlaceEntityId = candidate.object_entity_id;

    if (currentPlaceEntityId && nextPlaceEntityId) {
      const specificityDecision = await resolvePlaceSpecificity(
        client,
        candidate.namespace_id,
        currentPlaceEntityId,
        nextPlaceEntityId
      );

      if (specificityDecision === "keep_current") {
        await markClaimCandidate(client, {
          candidateId: candidate.candidate_id,
          status: "promoted",
          reason: `Retained existing specific current_location; kept broader place as structural containment only.`
        });

        decisions.push(
          buildDecision(
            "UPDATE",
            `Skipped promoting broader place ${candidate.object_text} over existing specific current_location.`,
            Math.max(0.7, candidate.confidence)
          )
        );

        return {
          decisions,
          promotedCount: 0,
          supersededCount: 0
        };
      }
    }
  }

  const result = await upsertProceduralState(client, {
    namespaceId: candidate.namespace_id,
    stateType,
    stateKey,
    stateValue,
    occurredAt,
    sourceMemoryId: candidate.source_memory_id,
      metadata: {
        source: "claim_candidate_promotion",
        claim_candidate_id: candidate.candidate_id,
        claim_type: candidate.claim_type,
        is_anchor:
          stateType === "current_location" ||
          stateType === "project_role" ||
          stateType === "active_affiliation" ||
          stateType === "current_employer"
      },
    supersessionMode
  });

  await markClaimCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "promoted",
    reason: `Promoted ${candidate.claim_type} into ${stateType}.`
  });

  decisions.push(
    buildDecision(
      result.superseded ? "SUPERSEDE" : "ADD",
      `Promoted ${candidate.claim_type} into ${stateType}.`,
      Math.max(0.65, candidate.confidence)
    )
  );

  return {
    decisions,
    promotedCount: result.promoted ? 1 : 0,
    supersededCount: result.superseded ? 1 : 0
  };
}

export async function runCandidateConsolidation(
  namespaceId: string,
  limit = 50
): Promise<ConsolidationRunSummary> {
  const context: JobRunContext = {
    runId: randomUUID(),
    startedAt: new Date().toISOString()
  };

  return withTransaction(async (client) => {
    const candidates = await client.query<CandidateRow>(
      `
        SELECT
          mc.id AS candidate_id,
          mc.namespace_id,
          mc.candidate_type,
          mc.content,
          mc.created_at,
          mc.source_memory_id,
          mc.source_chunk_id,
          mc.source_artifact_observation_id,
          mc.metadata,
          em.occurred_at
        FROM memory_candidates mc
        LEFT JOIN episodic_memory em ON em.id = mc.source_memory_id
        WHERE mc.namespace_id = $1
          AND mc.status = 'pending'
          AND mc.candidate_type IN ('semantic_preference', 'semantic_skill', 'semantic_decision', 'semantic_constraint', 'semantic_style_spec', 'semantic_goal', 'semantic_plan', 'semantic_belief')
        ORDER BY COALESCE(em.occurred_at, mc.created_at) ASC, mc.created_at ASC
        LIMIT $2
      `,
      [namespaceId, Math.max(1, limit)]
    );

    const decisions: ConsolidationDecision[] = [];
    let processedCandidates = 0;
    let promotedMemories = 0;
    let supersededMemories = 0;

    for (const candidate of candidates.rows) {
      const result =
        candidate.candidate_type === "semantic_skill"
          ? await promoteSkillCandidate(client, candidate)
          : candidate.candidate_type === "semantic_decision"
            ? await promoteDecisionCandidate(client, candidate)
            : candidate.candidate_type === "semantic_constraint"
              ? await promoteConstraintCandidate(client, candidate)
              : candidate.candidate_type === "semantic_style_spec"
                ? await promoteStyleSpecCandidate(client, candidate)
                : candidate.candidate_type === "semantic_goal"
                  ? await promoteGoalCandidate(client, candidate)
                  : candidate.candidate_type === "semantic_plan"
                    ? await promotePlanCandidate(client, candidate)
                    : candidate.candidate_type === "semantic_belief"
                      ? await promoteBeliefCandidate(client, candidate)
              : await promotePreferenceCandidate(client, candidate);
      processedCandidates += 1;
      promotedMemories += result.promotedCount;
      supersededMemories += result.supersededCount;
      decisions.push(...result.decisions);
    }

    const projectClaims = await client.query<ClaimCandidateRow>(
      `
        SELECT
          cc.id AS candidate_id,
          cc.namespace_id,
          cc.claim_type,
          cc.source_memory_id::text,
          cc.subject_entity_id::text,
          cc.object_entity_id::text,
          cc.subject_text,
          cc.predicate,
          cc.object_text,
          cc.confidence,
          COALESCE(cc.occurred_at, cc.created_at) AS occurred_at,
          cc.metadata,
          cc.created_at
        FROM claim_candidates cc
        WHERE cc.namespace_id = $1
          AND cc.status = 'accepted'
          AND (
            cc.claim_type IN ('employment', 'role_assigned', 'project_status_changed', 'deadline_changed', 'project_spec_changed', 'project_engagement', 'current_location')
            OR cc.predicate IN ('works_on', 'works_at', 'worked_at', 'member_of', 'created_by', 'runs', 'project_role', 'currently_in', 'lives_in')
            OR cc.metadata->>'route_family' IN ('procedural_current', 'procedural_historical')
          )
        ORDER BY COALESCE(cc.occurred_at, cc.created_at) ASC, cc.created_at ASC
        LIMIT $2
      `,
      [namespaceId, Math.max(1, limit)]
    );

    for (const claim of projectClaims.rows) {
      const result = await promoteProjectClaimCandidate(client, claim);
      processedCandidates += 1;
      promotedMemories += result.promotedCount;
      supersededMemories += result.supersededCount;
      decisions.push(...result.decisions);
    }

    const routineResult = await syncDerivedRoutines(client, namespaceId);
    promotedMemories += routineResult.promotedCount;
    supersededMemories += routineResult.supersededCount;
    decisions.push(...routineResult.decisions);

    const heuristicResult = await syncOperationalHeuristics(client, namespaceId);
    promotedMemories += heuristicResult.promotedCount;
    supersededMemories += heuristicResult.supersededCount;
    decisions.push(...heuristicResult.decisions);

    return {
      context,
      scannedCandidates: (candidates.rowCount ?? 0) + (projectClaims.rowCount ?? 0),
      processedCandidates,
      promotedMemories,
      supersededMemories,
      decisions
    };
  });
}
