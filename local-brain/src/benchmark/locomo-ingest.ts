import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get } from "node:https";
import path from "node:path";
import { readConfig } from "../config.js";
import { attachTextDerivation } from "../derivations/service.js";
import { ingestArtifact } from "../ingest/worker.js";
import { getProviderAdapter } from "../providers/registry.js";
import { parseLoCoMoSessionDateTimeToIso } from "./public-memory-date-utils.js";

export interface LoCoMoTurnRecord {
  readonly speaker: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
  readonly dia_id?: string;
  readonly img_url?: readonly string[];
}

export interface LoCoMoConversationRecord {
  readonly sample_id: string;
  readonly conversation: Record<string, string | readonly LoCoMoTurnRecord[]>;
}

export interface LoCoMoSessionIngestResult {
  readonly sessionPath: string;
  readonly imageArtifactCount: number;
  readonly derivedImageCount: number;
  readonly imageDerivationCacheHits: number;
  readonly skippedImageCount: number;
  readonly proxyImageArtifactCount: number;
}

interface CachedImageDerivation {
  readonly contentText: string;
  readonly provider: string;
  readonly model: string;
  readonly createdAt: string;
}

interface LoCoMoImageIngestBudget {
  readonly sessionDeadlineMs?: number;
  readonly imageWorkDeadlineMs?: number;
  readonly sessionReserveMs: number;
  readonly minStepBudgetMs: number;
  readonly downloadTimeoutMs: number;
  readonly deriveTimeoutMs: number;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function fileExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    return ext || ".bin";
  } catch {
    return ".bin";
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveImageIngestBudget(params: {
  readonly sessionDeadlineMs?: number;
  readonly imageWorkDeadlineMs?: number;
}): LoCoMoImageIngestBudget {
  return {
    sessionDeadlineMs: params.sessionDeadlineMs,
    imageWorkDeadlineMs: params.imageWorkDeadlineMs,
    sessionReserveMs: parsePositiveInteger(process.env.BRAIN_BENCHMARK_IMAGE_SESSION_RESERVE_MS, 5_000),
    minStepBudgetMs: parsePositiveInteger(process.env.BRAIN_BENCHMARK_IMAGE_MIN_STEP_BUDGET_MS, 1_500),
    downloadTimeoutMs: parsePositiveInteger(process.env.BRAIN_BENCHMARK_IMAGE_DOWNLOAD_TIMEOUT_MS, 8_000),
    deriveTimeoutMs: parsePositiveInteger(process.env.BRAIN_BENCHMARK_IMAGE_DERIVE_TIMEOUT_MS, 12_000)
  };
}

function resolveBenchmarkImageBinaryMode(): "off" | "bounded" {
  const value = normalize(process.env.BRAIN_BENCHMARK_IMAGE_BINARY_MODE).toLowerCase();
  return value === "bounded" ? "bounded" : "off";
}

function resolveStepTimeoutMs(maxTimeoutMs: number, budget: LoCoMoImageIngestBudget): number | null {
  if (budget.imageWorkDeadlineMs) {
    const remainingMs = budget.imageWorkDeadlineMs - Date.now();
    if (remainingMs < budget.minStepBudgetMs) {
      return null;
    }
    return Math.max(budget.minStepBudgetMs, Math.min(maxTimeoutMs, remainingMs));
  }
  if (!budget.sessionDeadlineMs) {
    return maxTimeoutMs;
  }
  const remainingMs = budget.sessionDeadlineMs - Date.now() - budget.sessionReserveMs;
  if (remainingMs < budget.minStepBudgetMs) {
    return null;
  }
  return Math.max(budget.minStepBudgetMs, Math.min(maxTimeoutMs, remainingMs));
}

async function withOptionalTimeout<T>(label: string, timeoutMs: number | null, fn: () => Promise<T>): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fn();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function downloadBinary(url: string, timeoutMs?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("http://") ? httpGet : get;
    let settled = false;
    const request = getter(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        settled = true;
        reject(new Error(`request failed for ${url}: ${response.statusCode}`));
        response.resume();
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      response.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      });
    });
    const timer =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            request.destroy(new Error(`download timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;
    request.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    request.on("close", () => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  });
}

async function downloadBinaryCached(url: string, destination: string, timeoutMs?: number): Promise<string> {
  try {
    await readFile(destination);
    return destination;
  } catch {
    await mkdir(path.dirname(destination), { recursive: true });
    const body = await downloadBinary(url, timeoutMs);
    await writeFile(destination, body);
    return destination;
  }
}

function locomoImageCacheRoot(localBrainRoot: string): string {
  return path.resolve(localBrainRoot, "benchmark-generated", "locomo-image-cache");
}

function resolveImageDeriveProvider(): { readonly provider: "external" | "openrouter" | "gemini"; readonly model: string } | null {
  const config = readConfig();
  if (config.externalAiApiKey && normalize(config.externalAiBaseUrl) && normalize(config.externalAiDeriveModel)) {
    return {
      provider: "external",
      model: config.externalAiDeriveModel
    };
  }
  if (config.openRouterApiKey && normalize(config.openRouterDeriveModel)) {
    return {
      provider: "openrouter",
      model: config.openRouterDeriveModel
    };
  }
  if (config.geminiApiKey && normalize(config.geminiMultimodalModel)) {
    return {
      provider: "gemini",
      model: config.geminiMultimodalModel
    };
  }
  return null;
}

function isUsefulDerivedImageText(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) {
    return false;
  }
  return !/provider-backed visual extraction was unavailable/iu.test(normalized);
}

async function readCachedImageDerivation(cachePath: string): Promise<CachedImageDerivation | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CachedImageDerivation>;
    if (
      typeof parsed.contentText === "string" &&
      typeof parsed.provider === "string" &&
      typeof parsed.model === "string" &&
      typeof parsed.createdAt === "string" &&
      isUsefulDerivedImageText(parsed.contentText)
    ) {
      return {
        contentText: parsed.contentText,
        provider: parsed.provider,
        model: parsed.model,
        createdAt: parsed.createdAt
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCachedImageDerivation(cachePath: string, value: CachedImageDerivation): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(value, null, 2), "utf8");
}

function buildImageTurnSourceText(turn: LoCoMoTurnRecord): string {
  const parts = [`${turn.speaker}: ${normalize(turn.text)}`];
  if (normalize(turn.blip_caption)) {
    parts.push(`Image caption: ${normalize(turn.blip_caption)}`);
  }
  if (normalize(turn.query)) {
    parts.push(`Image query: ${normalize(turn.query)}`);
  }
  return parts.filter((part) => normalize(part)).join("\n");
}

async function attachCachedOrDerivedImageText(params: {
  readonly cachePath: string;
  readonly artifactId: string;
  readonly artifactObservationId: string;
  readonly imageUrl: string;
  readonly metadata: Record<string, unknown>;
  readonly deriveTimeoutMs?: number | null;
}): Promise<{ readonly derived: boolean; readonly cacheHit: boolean }> {
  const cached = await readCachedImageDerivation(params.cachePath);
  if (cached) {
    await attachTextDerivation({
      artifactId: params.artifactId,
      artifactObservationId: params.artifactObservationId,
      derivationType: "benchmark_locomo_cached_image_derivation",
      text: cached.contentText,
      metadata: {
        ...params.metadata,
        derivation_cache_hit: true,
        derivation_provider: cached.provider,
        derivation_model: cached.model,
        derivation_cached_at: cached.createdAt
      }
    });
    return { derived: true, cacheHit: true };
  }

  const provider = resolveImageDeriveProvider();
  if (!provider) {
    return { derived: false, cacheHit: false };
  }
  const adapter = getProviderAdapter(provider.provider);
  const derived = await withOptionalTimeout("image derivation", params.deriveTimeoutMs ?? null, () =>
    adapter.deriveFromArtifact({
      modality: "image",
      artifactUri: params.imageUrl,
      model: provider.model,
      metadata: {
        ...params.metadata,
        derivation_cache_hit: false,
        benchmark_image_url: params.imageUrl
      }
    })
  );
  if (!isUsefulDerivedImageText(derived.contentAbstract)) {
    return { derived: false, cacheHit: false };
  }
  await attachTextDerivation({
    artifactId: params.artifactId,
    artifactObservationId: params.artifactObservationId,
    derivationType: "benchmark_locomo_image_derivation",
    text: derived.contentAbstract,
    metadata: {
      ...params.metadata,
      derivation_cache_hit: false,
      benchmark_image_url: params.imageUrl,
      derivation_provider: derived.provider,
      derivation_model: derived.model,
      derivation_modality: derived.modality,
      derivation_confidence: derived.confidenceScore ?? null,
      derivation_entities: derived.entities ?? [],
      derivation_provenance: derived.provenance,
      derivation_provider_metadata: derived.providerMetadata ?? {}
    }
  });
  await writeCachedImageDerivation(params.cachePath, {
    contentText: derived.contentAbstract,
    provider: derived.provider,
    model: derived.model,
    createdAt: new Date().toISOString()
  });
  return { derived: true, cacheHit: false };
}

async function ingestLoCoMoImageProxyArtifact(params: {
  readonly localBrainRoot: string;
  readonly benchmarkName: string;
  readonly namespaceId: string;
  readonly sampleId: string;
  readonly sessionKey: string;
  readonly sessionCapturedAt: string;
  readonly turn: LoCoMoTurnRecord;
  readonly turnIndex: number;
  readonly imageIndex: number;
  readonly imageUrl: string;
  readonly reason: string;
}): Promise<void> {
  const proxyRoot = path.join(locomoImageCacheRoot(params.localBrainRoot), "proxies", params.sampleId, params.sessionKey);
  const proxyPath = path.join(proxyRoot, `turn-${params.turnIndex}-image-${params.imageIndex}.md`);
  const content = [
    `Speaker: ${normalize(params.turn.speaker)}`,
    `Turn text: ${normalize(params.turn.text)}`,
    `Image caption: ${normalize(params.turn.blip_caption)}`,
    `Image query: ${normalize(params.turn.query)}`,
    `Image url: ${params.imageUrl}`,
    `Proxy reason: ${params.reason}`
  ]
    .filter((line) => normalize(line.split(":").slice(1).join(":")))
    .join("\n");
  await mkdir(path.dirname(proxyPath), { recursive: true });
  await writeFile(proxyPath, content, "utf8");
  await ingestArtifact({
    namespaceId: params.namespaceId,
    sourceType: "markdown",
    inputUri: proxyPath,
    capturedAt: params.sessionCapturedAt,
    metadata: {
      benchmark: params.benchmarkName,
      sample_id: params.sampleId,
      session_key: params.sessionKey,
      turn_index: params.turnIndex,
      image_index: params.imageIndex,
      dia_id: params.turn.dia_id ?? null,
      speaker_name: params.turn.speaker,
      turn_text: normalize(params.turn.text),
      source_turn_text: buildImageTurnSourceText(params.turn),
      source_sentence_text: normalize(params.turn.text),
      blip_caption: normalize(params.turn.blip_caption),
      query: normalize(params.turn.query),
      image_query: normalize(params.turn.query),
      image_caption: normalize(params.turn.blip_caption),
      image_url: params.imageUrl,
      image_proxy_fallback: true,
      image_proxy_reason: params.reason
    },
    sourceChannel: `benchmark:${params.benchmarkName}:image-proxy`
  });
}

function turnImageUrls(turn: LoCoMoTurnRecord): readonly string[] {
  return Array.isArray(turn.img_url)
    ? turn.img_url.filter((value): value is string => typeof value === "string" && isHttpUrl(value))
    : [];
}

async function ingestLoCoMoTurnImages(params: {
  readonly localBrainRoot: string;
  readonly benchmarkName: string;
  readonly namespaceId: string;
  readonly sampleId: string;
  readonly sessionKey: string;
  readonly sessionCapturedAt: string;
  readonly turn: LoCoMoTurnRecord;
  readonly turnIndex: number;
  readonly sessionDeadlineMs?: number;
  readonly imageWorkDeadlineMs?: number;
}): Promise<{
  readonly imageArtifactCount: number;
  readonly derivedImageCount: number;
  readonly imageDerivationCacheHits: number;
  readonly skippedImageCount: number;
  readonly proxyImageArtifactCount: number;
}> {
  const binaryImageMode = resolveBenchmarkImageBinaryMode();
  const imageBudget = resolveImageIngestBudget({
    sessionDeadlineMs: params.sessionDeadlineMs,
    imageWorkDeadlineMs: params.imageWorkDeadlineMs
  });
  let imageArtifactCount = 0;
  let derivedImageCount = 0;
  let imageDerivationCacheHits = 0;
  let skippedImageCount = 0;
  let proxyImageArtifactCount = 0;

  for (const [imageIndex, imageUrl] of turnImageUrls(params.turn).entries()) {
    try {
      if (binaryImageMode !== "bounded") {
        skippedImageCount += 1;
        await ingestLoCoMoImageProxyArtifact({
          localBrainRoot: params.localBrainRoot,
          benchmarkName: params.benchmarkName,
          namespaceId: params.namespaceId,
          sampleId: params.sampleId,
          sessionKey: params.sessionKey,
          sessionCapturedAt: params.sessionCapturedAt,
          turn: params.turn,
          turnIndex: params.turnIndex,
          imageIndex,
          imageUrl,
          reason: "binary image enrichment disabled for benchmark ingest"
        });
        proxyImageArtifactCount += 1;
        continue;
      }
      const downloadTimeoutMs = resolveStepTimeoutMs(imageBudget.downloadTimeoutMs, imageBudget);
      if (downloadTimeoutMs === null) {
        skippedImageCount += 1;
        await ingestLoCoMoImageProxyArtifact({
          localBrainRoot: params.localBrainRoot,
          benchmarkName: params.benchmarkName,
          namespaceId: params.namespaceId,
          sampleId: params.sampleId,
          sessionKey: params.sessionKey,
          sessionCapturedAt: params.sessionCapturedAt,
          turn: params.turn,
          turnIndex: params.turnIndex,
          imageIndex,
          imageUrl,
          reason: "session image budget exhausted before binary download"
        });
        proxyImageArtifactCount += 1;
        console.warn(
          `[${params.benchmarkName}] skipped image sample=${params.sampleId} session=${params.sessionKey} turn=${params.turnIndex} url=${imageUrl} reason=session image budget exhausted before download`
        );
        continue;
      }
      const cacheKey = sha256(imageUrl);
      const ext = fileExtensionFromUrl(imageUrl);
      const imagePath = path.join(locomoImageCacheRoot(params.localBrainRoot), "assets", `${cacheKey}${ext}`);
      const derivationCachePath = path.join(locomoImageCacheRoot(params.localBrainRoot), "derivations", `${cacheKey}.json`);
      const localImagePath = await downloadBinaryCached(imageUrl, imagePath, downloadTimeoutMs);
      const sourceTurnText = buildImageTurnSourceText(params.turn);
      const ingestResult = await ingestArtifact({
        namespaceId: params.namespaceId,
        sourceType: "image",
        inputUri: localImagePath,
        capturedAt: params.sessionCapturedAt,
        metadata: {
          benchmark: params.benchmarkName,
          sample_id: params.sampleId,
          session_key: params.sessionKey,
          turn_index: params.turnIndex,
          image_index: imageIndex,
          dia_id: params.turn.dia_id ?? null,
          speaker_name: params.turn.speaker,
          turn_text: normalize(params.turn.text),
          source_turn_text: sourceTurnText,
          source_sentence_text: normalize(params.turn.text),
          blip_caption: normalize(params.turn.blip_caption),
          query: normalize(params.turn.query),
          image_query: normalize(params.turn.query),
          image_caption: normalize(params.turn.blip_caption),
          image_url: imageUrl
        },
        sourceChannel: `benchmark:${params.benchmarkName}:image`
      });
      imageArtifactCount += 1;
      const artifactObservationId = ingestResult.artifact.observationId;
      if (!artifactObservationId) {
        continue;
      }

      const deriveTimeoutMs = resolveStepTimeoutMs(imageBudget.deriveTimeoutMs, imageBudget);
      if (deriveTimeoutMs === null) {
        skippedImageCount += 1;
        await ingestLoCoMoImageProxyArtifact({
          localBrainRoot: params.localBrainRoot,
          benchmarkName: params.benchmarkName,
          namespaceId: params.namespaceId,
          sampleId: params.sampleId,
          sessionKey: params.sessionKey,
          sessionCapturedAt: params.sessionCapturedAt,
          turn: params.turn,
          turnIndex: params.turnIndex,
          imageIndex,
          imageUrl,
          reason: "session image budget exhausted before binary derivation"
        });
        proxyImageArtifactCount += 1;
        console.warn(
          `[${params.benchmarkName}] skipped image derivation sample=${params.sampleId} session=${params.sessionKey} turn=${params.turnIndex} url=${imageUrl} reason=session image budget exhausted before derivation`
        );
        continue;
      }
      const derivationResult = await attachCachedOrDerivedImageText({
        cachePath: derivationCachePath,
        artifactId: ingestResult.artifact.artifactId,
        artifactObservationId,
        imageUrl,
        deriveTimeoutMs,
        metadata: {
          benchmark: params.benchmarkName,
          sample_id: params.sampleId,
          session_key: params.sessionKey,
          turn_index: params.turnIndex,
          image_index: imageIndex,
          dia_id: params.turn.dia_id ?? null
        }
      });
      if (derivationResult.derived) {
        derivedImageCount += 1;
      }
      if (derivationResult.cacheHit) {
        imageDerivationCacheHits += 1;
      }
    } catch (error) {
      skippedImageCount += 1;
      await ingestLoCoMoImageProxyArtifact({
        localBrainRoot: params.localBrainRoot,
        benchmarkName: params.benchmarkName,
        namespaceId: params.namespaceId,
        sampleId: params.sampleId,
        sessionKey: params.sessionKey,
        sessionCapturedAt: params.sessionCapturedAt,
        turn: params.turn,
        turnIndex: params.turnIndex,
        imageIndex,
        imageUrl,
        reason: error instanceof Error ? error.message : String(error)
      });
      proxyImageArtifactCount += 1;
      console.warn(
        `[${params.benchmarkName}] skipped image sample=${params.sampleId} session=${params.sessionKey} turn=${params.turnIndex} url=${imageUrl} reason=${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
  }

  return {
    imageArtifactCount,
    derivedImageCount,
    imageDerivationCacheHits,
    skippedImageCount,
    proxyImageArtifactCount
  };
}

export function formatLoCoMoConversationSession(
  sample: LoCoMoConversationRecord,
  sessionKey: string,
  turns: readonly LoCoMoTurnRecord[]
): string {
  const dateTime = typeof sample.conversation[`${sessionKey}_date_time`] === "string" ? sample.conversation[`${sessionKey}_date_time`] : "";
  const canonicalCapturedAt = typeof dateTime === "string" && dateTime ? parseLoCoMoSessionDateTimeToIso(dateTime) : null;
  const speakerA = typeof sample.conversation.speaker_a === "string" ? sample.conversation.speaker_a : "Speaker A";
  const speakerB = typeof sample.conversation.speaker_b === "string" ? sample.conversation.speaker_b : "Speaker B";
  const lines: string[] = [];
  if (canonicalCapturedAt) {
    lines.push(`Captured: ${canonicalCapturedAt}`);
    lines.push("");
  } else if (dateTime) {
    lines.push(`Captured: ${dateTime}`);
    lines.push("");
  }
  lines.push(`Conversation between ${speakerA} and ${speakerB}`);
  for (const turn of turns) {
    const caption = typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0 ? ` [image: ${turn.blip_caption.trim()}]` : "";
    lines.push(`${turn.speaker}: ${normalize(turn.text)}${caption}`);
    if (typeof turn.query === "string" && turn.query.trim().length > 0) {
      lines.push(`--- image_query: ${turn.query.trim()}`);
    }
    if (typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0) {
      lines.push(`--- image_caption: ${turn.blip_caption.trim()}`);
    }
    for (const imageUrl of turnImageUrls(turn)) {
      lines.push(`--- image_url: ${imageUrl}`);
    }
  }
  return lines.join("\n");
}

export async function ingestLoCoMoSessionArtifacts(params: {
  readonly localBrainRoot: string;
  readonly benchmarkName: string;
  readonly corpusRoot: string;
  readonly namespaceId: string;
  readonly sample: LoCoMoConversationRecord;
  readonly sessionKey: string;
  readonly turns: readonly LoCoMoTurnRecord[];
  readonly sessionDeadlineMs?: number;
}): Promise<LoCoMoSessionIngestResult> {
  const sessionPath = path.join(params.corpusRoot, `${params.sample.sample_id}-${params.sessionKey}.md`);
  const sessionDateTime =
    typeof params.sample.conversation[`${params.sessionKey}_date_time`] === "string"
      ? parseLoCoMoSessionDateTimeToIso(params.sample.conversation[`${params.sessionKey}_date_time`] as string)
      : null;
  const capturedAt = sessionDateTime ?? new Date().toISOString();

  await writeFile(sessionPath, formatLoCoMoConversationSession(params.sample, params.sessionKey, params.turns), "utf8");
  await ingestArtifact({
    namespaceId: params.namespaceId,
    sourceType: "markdown",
    inputUri: sessionPath,
    capturedAt,
    metadata: {
      benchmark: params.benchmarkName,
      sample_id: params.sample.sample_id,
      session_key: params.sessionKey
    },
    sourceChannel: `benchmark:${params.benchmarkName}`
  });

  let imageArtifactCount = 0;
  let derivedImageCount = 0;
  let imageDerivationCacheHits = 0;
  let skippedImageCount = 0;
  let proxyImageArtifactCount = 0;
  const imageWorkBudgetMs = parsePositiveInteger(process.env.BRAIN_BENCHMARK_IMAGE_WORK_BUDGET_MS, 12_000);
  const imageWorkDeadlineMs = params.sessionDeadlineMs ? Date.now() + imageWorkBudgetMs : undefined;
  for (const [turnIndex, turn] of params.turns.entries()) {
    const imageIngest = await ingestLoCoMoTurnImages({
      localBrainRoot: params.localBrainRoot,
      benchmarkName: params.benchmarkName,
      namespaceId: params.namespaceId,
      sampleId: params.sample.sample_id,
      sessionKey: params.sessionKey,
      sessionCapturedAt: capturedAt,
      turn,
      turnIndex,
      sessionDeadlineMs: params.sessionDeadlineMs,
      imageWorkDeadlineMs
    });
    imageArtifactCount += imageIngest.imageArtifactCount;
    derivedImageCount += imageIngest.derivedImageCount;
    imageDerivationCacheHits += imageIngest.imageDerivationCacheHits;
    skippedImageCount += imageIngest.skippedImageCount;
    proxyImageArtifactCount += imageIngest.proxyImageArtifactCount;
  }

  return {
    sessionPath,
    imageArtifactCount,
    derivedImageCount,
    imageDerivationCacheHits,
    skippedImageCount,
    proxyImageArtifactCount
  };
}
