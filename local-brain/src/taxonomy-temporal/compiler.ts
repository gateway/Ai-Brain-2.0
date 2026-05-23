import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import { runExternalRelationExtractionShadow, shutdownRelationIeSidecarWorker } from "../relationships/external-ie.js";
import { ASSISTANT_PROMPT_VERSION, runTaxonomyTemporalAssistant, deterministicAssistantCandidates } from "./assistant.js";
import { compilerCacheKey, loadCompilerCacheEntry, upsertCompilerCacheEntry } from "./compiler-cache.js";
import { buildExtractionUnits, persistExtractionUnitsForClient } from "./extraction-units.js";
import {
  candidateHasReviewOnlySuggestion,
  loadMemoryTaxonomyRegistry,
  persistTaxonomyReviewItemForClient,
  validateCandidateTaxonomy
} from "./registry.js";
import { resolveTemporalCandidate } from "./temporal.js";
import { persistCompiledDirectFactObservationForClient } from "./direct-fact-compiler.js";
import type {
  AssistantCandidate,
  AssistantRunResult,
  CompilerRunResult,
  ExtractionAssistantMode,
  ExtractionUnitBuildInput,
  TaxonomyRegistry,
  ValidatedCandidate,
  ValidationIssue
} from "./types.js";

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function readConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

const PROFILE_TRAIT_FAMILIES = new Set([
  "profile_trait",
  "civic_identity",
  "religious_identity",
  "political_orientation",
  "personality_trait",
  "allyship_support",
  "value_stance"
]);

function isProfileTraitCandidate(candidate: AssistantCandidate): boolean {
  const domain = normalize(candidate.domain);
  const family = normalize(candidate.family);
  const traitFamily = normalize(candidate.trait_family);
  return domain === "identity_values" || PROFILE_TRAIT_FAMILIES.has(family) || PROFILE_TRAIT_FAMILIES.has(traitFamily);
}

function profileTraitFamily(candidate: AssistantCandidate): string {
  const traitFamily = normalize(candidate.trait_family);
  const family = normalize(candidate.family);
  if (PROFILE_TRAIT_FAMILIES.has(traitFamily) && traitFamily !== "profile_trait") {
    return traitFamily;
  }
  if (PROFILE_TRAIT_FAMILIES.has(family) && family !== "profile_trait") {
    return family;
  }
  const subtype = normalize(candidate.subtype);
  return PROFILE_TRAIT_FAMILIES.has(subtype) && subtype !== "profile_trait" ? subtype : "profile_trait";
}

function profileTraitAnswerValue(candidate: AssistantCandidate): string {
  const polarity = normalize(candidate.polarity).toLowerCase();
  if (polarity === "negative") {
    return "Likely no";
  }
  const traitValue = normalize(candidate.trait_value);
  if (traitValue && !["yes", "true", "positive"].includes(traitValue.toLowerCase())) {
    return `Likely yes: ${traitValue}`;
  }
  return "Likely yes";
}

function evidenceIssue(candidate: AssistantCandidate, candidateIndex: number): ValidationIssue | null {
  return normalize(candidate.evidence_quote)
    ? null
    : { code: "missing_evidence_quote", message: "Promotion requires exact source evidence quote.", candidateIndex };
}

function promotionAllowed(candidate: AssistantCandidate, issues: readonly ValidationIssue[]): boolean {
  const recommendation = normalize(candidate.promotion_recommendation);
  const status = normalize(candidate.taxonomy_status);
  if (recommendation !== "promote") {
    return false;
  }
  if (
    status === "needs_taxonomy_review" ||
    status === "diagnostic_only" ||
    status === "generic_reviewable" ||
    status === "unsupported"
  ) {
    return false;
  }
  return issues.length === 0;
}

function admissionIssues(candidate: AssistantCandidate, candidateIndex: number): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const evidenceQuote = normalize(candidate.evidence_quote);
  const candidateType = normalize(candidate.candidate_type);
  const domain = normalize(candidate.domain);
  const family = normalize(candidate.family);
  const subtype = normalize(candidate.subtype);
  const objectType = normalize(candidate.object_type);
  const recommendation = normalize(candidate.promotion_recommendation);
  if (recommendation !== "promote") {
    return issues;
  }
  if (!["fact", "event", "relationship", "task", "temporal_reference", "diagnostic"].includes(candidateType)) {
    issues.push({
      code: "unknown_candidate_type",
      message: "Promotion requires a known taxonomy-temporal candidate type.",
      candidateIndex
    });
  }
  if (domain === "unknown" || family === "unclassified_observation" || subtype === "unknown_reviewable") {
    issues.push({
      code: "review_only_taxonomy_promoted",
      message: "Unknown or unclassified taxonomy rows are review-only and cannot be promoted.",
      candidateIndex
    });
  }
  if (
    family === "current_state" &&
    subtype === "service_name" &&
    !/\b(?:service|provider|subscription|music|streaming|switched|using|use|spotify|apple music|youtube music|tidal)\b/iu.test(evidenceQuote)
  ) {
    issues.push({
      code: "weak_service_name_evidence",
      message: "Service-name facts require an explicit service/provider cue or known service value.",
      candidateIndex
    });
  }
  if (family === "project_support" && !/\b(?:project|engine|graph|tool|postgres|taxonomy|registry|roadmap|memoir)\b/iu.test(evidenceQuote)) {
    issues.push({
      code: "weak_project_support_evidence",
      message: "Project support promotion requires an explicit project, tool, substrate, or roadmap cue.",
      candidateIndex
    });
  }
  if (family === "project_support" && objectType === "DOCUMENT_OR_MEDIA") {
    issues.push({
      code: "project_support_document_value",
      message: "A document/media value is not an authoritative project-support fact without a project/tool cue.",
      candidateIndex
    });
  }
  if (family === "temporal_event" && !candidate.temporal) {
    issues.push({
      code: "temporal_event_missing_temporal_payload",
      message: "Temporal event promotion requires a temporal payload.",
      candidateIndex
    });
  }
  if (family === "health_status" && subtype === "diagnosis" && !/\b(?:diagnosed|diagnosis|adhd|anxiety|depression|condition)\b/iu.test(evidenceQuote)) {
    issues.push({
      code: "weak_health_status_evidence",
      message: "Health-status promotion requires explicit health status evidence.",
      candidateIndex
    });
  }
  if (isProfileTraitCandidate(candidate)) {
    if (!normalize(candidate.subject)) {
      issues.push({
        code: "subject_ambiguous",
        message: "Profile-trait promotion requires an explicit subject.",
        candidateIndex
      });
    }
    if (normalize(candidate.polarity).toLowerCase() === "ambiguous") {
      issues.push({
        code: "polarity_ambiguous",
        message: "Ambiguous profile-trait polarity is review-only.",
        candidateIndex
      });
    }
    if (
      /\b(?:job|role|career|project|worked as|works as|title|manager|engineer|designer)\b/iu.test(evidenceQuote) &&
      !/\b(?:value|believe|belief|proud|patriotic|religious|spiritual|atheist|agnostic|political|policy|supports?|advocates?|ally|trait)\b/iu.test(evidenceQuote)
    ) {
      issues.push({
        code: "generic_role_summary",
        message: "Generic role or career summaries cannot compile as trait truth.",
        candidateIndex
      });
    }
    if (
      !/\b(?:patriotic|proud|country|nation|fourth of july|independence day|flag|anthem|civic|religious|spiritual|atheist|agnostic|belief|political|policy|party|progressive|conservative|liberal|ally|advocates?|supports?|mentors?|helped|trait|personality|values?)\b/iu.test(
        evidenceQuote
      )
    ) {
      issues.push({
        code: "missing_trait_evidence",
        message: "Profile-trait promotion requires explicit trait/value evidence, not a co-mention.",
        candidateIndex
      });
    }
  }
  return issues;
}

function mergeCandidates(assistant: AssistantRunResult, fallback: readonly AssistantCandidate[]): readonly AssistantCandidate[] {
  const seen = new Set<string>();
  const merged: AssistantCandidate[] = [];
  // Deterministic candidates are compact value-slot extracts; keep them ahead of
  // broader LLM clauses so exact-detail promotion stays atomic.
  for (const candidate of [...fallback, ...(assistant.output?.candidates ?? [])]) {
    const quote = normalize(candidate.evidence_quote).toLowerCase();
    if (
      merged.some((existing) => {
        const existingQuote = normalize(existing.evidence_quote).toLowerCase();
        const sameTaxonomy =
          normalize(existing.domain) === normalize(candidate.domain) &&
          normalize(existing.family) === normalize(candidate.family) &&
          normalize(existing.subtype) === normalize(candidate.subtype);
        return sameTaxonomy && Boolean(quote) && Boolean(existingQuote) && (quote.includes(existingQuote) || existingQuote.includes(quote));
      })
    ) {
      continue;
    }
    const key = [
      normalize(candidate.candidate_type),
      quote,
      normalize(candidate.domain),
      normalize(candidate.family),
      normalize(candidate.subtype)
    ].join("|");
    if (seen.has(key) || !normalize(candidate.evidence_quote)) {
      continue;
    }
    seen.add(key);
    merged.push(candidate);
  }
  return merged.slice(0, 6);
}

async function runGliner2(unitText: string): Promise<CompilerRunResult["gliner2"]> {
  try {
    const response = await runExternalRelationExtractionShadow([{ sceneIndex: 0, text: unitText }], { extractors: ["gliner2"] });
    const warningCount = response.scenes.reduce(
      (sum, scene) => sum + scene.extractors.reduce((inner, extractor) => inner + (extractor.warnings?.length ?? 0), 0),
      0
    );
    return {
      attempted: true,
      warningCount,
      response: response as unknown as Record<string, unknown>,
      error: response.errors?.join("; ") || null
    };
  } catch (error) {
    return {
      attempted: true,
      warningCount: 1,
      response: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function validateAssistantCandidates(params: {
  readonly registry: TaxonomyRegistry;
  readonly sourceCapturedAt: string | null;
  readonly candidates: readonly AssistantCandidate[];
}): readonly ValidatedCandidate[] {
  return params.candidates.map((candidate, candidateIndex) => {
    const taxonomyIssues = validateCandidateTaxonomy(params.registry, candidate, candidateIndex);
    const evidence = evidenceIssue(candidate, candidateIndex);
    const temporal = resolveTemporalCandidate({
      registry: params.registry,
      candidate,
      sourceCapturedAt: params.sourceCapturedAt,
      candidateIndex
    });
    const suggestionIssue =
      candidateHasReviewOnlySuggestion(candidate) && candidate.promotion_recommendation === "promote"
        ? {
            code: "suggested_taxonomy_promoted",
            message: "Review-only suggested taxonomy cannot be promoted.",
            candidateIndex
          }
        : null;
    const issues = [
      ...taxonomyIssues,
      ...temporal.issues,
      ...admissionIssues(candidate, candidateIndex),
      ...(evidence ? [evidence] : []),
      ...(suggestionIssue ? [suggestionIssue] : [])
    ];
    return {
      candidate,
      promotionEligible: promotionAllowed(candidate, issues),
      issues,
      normalizedTemporal: temporal.temporal
    };
  });
}

export async function runTaxonomyTemporalCompiler(input: ExtractionUnitBuildInput, options?: {
  readonly mode?: ExtractionAssistantMode;
  readonly registry?: TaxonomyRegistry;
  readonly skipGliner2?: boolean;
  readonly usePersistentCache?: boolean;
  readonly writePersistentCache?: boolean;
}): Promise<readonly CompilerRunResult[]> {
  const registry = options?.registry ?? (await loadMemoryTaxonomyRegistry());
  const units = buildExtractionUnits(input);
  const results: CompilerRunResult[] = [];

  for (const unit of units) {
    const chunkBudgetPass = unit.chunkingStatus === "ready";
    const cacheIdentity = {
      cacheScope: "taxonomy_temporal_unit" as const,
      namespaceId: input.namespaceId,
      sourceText: unit.unitText,
      sourceType: input.sourceType,
      relationIeMode: null,
      extractorSignature: [
        options?.skipGliner2 ? "deterministic+assistant:no_gliner2" : "gliner2+deterministic+assistant",
        `assistant_mode:${options?.mode ?? "configured"}`
      ].join("|"),
      taxonomyVersion: registry.version,
      temporalVersion: "temporal_semantic_v1",
      assistantModelId: null,
      gliner2ModelId: options?.skipGliner2 ? null : "fastino/gliner2-base-v1",
      schemaVersion: "taxonomy_temporal_assistant_output_v1",
      promptVersion: ASSISTANT_PROMPT_VERSION
    };
    const cacheKey = compilerCacheKey(cacheIdentity);
    const cached = options?.usePersistentCache === false ? null : await loadCompilerCacheEntry(null, cacheIdentity).catch(() => null);
    if (cached) {
      const payload = cached.responsePayload as Partial<CompilerRunResult>;
      results.push({
        unit,
        cache: {
          status: "hit",
          cacheKey: cached.cacheKey,
          sourceHash: cached.sourceHash
        },
        gliner2: payload.gliner2 ?? { attempted: false, warningCount: 0, response: null, error: null },
        assistant: payload.assistant as CompilerRunResult["assistant"],
        candidates: payload.candidates ?? [],
        metrics: payload.metrics as CompilerRunResult["metrics"]
      });
      continue;
    }

    const gliner2 = options?.skipGliner2 ? { attempted: false, warningCount: 0, response: null, error: null } : await runGliner2(unit.unitText);
    const assistant = await runTaxonomyTemporalAssistant({
      registry,
      unit,
      gliner2Candidates: gliner2.response ?? {},
      mode: options?.mode
    });
    const fallbackCandidates = deterministicAssistantCandidates(unit);
    const candidates = validateAssistantCandidates({
      registry,
      sourceCapturedAt: unit.capturedAt ?? null,
      candidates: mergeCandidates(assistant, fallbackCandidates)
    });
    const taxonomyCompliancePass = candidates.every((entry) =>
      !entry.promotionEligible ||
      entry.issues.every((issue) =>
        ![
          "unknown_object_type",
          "unknown_domain",
          "unknown_family",
          "unknown_subtype",
          "domain_family_mismatch",
          "suggested_taxonomy_promoted"
        ].includes(issue.code)
      )
    );
    const temporalNormalizationPass = candidates.every((entry) =>
      entry.issues.every((issue) => issue.code !== "unsupported_temporal_precision_upgrade")
    );
    const promotionSafetyPass = candidates.every((entry) => !entry.promotionEligible || Boolean(normalize(entry.candidate.evidence_quote)));
    const result: CompilerRunResult = {
      unit,
      cache: {
        status: options?.usePersistentCache === false ? "bypass" : "miss",
        cacheKey: cacheKey.cacheKey,
        sourceHash: cacheKey.sourceHash
      },
      gliner2,
      assistant,
      candidates,
      metrics: {
        chunkBudgetPass,
        jsonValidityPass: assistant.jsonValid,
        taxonomyCompliancePass,
        temporalNormalizationPass,
        promotionSafetyPass,
        suggestedTaxonomyCount: candidates.filter((entry) => candidateHasReviewOnlySuggestion(entry.candidate)).length,
        needsClarificationCount: candidates.filter((entry) => entry.normalizedTemporal?.needsClarification === true).length
      }
    };
    if (options?.writePersistentCache !== false) {
      await upsertCompilerCacheEntry(null, {
        ...cacheIdentity,
        responsePayload: {
          gliner2: result.gliner2,
          assistant: result.assistant,
          candidates: result.candidates,
          metrics: result.metrics
        },
        requestPayload: {
          unit_id: unit.unitId,
          source_id: unit.sourceId ?? null,
          source_memory_id: unit.sourceMemoryId ?? null,
          source_chunk_id: unit.sourceChunkId ?? null
        },
        metrics: {
          candidate_count: candidates.length,
          promoted_count: candidates.filter((entry) => entry.promotionEligible).length,
          json_valid: assistant.jsonValid,
          gliner2_error: gliner2.error
        }
      }).catch(() => undefined);
      results.push({ ...result, cache: { ...result.cache, status: "written" } });
    } else {
      results.push(result);
    }
  }

  await shutdownRelationIeSidecarWorker().catch(() => undefined);
  return results;
}

export async function persistCompilerRuns(namespaceId: string, runs: readonly CompilerRunResult[]): Promise<void> {
  await withTransaction(async (client) => {
    for (const run of runs) {
      await persistExtractionUnitsForClient(client, [run.unit]);
      await persistCompilerRunForClient(client, namespaceId, run);
    }
  });
}

async function persistCompilerRunForClient(client: PoolClient, namespaceId: string, run: CompilerRunResult): Promise<void> {
  await client.query(
    `
      INSERT INTO extraction_assistant_runs (
        namespace_id, extraction_unit_id, mode, provider, model_id, taxonomy_version, schema_version,
        prompt_version, input_chars, output_chars, input_tokens, output_tokens, total_tokens,
        latency_ms, json_valid, validation_status, rejection_reason, request_payload, response_payload
      )
      VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, '{}'::jsonb, $18::jsonb)
    `,
    [
      namespaceId,
      run.unit.unitId,
      run.assistant.mode,
      run.assistant.provider,
      run.assistant.model,
      "memory_taxonomy_v1",
      "taxonomy_temporal_assistant_output_v1",
      ASSISTANT_PROMPT_VERSION,
      run.unit.unitText.length + run.unit.contextBefore.length + run.unit.contextAfter.length,
      JSON.stringify(run.assistant.rawOutput ?? run.assistant.output ?? {}).length,
      run.assistant.tokenUsage?.inputTokens ?? null,
      run.assistant.tokenUsage?.outputTokens ?? null,
      run.assistant.tokenUsage?.totalTokens ?? null,
      run.assistant.latencyMs,
      run.assistant.jsonValid,
      run.assistant.validationIssues.length === 0 ? "valid" : "invalid",
      run.assistant.validationIssues[0]?.code ?? run.assistant.skippedReason,
      JSON.stringify(run.assistant.rawOutput ?? run.assistant.output ?? {})
    ]
  );

  const registry = await loadMemoryTaxonomyRegistry();
  for (const entry of run.candidates) {
    const evidenceQuote = normalize(entry.candidate.evidence_quote);
    if (candidateHasReviewOnlySuggestion(entry.candidate)) {
      await persistTaxonomyReviewItemForClient(client, {
        namespaceId,
        registry,
        candidate: entry.candidate,
        evidenceQuote,
        sourceKey: `${run.unit.sourceId ?? run.unit.unitId}:${run.unit.unitIndex}`
      });
    }
    if (entry.normalizedTemporal) {
      await client.query(
        `
          INSERT INTO temporal_resolution_candidates (
            namespace_id, extraction_unit_id, source_scene_id, source_memory_id, source_chunk_id,
            raw_text, temporal_type, normalized_start, normalized_end, granularity, anchor_type,
            anchor_id, needs_clarification, confidence, evidence_quote, status, rejection_reason,
            temporal_semantic_payload, answerable_shapes, blocked_shapes, normalized_duration, semantic_status,
            executor_version, metadata
          )
          VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14, $15, $16, $17,
            $18::jsonb, $19::text[], $20::text[], $21, $22, $23, $24::jsonb)
        `,
        [
          namespaceId,
          run.unit.unitId,
          run.unit.sourceSceneId ?? null,
          run.unit.sourceMemoryId ?? null,
          run.unit.sourceChunkId ?? null,
          entry.normalizedTemporal.rawText,
          entry.normalizedTemporal.temporalType,
          entry.normalizedTemporal.normalizedStart,
          entry.normalizedTemporal.normalizedEnd,
          entry.normalizedTemporal.granularity,
          entry.normalizedTemporal.anchorType,
          entry.normalizedTemporal.anchorId,
          entry.normalizedTemporal.needsClarification,
          entry.normalizedTemporal.confidence,
          evidenceQuote,
          entry.normalizedTemporal.needsClarification ? "clarification_needed" : entry.normalizedTemporal.rejectionReason ? "rejected" : "candidate",
          entry.normalizedTemporal.rejectionReason,
          JSON.stringify(entry.normalizedTemporal.semanticPayload),
          entry.normalizedTemporal.answerableShapes,
          entry.normalizedTemporal.blockedShapes,
          entry.normalizedTemporal.normalizedDuration,
          entry.normalizedTemporal.semanticStatus,
          String(entry.normalizedTemporal.semanticPayload.executorVersion ?? "temporal_semantic_executor_ts_v1"),
          JSON.stringify({
            candidate: entry.candidate,
            temporal: entry.normalizedTemporal,
            ingestion_router_v2: run.unit.metadata?.ingestion_router_v2 ?? null
          })
        ]
      );
    }
    const directFactResult = await persistCompiledDirectFactObservationForClient({
      client,
      namespaceId,
      run,
      entry,
      registry,
      modelId: run.assistant.model,
      schemaVersion: "taxonomy_temporal_assistant_output_v1"
    });
    if (directFactResult.handled) {
      continue;
    }
    if (!entry.promotionEligible) {
      await client.query(
        `
          INSERT INTO compiled_memory_coverage (
            namespace_id, source_table, source_row_id, source_scene_id, compiler_stage, query_family,
            exact_detail_family, promotion_status, rejection_reason, support_phrase, source_text, confidence, metadata
          )
          VALUES ($1, 'extraction_units', $2::uuid, $3::uuid, 'taxonomy_temporal_assistant', $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        `,
        [
          namespaceId,
          run.unit.unitId,
          run.unit.sourceSceneId ?? null,
          isProfileTraitCandidate(entry.candidate)
            ? "profile_report"
            : entry.candidate.candidate_type === "temporal_reference"
              ? "temporal_detail"
              : "exact_detail",
          isProfileTraitCandidate(entry.candidate) ? null : normalize(entry.candidate.family) || null,
          entry.issues.some((issue) => issue.code.includes("ambiguous")) ? "ambiguous" : "rejected",
          entry.issues[0]?.code ?? "not_promotable",
          evidenceQuote,
          run.unit.unitText,
          readConfidence(entry.candidate.confidence?.overall),
          JSON.stringify({
            candidate: entry.candidate,
            issues: entry.issues,
            ingestion_router_v2: run.unit.metadata?.ingestion_router_v2 ?? null
          })
        ]
      );
      continue;
    }

    if (isProfileTraitCandidate(entry.candidate)) {
      const traitFamily = profileTraitFamily(entry.candidate);
      await client.query(
        `
          INSERT INTO compiled_fact_observations (
            namespace_id, query_family, exact_detail_family, predicate_family, property_key, answer_value, normalized_answer_value,
            truth_status, confidence, source_table, source_row_id, source_scene_id, source_memory_id, source_chunk_id,
            support_phrase, source_text, extractor, model_id, schema_version, promotion_status, admissibility_status,
            rejection_reason, metadata
          )
          VALUES ($1, 'profile_report', NULL, 'profile_trait', $2, $3, lower(regexp_replace($3, '[^a-zA-Z0-9]+', ' ', 'g')),
            'active', $4, 'extraction_units', $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10,
            'taxonomy_temporal_assistant', $11, 'taxonomy_temporal_assistant_output_v1', 'compiled', 'admissible', NULL, $12::jsonb)
          ON CONFLICT (
            namespace_id, source_table, source_row_id, exact_detail_family, property_key, normalized_answer_value, subject_entity_id
          )
          DO UPDATE SET
            answer_value = EXCLUDED.answer_value,
            confidence = GREATEST(COALESCE(compiled_fact_observations.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
            metadata = compiled_fact_observations.metadata || EXCLUDED.metadata,
            updated_at = now()
        `,
        [
          namespaceId,
          `trait:${traitFamily}`,
          profileTraitAnswerValue(entry.candidate),
          readConfidence(entry.candidate.confidence?.overall),
          run.unit.unitId,
          run.unit.sourceSceneId ?? null,
          run.unit.sourceMemoryId ?? null,
          run.unit.sourceChunkId ?? null,
          evidenceQuote,
          run.unit.unitText,
          run.assistant.model,
          JSON.stringify({
            candidate: entry.candidate,
            subject: normalize(entry.candidate.subject) || null,
            traitFamily,
            traitPolarity: normalize(entry.candidate.polarity) || "positive",
            traitEvidenceSource: "taxonomy_temporal_assistant",
            taxonomyVersion: registry.version,
            promptVersion: ASSISTANT_PROMPT_VERSION,
            ingestion_router_v2: run.unit.metadata?.ingestion_router_v2 ?? null
          })
        ]
      );
      continue;
    }

    await client.query(
      `
        INSERT INTO compiled_fact_observations (
          namespace_id, query_family, exact_detail_family, property_key, answer_value, normalized_answer_value,
          truth_status, confidence, source_table, source_row_id, source_scene_id, source_memory_id, source_chunk_id,
          support_phrase, source_text, extractor, model_id, schema_version, promotion_status, admissibility_status,
          rejection_reason, metadata
        )
        VALUES ($1, $2, $3, $4, $5, lower(regexp_replace($5, '[^a-zA-Z0-9]+', ' ', 'g')), 'active', $6, 'extraction_units',
          $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11, $12, 'taxonomy_temporal_assistant', $13, 'taxonomy_temporal_assistant_output_v1',
          'compiled', 'admissible', NULL, $14::jsonb)
        ON CONFLICT (
          namespace_id, source_table, source_row_id, exact_detail_family, property_key, normalized_answer_value, subject_entity_id
        )
        DO UPDATE SET
          answer_value = EXCLUDED.answer_value,
          confidence = GREATEST(COALESCE(compiled_fact_observations.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
          metadata = compiled_fact_observations.metadata || EXCLUDED.metadata,
          updated_at = now()
      `,
      [
        namespaceId,
        entry.candidate.candidate_type === "temporal_reference" ? "temporal_detail" : "exact_detail",
        normalize(entry.candidate.family) || null,
        normalize(entry.candidate.subtype) || normalize(entry.candidate.family) || null,
        evidenceQuote,
        readConfidence(entry.candidate.confidence?.overall),
        run.unit.unitId,
        run.unit.sourceSceneId ?? null,
        run.unit.sourceMemoryId ?? null,
        run.unit.sourceChunkId ?? null,
        evidenceQuote,
        run.unit.unitText,
        run.assistant.model,
        JSON.stringify({
          candidate: entry.candidate,
          temporal: entry.normalizedTemporal,
          temporalSemantic: entry.normalizedTemporal?.semanticPayload ?? null,
          ingestion_router_v2: run.unit.metadata?.ingestion_router_v2 ?? null
        })
      ]
    );
  }
}
