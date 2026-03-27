import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import type { ArtifactRecord, SourceType } from "../types.js";

export interface ArtifactObservation {
  readonly artifactId: string;
  readonly observationId: string;
  readonly checksumSha256: string;
  readonly version: number;
  readonly textContent: string;
  readonly hasTextContent: boolean;
  readonly mimeType: string;
  readonly uri: string;
}

function inferMimeType(sourceType: SourceType, uri: string): string {
  const ext = path.extname(uri).toLowerCase();

  if (sourceType === "markdown" || sourceType === "markdown_session" || ext === ".md") {
    return "text/markdown";
  }

  if (sourceType === "transcript" || sourceType === "text" || ext === ".txt") {
    return "text/plain";
  }

  if (sourceType === "chat_turn" || ext === ".json") {
    return "application/json";
  }

  if (sourceType === "pdf" || ext === ".pdf") {
    return "application/pdf";
  }

  if (sourceType === "image" || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"].includes(ext)) {
    return ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
  }

  if (sourceType === "audio" || [".mp3", ".m4a", ".wav", ".aac"].includes(ext)) {
    return ext === ".wav" ? "audio/wav" : ext === ".aac" ? "audio/aac" : ext === ".mp3" ? "audio/mpeg" : "audio/mp4";
  }

  if (sourceType === "video" || [".mp4", ".mov", ".m4v", ".webm"].includes(ext)) {
    return ext === ".mov" ? "video/quicktime" : ext === ".webm" ? "video/webm" : "video/mp4";
  }

  return "application/octet-stream";
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isTextLike(sourceType: SourceType, mimeType: string, uri: string): boolean {
  const ext = path.extname(uri).toLowerCase();

  if (sourceType === "image" || sourceType === "audio" || sourceType === "video" || sourceType === "pdf") {
    return false;
  }

  if (mimeType.startsWith("text/")) {
    return true;
  }

  return [".md", ".markdown", ".txt", ".json"].includes(ext);
}

export async function ensureArtifactRoot(artifactRoot: string): Promise<void> {
  if (!artifactRoot) {
    return;
  }

  await mkdir(artifactRoot, { recursive: true });
}

export async function readArtifactSource(inputUri: string, sourceType: SourceType = "text"): Promise<{
  readonly textContent: string;
  readonly hasTextContent: boolean;
  readonly uri: string;
  readonly byteSize: number;
  readonly modifiedAt: string;
  readonly checksumSha256: string;
}> {
  const absolutePath = path.resolve(inputUri);
  const [buffer, fileStats] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  const mimeType = inferMimeType(sourceType, absolutePath);

  return {
    textContent: buffer.toString("utf8"),
    hasTextContent: mimeType.startsWith("text/") || path.extname(absolutePath).toLowerCase() === ".json",
    uri: absolutePath,
    byteSize: fileStats.size,
    modifiedAt: fileStats.mtime.toISOString(),
    checksumSha256: sha256(buffer)
  };
}

export async function registerArtifactObservation(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly sourceType: SourceType;
    readonly inputUri: string;
    readonly capturedAt?: string;
    readonly sourceChannel?: string;
    readonly metadata?: Record<string, unknown>;
  }
): Promise<ArtifactObservation> {
  const absolutePath = path.resolve(options.inputUri);
  const mimeType = inferMimeType(options.sourceType, absolutePath);
  const [buffer, fileStats] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  const checksumSha256 = sha256(buffer);
  const textLike = isTextLike(options.sourceType, mimeType, absolutePath);
  const source = {
    textContent: textLike ? buffer.toString("utf8") : "",
    hasTextContent: textLike,
    uri: absolutePath,
    byteSize: fileStats.size,
    modifiedAt: fileStats.mtime.toISOString(),
    checksumSha256
  };
  const metadata = {
    ...(options.metadata ?? {}),
    captured_at: options.capturedAt ?? null,
    byte_size: source.byteSize,
    modified_at: source.modifiedAt,
    has_text_content: source.hasTextContent
  };

  const artifactResult = await client.query<{
    id: string;
    created_at: string;
  }>(
    `
      INSERT INTO artifacts (
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        created_at,
        last_seen_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, now(), now(), $7::jsonb)
      ON CONFLICT (namespace_id, uri)
      DO UPDATE SET
        artifact_type = EXCLUDED.artifact_type,
        latest_checksum_sha256 = EXCLUDED.latest_checksum_sha256,
        mime_type = EXCLUDED.mime_type,
        source_channel = EXCLUDED.source_channel,
        last_seen_at = now(),
        metadata = artifacts.metadata || EXCLUDED.metadata
      RETURNING id, created_at
    `,
    [
      options.namespaceId,
      options.sourceType,
      source.uri,
      checksumSha256,
      mimeType,
      options.sourceChannel ?? null,
      JSON.stringify(metadata)
    ]
  );

  const artifactId = artifactResult.rows[0]?.id;
  if (!artifactId) {
    throw new Error("Failed to register artifact");
  }

  const existingObservation = await client.query<{
    id: string;
    version: number;
  }>(
    `
      SELECT id, version
      FROM artifact_observations
      WHERE artifact_id = $1 AND checksum_sha256 = $2
      LIMIT 1
    `,
    [artifactId, checksumSha256]
  );

  if (existingObservation.rowCount && existingObservation.rows[0]) {
    const row = existingObservation.rows[0];
    return {
      artifactId,
      observationId: row.id,
      checksumSha256,
      version: row.version,
      textContent: source.textContent,
      hasTextContent: source.hasTextContent,
      mimeType,
      uri: source.uri
    };
  }

  const versionResult = await client.query<{ next_version: number }>(
    `
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM artifact_observations
      WHERE artifact_id = $1
    `,
    [artifactId]
  );

  const nextVersion = Number(versionResult.rows[0]?.next_version ?? 1);

  const observationResult = await client.query<{
    id: string;
  }>(
    `
      INSERT INTO artifact_observations (
        artifact_id,
        version,
        checksum_sha256,
        byte_size,
        observed_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
      RETURNING id
    `,
    [
      artifactId,
      nextVersion,
      checksumSha256,
      source.byteSize,
      options.capturedAt ?? new Date().toISOString(),
      JSON.stringify(metadata)
    ]
  );

  const observationId = observationResult.rows[0]?.id;
  if (!observationId) {
    throw new Error("Failed to register artifact observation");
  }

  return {
    artifactId,
    observationId,
    checksumSha256,
    version: nextVersion,
    textContent: source.textContent,
    hasTextContent: source.hasTextContent,
    mimeType,
    uri: source.uri
  };
}

export function toArtifactRecord(input: {
  readonly namespaceId: string;
  readonly sourceType: SourceType;
  readonly sourceChannel?: string;
  readonly metadata?: Record<string, unknown>;
  readonly observation: ArtifactObservation;
}): ArtifactRecord {
  return {
    artifactId: input.observation.artifactId,
    observationId: input.observation.observationId,
    namespaceId: input.namespaceId,
    sourceType: input.sourceType,
    uri: input.observation.uri,
    checksumSha256: input.observation.checksumSha256,
    version: input.observation.version,
    mimeType: input.observation.mimeType,
    sourceChannel: input.sourceChannel,
    createdAt: new Date().toISOString(),
    metadata: input.metadata ?? {}
  };
}
