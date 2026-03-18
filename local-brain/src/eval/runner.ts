import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { queryRows } from "../db/client.js";
import { attachTextDerivation } from "../derivations/service.js";
import { ingestArtifact } from "../ingest/worker.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { runSemanticDecay } from "../jobs/semantic-decay.js";
import { runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { ingestWebhookPayload } from "../producers/webhook.js";
import { getArtifactDetail, getRelationships, searchMemory, timelineMemory } from "../retrieval/service.js";

interface EvalAssertion {
  readonly name: string;
  readonly passed: boolean;
  readonly details: string;
}

interface EvalReport {
  readonly namespaceId: string;
  readonly sampleFile: string;
  readonly generatedAt: string;
  readonly ingest: {
    readonly artifactId: string;
    readonly observationId?: string;
    readonly fragments: number;
    readonly candidateWrites: number;
    readonly episodicInsertCount: number;
  };
  readonly checks: readonly EvalAssertion[];
  readonly metrics: {
    readonly japanSearchApproxTokens: number;
    readonly spicySearchApproxTokens: number;
    readonly relationshipCount: number;
    readonly timelineCount: number;
    readonly abstentionResultCount: number;
    readonly idempotentObservationCount: number;
    readonly imageArtifactFragments: number;
    readonly imageProxySearchCount: number;
    readonly hybridVectorCandidateCount: number;
    readonly adjudicatedRelationshipCount: number;
    readonly temporalNodeCount: number;
    readonly temporalLinkedNodeCount: number;
    readonly semanticDecayEventCount: number;
    readonly episodicTimelineCount: number;
  };
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function defaultSampleFile(): string {
  return path.resolve(thisDir(), "../../examples/japan-memory.md");
}

function defaultEvalOutputDir(): string {
  return path.resolve(thisDir(), "../../eval-results");
}

function defaultWebhookSampleFile(): string {
  return path.resolve(thisDir(), "../../examples/webhook/slack-message.json");
}

function buildNamespaceId(): string {
  return `eval_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function approxTokenCount(texts: readonly string[]): number {
  return texts
    .map((text) => text.split(/\s+/u).filter(Boolean).length)
    .reduce((sum, count) => sum + count, 0);
}

function makeEvalEmbedding(seed = 0): number[] {
  const vector = new Array<number>(1536).fill(0);
  vector[seed % vector.length] = 1;
  vector[(seed + 11) % vector.length] = 0.6;
  vector[(seed + 37) % vector.length] = 0.25;
  return vector;
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function assert(name: string, passed: boolean, details: string): EvalAssertion {
  return {
    name,
    passed,
    details
  };
}

export async function runLocalEvaluation(): Promise<EvalReport> {
  const namespaceId = buildNamespaceId();
  const sampleFile = defaultSampleFile();
  const webhookSampleFile = defaultWebhookSampleFile();
  const generatedAt = new Date().toISOString();

  const ingest = await ingestArtifact({
    inputUri: sampleFile,
    namespaceId,
    sourceType: "markdown_session",
    sourceChannel: "eval_harness",
    capturedAt: generatedAt
  });

  const artifactDetail = await getArtifactDetail({
    artifactId: ingest.artifact.artifactId
  });
  const repeatIngest = await ingestArtifact({
    inputUri: sampleFile,
    namespaceId,
    sourceType: "markdown_session",
    sourceChannel: "eval_harness",
    capturedAt: generatedAt
  });
  const japanSearch = await searchMemory({
    namespaceId,
    query: "Japan 2025 Sarah",
    timeStart: "2025-01-01T00:00:00Z",
    timeEnd: "2025-12-31T23:59:59Z",
    limit: 5
  });
  const timeline = await timelineMemory({
    namespaceId,
    timeStart: "2025-01-01T00:00:00Z",
    timeEnd: "2025-12-31T23:59:59Z",
    limit: 10
  });
  const relationships = await getRelationships({
    namespaceId,
    entityName: "Japan",
    predicate: "with",
    timeStart: "2025-01-01T00:00:00Z",
    timeEnd: "2025-12-31T23:59:59Z",
    limit: 10
  });
  const consolidation = await runCandidateConsolidation(namespaceId, 10);
  const adjudication = await runRelationshipAdjudication(namespaceId, {
    limit: 200,
    acceptThreshold: 0.6,
    rejectThreshold: 0.4
  });
  const temporalDaySummary = await runTemporalSummaryScaffold(namespaceId, {
    layer: "day",
    lookbackDays: 120,
    maxMembersPerNode: 500
  });
  const temporalWeekSummary = await runTemporalSummaryScaffold(namespaceId, {
    layer: "week",
    lookbackDays: 120,
    maxMembersPerNode: 500
  });
  const temporalMonthSummary = await runTemporalSummaryScaffold(namespaceId, {
    layer: "month",
    lookbackDays: 400,
    maxMembersPerNode: 500
  });
  const temporalYearSummary = await runTemporalSummaryScaffold(namespaceId, {
    layer: "year",
    lookbackDays: 800,
    maxMembersPerNode: 500
  });
  const spicySearch = await searchMemory({
    namespaceId,
    query: "spicy food",
    limit: 5
  });
  const sweetSearch = await searchMemory({
    namespaceId,
    query: "sweet food",
    limit: 5
  });
  const abstentionSearch = await searchMemory({
    namespaceId,
    query: "quantum pineapple architecture decision that was never mentioned",
    limit: 5
  });
  const webhookPayload = JSON.parse(await readFile(webhookSampleFile, "utf8")) as Record<string, unknown>;
  const webhookIngest = await ingestWebhookPayload({
    namespaceId,
    provider: "slack",
    payload: webhookPayload,
    sourceChannel: "slack:eval",
    capturedAt: generatedAt
  });
  const webhookSearch = await searchMemory({
    namespaceId,
    query: "Kyoto Sarah Ken AI retreat",
    limit: 5
  });
  const japanTemporalContext = await searchMemory({
    namespaceId,
    query: "What was I doing in Japan in 2025?",
    limit: 6
  });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "local-brain-eval-"));
  const imagePath = path.join(tempDir, "pixel.png");
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9XK3sAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const imageIngest = await ingestArtifact({
    inputUri: imagePath,
    namespaceId,
    sourceType: "image",
    sourceChannel: "eval_image",
    capturedAt: generatedAt
  });
  const imageDetail = await getArtifactDetail({
    artifactId: imageIngest.artifact.artifactId
  });
  const imageDerivation = await attachTextDerivation({
    artifactId: imageIngest.artifact.artifactId,
    derivationType: "caption",
    text: "Kyoto temple map from the June 2025 Japan trip with walking routes.",
    metadata: {
      derivation_source: "eval_manual_proxy"
    }
  });
  const imageProxySearch = await searchMemory({
    namespaceId,
    query: "temple map walking routes",
    limit: 5
  });
  const imageObservationId = imageIngest.artifact.observationId ?? imageDetail?.observations[0]?.observationId;
  if (!imageObservationId) {
    throw new Error("Evaluation expected an image artifact observation id.");
  }
  const hybridEmbedding = makeEvalEmbedding(7);
  const [semanticEvalRow] = await queryRows<{ semantic_id: string }>(
    `
      INSERT INTO semantic_memory (
        namespace_id,
        content_abstract,
        embedding,
        embedding_model,
        importance_score,
        metadata
      )
      VALUES ($1, $2, $3::vector, $4, $5, $6::jsonb)
      RETURNING id AS semantic_id
    `,
    [
      namespaceId,
      "Companion memory about a quiet Kyoto shrine walk with Sarah in June 2025.",
      toVectorLiteral(hybridEmbedding),
      "eval.synthetic",
      0.88,
      JSON.stringify({
        eval_seed: 7,
        memory_kind: "travel_companion"
      })
    ]
  );
  await queryRows<{ derivation_id: string }>(
    `
      INSERT INTO artifact_derivations (
        artifact_observation_id,
        derivation_type,
        provider,
        model,
        content_text,
        embedding,
        output_dimensionality,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8::jsonb)
      RETURNING id AS derivation_id
    `,
    [
      imageObservationId,
      "text_proxy",
      "eval",
      "synthetic",
      "Temple path notes from Kyoto with Sarah and Ken during the 2025 trip.",
      toVectorLiteral(hybridEmbedding),
      hybridEmbedding.length,
      JSON.stringify({
        eval_seed: 7,
        provenance_mode: "synthetic_vector"
      })
    ]
  );
  const vectorOnlySearch = await searchMemory({
    namespaceId,
    query: "qzxj nonlexical probe",
    queryEmbedding: hybridEmbedding,
    limit: 5
  });
  await queryRows(
    `
      WITH target AS (
        SELECT id
        FROM semantic_memory
        WHERE namespace_id = $1
          AND status = 'active'
          AND valid_until IS NULL
          AND is_anchor = false
        LIMIT 1
      )
      UPDATE semantic_memory sm
      SET
        last_accessed_at = now() - interval '72 hours',
        importance_score = 0.12
      FROM target
      WHERE sm.id = target.id
    `,
    [namespaceId]
  );
  const semanticDecay = await runSemanticDecay(namespaceId, {
    limit: 50,
    inactivityHours: 24,
    decayFactor: 0.995,
    minimumScore: 0.1
  });
  const [observationCountRow] = await queryRows<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM artifact_observations
      WHERE artifact_id = $1
    `,
    [ingest.artifact.artifactId]
  );

  const japanTop = japanSearch.results[0];
  const relationshipNames = new Set(relationships.relationships.map((result) => result.objectName));
  const spicyTop = spicySearch.results[0];
  const sweetTop = sweetSearch.results[0];
  const [relationshipMemoryCountRow] = await queryRows<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM relationship_memory
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const [temporalNodeCountRow] = await queryRows<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM temporal_nodes
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const [temporalLinkedNodeCountRow] = await queryRows<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM temporal_nodes
      WHERE namespace_id = $1
        AND parent_id IS NOT NULL
    `,
    [namespaceId]
  );
  const [semanticDecayCountRow] = await queryRows<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM semantic_decay_events
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const [episodicCountRow] = await queryRows<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM episodic_memory
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const [episodicTimelineCountRow] = await queryRows<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM episodic_timeline
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );

  const checks: EvalAssertion[] = [
    assert(
      "ingest.fragments",
      ingest.fragments.length >= 5,
      `Expected at least 5 fragments, got ${ingest.fragments.length}.`
    ),
    assert(
      "artifact.detail",
      Boolean(artifactDetail?.observations.length),
      `Expected artifact observations for ${ingest.artifact.artifactId}.`
    ),
    assert(
      "ingest.idempotency",
      repeatIngest.episodicInsertCount === 0 && Number(observationCountRow?.count ?? "0") === 1,
      `Expected re-ingesting the same file to add no episodic rows and keep one observation.`
    ),
    assert(
      "search.japan",
      Boolean(
        japanTop &&
          japanTop.memoryType === "episodic_memory" &&
          japanTop.content.includes("Sarah") &&
          japanTop.occurredAt?.startsWith("2025-06")
      ),
      `Expected top Japan result to be the June 2025 episodic travel fragment.`
    ),
    assert(
      "timeline.2025",
      timeline.timeline.some((result) => result.content.includes("Tokyo") && result.occurredAt?.startsWith("2025-06")),
      "Expected timeline query to include the June 2025 Japan travel fragment."
    ),
    assert(
      "relationships.japan",
      relationshipNames.has("Sarah") && relationshipNames.has("Ken"),
      `Expected relationship lookup to include Sarah and Ken, got: ${[...relationshipNames].join(", ")}.`
    ),
    assert(
      "consolidation.supersession",
      consolidation.supersededMemories >= 1 && consolidation.promotedMemories >= 3,
      `Expected at least 1 supersession and 3 promoted memories, got superseded=${consolidation.supersededMemories}, promoted=${consolidation.promotedMemories}.`
    ),
    assert(
      "relationships.adjudication",
      adjudication.accepted >= 1 && Number(relationshipMemoryCountRow?.count ?? "0") >= 1,
      `Expected adjudication to promote active relationship memory, got accepted=${adjudication.accepted}, stored=${relationshipMemoryCountRow?.count ?? "0"}.`
    ),
    assert(
      "temporal.weekly_summary",
      temporalWeekSummary.upsertedNodes >= 1 && Number(temporalNodeCountRow?.count ?? "0") >= 3,
      `Expected multi-layer temporal summary nodes, got day=${temporalDaySummary.upsertedNodes}, week=${temporalWeekSummary.upsertedNodes}, month=${temporalMonthSummary.upsertedNodes}, year=${temporalYearSummary.upsertedNodes}, stored=${temporalNodeCountRow?.count ?? "0"}.`
    ),
    assert(
      "temporal.hierarchy_links",
      Number(temporalLinkedNodeCountRow?.count ?? "0") >= 1,
      `Expected parent-linked temporal nodes, got linked=${temporalLinkedNodeCountRow?.count ?? "0"}.`
    ),
    assert(
      "temporal.ancestor_context",
      japanTemporalContext.results.some(
        (result) => result.memoryType === "temporal_nodes" && typeof result.provenance.tier === "string"
      ),
      "Expected temporal recall to include temporal summary or ancestor context for a Japan 2025 query."
    ),
    assert(
      "temporal.descendant_support",
      japanTemporalContext.results.some(
        (result) =>
          result.memoryType === "episodic_memory" &&
          (result.provenance.tier === "temporal_descendant_support" ||
            (typeof result.provenance.temporal_support === "object" && result.provenance.temporal_support !== null))
      ),
      "Expected temporal recall to bring back bounded episodic descendant support under matched temporal summaries."
    ),
    assert(
      "timescale.timeline_parity",
      Number(episodicCountRow?.count ?? "0") === Number(episodicTimelineCountRow?.count ?? "0"),
      `Expected episodic_timeline to mirror episodic_memory row counts, got episodic=${episodicCountRow?.count ?? "0"}, timeline=${episodicTimelineCountRow?.count ?? "0"}.`
    ),
    assert(
      "semantic.decay",
      semanticDecay.decayed + semanticDecay.archived >= 1 && Number(semanticDecayCountRow?.count ?? "0") >= 1,
      `Expected semantic decay to record at least one event, got decayed=${semanticDecay.decayed}, archived=${semanticDecay.archived}, stored=${semanticDecayCountRow?.count ?? "0"}.`
    ),
    assert(
      "search.spicy.active_truth",
      Boolean(spicyTop && spicyTop.memoryType === "procedural_memory" && spicyTop.content.includes("\"dislike\"")),
      "Expected spicy food current truth to resolve to a procedural dislike state."
    ),
    assert(
      "search.sweet.active_truth",
      Boolean(sweetTop && sweetTop.memoryType === "procedural_memory" && sweetTop.content.includes("\"like\"")),
      "Expected sweet food current truth to resolve to a procedural like state."
    ),
    assert(
      "provenance.japan",
      Boolean(japanTop?.provenance && typeof japanTop.provenance.source_uri === "string"),
      "Expected Japan search result to include a source_uri provenance pointer."
    ),
    assert(
      "abstention.unknown_query",
      abstentionSearch.results.length === 0,
      `Expected no results for an unknown lexical query, got ${abstentionSearch.results.length}.`
    ),
    assert(
      "producer.webhook_ingest",
      Boolean(
        webhookIngest.fragments >= 1 &&
          webhookSearch.results.some((result) => result.content.includes("Kyoto") && result.content.includes("Sarah"))
      ),
      "Expected webhook ingestion to persist searchable episodic evidence."
    ),
    assert(
      "binary.image_artifact",
      Boolean(
        imageIngest.fragments.length === 0 &&
          imageDetail?.mimeType === "image/png" &&
          imageDetail.observations.length === 1
      ),
      "Expected image ingestion to register a durable artifact without forcing text fragments."
    ),
    assert(
      "binary.image_proxy_search",
      Boolean(
        imageDerivation.derivationId &&
          imageProxySearch.results.some(
            (result) => result.memoryType === "artifact_derivation" && result.content.includes("Kyoto temple map")
          )
      ),
      "Expected attached proxy text to make the image artifact searchable."
    ),
    assert(
      "hybrid.vector_branch",
      Boolean(
        semanticEvalRow?.semantic_id &&
          vectorOnlySearch.meta.retrievalMode === "hybrid" &&
          vectorOnlySearch.meta.queryEmbeddingSource === "provided" &&
          vectorOnlySearch.meta.vectorCandidateCount >= 2 &&
          vectorOnlySearch.results.some((result) => result.memoryType === "semantic_memory") &&
          vectorOnlySearch.results.some((result) => result.memoryType === "artifact_derivation")
      ),
      "Expected provided query embeddings to activate the vector branch and return semantic plus artifact derivation hits."
    ),
    assert(
      "token_burn.japan",
      approxTokenCount(japanSearch.results.map((result) => result.content)) <= 220,
      `Expected Japan search payload to stay under an approximate 220-word token budget, got ${approxTokenCount(
        japanSearch.results.map((result) => result.content)
      )}.`
    )
  ];

  return {
    namespaceId,
    sampleFile,
    generatedAt,
    ingest: {
      artifactId: ingest.artifact.artifactId,
      observationId: ingest.artifact.observationId,
      fragments: ingest.fragments.length,
      candidateWrites: ingest.candidateWrites.length,
      episodicInsertCount: ingest.episodicInsertCount
    },
    checks,
    metrics: {
      japanSearchApproxTokens: approxTokenCount(japanSearch.results.map((result) => result.content)),
      spicySearchApproxTokens: approxTokenCount(spicySearch.results.map((result) => result.content)),
      relationshipCount: relationships.relationships.length,
      timelineCount: timeline.timeline.length,
      abstentionResultCount: abstentionSearch.results.length,
      idempotentObservationCount: Number(observationCountRow?.count ?? "0"),
      imageArtifactFragments: imageIngest.fragments.length,
      imageProxySearchCount: imageProxySearch.results.length,
      hybridVectorCandidateCount: vectorOnlySearch.meta.vectorCandidateCount,
      adjudicatedRelationshipCount: Number(relationshipMemoryCountRow?.count ?? "0"),
      temporalNodeCount: Number(temporalNodeCountRow?.count ?? "0"),
      temporalLinkedNodeCount: Number(temporalLinkedNodeCountRow?.count ?? "0"),
      semanticDecayEventCount: Number(semanticDecayCountRow?.count ?? "0"),
      episodicTimelineCount: Number(episodicTimelineCountRow?.count ?? "0")
    }
  };
}

export async function writeEvalReport(report: EvalReport): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const outputDir = defaultEvalOutputDir();
  await mkdir(outputDir, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir, `eval-${timestamp}.json`);
  const markdownPath = path.join(outputDir, `eval-${timestamp}.md`);
  const latestJsonPath = path.join(outputDir, "latest.json");
  const latestMarkdownPath = path.join(outputDir, "latest.md");

  const markdown = [
    "# Local Brain Evaluation",
    "",
    `- generated_at: \`${report.generatedAt}\``,
    `- namespace_id: \`${report.namespaceId}\``,
    `- sample_file: \`${report.sampleFile}\``,
    "",
    "## Checks",
    ...report.checks.map((check) => `- [${check.passed ? "x" : " "}] ${check.name}: ${check.details}`),
    "",
    "## Metrics",
    `- japan_search_approx_tokens: ${report.metrics.japanSearchApproxTokens}`,
    `- spicy_search_approx_tokens: ${report.metrics.spicySearchApproxTokens}`,
    `- relationship_count: ${report.metrics.relationshipCount}`,
    `- timeline_count: ${report.metrics.timelineCount}`,
    `- abstention_result_count: ${report.metrics.abstentionResultCount}`,
    `- idempotent_observation_count: ${report.metrics.idempotentObservationCount}`,
    `- image_artifact_fragments: ${report.metrics.imageArtifactFragments}`,
    `- image_proxy_search_count: ${report.metrics.imageProxySearchCount}`,
    `- hybrid_vector_candidate_count: ${report.metrics.hybridVectorCandidateCount}`,
    `- adjudicated_relationship_count: ${report.metrics.adjudicatedRelationshipCount}`,
    `- temporal_node_count: ${report.metrics.temporalNodeCount}`,
    `- temporal_linked_node_count: ${report.metrics.temporalLinkedNodeCount}`,
    `- semantic_decay_event_count: ${report.metrics.semanticDecayEventCount}`,
    `- episodic_timeline_count: ${report.metrics.episodicTimelineCount}`
  ].join("\n");

  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, `${markdown}\n`, "utf8"),
    writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(latestMarkdownPath, `${markdown}\n`, "utf8")
  ]);

  return {
    jsonPath,
    markdownPath
  };
}
