import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readConfig } from "../config.js";
import { ingestArtifact } from "../ingest/worker.js";
import { ingestWebhookPayload } from "./webhook.js";

interface AttachmentResult {
  readonly uri: string;
  readonly artifactId: string;
  readonly observationId?: string;
}

export interface LiveProducerResponse {
  readonly accepted: boolean;
  readonly provider: "slack" | "discord";
  readonly challenge?: string;
  readonly eventId?: string;
  readonly normalizedArtifactId?: string;
  readonly attachmentArtifacts: readonly AttachmentResult[];
}

export class ProducerRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ProducerRequestError";
    this.statusCode = statusCode;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "item";
}

function parseId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAllowed(value: string | undefined, allowlist: readonly string[]): boolean {
  return allowlist.length === 0 || (typeof value === "string" && allowlist.includes(value));
}

function requireAllowed(value: string | undefined, allowlist: readonly string[], label: string): void {
  if (!isAllowed(value, allowlist)) {
    throw new ProducerRequestError(`Rejected ${label}: not in allowlist.`, 202);
  }
}

function inferSourceType(filename: string, mimeType?: string): "image" | "pdf" | "audio" | "text" {
  const lowered = filename.toLowerCase();
  if (mimeType?.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"].some((ext) => lowered.endsWith(ext))) {
    return "image";
  }
  if (mimeType === "application/pdf" || lowered.endsWith(".pdf")) {
    return "pdf";
  }
  if (mimeType?.startsWith("audio/") || [".mp3", ".m4a", ".wav", ".aac"].some((ext) => lowered.endsWith(ext))) {
    return "audio";
  }
  return "text";
}

async function downloadToFile(url: string, targetPath: string, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, {
    headers
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(arrayBuffer));
}

async function ingestAttachments(
  namespaceId: string,
  provider: "slack" | "discord",
  eventId: string,
  capturedAt: string,
  sourceChannel: string | undefined,
  attachments: ReadonlyArray<{ url: string; filename: string; mimeType?: string; headers?: Record<string, string> }>
): Promise<AttachmentResult[]> {
  const config = readConfig();
  const folder = path.resolve(
    config.producerInboxRoot,
    provider,
    sanitize(capturedAt).slice(0, 10),
    `${sanitize(eventId)}-attachments`
  );

  const results: AttachmentResult[] = [];
  for (const attachment of attachments) {
    const targetPath = path.resolve(folder, sanitize(attachment.filename));
    await downloadToFile(attachment.url, targetPath, attachment.headers ?? {});
    const ingestResult = await ingestArtifact({
      inputUri: targetPath,
      namespaceId,
      sourceType: inferSourceType(attachment.filename, attachment.mimeType),
      sourceChannel,
      capturedAt,
      metadata: {
        producer_provider: provider,
        producer_event_id: eventId,
        attachment_url: attachment.url,
        attachment_filename: attachment.filename,
        attachment_mime_type: attachment.mimeType ?? null
      }
    });

    results.push({
      uri: targetPath,
      artifactId: ingestResult.artifact.artifactId,
      observationId: ingestResult.artifact.observationId
    });
  }

  return results;
}

function verifySlackSignature(rawBody: string, timestamp: string, signature: string): void {
  const config = readConfig();
  if (!config.slackSigningSecret) {
    return;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    throw new ProducerRequestError("Rejected Slack request: timestamp is outside the allowed replay window.", 401);
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", config.slackSigningSecret).update(base).digest("hex")}`;
  if (!safeEqual(expected, signature)) {
    throw new ProducerRequestError("Invalid Slack signature", 401);
  }
}

export async function ingestSlackEventsRequest(
  namespaceId: string,
  rawBody: string,
  headers: Record<string, string>,
  sourceChannel?: string
): Promise<LiveProducerResponse> {
  const timestamp = headers["x-slack-request-timestamp"] ?? "";
  const signature = headers["x-slack-signature"] ?? "";
  verifySlackSignature(rawBody, timestamp, signature);

  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  if (typeof payload.challenge === "string") {
    return {
      accepted: true,
      provider: "slack",
      challenge: payload.challenge,
      attachmentArtifacts: []
    };
  }

  const event = payload.event && typeof payload.event === "object" ? (payload.event as Record<string, unknown>) : {};
  if ((event.type as string | undefined) !== "message") {
    return {
      accepted: false,
      provider: "slack",
      attachmentArtifacts: []
    };
  }

  const config = readConfig();
  const teamId = parseId(payload.team_id) ?? parseId(event.team);
  const channelId = parseId(event.channel);
  const actorId = parseId(event.user);
  requireAllowed(teamId, config.slackAllowedTeams, "Slack team");
  requireAllowed(channelId, config.slackAllowedChannels, "Slack channel");
  requireAllowed(actorId, config.slackAllowedUsers, "Slack user");

  const ingestResult = await ingestWebhookPayload({
    namespaceId,
    provider: "slack",
    payload,
    sourceChannel,
    capturedAt: typeof event.ts === "string" ? new Date(Number(event.ts.split(".")[0]) * 1000).toISOString() : undefined
  });

  const files = Array.isArray(event.files) ? event.files : [];
  const attachments = files
    .map((file) => (file && typeof file === "object" ? (file as Record<string, unknown>) : null))
    .filter((file): file is Record<string, unknown> => Boolean(file))
    .map((file) => ({
      url: (file.url_private_download as string | undefined) ?? (file.url_private as string | undefined) ?? "",
      filename: (file.name as string | undefined) ?? "slack-attachment.bin",
      mimeType: file.mimetype as string | undefined,
      headers: config.slackBotToken ? { authorization: `Bearer ${config.slackBotToken}` } : undefined
    }))
    .filter((attachment) => attachment.url);

  const attachmentArtifacts =
    attachments.length > 0
      ? await ingestAttachments(
          namespaceId,
          "slack",
          ingestResult.eventId,
          payload.event_time ? new Date(Number(payload.event_time) * 1000).toISOString() : new Date().toISOString(),
          sourceChannel,
          attachments
        )
      : [];

  return {
    accepted: true,
    provider: "slack",
    eventId: ingestResult.eventId,
    normalizedArtifactId: ingestResult.artifactId,
    attachmentArtifacts
  };
}

function verifySharedSecret(headers: Record<string, string>): void {
  const config = readConfig();
  if (!config.producerSharedSecret) {
    return;
  }

  const provided = headers["x-brain-ingress-secret"] ?? "";
  if (!provided || !safeEqual(provided, config.producerSharedSecret)) {
    throw new ProducerRequestError("Invalid producer shared secret", 401);
  }
}

export async function ingestDiscordRelayRequest(
  namespaceId: string,
  rawBody: string,
  headers: Record<string, string>,
  sourceChannel?: string
): Promise<LiveProducerResponse> {
  verifySharedSecret(headers);
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const config = readConfig();
  const guildId = parseId(payload.guild_id);
  const channelId = parseId(payload.channel_id);
  const actorId = parseId(
    payload.author && typeof payload.author === "object" ? (payload.author as Record<string, unknown>).id : undefined
  );
  requireAllowed(guildId, config.discordAllowedGuilds, "Discord guild");
  requireAllowed(channelId, config.discordAllowedChannels, "Discord channel");
  requireAllowed(actorId, config.discordAllowedUsers, "Discord user");
  const ingestResult = await ingestWebhookPayload({
    namespaceId,
    provider: "discord",
    payload,
    sourceChannel,
    capturedAt: typeof payload.timestamp === "string" ? payload.timestamp : undefined
  });

  const attachmentsRaw = Array.isArray(payload.attachments) ? payload.attachments : [];
  const attachments = attachmentsRaw
    .map((attachment) => (attachment && typeof attachment === "object" ? (attachment as Record<string, unknown>) : null))
    .filter((attachment): attachment is Record<string, unknown> => Boolean(attachment))
    .map((attachment) => ({
      url: (attachment.url as string | undefined) ?? "",
      filename: (attachment.filename as string | undefined) ?? "discord-attachment.bin",
      mimeType: attachment.content_type as string | undefined,
      headers: config.discordBotToken ? { authorization: `Bot ${config.discordBotToken}` } : undefined
    }))
    .filter((attachment) => attachment.url);

  const attachmentArtifacts =
    attachments.length > 0
      ? await ingestAttachments(
          namespaceId,
          "discord",
          ingestResult.eventId,
          typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString(),
          sourceChannel,
          attachments
        )
      : [];

  return {
    accepted: true,
    provider: "discord",
    eventId: ingestResult.eventId,
    normalizedArtifactId: ingestResult.artifactId,
    attachmentArtifacts
  };
}
