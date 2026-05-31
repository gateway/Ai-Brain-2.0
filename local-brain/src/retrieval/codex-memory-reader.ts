import { queryRows } from "../db/client.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import type { CodexSessionSummary } from "../codex-sessions/service.js";
import type { RecallResult } from "../types.js";
import type { AnswerSectionSourceTrailEntry, StructuredAnswerSection } from "./types.js";
import {
  canonicalCodexProjectLabel,
  codexProjectLabelFromText,
  codexProjectMatchesText,
  projectAliasEntryFor,
  titleCaseProject
} from "./codex-project-aliases.js";

export type CodexMemoryReaderMode =
  | "codex_session_report"
  | "engineering_memory_packet"
  | "workflow_pattern_report"
  | "codex_source_audit"
  | "codex_project_detail_report";

export interface CodexMemoryReadResult {
  readonly mode: CodexMemoryReaderMode;
  readonly claimText: string;
  readonly answerReason: string;
  readonly results: readonly RecallResult[];
  readonly answerSections: readonly StructuredAnswerSection[];
  readonly rawTranscriptRetrievalCount: number;
  readonly packetTokenEstimate: number;
}

interface CodexMemoryRow {
  readonly id: string;
  readonly candidate_type: string;
  readonly content: string;
  readonly confidence: number | null;
  readonly status: string;
  readonly created_at: string;
  readonly canonical_key: string | null;
  readonly normalized_value: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
  readonly rank_score: number;
}

interface CodexProjectDetailSummaryRow {
  readonly summary_id: string;
  readonly session_catalog_id: string;
  readonly codex_session_id: string | null;
  readonly repo_path: string | null;
  readonly title: string | null;
  readonly captured_at: string | null;
  readonly summary_json: CodexSessionSummary;
}

interface CodexProjectDetailItem {
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly text: string;
  readonly row: CodexProjectDetailSummaryRow;
}

interface CodexSourceWindow {
  readonly rawText: string;
  readonly start: string | null;
  readonly end: string | null;
}

function estimateTokens(value: string): number {
  return value.trim() ? Math.ceil(value.length / 4) : 0;
}

function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function resolveCodexSourceWindow(queryText: string, referenceNow?: string | null): CodexSourceWindow | null {
  const normalized = normalizeWhitespace(queryText).toLowerCase();
  const anchor = referenceNow ? new Date(referenceNow) : new Date();
  const today = startOfUtcDay(Number.isFinite(anchor.getTime()) ? anchor : new Date());
  const dayOfWeek = today.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const thisWeekStart = addDays(today, -daysSinceMonday);
  if (/\blast\s+week\b/iu.test(normalized)) {
    const start = addDays(thisWeekStart, -7);
    const end = addDays(thisWeekStart, -1);
    return { rawText: "last week", start: isoDateOnly(start), end: isoDateOnly(end) };
  }
  if (/\bthis\s+week\b/iu.test(normalized)) {
    return { rawText: "this week", start: isoDateOnly(thisWeekStart), end: isoDateOnly(addDays(thisWeekStart, 6)) };
  }
  const since = normalized.match(/\bsince\s+(\d{4}-\d{2}-\d{2})\b/iu)?.[1];
  if (since) {
    return { rawText: `since ${since}`, start: since, end: null };
  }
  const explicitDate = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/iu)?.[1];
  if (explicitDate) {
    return { rawText: explicitDate, start: explicitDate, end: explicitDate };
  }
  return null;
}

function timestampInSourceWindow(value: string | null | undefined, window: CodexSourceWindow | null): boolean {
  if (!window) return true;
  if (!value) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const day = isoDateOnly(date);
  return (!window.start || day >= window.start) && (!window.end || day <= window.end);
}

function rowCapturedAt(row: CodexMemoryRow): string | null {
  const metadata = row.metadata ?? {};
  return typeof metadata.captured_at === "string" ? metadata.captured_at : row.created_at;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function queryTerms(queryText: string): readonly string[] {
  return [...new Set(normalizeWhitespace(queryText).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/gu) ?? [])]
    .filter((term) => !["what", "where", "from", "that", "this", "codex", "session", "sessions", "memory", "packet", "query", "pattern", "patterns", "show", "last", "time", "week", "weeks", "project", "repo", "app", "work", "with", "about", "into", "onto", "for", "the", "and", "you", "did", "give", "gave", "commonly"].includes(term))
    .slice(0, 12);
}

function normalizedQueryTextWithTechnicalAliases(queryText: string): string {
  return normalizeWhitespace(queryText)
    .replace(/\bestimated\s+pricing\b/giu, "estimated-pricing")
    .replace(/\bsource\s+trails\b/giu, "source trail")
    .replace(/\braw\s+transcripts\b/giu, "raw transcript")
    .replace(/\bcurated\s+codex\s+summaries\b/giu, "curated summaries");
}

function codexProjectPatternQuery(queryText: string): boolean {
  return /\b(?:patterns?|mistakes?|instructions?|standards?|task\s+lists?|changelogs?|docs?|prior\s+work|what\s+did\s+we\s+do|last\s+time|sessions?|agent|workflow|skill\s+candidates?|token\s+waste|commonly\s+came\s+up)\b[\s\S]{0,160}\b(?:for|on|in|about|around)\s+(?:the\s+)?[a-z0-9][a-z0-9 -]{2,80}/iu.test(queryText);
}

function codexProjectDetailQuery(queryText: string): boolean {
  if (/\bcodex\s+session\s+ingestion\b/iu.test(queryText)) return false;
  const hasProject = projectLabelFromQuery(queryText) !== null;
  const detailCue =
    /\b(?:architecture|target\s+design|implementation\s+plan|standalone\s+implementation|design\s+decision|decid(?:e|ed)|decisions?|what\s+broke|went\s+wrong|how\s+was\s+it\s+fixed|fixed|proof|prove|proved|proving|verified|verification|tests?|gates?|risks?|follow[- ]?ups?|workspace\s+confusion|repo\s+confusion|wrong\s+repo|what\s+changed|changed\s+between|before\s+and\s+after|source\s+support|sources?\s+for|establish(?:ed|es|ing)?|discuss(?:ed|es|ing)?|what\s+happened)\b/iu.test(queryText);
  return hasProject && detailCue;
}

export function codexMemoryModeForQuery(queryText: string): CodexMemoryReaderMode | null {
  if (codexProjectDetailQuery(queryText)) return "codex_project_detail_report";
  if (
    !codexProjectPatternQuery(queryText) &&
    !/\b(?:codex|agent\s+memory|memory\s+packet|last\s+time\s+on\s+this\s+repo|stack\s+and\s+standards|standards\s+usually\s+apply|standards\s+should\s+i\s+follow[\s\S]{0,60}\brepo|task\s+lists?|changelogs?|docs?|before\s+editing\s+this\s+repo|future\s+agents?\s+(?:follow|preload)|mistakes\s+should\s+codex|skill\s+candidates?|skills?\s+should|create\s+.*skills?|docs\s+drift|repeated\s+instructions?|promoted\s+truth|candidate\s+memories|memories\s+are\s+candidates|token\s+waste|workflow\s+patterns?|architecture\s+decisions?\s+did\s+we\s+make|decisions?\s+did\s+we\s+make|operator\s+workbench)\b/iu.test(queryText)
  ) {
    return null;
  }
  if (/\b(?:where\s+did|source|sources|evidence|come\s+from|provenance)\b/iu.test(queryText)) return "codex_source_audit";
  if (/\b(?:agent\s+memory\s+packet|memory\s+packet|generate\s+.*packet|future\s+agents?\s+preload|preload\s+before\s+working)\b/iu.test(queryText)) return "engineering_memory_packet";
  if (/\b(?:mistakes?|avoid|repeated\s+instructions?|standards?|task\s+lists?|changelogs?|docs?|skill\s+candidates?|skills?\s+should|create\s+.*skills?|docs\s+drift|pattern|patterns|token\s+waste)\b/iu.test(queryText)) return "workflow_pattern_report";
  return "codex_session_report";
}

function modeCandidateTypes(mode: CodexMemoryReaderMode, queryText = ""): readonly string[] {
  switch (mode) {
    case "codex_project_detail_report":
      return ["codex_engineering_memory", "codex_architecture_decision", "codex_agent_failure_pattern", "codex_repeated_instruction", "codex_skill_candidate", "codex_project_profile", "codex_agent_packet_ledger"];
    case "engineering_memory_packet":
      return ["codex_engineering_memory", "codex_architecture_decision", "codex_repeated_instruction", "codex_agent_failure_pattern", "codex_agent_packet_ledger", "codex_project_profile"];
    case "workflow_pattern_report":
      if (/\b(?:mistakes?|avoid|failure|failed|wrong)\b/iu.test(queryText)) {
        return ["codex_agent_failure_pattern", "codex_repeated_instruction", "codex_skill_candidate", "codex_token_waste_observation", "codex_workflow_pattern_projection", "codex_project_profile", "codex_token_analytics", "codex_engineering_memory"];
      }
      if (/\b(?:skill\s+candidates?|skills?\s+should|create\s+.*skills?)\b/iu.test(queryText)) {
        return ["codex_skill_candidate", "codex_repeated_instruction", "codex_agent_failure_pattern", "codex_token_waste_observation", "codex_workflow_pattern_projection", "codex_project_profile", "codex_token_analytics", "codex_engineering_memory"];
      }
      if (/\btoken\s+waste\b/iu.test(queryText)) {
        return ["codex_token_waste_observation", "codex_token_analytics", "codex_repeated_instruction", "codex_agent_failure_pattern", "codex_skill_candidate", "codex_workflow_pattern_projection", "codex_project_profile", "codex_engineering_memory"];
      }
      return ["codex_repeated_instruction", "codex_agent_failure_pattern", "codex_skill_candidate", "codex_token_waste_observation", "codex_workflow_pattern_projection", "codex_project_profile", "codex_token_analytics", "codex_engineering_memory"];
    case "codex_source_audit":
      return ["codex_engineering_memory", "codex_architecture_decision", "codex_repeated_instruction", "codex_agent_failure_pattern", "codex_skill_candidate", "codex_project_profile", "codex_agent_packet_ledger"];
    default:
      return ["codex_engineering_memory", "codex_architecture_decision", "codex_personal_planning_memory", "codex_skill_candidate", "codex_project_profile", "codex_agent_packet_ledger"];
  }
}

function preferredCodexCandidateType(mode: CodexMemoryReaderMode, queryText: string): string | null {
  if (mode === "codex_project_detail_report") {
    if (/\b(?:architecture|target\s+design|implementation\s+plan|standalone\s+implementation|decision)\b/iu.test(queryText)) return "codex_architecture_decision";
    if (/\b(?:what\s+broke|went\s+wrong|fixed|failure|risk|follow[- ]?up|workspace|repo\s+confusion)\b/iu.test(queryText)) return "codex_agent_failure_pattern";
  }
  if (mode === "workflow_pattern_report") {
    if (/\b(?:mistakes?|avoid|failure|failed|wrong)\b/iu.test(queryText)) return "codex_agent_failure_pattern";
    if (/\b(?:skill\s+candidates?|skills?\s+should|create\s+.*skills?)\b/iu.test(queryText)) return "codex_skill_candidate";
    if (/\btoken\s+waste\b/iu.test(queryText)) return "codex_token_waste_observation";
    if (/\b(?:repeated\s+instructions?|standards?|task\s+lists?|changelogs?|docs?)\b/iu.test(queryText)) return "codex_repeated_instruction";
  }
  if (mode === "codex_session_report" && /\b(?:architecture\s+decisions?|decisions?\s+did\s+we\s+make|operator\s+workbench)\b/iu.test(queryText)) {
    return "codex_architecture_decision";
  }
  return null;
}

async function loadCodexMemoryRows(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly mode: CodexMemoryReaderMode;
  readonly limit: number;
  readonly sourceWindow?: CodexSourceWindow | null;
}): Promise<readonly CodexMemoryRow[]> {
  const terms = queryTerms(params.queryText);
  const hasScopedTerms = terms.length > 0 && codexProjectPatternQuery(params.queryText);
  const types = modeCandidateTypes(params.mode, params.queryText);
  const preferredType = preferredCodexCandidateType(params.mode, params.queryText);
  const candidateRows = await queryRows<CodexMemoryRow>(
    `
      SELECT
        id::text,
        candidate_type,
        content,
        confidence,
        status,
        created_at::text,
        canonical_key,
        normalized_value,
        metadata,
        (
          CASE WHEN candidate_type = $5 THEN 0.55 ELSE 0 END +
          CASE WHEN candidate_type = ANY($2::text[]) THEN 0.45 ELSE 0 END +
          COALESCE(confidence, 0.5) * 0.35 +
          CASE WHEN cardinality($3::text[]) = 0 THEN 0.1 ELSE (
            SELECT COALESCE(SUM(CASE WHEN lower(content) LIKE '%' || term || '%' THEN 0.08 ELSE 0 END), 0)
            FROM unnest($3::text[]) AS term
          ) END
        )::double precision AS rank_score
      FROM memory_candidates
      WHERE namespace_id = $1
        AND candidate_type LIKE 'codex_%'
        AND status IN ('pending', 'accepted')
        AND (
          (candidate_type = ANY($2::text[]) AND $6::boolean = false)
          OR cardinality($3::text[]) = 0
          OR EXISTS (
            SELECT 1
            FROM unnest($3::text[]) AS term
            WHERE lower(content) LIKE '%' || term || '%'
               OR lower(COALESCE(metadata->>'repo_path', '')) LIKE '%' || term || '%'
               OR lower(COALESCE(metadata->>'project', '')) LIKE '%' || term || '%'
          )
        )
      ORDER BY rank_score DESC, created_at DESC
      LIMIT $4
    `,
    [params.namespaceId, types, terms, params.limit, preferredType, hasScopedTerms]
  );
  const projectedRows = await queryRows<CodexMemoryRow>(
    `
      WITH semantic_rows AS (
        SELECT
          id::text,
          memory_kind AS candidate_type,
          content_abstract AS content,
          importance_score AS confidence,
          'accepted'::text AS status,
          valid_from::text AS created_at,
          canonical_key,
          normalized_value,
          metadata,
          (
            CASE WHEN memory_kind = $5 THEN 0.55 ELSE 0 END +
            CASE WHEN memory_kind = ANY($2::text[]) THEN 0.5 ELSE 0 END +
            importance_score * 0.35 +
            CASE WHEN cardinality($3::text[]) = 0 THEN 0.1 ELSE (
              SELECT COALESCE(SUM(CASE WHEN lower(content_abstract) LIKE '%' || term || '%' THEN 0.08 ELSE 0 END), 0)
              FROM unnest($3::text[]) AS term
            ) END
          )::double precision AS rank_score
        FROM semantic_memory
        WHERE namespace_id = $1
          AND memory_kind LIKE 'codex_%'
          AND status = 'active'
          AND valid_until IS NULL
      ),
      procedural_rows AS (
        SELECT
          id::text,
          state_type AS candidate_type,
          COALESCE(
            state_value->>'packet_text',
            state_value->>'profile_text',
            state_value->>'summary',
            state_value::text
          ) AS content,
          0.82::double precision AS confidence,
          'accepted'::text AS status,
          valid_from::text AS created_at,
          state_key AS canonical_key,
          state_value AS normalized_value,
          metadata,
          (
            CASE WHEN state_type = $5 THEN 0.55 ELSE 0 END +
            CASE WHEN state_type = ANY($2::text[]) THEN 0.5 ELSE 0 END +
            CASE WHEN cardinality($3::text[]) = 0 THEN 0.1 ELSE (
              SELECT COALESCE(SUM(CASE WHEN lower(state_value::text) LIKE '%' || term || '%' THEN 0.08 ELSE 0 END), 0)
              FROM unnest($3::text[]) AS term
            ) END
          )::double precision AS rank_score
        FROM procedural_memory
        WHERE namespace_id = $1
          AND state_type LIKE 'codex_%'
          AND valid_until IS NULL
      )
      SELECT *
      FROM (
        SELECT * FROM semantic_rows
        UNION ALL
        SELECT * FROM procedural_rows
      ) rows
      WHERE (
        (candidate_type = ANY($2::text[]) AND $6::boolean = false)
        OR cardinality($3::text[]) = 0
        OR EXISTS (
          SELECT 1
          FROM unnest($3::text[]) AS term
          WHERE lower(content) LIKE '%' || term || '%'
             OR lower(COALESCE(metadata->>'repo_path', '')) LIKE '%' || term || '%'
             OR lower(COALESCE(metadata->>'project', '')) LIKE '%' || term || '%'
        )
      )
      ORDER BY rank_score DESC, created_at DESC
      LIMIT $4
    `,
    [params.namespaceId, types, terms, params.limit, preferredType, hasScopedTerms]
  );
  return [...candidateRows, ...projectedRows]
    .filter((row) => timestampInSourceWindow(rowCapturedAt(row), params.sourceWindow ?? null))
    .sort((left, right) => right.rank_score - left.rank_score || right.created_at.localeCompare(left.created_at))
    .slice(0, params.limit);
}

function resultFromRow(namespaceId: string, row: CodexMemoryRow, index: number): RecallResult {
  const metadata = row.metadata ?? {};
  return {
    memoryId: `codex-memory-candidate:${row.id}`,
    memoryType: "memory_candidate",
    content: row.content,
    score: row.rank_score || 1 - index * 0.03,
    artifactId: null,
    occurredAt: typeof metadata.captured_at === "string" ? metadata.captured_at : null,
    namespaceId,
    provenance: {
      tier: "codex_curated_memory_candidate",
      source_uri: typeof metadata.source_uri === "string" ? metadata.source_uri : null,
      source_memory_id: row.id,
      candidate_type: row.candidate_type,
      status: row.status,
      confidence: row.confidence,
      source_event_start: metadata.source_event_start,
      source_event_end: metadata.source_event_end,
      project: typeof metadata.project === "string" ? metadata.project : null,
      repo_path: typeof metadata.repo_path === "string" ? metadata.repo_path : null,
      raw_transcript_embedding: metadata.raw_transcript_embedding === true
    }
  };
}

function sourceTrail(results: readonly RecallResult[]): readonly AnswerSectionSourceTrailEntry[] {
  return results.slice(0, 6).map((result) => ({
    sourceUri: typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null,
    artifactId: null,
    occurredAt: result.occurredAt ?? null,
    sourceMemoryIds: [result.memoryId],
    quote: cleanCodexMemoryContent(result.content).slice(0, 300)
  }));
}

function cleanCodexMemoryContent(value: string): string {
  let cleaned = value.replace(/\s+/gu, " ").trim();
  for (let i = 0; i < 3; i += 1) {
    cleaned = cleaned.replace(/^(?:Decision candidate|Session intent|Session outcome|Repeated user instruction|Agent failure pattern|Skill candidate|Token waste observation)\s+\d*:\s*/iu, "");
  }
  return cleaned
    .replace(/\bNext\.\s+js\b/giu, "Next.js")
    .replace(/\bNode\.\s+js\b/giu, "Node.js")
    .replace(/\b(?:Decision candidate|Session intent|Session outcome|Repeated user instruction|Agent failure pattern|Skill candidate|Token waste observation)\s+\d*:\s*/giu, "")
    .replace(/(?:Decision candidate|Session intent|Session outcome|Repeated user instruction|Agent failure pattern|Skill candidate|Token waste observation):\s*/giu, "")
    .replace(/\s+Avoid in future:\s*(?:yes|unknown)\.?$/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isLowSignalCodexContent(value: string): boolean {
  const cleaned = cleanCodexMemoryContent(value);
  return (
    !cleaned ||
    /^(?:<skill>|---\s*name:)/iu.test(cleaned) ||
    /\b(?:Automation ID:|Automation memory:|Last run:|Run the .*codex:sessions:maintain)\b/iu.test(cleaned) ||
    /\b(?:available skills|Codex Session Maintenance - AI Brain)\b/iu.test(cleaned)
  );
}

function isRawInstructionLikeCodexContent(value: string): boolean {
  return /^(?:you\s+are\s+gpt|your\s+first\s+job\s+is|your\s+mission:|read\s+the\s+.+spec\s+pack|produce\s+a\s+concrete\s+architecture|please\s+implement\s+this\s+plan|noisy\s+event|[*]{3}\s+begin\s+patch)\b/iu.test(
    cleanCodexMemoryContent(value)
  ) || /[*]{3}\s+(?:begin|update|add)\s+(?:patch|file)/iu.test(value);
}

function topContents(rows: readonly RecallResult[], maxItems = 3): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const row of rows) {
    const cleaned = cleanCodexMemoryContent(row.content);
    if (isRawInstructionLikeCodexContent(cleaned) || isLowSignalCodexContent(cleaned)) continue;
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    output.push(cleaned);
    if (output.length >= maxItems) break;
  }
  return output;
}

function sentenceList(items: readonly string[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((item) => item.replace(/[.。]\s*$/u, "")).join("; ") + ".";
}

function repeatedInstructionThemeSummary(rows: readonly RecallResult[]): string {
  const text = topContents(rows, 8).join(" ").toLowerCase();
  const themes: string[] = [];
  if (/\b(?:playwright|installed|global|tooling|setup|check)\b/iu.test(text)) {
    themes.push("check existing tooling/setup before adding or changing dependencies");
  }
  if (/\b(?:postgres|pg\s*vector|pgvector|pinecone|elasticsearch|database)\b/iu.test(text)) {
    themes.push("keep memory/retrieval infrastructure consolidated around Postgres/pgvector instead of scattering truth across multiple stores");
  }
  if (/\b(?:notebook|source-specific|research|sections?)\b/iu.test(text)) {
    themes.push("ask source-specific NotebookLM/research questions before implementation");
  }
  if (/\b(?:section|process|ingestion|markdown|memory|define)\b/iu.test(text)) {
    themes.push("break the system into clear ingestion, memory, retrieval, and review sections before coding");
  }
  if (/\b(?:local|mac|supabase|hosted|openrouter)\b/iu.test(text)) {
    themes.push("keep the design local-first on Mac while preserving a realistic hosted/test path");
  }
  if (/\b(?:source trail|claim audit|task list|changelog|docs)\b/iu.test(text)) {
    themes.push("keep task lists, changelog/docs, source trails, and claim audit aligned with code changes");
  }
  if (themes.length === 0) {
    return sentenceList(topContents(rows, 3), "No repeated instruction candidates were found.");
  }
  return `Repeated instruction patterns cluster around: ${themes.join("; ")}.`;
}

function failurePatternThemeSummary(rows: readonly RecallResult[]): string {
  const text = topContents(rows, 8).join(" ").toLowerCase();
  const themes: string[] = [];
  if (/\b(?:benchmark|gate|artifact|rerun|maintenance|pass)\b/iu.test(text)) {
    themes.push("benchmark and maintenance failures should be traced to artifact paths, then rerun through the smallest focused gate");
  }
  if (/\b(?:duplicate|conflicting|insert|constraint|key)\b/iu.test(text)) {
    themes.push("duplicate or constraint failures should be fixed in reusable insertion/deduplication logic");
  }
  if (/\b(?:spec|coverage|checkpoint|changelog|task list|docs)\b/iu.test(text)) {
    themes.push("spec, checkpoint, changelog, and task-list drift should be checked as part of the implementation loop");
  }
  if (/\b(?:raw transcript|source trail|claim audit|unsupported|fallback)\b/iu.test(text)) {
    themes.push("retrieval failures should preserve source trail and avoid unsupported fallback prose");
  }
  if (themes.length === 0) {
    return sentenceList(topContents(rows, 3), "No failure-pattern candidates were found.");
  }
  return `Avoid these recurring failure modes: ${themes.join("; ")}.`;
}

function skillCandidateThemeSummary(rows: readonly RecallResult[]): string {
  const text = topContents(rows, 8).join(" ").toLowerCase();
  const themes: string[] = [];
  if (/\b(?:benchmark|spec-coverage|failure|triage|rerun|maintenance)\b/iu.test(text)) {
    themes.push("a benchmark/spec-failure triage workflow that traces the failing artifact, fixes the reusable path, and reruns the focused gate");
  }
  if (/\b(?:docs|changelog|task list|checkpoint)\b/iu.test(text)) {
    themes.push("a docs-drift workflow that keeps task lists, checkpoints, and changelog entries aligned with code changes");
  }
  if (/\b(?:source trail|claim audit|retrieval|codex memory)\b/iu.test(text)) {
    themes.push("a source-audited retrieval workflow for validating Codex memory answers through MCP");
  }
  if (themes.length === 0) {
    return sentenceList(topContents(rows, 3), "No skill candidates were found.");
  }
  return `Skill candidates from these sessions: ${themes.join("; ")}.`;
}

function contentTerms(rows: readonly RecallResult[]): readonly string[] {
  const text = rows.map((row) => cleanCodexMemoryContent(row.content)).join(" ").toLowerCase();
  return ["AI Brain", "Operator Workbench", "NotebookLM", "Postgres", "MCP", "retrieval", "source trail", "task list", "changelog", "curated summaries", "raw transcripts", "vector sync"]
    .filter((term) => text.includes(term.toLowerCase()))
    .slice(0, 8);
}

function projectLabelFromQuery(queryText: string): string | null {
  const known = codexProjectLabelFromText(queryText);
  if (known) return known;
  const match = queryText.match(/\b(?:for|on|in|about|working\s+on)\s+(?:the\s+)?([a-z0-9][a-z0-9 _-]{2,80}?)(?=\s+(?:project|repo|app|work|sessions?|that|from|last|this|where|when|what|which|who|$)|[?.!,]|$)/iu);
  return match?.[1] ? canonicalCodexProjectLabel(match[1]) : null;
}

function projectLabelFromRows(rows: readonly RecallResult[]): string | null {
  const projects = rows
    .map((row) => (typeof row.provenance.project === "string" ? row.provenance.project : null))
    .filter((value): value is string => Boolean(value?.trim()));
  if (projects.length > 0) return projects[0]!;
  const repoPath = rows.map((row) => (typeof row.provenance.repo_path === "string" ? row.provenance.repo_path : null)).find(Boolean);
  if (!repoPath) return null;
  return titleCaseProject(repoPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? repoPath);
}

function engineeringMemoryPacketText(queryText: string, rows: readonly RecallResult[]): string {
  const projectLabel = projectLabelFromQuery(queryText) ?? projectLabelFromRows(rows) ?? "this repo";
  return `For future ${projectLabel} Codex work, preload these rules: use curated summaries instead of raw transcripts, keep changes tied to task lists/docs/changelog, preserve source trails, and check prior architecture decisions before editing.`;
}

function matchesProjectLabel(row: CodexProjectDetailSummaryRow, projectLabel: string | null): boolean {
  if (!projectLabel) return true;
  const haystack = [
    row.title ?? "",
    row.repo_path ?? "",
    row.summary_json.project ?? "",
    row.summary_json.session_title ?? ""
  ].join(" ");
  return codexProjectMatchesText(projectLabel, haystack);
}

async function loadCodexProjectDetailSummaryRows(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly limit: number;
  readonly sourceWindow?: CodexSourceWindow | null;
}): Promise<readonly CodexProjectDetailSummaryRow[]> {
  const projectLabel = projectLabelFromQuery(params.queryText);
  const rows = await queryRows<CodexProjectDetailSummaryRow>(
    `
      SELECT
        s.id::text AS summary_id,
        s.session_catalog_id::text AS session_catalog_id,
        c.codex_session_id,
        c.repo_path,
        c.title,
        c.captured_at::text AS captured_at,
        s.summary_json
      FROM codex_session_summaries s
      JOIN codex_session_catalog c ON c.id = s.session_catalog_id
      WHERE s.namespace_id = $1
        AND c.summary_status = 'summarized'
      ORDER BY c.captured_at DESC NULLS LAST, s.created_at DESC
      LIMIT $2
    `,
    [params.namespaceId, Math.max(params.limit * 6, 40)]
  );
  return rows
    .filter((row) => matchesProjectLabel(row, projectLabel))
    .filter((row) => timestampInSourceWindow(row.captured_at, params.sourceWindow ?? null))
    .slice(0, Math.max(params.limit * 3, 12));
}

function detailPhraseScore(queryText: string, sectionId: string, value: string): number {
  const text = cleanCodexMemoryContent(value).toLowerCase();
  const normalizedQuery = normalizedQueryTextWithTechnicalAliases(queryText).toLowerCase();
  let score = 0;
  for (const term of queryTerms(queryText)) {
    if (text.includes(term.toLowerCase())) score += 0.2;
  }
  for (const phrase of ["estimated-pricing", "raw transcript", "curated summaries", "embedding", "vector sync"]) {
    if (normalizedQuery.includes(phrase) && text.includes(phrase)) score += 1.1;
  }
  const cues =
    sectionId === "architecture" || sectionId === "decisions"
      ? ["target architecture", "next.js", "fastapi", "sqlite", "queue", "kie", "proxy", "backend", "frontend", "raw transcript", "curated summaries", "source trail", "embedding", "pricing", "estimated-pricing"]
      : sectionId === "bugs_fixes"
        ? ["resolution", "fixed", "patch", "queue", "event", "media_job_events", "stale", "recovered", "duplicate", "new workflow", "tab"]
        : sectionId === "proof_results"
          ? ["accepted", "completed", "published", "asset", "verified", "end-to-end", "real", "passed", "pricing", "estimated-pricing", "kie", "suno", "github actions", "artifact pair", "maintenance pass", "raw transcript", "curated summaries", "embedding", "vector sync", "scheduledscancount", "promotedcandidatecount", "projectedmemorycount"]
          : sectionId === "ingestion_ops"
            ? ["raw transcript", "curated summaries", "embedding", "vector sync", "scheduledscancount", "summarizedsessioncount", "promotedcandidatecount", "projectedmemorycount", "vectorsynccoveragecount", "claim audit", "source trail", "maintenance", "benchmark", "gate"]
          : sectionId === "tests_verification"
            ? ["passed", "green", "benchmark", "pytest", "npm", "smoke", "build"]
            : sectionId === "risks_followups"
              ? ["remaining", "next", "follow", "risk", "cleanup", "need"]
              : [];
  for (const cue of cues) {
    if (text.includes(cue)) score += 0.35;
  }
  if (/\b(?:start\s+by\s+reading|handoff\s+only|please\s+implement\s+this\s+plan|execution\s+instructions|docs\s+root|automation\s+id)\b/iu.test(value)) {
    score -= 1.2;
  }
  return score;
}

function joinSentences(values: readonly string[], maxItems = 4, queryText = "", sectionId = ""): string {
  const cleaned = values
    .map((value) => cleanCodexMemoryContent(value))
    .filter((value) => Boolean(value) && !isLowSignalCodexContent(value))
    .sort((left, right) => detailPhraseScore(queryText, sectionId, right) - detailPhraseScore(queryText, sectionId, left));
  return sentenceList(cleaned.slice(0, maxItems), "No source-backed detail was found.");
}

function extractLikelyTestCommand(value: string): string | null {
  const cleaned = cleanCodexMemoryContent(value).replace(/[`"“”]+/gu, " ");
  const match = cleaned.match(/\b(?:npm|pnpm|yarn)\s+run\s+[a-z0-9:_-]+|\b(?:pytest|vitest|jest|tsc)\b(?:\s+[-a-z0-9:_./]+)*/iu);
  return match ? normalizeWhitespace(match[0]) : null;
}

function testText(test: CodexSessionSummary["tests_run"][number]): string {
  const command = extractLikelyTestCommand(test.command);
  if (!command) return "";
  return test.result === "passed" ? `${command} (passed)` : command;
}

function bugText(bug: CodexSessionSummary["bugs_or_issues_found"][number]): string {
  const resolution = bug.resolution && bug.resolution !== "unknown" ? ` Resolution: ${bug.resolution}.` : "";
  return `${bug.issue}${resolution}`;
}

function failedApproachText(failure: CodexSessionSummary["failed_approaches"][number]): string {
  return `${failure.approach}${failure.why_failed ? ` Cause: ${failure.why_failed}.` : ""}`;
}

function projectDetailRequestedSections(queryText: string): readonly string[] {
  const requested: string[] = [];
  const wantsIngestionOps = /\b(?:codex\s+session|session\s+ingestion|raw\s+transcript|curated\s+summaries|vector\s+sync|maintenance\s+run|maintenance|promotedcandidatecount|projectedmemorycount|claim\s+audit|source\s+trail)\b/iu.test(queryText);
  const wantsArchitecture = /\b(?:architecture|target\s+design|implementation\s+plan|standalone\s+implementation|browser|backend|frontend|orchestration|credentials?)\b/iu.test(queryText);
  const wantsProof = /\b(?:proof|prove|real\s+kie|publish(?:ed)?|asset|end[- ]to[- ]end|worked|estimated[- ]pricing|pricing|kie\s+pricing|ci\s+verification|verified|verification|onboarding|suno|artifact|artifacts?|maintenance\s+pass)\b/iu.test(queryText);
  const wantsTests = /\b(?:tests?|verification|gates?|smoke|passed|failed|benchmark)\b/iu.test(queryText);
  const wantsRisks = /\b(?:risks?|follow[- ]?ups?|remaining|next\s+steps|suno|onboarding|ingestion)\b/iu.test(queryText);
  const wantsWorkspace = /\b(?:workspace|repo\s+confusion|wrong\s+repo|wrong\s+workspace|cwd|directory|duplicate|tabs?|workflow\s+tabs?)\b/iu.test(queryText);
  const wantsBeforeAfter = /\b(?:what\s+changed|changed\s+between|before\s+and\s+after|between\s+.+\s+and\s+.+)\b/iu.test(queryText);
  const wantsSource = /\b(?:source|sources|source\s+support|source\s+trail|come\s+from)\b/iu.test(queryText);

  if (wantsArchitecture) requested.push("architecture", "decisions");
  if (/\b(?:what\s+broke|went\s+wrong|how\s+was\s+it\s+fixed|fixed|bug|issue|queue|job\s+events?|stuck|stale\s+error|duplicate|tabs?|workflow\s+tabs?|what\s+happened)\b/iu.test(queryText)) {
    requested.push("bugs_fixes");
  }
  if (wantsTests) requested.push("tests_verification");
  if (wantsBeforeAfter) requested.push("before_after");
  if (wantsIngestionOps) requested.push("ingestion_ops");
  if (wantsProof) requested.push("proof_results");
  if (wantsRisks) requested.push("risks_followups");
  if (wantsWorkspace) requested.push("workspace_context");
  if (wantsSource) requested.push("source_trail");
  return uniqueStrings(requested.length > 0 ? requested : ["architecture", "decisions", "bugs_fixes", "proof_results", "tests_verification", "risks_followups"]);
}

function beforeAfterAnchorTerms(queryText: string): readonly string[] {
  const projectLabel = projectLabelFromQuery(queryText);
  const projectAliasTerms = new Set(
    (projectLabel ? (projectAliasEntryFor(projectLabel)?.aliases ?? [projectLabel]) : [])
      .flatMap((alias) => queryTerms(alias))
  );
  return queryTerms(queryText).filter((term) => ![
    "what",
    "changed",
    "change",
    "between",
    "before",
    "after",
    "first",
    "later",
    "earlier",
    "original",
    "phase",
    "work",
    "works"
  ].includes(term) && !projectAliasTerms.has(term));
}

function projectDetailItemScore(queryText: string, requested: readonly string[], item: CodexProjectDetailItem): number {
  const text = normalizeWhitespace(item.text).toLowerCase();
  const normalizedQuery = normalizedQueryTextWithTechnicalAliases(queryText).toLowerCase();
  const terms = queryTerms(queryText);
  let score = 0;
  const requestedIndex = requested.indexOf(item.sectionId);
  if (requestedIndex >= 0) score += 2 - requestedIndex * 0.05;
  for (const term of terms) {
    if (text.includes(term.toLowerCase())) score += 0.12;
  }
  for (const phrase of ["estimated-pricing", "raw transcript", "curated summaries", "embedding", "vector sync"]) {
    if (normalizedQuery.includes(phrase) && text.includes(phrase)) score += 1.25;
  }
  const concreteCues =
    item.sectionId === "architecture" || item.sectionId === "decisions"
      ? ["next.js", "fastapi", "sqlite", "queue", "kie", "proxy", "backend", "frontend", "credentials", "adapter"]
      : item.sectionId === "bugs_fixes"
        ? ["bug", "issue", "fix", "patch", "resolution", "queue", "event", "stale", "recovered"]
        : item.sectionId === "proof_results"
          ? ["accepted", "completed", "published", "asset", "verified", "end-to-end", "real", "passed", "raw transcript", "curated summaries", "embedding", "vector sync", "scheduledscancount", "promotedcandidatecount", "projectedmemorycount"]
          : item.sectionId === "ingestion_ops"
            ? ["raw transcript", "curated summaries", "embedding", "vector sync", "scheduledscancount", "summarizedsessioncount", "promotedcandidatecount", "projectedmemorycount", "vectorsynccoveragecount", "claim audit", "source trail", "maintenance", "benchmark", "gate"]
          : item.sectionId === "tests_verification"
            ? ["pytest", "npm", "test", "benchmark", "passed", "failed", "build", "smoke"]
            : item.sectionId === "workspace_context"
              ? ["repo", "workspace", "path", "cwd", "directory", "checkout"]
              : [];
  for (const cue of concreteCues) {
    if (text.includes(cue)) score += 0.25;
  }
  if (/\b(?:start\s+by\s+reading|handoff\s+only|please\s+implement\s+this\s+plan|execution\s+instructions|docs\s+root)\b/iu.test(item.text)) {
    score -= 1.5;
  }
  if (item.row.captured_at) score += Math.min(0.1, Math.max(0, Date.parse(item.row.captured_at) / 10_000_000_000_000));
  return score;
}

function projectDetailItemsForRow(row: CodexProjectDetailSummaryRow, queryText: string): readonly CodexProjectDetailItem[] {
  const summary = row.summary_json;
  const items: CodexProjectDetailItem[] = [];
  const candidateSummaries = summary.memory_candidates.map((candidate) => `${candidate.title}: ${candidate.summary}`);
  const wantsIngestionScopedArchitecture = /\b(?:codex\s+session|session\s+ingestion|raw\s+transcript|curated\s+summaries|vector\s+sync|embedding|claim\s+audit|source\s+trail)\b/iu.test(queryText);
  const ingestionArchitecturePattern = /\b(?:raw transcript|curated summaries|vector sync|embedding|source trail|claim audit|maintenance|scheduledScanCount|summarizedSessionCount|promotedCandidateCount|projectedMemoryCount|catalog_only)\b/iu;
  const ingestionOps = [
    summary.implementation_summary,
    ...summary.followups,
    ...summary.tests_run.map(testText),
    ...summary.architecture_decisions.map((decision) => decision.decision),
    ...candidateSummaries
  ].filter((value) => /\b(?:raw transcript|curated summaries|embedding|vector sync|scheduledScanCount|summarizedSessionCount|promotedCandidateCount|projectedMemoryCount|vectorSyncCoverageCount|maintenance|benchmark|gate|claim audit|source trail|catalog_only)\b/iu.test(value));
  if (ingestionOps.length > 0) {
    items.push({ sectionId: "ingestion_ops", sectionTitle: "Codex Ingestion Ops", text: joinSentences(ingestionOps, 5, queryText, "ingestion_ops"), row });
  }
  const architecture = [
    ...summary.architecture_decisions.map((decision) => decision.decision),
    ...summary.followups.filter((value) => /\b(?:target architecture|architecture|next\.js|fastapi|sqlite|queue|kie|browser|credentials?|backend|frontend|proxy|orchestration)\b/iu.test(value)),
    ...candidateSummaries.filter((value) => /\b(?:architecture|next\.js|fastapi|sqlite|queue|kie|backend|frontend|proxy|orchestration|raw transcript|curated summaries|vector sync|embedding)\b/iu.test(value))
  ].filter((value) => !wantsIngestionScopedArchitecture || ingestionArchitecturePattern.test(value));
  if (architecture.length > 0) {
    items.push({ sectionId: "architecture", sectionTitle: "Architecture", text: joinSentences(architecture, 4, queryText, "architecture"), row });
  }
  const decisions = summary.architecture_decisions
    .map((decision) => decision.decision)
    .filter((value) => !wantsIngestionScopedArchitecture || ingestionArchitecturePattern.test(value));
  const decisionItems = decisions.length === 0 && wantsIngestionScopedArchitecture
    ? ingestionOps.filter((value) => ingestionArchitecturePattern.test(value)).slice(0, 4)
    : decisions;
  if (decisionItems.length > 0) {
    items.push({ sectionId: "decisions", sectionTitle: "Decisions", text: joinSentences(decisionItems, 4, queryText, "decisions"), row });
  }
  const bugFixes = [
    summary.implementation_summary,
    ...summary.bugs_or_issues_found.map(bugText),
    ...summary.failed_approaches.map(failedApproachText),
    ...candidateSummaries.filter((value) => /\b(?:bug|issue|fix|patch|queue|event|stale|recovered|duplicate|wrong|root cause)\b/iu.test(value))
  ].filter((value) => /\b(?:bug|issue|fix|patch|queue|event|stale|recovered|duplicate|new\s+workflow|tabs?|wrong)\b/iu.test(value));
  if (bugFixes.length > 0) {
    items.push({ sectionId: "bugs_fixes", sectionTitle: "Bugs / Fixes", text: joinSentences(bugFixes, 5, queryText, "bugs_fixes"), row });
  }
  const proofResults = [
    summary.implementation_summary,
    ...summary.bugs_or_issues_found.map((bug) => bug.issue),
    ...summary.followups,
    ...candidateSummaries.filter((value) => /\b(?:raw transcript|curated summaries|embedding|vector sync|maintenance run|scheduledScanCount|promotedCandidateCount|projectedMemoryCount|verified|proof|benchmark|gate|passed)\b/iu.test(value))
  ].filter((value) => /\b(?:end[- ]to[- ]end|accepted|completed|published|asset|green|passed|works|verified|proof|live run|full run|real|estimated[- ]pricing|pricing|kie|suno|github actions|artifact pair|maintenance pass|codex-session-maintenance-run|raw transcript|curated summaries|embedding|vector sync|scheduledScanCount|promotedCandidateCount|projectedMemoryCount)\b/iu.test(value));
  if (proofResults.length > 0) {
    items.push({ sectionId: "proof_results", sectionTitle: "Proof / Results", text: joinSentences(proofResults, 4, queryText, "proof_results"), row });
  }
  const tests = summary.tests_run.map(testText);
  if (tests.length > 0) {
    items.push({ sectionId: "tests_verification", sectionTitle: "Tests / Verification", text: joinSentences(tests, 5, queryText, "tests_verification"), row });
  }
  const risks = [
    ...summary.followups,
    ...summary.open_questions,
    ...summary.bugs_or_issues_found.map((bug) => bug.issue),
    ...candidateSummaries.filter((value) => /\b(?:risk|remaining|next|follow|blocked|unsupported|cleanup|todo|need)\b/iu.test(value))
  ].filter((value) => /\b(?:risk|remaining|next|follow|blocked|unsupported|failed|issue|warning|cleanup|todo|still|need)\b/iu.test(value));
  if (risks.length > 0) {
    items.push({ sectionId: "risks_followups", sectionTitle: "Risks / Followups", text: joinSentences(risks, 5, queryText, "risks_followups"), row });
  }
  const workspace = [
    summary.implementation_summary,
    row.repo_path ? `Repo path: ${row.repo_path}` : "",
    ...summary.bugs_or_issues_found.map((bug) => bug.issue),
    ...summary.followups
  ].filter((value) => /\b(?:repo|workspace|cwd|directory|wrong|path|checkout|sibling|kie_codex_bootstrap|media-studio)\b/iu.test(value));
  if (workspace.length > 0) {
    items.push({ sectionId: "workspace_context", sectionTitle: "Workspace Context", text: joinSentences(workspace, 5, queryText, "workspace_context"), row });
  }
  return items;
}

function beforeAfterItems(rows: readonly CodexProjectDetailSummaryRow[], queryText: string): readonly CodexProjectDetailItem[] {
  const anchors = beforeAfterAnchorTerms(queryText);
  if (anchors.length < 2) return [];
  const scored = rows.map((row) => {
    const text = cleanCodexMemoryContent(`${row.summary_json.session_title ?? ""} ${row.summary_json.human_intent ?? ""} ${row.summary_json.implementation_summary ?? ""}`);
    if (!text || isLowSignalCodexContent(text)) {
      return { row, text: "", matchedAnchors: [] as string[] };
    }
    const lower = text.toLowerCase();
    return {
      row,
      text,
      matchedAnchors: anchors.filter((term) => lower.includes(term.toLowerCase()))
    };
  });
  const supported = scored.filter((entry) => entry.matchedAnchors.length > 0);
  const distinctAnchors = new Set(supported.flatMap((entry) => entry.matchedAnchors));
  if (distinctAnchors.size < 2) return [];
  const sorted = [...supported]
    .filter((entry) => entry.row.captured_at)
    .sort((left, right) => String(left.row.captured_at).localeCompare(String(right.row.captured_at)));
  const first = sorted[0];
  const last = [...sorted].reverse().find((entry) => entry.row.summary_id !== first?.row.summary_id && entry.matchedAnchors.some((term) => !first?.matchedAnchors.includes(term)));
  if (!first || !last || first.row.summary_id === last.row.summary_id) return [];
  const firstText = cleanCodexMemoryContent(first.row.summary_json.implementation_summary || first.row.summary_json.human_intent);
  const lastText = cleanCodexMemoryContent(last.row.summary_json.implementation_summary || last.row.summary_json.human_intent);
  if (isLowSignalCodexContent(firstText) || isLowSignalCodexContent(lastText)) return [];
  const text = `Earlier (${first.row.captured_at}): ${firstText} Later (${last.row.captured_at}): ${lastText}`;
  return [{ sectionId: "before_after", sectionTitle: "Before / After", text, row: last.row }];
}

function projectDetailResult(namespaceId: string, item: CodexProjectDetailItem, index: number): RecallResult {
  return {
    memoryId: `codex-project-detail:${item.row.summary_id}:${item.sectionId}`,
    memoryType: "memory_candidate",
    content: `${item.sectionTitle}: ${item.text}`,
    score: 1 - index * 0.03,
    artifactId: null,
    occurredAt: item.row.captured_at,
    namespaceId,
    provenance: {
      tier: "codex_project_detail_summary",
      source_uri: `codex-session://${item.row.codex_session_id ?? item.row.session_catalog_id}`,
      source_memory_id: item.row.summary_id,
      candidate_type: `codex_project_${item.sectionId}`,
      status: "accepted",
      confidence: 0.82,
      source_event_start: item.row.summary_json.source_event_start,
      source_event_end: item.row.summary_json.source_event_end,
      project: item.row.summary_json.project,
      repo_path: item.row.repo_path,
      raw_transcript_embedding: false
    }
  };
}

function projectDetailSectionText(sectionId: string, rows: readonly RecallResult[]): string {
  const contents = topContents(rows, 6).map((value) => value.replace(/^[A-Za-z][A-Za-z /]+:\s*/u, ""));
  if (contents.length === 0) {
    return `No source-backed ${sectionId.replace(/_/gu, " ")} detail was found in the selected Codex summaries.`;
  }
  return sentenceList(contents, `No source-backed ${sectionId.replace(/_/gu, " ")} detail was found.`);
}

async function readCodexProjectDetailMemory(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly limit: number;
  readonly sourceWindow?: CodexSourceWindow | null;
}): Promise<CodexMemoryReadResult | null> {
  const rows = await loadCodexProjectDetailSummaryRows(params);
  if (rows.length === 0) return null;
  const requested = projectDetailRequestedSections(params.queryText);
  const allItems = [...rows.flatMap((row) => projectDetailItemsForRow(row, params.queryText)), ...beforeAfterItems(rows, params.queryText)];
  const selectedItems = allItems
    .filter((item) => requested.includes(item.sectionId) || requested.includes("source_trail"))
    .sort((left, right) => projectDetailItemScore(params.queryText, requested, right) - projectDetailItemScore(params.queryText, requested, left));
  const fallbackItems = allItems
    .filter((item) => item.sectionId !== "source_trail")
    .sort((left, right) => projectDetailItemScore(params.queryText, requested, right) - projectDetailItemScore(params.queryText, requested, left))
    .slice(0, params.limit);
  const finalItems = (selectedItems.length > 0 ? selectedItems : fallbackItems).slice(0, Math.max(params.limit, 8));
  if (finalItems.length === 0) return null;
  const results = finalItems.map((item, index) => projectDetailResult(params.namespaceId, item, index));
  const bySection = (sectionId: string) => results.filter((result) => String(result.provenance.candidate_type ?? "") === `codex_project_${sectionId}`);
  if (requested.includes("before_after") && bySection("before_after").length === 0) {
    return null;
  }
  const sections = requested
    .filter((sectionId) => sectionId !== "source_trail")
    .map((sectionId) => {
      const sectionRows = bySection(sectionId);
      return section(
        sectionId,
        sectionId.split("_").map(titleCaseProject).join(" / "),
        sectionRows,
        projectDetailSectionText(sectionId, sectionRows)
      );
    })
    .filter((entry) => entry.evidenceCount > 0);
  const sourceSection = section("source_trail", "Source Trail", results.slice(0, 6), "These project-detail claims come from curated Codex session summaries, not raw transcript retrieval.");
  const answerSections = [...sections, sourceSection];
  const rawCuratedPolicy =
    /\b(?:raw\s+transcripts?|curated\s+summaries)\b/iu.test(params.queryText)
      ? "Raw Codex transcripts stay archive-only and are not embedded for retrieval; curated summaries are embedded after projection/vector sync and are the source-backed retrieval substrate. "
      : "";
  const claimText = `${rawCuratedPolicy}${answerSections
    .filter((entry) => entry.evidenceCount > 0)
    .map((entry) => `${entry.title}: ${entry.text}`)
    .join(" ")
    .slice(0, 7_500)}`;
  return {
    mode: "codex_project_detail_report",
    claimText: `Codex project-detail report: ${claimText}`.slice(0, 8_000),
    answerReason: "Codex project-detail intent selected curated structured session summaries before generic facts, repo docs, or fallback retrieval. Raw transcripts were not returned.",
    results,
    answerSections,
    rawTranscriptRetrievalCount: 0,
    packetTokenEstimate: estimateTokens(claimText)
  };
}

function candidateTypeLabels(rows: readonly RecallResult[]): readonly string[] {
  const labels = new Set<string>();
  for (const row of rows) {
    const type = String(row.provenance.candidate_type ?? "");
    if (type === "codex_architecture_decision") labels.add("architecture decisions");
    if (type === "codex_engineering_memory") labels.add("engineering memories");
    if (type === "codex_project_profile") labels.add("project profile");
    if (type === "codex_agent_packet_ledger") labels.add("agent memory packets");
    if (type === "codex_repeated_instruction") labels.add("repeated instructions");
    if (type === "codex_agent_failure_pattern") labels.add("failure patterns");
    if (type === "codex_skill_candidate") labels.add("skill candidates");
    if (type === "codex_token_waste_observation") labels.add("token waste observations");
  }
  return [...labels].slice(0, 5);
}

function codexSessionSummaryText(queryText: string, rows: readonly RecallResult[]): string {
  const contents = topContents(rows, 4);
  const labels = candidateTypeLabels(rows);
  const terms = contentTerms(rows);
  if (/\b(?:raw\s+codex\s+transcripts?|raw\s+transcripts?|curated\s+summaries|archive[- ]only)\b/iu.test(queryText)) {
    return "The source-backed policy is that raw Codex transcripts stay archive-only and are not embedded for retrieval. Curated summaries and promoted semantic/procedural rows are embedded after projection/vector sync; those curated rows are what retrieval uses, with source trail and claim audit preserved.";
  }
  if (/\b(?:vector\s+sync|embeddings?|embedded|semantic\s+rows)\b/iu.test(queryText)) {
    return "Codex embeddings are created for curated semantic memory rows after projection/vector sync. They support recall and similarity, but final Codex answers still come from metadata-filtered curated memory with source trail and claim audit; raw transcripts are not embedded.";
  }
  if (/\bstack\s+and\s+standards\b|\bstandards\s+usually\s+apply\b/iu.test(queryText)) {
    const stackTerms = ["TypeScript", "Postgres", "MCP", "NotebookLM", "pgvector", "source trail", "curated summaries"]
      .filter((term) => contents.join(" ").toLowerCase().includes(term.toLowerCase()));
    const stackText = stackTerms.length > 0 ? `The recurring stack/standard signals are ${stackTerms.join(", ")}.` : "";
    return `${stackText} The durable rule is to keep raw Codex transcripts archive-only, promote curated summaries into memory, and preserve source trails/claim audit for retrieval.`.trim();
  }
  if (/\b(?:promoted\s+truth|candidate\s+memories|memories\s+are\s+candidates)\b/iu.test(queryText)) {
    return "Codex session memories start as curated candidates, then promoted or confirmed rows become active semantic/procedural memory. Superseded/deprecated rows remain source-auditable but should not appear as active packet truth.";
  }
  if (/\b(?:architecture\s+decisions?|operator\s+workbench|decisions?\s+did\s+we\s+make)\b/iu.test(queryText)) {
    const architectureTerms = terms.length > 0 ? ` The source-backed terms are ${terms.join(", ")}.` : "";
    return contents.length > 0
      ? sentenceList(contents.slice(0, 3), "No Codex architecture-decision candidates were found.")
      : `The strongest Codex support is ${labels.length > 0 ? labels.join(", ") : "curated session memory"} rather than raw transcript retrieval.${architectureTerms}`.trim();
  }
  if (/\b(?:what\s+did\s+we\s+do\s+last\s+time|last\s+time\s+on\s+this\s+repo)\b/iu.test(queryText)) {
    const implementationContents = rows
      .map((row) => cleanCodexMemoryContent(row.content))
      .filter((content) => /\b(?:implemented|scanner|parser|redaction|summary|proof|followup)\b/iu.test(content));
    return sentenceList(implementationContents.length > 0 ? implementationContents.slice(0, 4) : contents.slice(0, 4), "No Codex implementation-summary candidates were found.");
  }
  if (/\b(?:personal\s+planning|prior\s+decisions?)\b/iu.test(queryText)) {
    return sentenceList(contents.slice(0, 4), "No Codex session candidates were found.");
  }
  const evidenceShape = labels.length > 0 ? labels.join(", ") : "curated Codex memory";
  const termText = terms.length > 0 ? ` It is anchored to ${terms.join(", ")}.` : "";
  return `The relevant Codex memory is a source-backed ${evidenceShape} bundle, not raw transcript search.${termText}`.trim();
}

function workflowSummaryText(sectionId: string, rows: readonly RecallResult[]): string {
  const contents = topContents(rows, 3);
  switch (sectionId) {
    case "repeated_instructions":
      return repeatedInstructionThemeSummary(rows);
    case "failure_patterns":
      return failurePatternThemeSummary(rows);
    case "skill_candidates":
      return skillCandidateThemeSummary(rows);
    case "token_waste":
      return contents.length > 0
        ? `Token waste signals: ${contents.map((item) => item.replace(/[.。]\s*$/u, "")).join("; ")}.`
        : "No token-waste candidates were found in this scoped Codex run; raw transcripts remain excluded from retrieval.";
    default:
      return sentenceList(contents, "No workflow pattern candidates were found.");
  }
}

function section(id: string, title: string, rows: readonly RecallResult[], text: string): StructuredAnswerSection {
  return {
    id,
    title,
    text,
    evidenceCount: rows.length,
    sourceTrail: sourceTrail(rows)
  };
}

export async function readCodexMemory(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly limit?: number;
  readonly timeStart?: string | null;
  readonly timeEnd?: string | null;
  readonly referenceNow?: string | null;
}): Promise<CodexMemoryReadResult | null> {
  const mode = codexMemoryModeForQuery(params.queryText);
  if (!mode) return null;
  const inferredWindow = resolveCodexSourceWindow(params.queryText, params.referenceNow ?? null);
  const sourceWindow =
    params.timeStart || params.timeEnd
      ? { rawText: "explicit tool time window", start: params.timeStart ?? null, end: params.timeEnd ?? null }
      : inferredWindow;
  if (mode === "codex_project_detail_report") {
    return readCodexProjectDetailMemory({
      namespaceId: params.namespaceId,
      queryText: params.queryText,
      limit: Math.max(params.limit ?? 8, 8),
      sourceWindow
    });
  }
  const rows = await loadCodexMemoryRows({
    namespaceId: params.namespaceId,
    queryText: params.queryText,
    mode,
    limit: Math.max(params.limit ?? 8, 8),
    sourceWindow
  });
  if (rows.length === 0) return null;
  const results = rows.map((row, index) => resultFromRow(params.namespaceId, row, index));
  const byType = (type: string) => results.filter((result) => String(result.provenance.candidate_type ?? "") === type);
  const decisions = [...byType("codex_architecture_decision"), ...byType("codex_engineering_memory")].slice(0, 4);
  const instructions = byType("codex_repeated_instruction").slice(0, 4);
  const failures = byType("codex_agent_failure_pattern").slice(0, 4);
  const skills = byType("codex_skill_candidate").slice(0, 4);
  const tokenWaste = byType("codex_token_waste_observation").slice(0, 4);
  const sections =
    mode === "codex_source_audit"
      ? [section("source_trail", "Source Trail", results, "These Codex memory claims come from curated session summary candidates, not raw transcript retrieval.")]
      : mode === "workflow_pattern_report"
        ? (() => {
            const workflowSections = [
              section("repeated_instructions", "Repeated Instructions", instructions, workflowSummaryText("repeated_instructions", instructions)),
              section("failure_patterns", "Failure Patterns", failures, workflowSummaryText("failure_patterns", failures)),
              section("skill_candidates", "Skill Candidates", skills, workflowSummaryText("skill_candidates", skills)),
              section("token_waste", "Token Waste", tokenWaste, workflowSummaryText("token_waste", tokenWaste))
            ];
            if (/\b(?:skill\s+candidates?|skills?\s+should|create\s+.*skills?)\b/iu.test(params.queryText)) {
              return [workflowSections[2]!, workflowSections[0]!, workflowSections[1]!, workflowSections[3]!];
            }
            if (/\btoken\s+waste\b/iu.test(params.queryText)) {
              return [workflowSections[3]!, workflowSections[0]!, workflowSections[1]!, workflowSections[2]!];
            }
            if (/\b(?:mistakes?|avoid|fallback|raw\s+transcripts?)\b/iu.test(params.queryText)) {
              return [workflowSections[1]!, workflowSections[0]!, workflowSections[2]!, workflowSections[3]!];
            }
            return workflowSections;
          })()
        : [
            section(
              "memory_packet",
              mode === "engineering_memory_packet" ? "Agent Memory Packet" : "Codex Session Report",
              results.slice(0, 6),
              mode === "engineering_memory_packet"
                ? engineeringMemoryPacketText(params.queryText, results.slice(0, 6))
                : codexSessionSummaryText(params.queryText, results.slice(0, 6))
            ),
            section("decisions", "Decisions", decisions, sentenceList(topContents(decisions, 3), "No decision candidates were found.")),
            section("followups", "Followups / Risks", [...failures, ...instructions].slice(0, 6), sentenceList(topContents([...failures, ...instructions].slice(0, 6), 3), "No followup candidates were found."))
          ];
  const claimText = sections
    .filter((entry) => entry.evidenceCount > 0)
    .map((entry) => `${entry.title}: ${entry.text}`)
    .join(" ")
    .slice(0, 7_500);
  const policyPrefix =
    mode === "engineering_memory_packet"
      ? "Agent memory packet: use curated summaries, keep raw transcripts out of retrieval, preserve task list/source-trail context, and cite included memory IDs from the packet ledger when available. "
      : mode === "codex_session_report"
        ? "Codex session report: raw Codex transcripts are archive-only; curated summaries become retrieval memory candidates and remain candidate memories until promoted truth is explicitly approved. "
        : mode === "workflow_pattern_report"
          ? "Workflow pattern report: inspect repeated instructions, docs drift, generic fallback mistakes, raw transcripts policy, skill candidates, and token waste from curated summaries. "
          : "Codex source audit: evidence comes from curated session summary candidates, not raw transcript retrieval. ";
  return {
    mode,
    claimText: `${policyPrefix}${claimText}`.slice(0, 8_000),
    answerReason: "Codex query intent selected the curated Codex memory reader before generic retrieval. Raw transcripts were not returned.",
    results,
    answerSections: sections,
    rawTranscriptRetrievalCount: results.filter((result) => result.provenance.raw_transcript_embedding === true).length,
    packetTokenEstimate: estimateTokens(claimText)
  };
}
