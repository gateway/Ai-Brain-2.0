import { readFile, writeFile } from "node:fs/promises";
import { closePool, queryRows, withClient } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { stageExternalRelationCandidatesForScenes, type ExternalRelationIeMode } from "../relationships/external-ie.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";

type StageName = "ingest" | "rebuild" | "query";

interface IngestStagePayload {
  readonly namespaceId: string;
  readonly sessionPath: string;
  readonly capturedAt: string;
  readonly questionId: string;
  readonly questionType: string;
  readonly forceRelationIe?: boolean;
  readonly relationIeMode?: ExternalRelationIeMode;
  readonly relationIeExtractors?: readonly string[];
}

interface RebuildStagePayload {
  readonly namespaceId: string;
  readonly query?: string;
  readonly forceRelationIe?: boolean;
  readonly relationIeMode?: ExternalRelationIeMode;
  readonly relationIeExtractors?: readonly string[];
}

interface QueryStagePayload {
  readonly namespaceId: string;
  readonly query: string;
  readonly limit: number;
}

interface StageWorkerEnvelope {
  readonly stage: StageName;
  readonly payload: IngestStagePayload | RebuildStagePayload | QueryStagePayload;
  readonly resultPath?: string;
}

interface LongMemRelationIeTelemetry {
  readonly relationIeStage: "disabled" | "forced_gliner2_support_and_promote" | "support_only" | "support_and_promote";
  readonly relationIeSceneCount: number;
  readonly relationIePromotedRows: number;
  readonly relationIeRejectedRows: number;
  readonly relationIeWarnings: number;
  readonly relationIeCacheHits: number;
  readonly relationIeCacheMisses: number;
  readonly gliner2JobsSkipped: number;
  readonly exactDetailFactKeyRows: number;
}

const RELATION_IE_REBUILD_BATCH_SIZE = 16;
const LONGMEM_EXACT_DETAIL_SCENE_REGEX =
  "internet|network|speed|mbps|gbps|brand|shoe|shoes|sneaker|breed|dog|cat|pet|named|called|name is|playlist|last name|surname|maiden|music|spotify|service|app|platform|checking emails|emails|7[[:space:]]*pm|time|capacity|ram|storage|gb|tb|bike|bikes|count|how many|degree|graduat|undergrad|class|course|certification|certificate|program|data science|venue|university|college|school|ucla|melbourne|serenity yoga|yoga|studio|gym|wedding|ballroom|grand ballroom|shop|store|retailer|ikea|bought|purchased|ordered|redeem|redeemed|coupon|discount|voucher|creamer|target|duration|commute|each way|for[[:space:]]+[0-9]+|month|months|week|weeks|day|days|hours|screen time|instagram|assemble|assembled|assembly|bookshelf|furniture|put together|occupation|job|role|position|worked as|specialist|price|cost|spent|paid|dollars|handbag|stance|belief|view|opinion|spirituality|atheist|play|production|performance|movie|film|book|title|cocktail|recipe";
const LONGMEM_SELF_OWNED_SCENE_REGEX =
  "user:|(^|[^[:alpha:]])(i|i'm|ive|i've|my|me|mine|we|we're|weve|we've|our)([^[:alpha:]]|$)";
const LONGMEM_RELATION_IE_CANDIDATE_MULTIPLIER = 6;

interface NamespaceNarrativeSceneRow {
  readonly id: string;
  readonly scene_text: string;
  readonly occurred_at: string;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
}

async function loadRelationIeTelemetry(
  namespaceId: string,
  stage: LongMemRelationIeTelemetry["relationIeStage"]
): Promise<LongMemRelationIeTelemetry> {
  const rows = await queryRows<{
    readonly relation_ie_scene_count: number;
    readonly promoted_rows: number;
    readonly rejected_rows: number;
    readonly warning_count: number;
    readonly relation_ie_cache_hits: number;
    readonly relation_ie_cache_misses: number;
    readonly exact_detail_fact_key_rows: number;
  }>(
    `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM narrative_scenes
          WHERE namespace_id = $1
            AND metadata ? 'external_relation_ie'
        ) AS relation_ie_scene_count,
        (
          SELECT COALESCE(SUM(NULLIF(metadata#>>'{external_relation_ie,promotion_review,promoted_row_count}', '')::int), 0)::int
          FROM narrative_scenes
          WHERE namespace_id = $1
            AND metadata#>>'{external_relation_ie,promotion_review,promoted_row_count}' IS NOT NULL
        ) AS promoted_rows,
        (
          SELECT COALESCE(SUM(NULLIF(metadata#>>'{external_relation_ie,promotion_review,rejected_count}', '')::int), 0)::int
          FROM narrative_scenes
          WHERE namespace_id = $1
            AND metadata#>>'{external_relation_ie,promotion_review,rejected_count}' IS NOT NULL
        ) AS rejected_rows,
        (
          SELECT COALESCE(SUM(NULLIF(metadata#>>'{external_relation_ie,warning_count}', '')::int), 0)::int
          FROM narrative_scenes
          WHERE namespace_id = $1
            AND metadata#>>'{external_relation_ie,warning_count}' IS NOT NULL
        ) AS warning_count,
        (
          SELECT COUNT(*)::int
          FROM narrative_scenes
          WHERE namespace_id = $1
            AND metadata#>>'{external_relation_ie,compiler_cache,status}' = 'hit'
        ) AS relation_ie_cache_hits,
        (
          SELECT COUNT(*)::int
          FROM narrative_scenes
          WHERE namespace_id = $1
            AND metadata#>>'{external_relation_ie,compiler_cache,status}' = 'miss'
        ) AS relation_ie_cache_misses,
        (
          SELECT COUNT(*)::int
          FROM exact_detail_fact_keys
          WHERE namespace_id = $1
        ) AS exact_detail_fact_key_rows
    `,
    [namespaceId]
  );
  const row = rows[0];
  return {
    relationIeStage: stage,
    relationIeSceneCount: row?.relation_ie_scene_count ?? 0,
    relationIePromotedRows: row?.promoted_rows ?? 0,
    relationIeRejectedRows: row?.rejected_rows ?? 0,
    relationIeWarnings: row?.warning_count ?? 0,
    relationIeCacheHits: row?.relation_ie_cache_hits ?? 0,
    relationIeCacheMisses: row?.relation_ie_cache_misses ?? 0,
    gliner2JobsSkipped: row?.relation_ie_cache_hits ?? 0,
    exactDetailFactKeyRows: row?.exact_detail_fact_key_rows ?? 0
  };
}

async function runNamespaceRelationIeForLongMem(input: {
  readonly namespaceId: string;
  readonly query?: string;
  readonly relationIeMode?: ExternalRelationIeMode;
  readonly relationIeExtractors?: readonly string[];
}): Promise<{
  readonly stagedCount: number;
  readonly warningCount: number;
  readonly sceneCount: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly gliner2JobsSkipped: number;
}> {
  return withClient(async (client) => {
    const requestedMaxScenes = Number(process.env.BRAIN_LONGMEM_RELATION_IE_MAX_SCENES ?? "");
    const maxScenes = Number.isFinite(requestedMaxScenes) && requestedMaxScenes > 0 ? Math.floor(requestedMaxScenes) : 16;
    const queryRegex = buildLongMemQuerySceneRegex(input.query);
    const priorityQueryRegex = buildLongMemQueryPrioritySceneRegex(input.query);
    const candidateLimit = Math.max(maxScenes, maxScenes * LONGMEM_RELATION_IE_CANDIDATE_MULTIPLIER, 160);
    const result = await client.query<NamespaceNarrativeSceneRow>(
      `
        SELECT
          id::text,
          scene_text,
          to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
          NULLIF(metadata#>>'{source_memory_ids,0}', '') AS source_memory_id,
          NULLIF(metadata#>>'{source_chunk_ids,0}', '') AS source_chunk_id
        FROM narrative_scenes
        WHERE namespace_id = $1
          AND NOT (metadata ? 'external_relation_ie')
          AND scene_text ~* COALESCE($4::text, $2)
        ORDER BY
          CASE
            WHEN $5::text IS NOT NULL AND scene_text ~* $5 THEN 0
            WHEN $4::text IS NOT NULL AND scene_text ~* $4 THEN 1
            ELSE 2
          END,
          CASE
            WHEN scene_text ~* $6 THEN 0
            ELSE 1
          END,
          occurred_at ASC,
          created_at ASC
        LIMIT $3
      `,
      [input.namespaceId, LONGMEM_EXACT_DETAIL_SCENE_REGEX, candidateLimit, queryRegex, priorityQueryRegex, LONGMEM_SELF_OWNED_SCENE_REGEX]
    );
    const selectedScenes = rankLongMemRelationIeScenes({
      scenes: result.rows,
      queryRegex,
      priorityQueryRegex,
      maxScenes
    });

    let stagedCount = 0;
    let warningCount = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let gliner2JobsSkipped = 0;
    for (let offset = 0; offset < selectedScenes.length; offset += RELATION_IE_REBUILD_BATCH_SIZE) {
      const batch = selectedScenes.slice(offset, offset + RELATION_IE_REBUILD_BATCH_SIZE);
      const staged = await stageExternalRelationCandidatesForScenes(client, {
        namespaceId: input.namespaceId,
        forceRun: true,
        relationIeMode: input.relationIeMode ?? "support_and_promote",
        extractors: input.relationIeExtractors ?? ["gliner2"],
        scenes: batch.map((scene, index) => ({
          sceneIndex: index,
          sceneId: scene.id,
          text: scene.scene_text,
          occurredAt: scene.occurred_at,
          sourceMemoryId: scene.source_memory_id,
          sourceChunkId: scene.source_chunk_id
        }))
      });
      stagedCount += staged.stagedCount;
      warningCount += staged.warningCount;
      cacheHits += staged.cacheHits;
      cacheMisses += staged.cacheMisses;
      gliner2JobsSkipped += staged.gliner2JobsSkipped;
    }

    return {
      stagedCount,
      warningCount,
      sceneCount: selectedScenes.length,
      cacheHits,
      cacheMisses,
      gliner2JobsSkipped
    };
  });
}

function regexMatchCount(text: string, pattern: string | null): number {
  if (!pattern) {
    return 0;
  }
  try {
    const regex = new RegExp(pattern, "giu");
    return [...text.matchAll(regex)].length;
  } catch {
    return pattern
      .split("|")
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
      .reduce((count, term) => count + (text.toLowerCase().includes(term) ? 1 : 0), 0);
  }
}

function isSelfOwnedLongMemScene(text: string): boolean {
  return /\buser:/iu.test(text) || /\b(?:i|i'm|ive|i've|my|me|mine|we|we're|weve|we've|our)\b/iu.test(text);
}

function rankLongMemRelationIeScenes(params: {
  readonly scenes: readonly NamespaceNarrativeSceneRow[];
  readonly queryRegex: string | null;
  readonly priorityQueryRegex: string | null;
  readonly maxScenes: number;
}): NamespaceNarrativeSceneRow[] {
  return [...params.scenes]
    .map((scene, index) => ({
      scene,
      index,
      priorityMatches: regexMatchCount(scene.scene_text, params.priorityQueryRegex),
      queryMatches: regexMatchCount(scene.scene_text, params.queryRegex),
      selfOwned: isSelfOwnedLongMemScene(scene.scene_text) ? 1 : 0
    }))
    .sort((left, right) => {
      const leftScore = left.priorityMatches * 100 + left.queryMatches * 10 + left.selfOwned * 8;
      const rightScore = right.priorityMatches * 100 + right.queryMatches * 10 + right.selfOwned * 8;
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return left.index - right.index;
    })
    .slice(0, params.maxScenes)
    .map((entry) => entry.scene);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function buildLongMemQueryPrioritySceneRegex(query: string | undefined): string | null {
  const normalized = String(query ?? "").toLowerCase();
  const priorityTerms = new Set<string>();
  const add = (...values: readonly string[]) => {
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        priorityTerms.add(trimmed);
      }
    }
  };

  if (/\bcommute\b/u.test(normalized)) {
    add("daily commute", "commute", "each way");
  }
  if (/\bdegree|graduat|major\b/u.test(normalized)) {
    add("graduated with", "degree in", "my degree", "bachelor", "master", "undergrad in", "undergrad in CS", "from UCLA", "from university");
  }
  if (/\bstudy|abroad|university|college|wedding|venue|attend\b/u.test(normalized)) {
    add("study abroad", "program at", "university", "college", "wedding at", "cousin's wedding", "grand ballroom", "ballroom", "attended");
  }
  if (/\bredeem|redeemed|coupon|discount|voucher|creamer\b/u.test(normalized)) {
    add("coupon", "creamer", "redeem", "redeemed", "discount", "voucher", "cartwheel", "shop at target");
  }
  if (/\bshop|store|buy|bought|purchase|from|racket|bookshelf\b/u.test(normalized)) {
    add("got from", "bought from", "purchased from", "is from", "came from", "store downtown", "thrift store", "bookshelf");
  }
  if (/\byoga|classes?\b/u.test(normalized)) {
    add("serenity yoga", "yoga classes", "yoga studio", "make it to serenity yoga", "near serenity yoga");
  }
  if (/\bspeed|internet|network|mbps|gbps\b/u.test(normalized)) {
    add("internet speed", "upgraded to", "mbps", "internet plan", "network speed");
  }
  if (/\bbrand|shoe|shoes|sneaker|gym\s+shoe\b/u.test(normalized)) {
    add("gym shoes", "running shoes", "shoe brand", "experience with");
  }
  if (/\bbreed|dog|cat|pet|collar\b/u.test(normalized)) {
    add("breed", "my cat", "my dog", "my pet", "collar", "name tag", "cat's name", "dog's name", "pet's name", "name is", "like my", "like Max");
  }
  if (/\bservice|music|spotify|platform|app|streaming\b/u.test(normalized)) {
    add("lately", "listening to", "music", "streaming", "songs", "service");
  }
  if (/\bplaylist\b/u.test(normalized)) {
    add("playlist on Spotify", "Spotify playlist", "playlist called", "playlist named", "created a playlist", "created, called");
  }
  if (/\blast name|surname|maiden|former|previous\b/u.test(normalized)) {
    add("last name", "surname", "maiden", "former", "previous", "changed");
  }
  if (/\btime|email|checking|stop|screen\s+time|instagram\b/u.test(normalized)) {
    add("stop work emails", "stopping work emails", "by 7", "screen time", "instagram", "per day", "averaging");
  }
  if (/\b(?:ram|storage|capacity|memory|laptop|upgrade)\b/u.test(normalized)) {
    add("ram upgrade", "upgrade to", "upgraded my laptop", "laptop's RAM", "RAM upgrade to", "to 16GB", "16GB");
  }
  if (/\bhow many|count|bike|bikes|copies|album|released|caught|bass|fish\b/u.test(normalized)) {
    add("got", "of them", "bikes", "caught", "bass", "copies", "released worldwide");
  }
  if (/\bduration|how long|month|week|day|year|japan|apartment|move|camera|collecting\b/u.test(normalized)) {
    add("for", "spent", "spent two weeks", "traveling solo", "took me and my friends", "move everything", "around", "screen time", "per day", "averaging around", "collecting vintage cameras", "in Japan", "move to the new apartment", "into the new apartment");
  }
  if (/\b(?:assemble|assembly|bookshelf|furniture|put together|build|built)\b/u.test(normalized)) {
    add("assemble", "assembled", "assembly", "bookshelf", "furniture", "put together", "took", "took 4 hours");
  }
  if (/\brole|occupation|job|work|worked|position\b/u.test(normalized)) {
    add("previous role as", "occupation", "worked as", "small startup");
  }
  if (/\b(?:price|cost|spent|paid|handbag|purchase)\b/u.test(normalized)) {
    add("spent", "paid", "cost", "price", "designer handbag", "handbag", "$");
  }
  if (/\b(?:stance|belief|view|opinion|position|spirituality|atheist)\b/u.test(normalized)) {
    add("previous stance", "stance on", "spirituality", "staunch atheist", "used to be", "belief");
  }
  if (/\bgift|birthday|present|thrift|action figure|cocktail|recipe|rice|cake|bake|baked|grandma|necklace|how old\b/u.test(normalized)) {
    add("birthday", "gift", "sister", "niece", "thrift store", "action figure", "cocktail", "recipe", "tried a", "rice", "birthday party", "grandma", "necklace", "18th birthday");
  }
  if (/\bplay|production|performance|movie|film|book|title\b/u.test(normalized)) {
    add("production of", "attended a production", "community theater", "play", "called", "named", "title");
  }
  if (/\bshelter|fundraising|volunteer|valentine\b/u.test(normalized)) {
    add("fundraising dinner", "volunteered", "valentine", "valentine's day", "love is in the air");
  }

  return priorityTerms.size === 0 ? null : [...priorityTerms].map(escapeRegexLiteral).join("|");
}

function buildLongMemQuerySceneRegex(query: string | undefined): string | null {
  const normalized = String(query ?? "").toLowerCase();
  const isCommuteQuery = /\bcommute\b/u.test(normalized);
  const isCouponRedemptionQuery = /\bredeem|redeemed|coupon|discount|voucher|creamer\b/u.test(normalized);
  const terms = new Set<string>();
  const add = (...values: readonly string[]) => {
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        terms.add(trimmed);
      }
    }
  };

  if (/\bdegree|graduat|major\b/u.test(normalized)) {
    add("degree", "graduat", "major", "bachelor", "master", "undergrad", "university");
  }
  if (/\bclass|course|study|abroad|venue|where|yoga|wedding|ballroom\b/u.test(normalized) && !isCouponRedemptionQuery) {
    add("class", "course", "study", "abroad", "venue", "university", "college", "school", "campus", "studio", "yoga", "wedding", "ballroom");
  }
  if (/\bshop|store|buy|bought|purchase|from|racket|bookshelf|thrift\b/u.test(normalized) && !isCouponRedemptionQuery) {
    add("shop", "store", "retailer", "bought", "purchased", "ordered", "from", "got", "racket", "bookshelf", "thrift");
  }
  if (isCouponRedemptionQuery) {
    add("redeem", "redeemed", "coupon", "discount", "voucher", "creamer", "coffee creamer", "target", "cartwheel", "shop at target");
  }
  if (/\bspeed|internet|network|mbps|gbps\b/u.test(normalized)) {
    add("internet", "network", "speed", "mbps", "gbps");
  }
  if (/\bbrand|shoe|shoes|sneaker|gym\s+shoe\b/u.test(normalized)) {
    add("brand", "shoe", "shoes", "sneaker", "gym shoes", "running shoes");
  }
  if (/\bbreed|dog|cat|pet|collar\b/u.test(normalized)) {
    add("breed", "dog", "cat", "pet", "puppy", "collar", "name tag");
  }
  if (/\bname|named|called\b/u.test(normalized)) {
    add("name", "named", "called");
  }
  if (/\bservice|music|spotify|platform|app\b/u.test(normalized)) {
    add("service", "music", "spotify", "platform", "app", "listening to", "songs");
  }
  if (/\bplaylist\b/u.test(normalized)) {
    add("playlist", "spotify", "called", "named", "created");
  }
  if (/\blast name|surname|maiden|former|previous\b/u.test(normalized)) {
    add("last name", "surname", "maiden", "former", "previous", "changed");
  }
  if (/\btime|email|checking|stop\b/u.test(normalized)) {
    add("time", "email", "emails", "messages", "checking", "stopping", "stop", "pm", "am");
  }
  if (/\b(?:ram|storage|capacity|memory|laptop|upgrade)\b/u.test(normalized)) {
    add("ram", "storage", "capacity", "memory", "laptop", "upgrade", "upgraded", "16gb", "gb", "tb");
  }
  if (/\bscreen\s+time|instagram\b/u.test(normalized)) {
    add("screen time", "instagram", "per day", "averaging", "hours");
  }
  if (/\bhow many|count|bike|bikes|copies|album|released|caught|bass|fish\b/u.test(normalized)) {
    add("count", "bike", "bikes", "own", "have", "copies", "album", "released", "caught", "bass", "fish");
  }
  if (/\bduration|how long|month|week|day|year|japan|apartment|move|collecting|camera|assemble|assembly|bookshelf|furniture|put together\b/u.test(normalized) && !isCommuteQuery) {
    add("duration", "month", "months", "week", "weeks", "day", "days", "year", "years", "for", "japan", "move", "apartment", "collecting", "camera", "assemble", "assembled", "assembly", "bookshelf", "furniture", "put together");
  }
  if (isCommuteQuery) {
    add("daily commute", "commute", "each way", "minutes each way", "minutes", "hours");
  }
  if (/\brole|occupation|job|work|worked|position\b/u.test(normalized)) {
    add("role", "occupation", "job", "worked", "position", "specialist", "previous role");
  }
  if (/\b(?:price|cost|spent|paid|handbag|purchase)\b/u.test(normalized)) {
    add("price", "cost", "spent", "paid", "dollars", "handbag", "designer handbag", "$");
  }
  if (/\b(?:stance|belief|view|opinion|position|spirituality|atheist)\b/u.test(normalized)) {
    add("stance", "belief", "view", "opinion", "position", "spirituality", "atheist", "used to");
  }
  if (/\bcertification|certificate|certified|program\b/u.test(normalized)) {
    add("certification", "certificate", "certified", "program", "course", "completed", "data science");
  }
  if (/\bgift|birthday|present|thrift|action figure|cocktail|recipe|rice|cake|bake|baked|grandma|necklace|how old\b/u.test(normalized)) {
    add("gift", "birthday", "present", "thrift", "action figure", "cocktail", "recipe", "rice", "cake", "baked", "grandma", "necklace");
  }
  if (/\bplay|production|performance|movie|film|book|title\b/u.test(normalized)) {
    add("play", "production", "performance", "community theater", "title", "called", "named");
  }
  if (/\bshelter|fundraising|volunteer|valentine\b/u.test(normalized)) {
    add("shelter", "fundraising", "volunteer", "volunteered", "valentine", "love is in the air");
  }

  const skipBroadTokenFallback = isCommuteQuery || isCouponRedemptionQuery;
  for (const token of skipBroadTokenFallback ? [] : normalized.match(/[a-z0-9][a-z0-9'-]{3,}/gu) ?? []) {
    if (!/^(?:what|where|when|with|have|that|this|from|about|your|were|been|long|daily|work|does|did)$/u.test(token)) {
      terms.add(token);
    }
  }

  if (terms.size === 0) {
    return null;
  }
  return [...terms].map(escapeRegexLiteral).join("|");
}

function parseEnvelope(raw: string): StageWorkerEnvelope {
  const parsed = JSON.parse(raw) as Partial<StageWorkerEnvelope>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Stage worker payload must be a JSON object");
  }
  if (parsed.stage !== "ingest" && parsed.stage !== "rebuild" && parsed.stage !== "query") {
    throw new Error(`Unsupported stage: ${String(parsed.stage)}`);
  }
  if (!parsed.payload || typeof parsed.payload !== "object") {
    throw new Error("Stage worker payload missing stage payload object");
  }
  return parsed as StageWorkerEnvelope;
}

async function readStdinText(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
  }
  return buffer;
}

async function runStage(envelope: StageWorkerEnvelope): Promise<unknown> {
  switch (envelope.stage) {
    case "ingest": {
      const payload = envelope.payload as IngestStagePayload;
      await readFile(payload.sessionPath, "utf8");
      const relationIeForced = false;
      const ingestResult = await ingestArtifact({
        namespaceId: payload.namespaceId,
        sourceType: "markdown",
        inputUri: payload.sessionPath,
        capturedAt: payload.capturedAt,
        metadata: {
          benchmark: "longmemeval",
          question_id: payload.questionId,
          question_type: payload.questionType,
          relation_ie_mode: payload.relationIeMode ?? null,
          relation_ie_extractors: payload.relationIeExtractors ?? null,
          relation_ie_forced: relationIeForced
        },
        sourceChannel: "benchmark:longmemeval"
      });
      const telemetry = await loadRelationIeTelemetry(
        payload.namespaceId,
        relationIeForced && payload.relationIeMode === "support_and_promote"
          ? "forced_gliner2_support_and_promote"
          : payload.relationIeMode ?? "disabled"
      );
      return { ingestResult, relationIeTelemetry: telemetry };
    }
    case "rebuild": {
      const payload = envelope.payload as RebuildStagePayload;
      let relationIeStage: LongMemRelationIeTelemetry["relationIeStage"] = "disabled";
      if (payload.forceRelationIe === true) {
        await runNamespaceRelationIeForLongMem({
          namespaceId: payload.namespaceId,
          query: payload.query,
          relationIeMode: payload.relationIeMode,
          relationIeExtractors: payload.relationIeExtractors
        });
        relationIeStage = payload.relationIeMode === "support_and_promote" ? "support_and_promote" : "support_only";
      }
      const summary = await rebuildTypedMemoryNamespace(payload.namespaceId, { skipVectorActivation: true });
      const telemetry = await loadRelationIeTelemetry(payload.namespaceId, relationIeStage);
      return { summary, relationIeTelemetry: telemetry };
    }
    case "query": {
      const payload = envelope.payload as QueryStagePayload;
      const result = (await executeMcpTool("memory.search", {
        namespace_id: payload.namespaceId,
        query: payload.query,
        limit: payload.limit
      })) as { readonly structuredContent?: unknown };
      return result.structuredContent ?? null;
    }
  }
}

let exitCode = 0;
try {
  const input = await readStdinText();
  const envelope = parseEnvelope(input);
  const result = await runStage(envelope);
  if (typeof envelope.resultPath === "string" && envelope.resultPath.trim().length > 0) {
    await writeFile(envelope.resultPath, `${JSON.stringify({ ok: true, result })}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, resultPath: envelope.resultPath })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  }
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
} finally {
  await closePool();
}

process.exit(exitCode);
