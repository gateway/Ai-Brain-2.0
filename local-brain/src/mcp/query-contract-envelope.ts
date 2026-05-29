import { queryCatalogEntryForContract } from "../retrieval/query-catalog-v1.js";
import { inferQueryContract } from "../retrieval/query-contract-router.js";
import { persistQueryReviewUnknownCandidate } from "../retrieval/query-review-backlog.js";
import { buildOperatorActionPrompt } from "./operator-action-prompt.js";

type QueryToolName = "memory.search" | "memory.recap" | "memory.extract_tasks" | "memory.extract_calendar";
type ClaimFamily =
  | "temporal"
  | "task"
  | "relationship"
  | "career"
  | "dossier_section"
  | "project"
  | "preference"
  | "source_topic"
  | "procedure"
  | "abstention"
  | "unknown";
type ClaimSupportKind =
  | "typed_read_model"
  | "procedural_truth"
  | "relationship_memory"
  | "answer_section"
  | "artifact_derivation"
  | "episodic_leaf"
  | "abstention";
type ClaimSupportStatus = "supported" | "partial" | "unsupported" | "abstained";
type ClaimFaithfulnessStatus = "verified" | "unchecked" | "failed";

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  if (Array.isArray(payload?.tasks)) {
    return payload.tasks;
  }
  if (Array.isArray(payload?.commitments)) {
    return payload.commitments;
  }
  return [];
}

function normalizeArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeSnippet(value: unknown, max = 220): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeSelectionTrace(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const stage = typeof record.stage === "string" ? record.stage.trim() : "";
    const decision = typeof record.decision === "string" ? record.decision.trim() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (!stage || !decision || !reason) {
      continue;
    }
    const selectedSections = uniqueStrings(normalizeArray(record.selectedSections));
    const rejectedOptions = uniqueStrings(normalizeArray(record.rejectedOptions));
    output.push({
      stage,
      decision,
      reason,
      ...(selectedSections.length > 0 ? { selectedSections } : {}),
      ...(rejectedOptions.length > 0 ? { rejectedOptions } : {})
    });
  }
  return output.slice(0, 8);
}

function normalizeSourceTrailEntries(value: unknown, maxItems = 12): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const sourceUri = typeof record.sourceUri === "string" ? record.sourceUri : null;
    const artifactId = typeof record.artifactId === "string" ? record.artifactId : null;
    const occurredAt = typeof record.occurredAt === "string" ? record.occurredAt : null;
    const sourceTable = typeof record.sourceTable === "string" ? record.sourceTable : null;
    const sourceRowId = typeof record.sourceRowId === "string" ? record.sourceRowId : null;
    const quote = normalizeSnippet(record.quote, 220);
    const sourceMemoryIds = uniqueStrings(normalizeArray(record.sourceMemoryIds));
    const sourceChunkIds = uniqueStrings(normalizeArray(record.sourceChunkIds));
    const sourceSceneIds = uniqueStrings(normalizeArray(record.sourceSceneIds));
    if (!sourceUri && !artifactId && sourceMemoryIds.length === 0 && sourceChunkIds.length === 0 && sourceSceneIds.length === 0 && !quote) {
      continue;
    }
    const key = [sourceUri ?? "none", artifactId ?? "none", sourceMemoryIds.join(","), sourceRowId ?? "none", quote ?? "none"].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push({
      sourceUri,
      artifactId,
      occurredAt,
      sourceMemoryIds,
      sourceChunkIds,
      sourceSceneIds,
      sourceTable,
      sourceRowId,
      quote
    });
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

function normalizeClaimAuditEntries(value: unknown, maxItems = 24): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const claimText = typeof record.claimText === "string" ? record.claimText.trim() : "";
    if (!id || !claimText) {
      continue;
    }
    const claimFamily = normalizeClaimFamily(record.claimFamily);
    const supportKind = normalizeSupportKind(record.supportKind);
    const supportStatus = normalizeSupportStatus(record.supportStatus);
    const faithfulnessStatus = normalizeFaithfulnessStatus(record.faithfulnessStatus);
    const sourceTrail = normalizeSourceTrailEntries(record.sourceTrail, 8);
    output.push({
      id,
      claimText,
      claimFamily,
      supportKind,
      finalClaimSource: typeof record.finalClaimSource === "string" ? record.finalClaimSource : null,
      evidenceCount: typeof record.evidenceCount === "number" && Number.isFinite(record.evidenceCount) ? record.evidenceCount : sourceTrail.length,
      sourceTrail,
      sourceQuotes: uniqueStrings(normalizeArray(record.sourceQuotes)),
      supportStatus,
      faithfulnessStatus
    });
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

function normalizeAnswerSections(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!id || !title || !text) {
      continue;
    }
    const evidenceCount = typeof record.evidenceCount === "number" && Number.isFinite(record.evidenceCount) ? record.evidenceCount : 0;
    const sourceTrail = normalizeSourceTrailEntries(record.sourceTrail, 8);
    const focusModes = uniqueStrings(normalizeArray(record.focusModes));
    const claimAudit = normalizeClaimAuditEntries(record.claimAudit, 8);
    output.push({
      id,
      title,
      text,
      evidenceCount,
      sourceTrail,
      ...(claimAudit.length > 0 ? { claimAudit } : {}),
      ...(focusModes.length > 0 ? { focusModes } : {})
    });
  }
  return output.slice(0, 12);
}

function deriveSelectionTrace(params: {
  readonly payload: Record<string, any>;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
}): readonly Record<string, unknown>[] {
  const meta = (params.payload?.meta ?? {}) as Record<string, unknown>;
  const explicit = normalizeSelectionTrace(meta.selectionTrace);
  if (explicit.length > 0) {
    return explicit;
  }
  const stage =
    typeof meta.dominantStage === "string"
      ? meta.dominantStage
      : typeof meta.finalRouteFamily === "string"
        ? meta.finalRouteFamily
        : params.finalClaimSource ?? "unknown";
  const reason =
    typeof meta?.answerAssessment === "object" && typeof (meta.answerAssessment as Record<string, unknown>).reason === "string"
      ? String((meta.answerAssessment as Record<string, unknown>).reason)
      : typeof meta.queryContractFallbackBlockedReason === "string"
        ? meta.queryContractFallbackBlockedReason
        : params.evidenceCount > 0
          ? "The runtime selected the highest-confidence source-bound route."
          : "The runtime abstained because no authoritative evidence was returned.";
  const selectedSections = uniqueStrings(
    evidenceItems(params.payload).flatMap((item: any) => {
      const provenance = item?.provenance && typeof item.provenance === "object" ? (item.provenance as Record<string, unknown>) : {};
      return [
        typeof provenance.section === "string" ? provenance.section : "",
        typeof provenance.entity_dossier_section === "string" ? provenance.entity_dossier_section : "",
        typeof provenance.work_history_section === "string" ? provenance.work_history_section : ""
      ].filter(Boolean);
    })
  );
  return [
    {
      stage,
      decision: params.evidenceCount > 0 ? "selected" : "abstained",
      reason,
      ...(selectedSections.length > 0 ? { selectedSections } : {})
    }
  ];
}

function buildSourceTrailFromItems(items: readonly any[]): readonly Record<string, unknown>[] {
  const trail: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const provenance = item?.provenance && typeof item.provenance === "object" ? (item.provenance as Record<string, unknown>) : {};
    const sourceUri =
      typeof item?.sourceUri === "string"
        ? item.sourceUri
        : typeof provenance.source_uri === "string"
          ? provenance.source_uri
          : null;
    const artifactId =
      typeof item?.artifactId === "string"
        ? item.artifactId
        : typeof provenance.source_artifact_id === "string"
          ? provenance.source_artifact_id
          : null;
    const sourceMemoryIds = uniqueStrings(
      [
        ...normalizeArray(provenance.source_memory_ids),
        typeof provenance.source_memory_id === "string" ? provenance.source_memory_id : "",
        typeof item?.memoryId === "string" ? item.memoryId : ""
      ].filter(Boolean)
    );
    const sourceChunkIds = uniqueStrings(
      [...normalizeArray(provenance.source_chunk_ids), typeof provenance.source_chunk_id === "string" ? provenance.source_chunk_id : ""].filter(Boolean)
    );
    const sourceSceneIds = uniqueStrings(
      [...normalizeArray(provenance.source_scene_ids), typeof provenance.source_scene_id === "string" ? provenance.source_scene_id : ""].filter(Boolean)
    );
    const sourceTable = typeof provenance.source_table === "string" ? provenance.source_table : null;
    const sourceRowId = typeof provenance.source_row_id === "string" ? provenance.source_row_id : null;
    const quote = normalizeSnippet(item?.snippet ?? provenance.source_quote ?? item?.content ?? item?.text);
    const occurredAt =
      typeof item?.occurredAt === "string"
        ? item.occurredAt
        : typeof provenance.occurred_at === "string"
          ? provenance.occurred_at
          : null;
    if (!sourceUri && !artifactId && sourceMemoryIds.length === 0 && sourceChunkIds.length === 0 && sourceSceneIds.length === 0) {
      continue;
    }
    const key = [
      sourceUri ?? "none",
      artifactId ?? "none",
      sourceMemoryIds.join(","),
      sourceChunkIds.join(","),
      sourceSceneIds.join(","),
      sourceTable ?? "none",
      sourceRowId ?? "none",
      quote ?? "none"
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    trail.push({
      sourceUri,
      artifactId,
      occurredAt,
      sourceMemoryIds,
      sourceChunkIds,
      sourceSceneIds,
      sourceTable,
      sourceRowId,
      quote
    });
  }
  return trail.slice(0, 12);
}

function buildSourceTrail(payload: any): readonly Record<string, unknown>[] {
  return buildSourceTrailFromItems(evidenceItems(payload));
}

function normalizeClaimFamily(value: unknown): ClaimFamily {
  const allowed: readonly ClaimFamily[] = [
    "temporal",
    "task",
    "relationship",
    "career",
    "dossier_section",
    "project",
    "preference",
    "source_topic",
    "procedure",
    "abstention",
    "unknown"
  ];
  return typeof value === "string" && allowed.includes(value as ClaimFamily) ? (value as ClaimFamily) : "unknown";
}

function normalizeSupportKind(value: unknown): ClaimSupportKind {
  const allowed: readonly ClaimSupportKind[] = [
    "typed_read_model",
    "procedural_truth",
    "relationship_memory",
    "answer_section",
    "artifact_derivation",
    "episodic_leaf",
    "abstention"
  ];
  return typeof value === "string" && allowed.includes(value as ClaimSupportKind) ? (value as ClaimSupportKind) : "episodic_leaf";
}

function normalizeSupportStatus(value: unknown): ClaimSupportStatus {
  const allowed: readonly ClaimSupportStatus[] = ["supported", "partial", "unsupported", "abstained"];
  return typeof value === "string" && allowed.includes(value as ClaimSupportStatus) ? (value as ClaimSupportStatus) : "unsupported";
}

function normalizeFaithfulnessStatus(value: unknown): ClaimFaithfulnessStatus {
  const allowed: readonly ClaimFaithfulnessStatus[] = ["verified", "unchecked", "failed"];
  return typeof value === "string" && allowed.includes(value as ClaimFaithfulnessStatus) ? (value as ClaimFaithfulnessStatus) : "unchecked";
}

function inferClaimFamily(params: {
  readonly queryContractName: string;
  readonly finalClaimSource: string | null;
  readonly answerShape: string;
  readonly toolName: QueryToolName;
  readonly sectionId?: string;
}): ClaimFamily {
  const haystack = [params.queryContractName, params.finalClaimSource ?? "", params.answerShape, params.toolName, params.sectionId ?? ""]
    .join(" ")
    .toLowerCase();
  if (/\babstain|abstention|gap|unknown\b/u.test(haystack)) return "abstention";
  if (/\btask|lifecycle\b/u.test(haystack)) return "task";
  if (/\btemporal|calendar|trip|travel|date|time|timeline\b/u.test(haystack)) return "temporal";
  if (/\brelationship|chronology|social|friend|edge\b/u.test(haystack)) return "relationship";
  if (/\bcareer|employment|employer|work_history|role|advisory|venture\b/u.test(haystack)) return "career";
  if (/\bproject_definition|project\b/u.test(haystack)) return "project";
  if (/\bsource_topic|artifact|source_audit\b/u.test(haystack)) return "source_topic";
  if (/\bpreference|constraint\b/u.test(haystack)) return "preference";
  if (/\bprocedure|protocol|how_to\b/u.test(haystack)) return "procedure";
  if (/\bdossier|profile_report|report|section\b/u.test(haystack)) return "dossier_section";
  return "unknown";
}

function inferSupportKind(params: {
  readonly finalClaimSource: string | null;
  readonly family: ClaimFamily;
  readonly sectionBacked?: boolean;
  readonly abstained?: boolean;
}): ClaimSupportKind {
  const source = (params.finalClaimSource ?? "").toLowerCase();
  if (params.abstained || params.family === "abstention") return "abstention";
  if (params.sectionBacked) return "answer_section";
  if (params.family === "relationship" || /\brelationship\b/u.test(source)) return "relationship_memory";
  if (/\bprocedural|truth|current_state|constraint\b/u.test(source)) return "procedural_truth";
  if (params.family === "source_topic" || /\bartifact|source_topic|derivation\b/u.test(source)) return "artifact_derivation";
  if (params.family === "temporal" || params.family === "task" || /\btyped|projection|read_model\b/u.test(source)) return "typed_read_model";
  return "episodic_leaf";
}

function claimTextForEvidenceItem(item: any): string | null {
  return normalizeSnippet(item?.claimText ?? item?.title ?? item?.summary ?? item?.text ?? item?.content ?? item?.snippet, 260);
}

function answerClaimText(params: {
  readonly toolName: QueryToolName;
  readonly queryText: string;
  readonly payload: Record<string, any>;
  readonly abstentionReason: string | null;
}): string {
  const answer = answerForToolPayload(params.toolName, params.queryText, params.payload);
  if (answer) return answer;
  const dualityClaim = normalizeSnippet(params.payload?.duality?.claim?.text, 260);
  if (dualityClaim) return dualityClaim;
  const summary = normalizeSnippet(params.payload?.summaryText, 260);
  if (summary) return summary;
  if (params.abstentionReason) return params.abstentionReason;
  return "No supported claim was selected.";
}

function terms(value: string): readonly string[] {
  return uniqueStrings(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length >= 4)
  );
}

function faithfulnessStatus(claimText: string, sourceTrail: readonly Record<string, unknown>[], supportStatus: ClaimSupportStatus): ClaimFaithfulnessStatus {
  if (supportStatus === "unsupported") return "failed";
  if (supportStatus === "abstained") return "verified";
  if (sourceTrail.length === 0) return "failed";
  const claimTerms = terms(claimText);
  const quoteTerms = terms(sourceTrail.map((item) => String(item.quote ?? "")).join(" "));
  if (claimTerms.length === 0 || quoteTerms.length === 0) return "unchecked";
  return claimTerms.some((term) => quoteTerms.includes(term)) ? "verified" : "unchecked";
}

function buildClaimAudit(params: {
  readonly toolName: QueryToolName;
  readonly queryText: string;
  readonly payload: Record<string, any>;
  readonly queryContractName: string;
  readonly answerShape: string;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrail: readonly Record<string, unknown>[];
  readonly sourceQuotes: readonly string[];
  readonly answerSections: readonly Record<string, unknown>[];
  readonly abstentionReason: string | null;
}): readonly Record<string, unknown>[] {
  const meta = (params.payload?.meta ?? {}) as Record<string, unknown>;
  const explicit = [
    ...normalizeClaimAuditEntries(params.payload.claimAudit),
    ...normalizeClaimAuditEntries(meta.claimAudit)
  ];
  if (explicit.length > 0) {
    return explicit;
  }

  const output: Record<string, unknown>[] = [];
  for (const section of params.answerSections) {
    const sectionId = String(section.id ?? "section");
    const sectionTrail = normalizeSourceTrailEntries(section.sourceTrail, 8);
    const family = inferClaimFamily({
      queryContractName: params.queryContractName,
      finalClaimSource: params.finalClaimSource,
      answerShape: params.answerShape,
      toolName: params.toolName,
      sectionId
    });
    const evidenceCount = typeof section.evidenceCount === "number" && Number.isFinite(section.evidenceCount) ? section.evidenceCount : sectionTrail.length;
    const supportStatus: ClaimSupportStatus = evidenceCount > 0 && sectionTrail.length > 0 ? "supported" : evidenceCount > 0 ? "partial" : "unsupported";
    const claimText = String(section.text ?? "").trim();
    output.push({
      id: `section:${sectionId}`,
      claimText,
      claimFamily: family,
      supportKind: inferSupportKind({ finalClaimSource: params.finalClaimSource, family, sectionBacked: true }),
      finalClaimSource: params.finalClaimSource,
      evidenceCount,
      sourceTrail: sectionTrail,
      sourceQuotes: uniqueStrings(sectionTrail.map((item) => String(item.quote ?? "")).filter(Boolean)),
      supportStatus,
      faithfulnessStatus: faithfulnessStatus(claimText, sectionTrail, supportStatus)
    });
  }

  if (output.length === 0) {
    const items = evidenceItems(params.payload);
    for (const [index, item] of items.entries()) {
      const itemTrail = buildSourceTrailFromItems([item]);
      const claimText = claimTextForEvidenceItem(item);
      if (!claimText) {
        continue;
      }
      const family = inferClaimFamily({
        queryContractName: params.queryContractName,
        finalClaimSource: params.finalClaimSource,
        answerShape: params.answerShape,
        toolName: params.toolName
      });
      const supportStatus: ClaimSupportStatus = itemTrail.length > 0 ? "supported" : "partial";
      output.push({
        id: `evidence:${index + 1}`,
        claimText,
        claimFamily: family,
        supportKind: inferSupportKind({ finalClaimSource: params.finalClaimSource, family }),
        finalClaimSource: params.finalClaimSource,
        evidenceCount: 1,
        sourceTrail: itemTrail.length > 0 ? itemTrail : params.sourceTrail.slice(0, 1),
        sourceQuotes: uniqueStrings((itemTrail.length > 0 ? itemTrail : params.sourceTrail).map((trailItem) => String(trailItem.quote ?? "")).filter(Boolean)),
        supportStatus,
        faithfulnessStatus: faithfulnessStatus(claimText, itemTrail.length > 0 ? itemTrail : params.sourceTrail.slice(0, 1), supportStatus)
      });
      if (output.length >= 12) {
        break;
      }
    }
  }

  if (output.length === 0) {
    const abstained = params.evidenceCount === 0;
    const family = inferClaimFamily({
      queryContractName: params.queryContractName,
      finalClaimSource: params.finalClaimSource,
      answerShape: params.answerShape,
      toolName: params.toolName
    });
    const claimText = answerClaimText({ toolName: params.toolName, queryText: params.queryText, payload: params.payload, abstentionReason: params.abstentionReason });
    const supportStatus: ClaimSupportStatus = abstained ? "abstained" : params.sourceTrail.length > 0 ? "supported" : "unsupported";
    output.push({
      id: abstained ? "abstention:1" : "claim:1",
      claimText,
      claimFamily: abstained ? "abstention" : family,
      supportKind: inferSupportKind({ finalClaimSource: params.finalClaimSource, family, abstained }),
      finalClaimSource: params.finalClaimSource,
      evidenceCount: params.evidenceCount,
      sourceTrail: params.sourceTrail,
      sourceQuotes: params.sourceQuotes,
      supportStatus,
      faithfulnessStatus: faithfulnessStatus(claimText, params.sourceTrail, supportStatus)
    });
  }

  return output.slice(0, 24);
}

function taskAnswer(queryText: string, tasks: readonly any[]): string | null {
  if (tasks.length === 0) {
    return "No task items were found in the scoped evidence.";
  }
  const titles = tasks
    .map((task) => (typeof task?.title === "string" ? task.title.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
  if (titles.length === 0) {
    return null;
  }
  const label = /\b(?:travel|trip|trips|flight|hotel|july|september|summer|istanbul|thailand|rv|jeep|driver'?s?\s+license|storage)\b/iu.test(queryText)
    ? "Travel-planning open tasks"
    : "Open tasks";
  return `${label}: ${titles.join("; ")}.`;
}

function calendarAnswer(commitments: readonly any[]): string | null {
  const items = commitments
    .map((commitment) => {
      const title = typeof commitment?.title === "string" ? commitment.title.trim() : "";
      const timeHint = typeof commitment?.timeHint === "string" ? commitment.timeHint.trim() : "";
      if (!title) {
        return "";
      }
      return timeHint ? `${title} (${timeHint})` : title;
    })
    .filter(Boolean)
    .slice(0, 8);
  if (items.length === 0) {
    return null;
  }
  return `Commitments: ${items.join("; ")}.`;
}

function answerForToolPayload(toolName: QueryToolName, queryText: string, payload: Record<string, any>): string | undefined {
  if (typeof payload.answer === "string" && payload.answer.trim().length > 0) {
    return payload.answer;
  }
  if (payload.followUpAction === "route_to_clarifications" && typeof payload.clarificationHint?.suggestedPrompt === "string") {
    return payload.clarificationHint.suggestedPrompt;
  }
  if (toolName === "memory.extract_tasks" && Array.isArray(payload.tasks)) {
    return taskAnswer(queryText, payload.tasks) ?? undefined;
  }
  if (toolName === "memory.extract_calendar" && Array.isArray(payload.commitments)) {
    return calendarAnswer(payload.commitments) ?? undefined;
  }
  return undefined;
}

export async function attachStableQueryContractEnvelope(params: {
  readonly toolName: QueryToolName;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly payload: Record<string, any>;
}): Promise<Record<string, any>> {
  const inferred = inferQueryContract(params.queryText);
  const meta = (params.payload?.meta ?? {}) as Record<string, unknown>;
  const toolDefaultContract =
    params.toolName === "memory.extract_tasks"
      ? "task_list"
      : params.toolName === "memory.extract_calendar"
        ? "temporal_event"
        : null;
  const queryContractName = String(meta.queryContractName ?? toolDefaultContract ?? inferred.contractName);
  const catalogEntry = queryCatalogEntryForContract(queryContractName);
  const retrievalDomain = String(meta.queryContractRetrievalDomain ?? catalogEntry?.retrievalDomain ?? inferred.retrievalDomain);
  const answerShape = String(
    meta.queryContractAnswerShape ??
      (params.toolName === "memory.extract_tasks" || params.toolName === "memory.extract_calendar" ? "list" : undefined) ??
      catalogEntry?.answerShape ??
      inferred.answerShape
  );
  const evidenceCount = evidenceItems(params.payload).length;
  const finalClaimSource =
    typeof meta.finalClaimSource === "string"
      ? meta.finalClaimSource
        : typeof meta.finalRouteFamily === "string"
          ? meta.finalRouteFamily
          : params.toolName === "memory.extract_tasks" && evidenceCount > 0
          ? "task_extraction"
          : params.toolName === "memory.extract_calendar" && evidenceCount > 0
            ? Array.isArray(params.payload.commitments) && params.payload.commitments.length === 0
              ? "typed_temporal_anchor_abstention"
              : "typed_temporal_anchor"
        : null;
  const followUpAction =
    typeof meta.followUpAction === "string"
      ? meta.followUpAction
      : typeof params.payload?.followUpAction === "string"
        ? params.payload.followUpAction
      : typeof params.payload?.duality?.followUpAction === "string"
        ? params.payload.duality.followUpAction
        : "none";
  const blockedFallbacks = normalizeArray(meta.queryContractBlockedFallbacks ?? catalogEntry?.abstainWhen ?? inferred.blockedFallbacks);
  const abstentionReason =
    typeof meta.queryContractFallbackBlockedReason === "string"
      ? meta.queryContractFallbackBlockedReason
      : typeof params.payload?.clarificationHint?.reason === "string"
        ? params.payload.clarificationHint.reason
      : typeof meta.temporalAmbiguityReason === "string"
        ? meta.temporalAmbiguityReason
      : evidenceCount === 0
        ? String((params.payload?.meta?.answerAssessment as any)?.reason ?? "no_authoritative_evidence")
        : null;
  const queryEmbeddingCacheHit = meta.queryEmbeddingCacheHit === true;
  const vectorContribution =
    typeof meta.vectorContribution === "string"
      ? meta.vectorContribution
      : meta.vectorContributedToFinalSupport === true
        ? "final_support"
        : typeof meta.vectorCandidateCount === "number" && meta.vectorCandidateCount > 0
          ? "candidate_pool"
          : "none";
  const vectorBlockedReason =
    typeof meta.vectorBlockedReason === "string"
      ? meta.vectorBlockedReason
      : typeof meta.vectorFallbackReason === "string"
        ? meta.vectorFallbackReason
        : null;
  const selectionTrace = deriveSelectionTrace({
    payload: params.payload,
    finalClaimSource,
    evidenceCount
  });
  const sourceTrail = buildSourceTrail(params.payload);
  const answerSections = normalizeAnswerSections(meta.answerSections);
  const primarySource = (sourceTrail[0] ?? null) as Record<string, unknown> | null;
  const sourceQuotes = uniqueStrings(sourceTrail.map((item) => String(item.quote ?? "")).filter(Boolean));
  const claimAudit = buildClaimAudit({
    toolName: params.toolName,
    queryText: params.queryText,
    payload: params.payload,
    queryContractName,
    answerShape,
    finalClaimSource,
    evidenceCount,
    sourceTrail,
    sourceQuotes,
    answerSections,
    abstentionReason
  });
  const answerSectionsWithAudit = answerSections.map((section) => {
    if (Array.isArray(section.claimAudit) && section.claimAudit.length > 0) {
      return section;
    }
    const sectionAudit = claimAudit.filter((entry) => String(entry.id ?? "") === `section:${String(section.id ?? "")}`);
    return sectionAudit.length > 0 ? { ...section, claimAudit: sectionAudit } : section;
  });
  const sourceMemoryIds = uniqueStrings(sourceTrail.flatMap((item) => normalizeArray(item.sourceMemoryIds)));
  const sourceChunkIds = uniqueStrings(sourceTrail.flatMap((item) => normalizeArray(item.sourceChunkIds)));
  const sourceSceneIds = uniqueStrings(sourceTrail.flatMap((item) => normalizeArray(item.sourceSceneIds)));
  const operatorActionPrompt = buildOperatorActionPrompt({
    queryText: params.queryText,
    evidenceCount,
    abstentionReason,
    sourceAuditTarget: meta.memoryQueryPlanSourceAuditTarget,
    privacyBlocked: params.payload?.sourcePrivacy?.blocked === true
  });

  const shouldRecordReviewUnknown = queryContractName === "review_only" || retrievalDomain === "review_unknown";
  let recordedReviewUnknown = false;
  if (shouldRecordReviewUnknown) {
    await persistQueryReviewUnknownCandidate({
      namespaceId: params.namespaceId,
      toolName: params.toolName,
      queryText: params.queryText,
      suggestedRetrievalDomain: retrievalDomain,
      blockedReason: typeof meta.queryContractFallbackBlockedReason === "string" ? meta.queryContractFallbackBlockedReason : "review_unknown_contract",
      graduationRecommendation: "define_new_query_contract",
      routingReasons: normalizeArray(meta.queryContractRoutingReasons ?? inferred.routingReasons)
    });
    recordedReviewUnknown = true;
  }

  return {
    ...params.payload,
    ...(answerForToolPayload(params.toolName, params.queryText, params.payload) ? { answer: answerForToolPayload(params.toolName, params.queryText, params.payload) } : {}),
    queryContract: queryContractName,
    retrievalDomain,
    answerShape,
    finalClaimSource,
    evidenceCount,
    selectionTrace,
    answerSections: answerSectionsWithAudit,
    claimAudit,
    sourceTrail,
    primarySource,
    sourceQuotes,
    sourceMemoryIds,
    sourceChunkIds,
    sourceSceneIds,
    queryEmbeddingCacheHit,
    vectorContribution,
    vectorBlockedReason,
    followUpAction,
    abstentionReason,
    blockedFallbacks,
    operatorActionPrompt,
    reviewUnknown: {
      shouldRecord: shouldRecordReviewUnknown,
      recorded: recordedReviewUnknown,
      suggestedRetrievalDomain: shouldRecordReviewUnknown ? retrievalDomain : null,
      blockedReason: shouldRecordReviewUnknown ? abstentionReason ?? "review_unknown_contract" : null
    }
  };
}
