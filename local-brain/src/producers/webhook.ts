import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readConfig } from "../config.js";
import { ingestArtifact } from "../ingest/worker.js";
import type { ProducerProvider, ProducerWebhookIngestRequest, ProducerWebhookIngestResult } from "./types.js";

interface NormalizedEvent {
  readonly provider: ProducerProvider;
  readonly eventId: string;
  readonly capturedAt: string;
  readonly sourceChannel?: string;
  readonly actorId?: string;
  readonly actorName?: string;
  readonly channelId?: string;
  readonly textContent: string;
  readonly metadata: Record<string, unknown>;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "event";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeGeneric(payload: Record<string, unknown>): {
  readonly eventId?: string;
  readonly capturedAt?: string;
  readonly textContent?: string;
  readonly channelId?: string;
  readonly actorId?: string;
  readonly actorName?: string;
} {
  return {
    eventId: asString(payload.event_id) ?? asString(payload.id),
    capturedAt: asString(payload.captured_at) ?? asString(payload.timestamp),
    textContent: asString(payload.text) ?? asString(payload.message) ?? asString(payload.content),
    channelId: asString(payload.channel_id) ?? asString(payload.channel),
    actorId: asString(payload.user_id) ?? asString(payload.author_id),
    actorName: asString(payload.user_name) ?? asString(payload.author_name)
  };
}

function normalizeSlack(payload: Record<string, unknown>): {
  readonly eventId?: string;
  readonly capturedAt?: string;
  readonly textContent?: string;
  readonly channelId?: string;
  readonly actorId?: string;
  readonly actorName?: string;
} {
  const event = payload.event && typeof payload.event === "object" ? (payload.event as Record<string, unknown>) : {};

  return {
    eventId: asString(payload.event_id) ?? asString(event.client_msg_id) ?? asString(event.ts),
    capturedAt: asString(event.ts) ?? asString(payload.event_time),
    textContent: asString(event.text),
    channelId: asString(event.channel),
    actorId: asString(event.user),
    actorName: asString(event.username)
  };
}

function normalizeDiscord(payload: Record<string, unknown>): {
  readonly eventId?: string;
  readonly capturedAt?: string;
  readonly textContent?: string;
  readonly channelId?: string;
  readonly actorId?: string;
  readonly actorName?: string;
} {
  const author = payload.author && typeof payload.author === "object" ? (payload.author as Record<string, unknown>) : {};

  return {
    eventId: asString(payload.id),
    capturedAt: asString(payload.timestamp),
    textContent: asString(payload.content),
    channelId: asString(payload.channel_id),
    actorId: asString(author.id),
    actorName: asString(author.username)
  };
}

function toNormalizedEvent(request: ProducerWebhookIngestRequest): NormalizedEvent {
  const normalized =
    request.provider === "slack"
      ? normalizeSlack(request.payload)
      : request.provider === "discord"
        ? normalizeDiscord(request.payload)
        : normalizeGeneric(request.payload);

  const capturedAt = request.capturedAt ?? normalized.capturedAt ?? new Date().toISOString();
  const sourceChannel = request.sourceChannel ?? normalized.channelId;
  const eventId = normalized.eventId ?? randomUUID();
  const textContent = normalized.textContent ?? JSON.stringify(request.payload);

  return {
    provider: request.provider,
    eventId,
    capturedAt,
    sourceChannel,
    actorId: normalized.actorId,
    actorName: normalized.actorName,
    channelId: normalized.channelId,
    textContent,
    metadata: {
      producer_provider: request.provider,
      producer_event_id: eventId,
      producer_channel_id: normalized.channelId ?? null,
      producer_actor_id: normalized.actorId ?? null,
      producer_actor_name: normalized.actorName ?? null
    }
  };
}

async function persistProducerFiles(event: NormalizedEvent, payload: Record<string, unknown>): Promise<{
  readonly payloadUri: string;
  readonly normalizedUri: string;
}> {
  const config = readConfig();
  const folder = path.resolve(config.producerInboxRoot, event.provider, sanitizeName(event.capturedAt).slice(0, 10));
  await mkdir(folder, { recursive: true });

  const eventSlug = sanitizeName(event.eventId);
  const payloadUri = path.resolve(folder, `${eventSlug}.json`);
  const normalizedUri = path.resolve(folder, `${eventSlug}.md`);

  const rawPayload = JSON.stringify(payload, null, 2);
  const normalizedText = [
    `# Producer Event`,
    ``,
    `provider: ${event.provider}`,
    `event_id: ${event.eventId}`,
    `captured_at: ${event.capturedAt}`,
    `source_channel: ${event.sourceChannel ?? "unknown"}`,
    `actor_id: ${event.actorId ?? "unknown"}`,
    `actor_name: ${event.actorName ?? "unknown"}`,
    `raw_payload_sha256: ${sha256(rawPayload)}`,
    ``,
    `---`,
    ``,
    event.textContent
  ].join("\n");

  await Promise.all([writeFile(payloadUri, `${rawPayload}\n`, "utf8"), writeFile(normalizedUri, normalizedText, "utf8")]);

  return {
    payloadUri,
    normalizedUri
  };
}

export async function ingestWebhookPayload(request: ProducerWebhookIngestRequest): Promise<ProducerWebhookIngestResult> {
  const normalized = toNormalizedEvent(request);
  const persisted = await persistProducerFiles(normalized, request.payload);

  const ingestResult = await ingestArtifact({
    inputUri: persisted.normalizedUri,
    namespaceId: request.namespaceId,
    sourceType: "chat_turn",
    sourceChannel: normalized.sourceChannel ?? `${normalized.provider}:webhook`,
    capturedAt: normalized.capturedAt,
    metadata: {
      ...normalized.metadata,
      raw_payload_uri: persisted.payloadUri
    }
  });

  return {
    provider: normalized.provider,
    eventId: normalized.eventId,
    payloadUri: persisted.payloadUri,
    normalizedUri: persisted.normalizedUri,
    artifactId: ingestResult.artifact.artifactId,
    observationId: ingestResult.artifact.observationId,
    fragments: ingestResult.fragments.length,
    candidateWrites: ingestResult.candidateWrites.length,
    episodicInsertCount: ingestResult.episodicInsertCount
  };
}

