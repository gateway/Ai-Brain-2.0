import { createHash } from "node:crypto";
import { withTransaction, queryRows } from "../db/client.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ProviderModality } from "../providers/types.js";

export interface AttachTextDerivationRequest {
  readonly artifactId: string;
  readonly artifactObservationId?: string;
  readonly sourceChunkId?: string;
  readonly derivationType: string;
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
  readonly provider?: string;
  readonly model?: string;
  readonly outputDimensionality?: number;
  readonly embed?: boolean;
}

export interface AttachTextDerivationResult {
  readonly derivationId: string;
  readonly artifactId: string;
  readonly artifactObservationId: string;
  readonly derivationType: string;
  readonly embedded: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly outputDimensionality?: number;
}

export interface DeriveArtifactRequest {
  readonly artifactId: string;
  readonly artifactObservationId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly derivationType?: string;
  readonly modality?: ProviderModality;
  readonly maxOutputTokens?: number;
  readonly outputDimensionality?: number;
  readonly embed?: boolean;
  readonly metadata?: Record<string, unknown>;
}

interface ObservationRow {
  readonly observation_id: string;
}

interface ArtifactContextRow {
  readonly artifact_id: string;
  readonly observation_id: string;
  readonly uri: string;
  readonly mime_type: string | null;
  readonly artifact_type: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveObservationId(artifactId: string, artifactObservationId?: string): Promise<string> {
  if (artifactObservationId) {
    return artifactObservationId;
  }

  const rows = await queryRows<ObservationRow>(
    `
      SELECT id AS observation_id
      FROM artifact_observations
      WHERE artifact_id = $1
      ORDER BY version DESC
      LIMIT 1
    `,
    [artifactId]
  );

  const observationId = rows[0]?.observation_id;
  if (!observationId) {
    throw new Error(`No artifact observation found for artifact ${artifactId}`);
  }

  return observationId;
}

async function resolveArtifactContext(artifactId: string, artifactObservationId?: string): Promise<ArtifactContextRow> {
  const observationId = await resolveObservationId(artifactId, artifactObservationId);
  const rows = await queryRows<ArtifactContextRow>(
    `
      SELECT
        a.id AS artifact_id,
        ao.id AS observation_id,
        a.uri,
        a.mime_type,
        a.artifact_type
      FROM artifacts a
      JOIN artifact_observations ao ON ao.artifact_id = a.id
      WHERE a.id = $1
        AND ao.id = $2
      LIMIT 1
    `,
    [artifactId, observationId]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`No artifact context found for artifact ${artifactId}`);
  }

  return row;
}

function inferModality(artifactType: string, mimeType?: string | null): ProviderModality {
  if (artifactType === "image" || mimeType?.startsWith("image/")) {
    return "image";
  }
  if (artifactType === "pdf" || mimeType === "application/pdf") {
    return "pdf";
  }
  if (artifactType === "audio" || mimeType?.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType?.startsWith("video/")) {
    return "video";
  }
  return "text";
}

export async function attachTextDerivation(request: AttachTextDerivationRequest): Promise<AttachTextDerivationResult> {
  const text = request.text.trim();
  if (!text) {
    throw new Error("attachTextDerivation requires non-empty text");
  }

  const artifactObservationId = await resolveObservationId(request.artifactId, request.artifactObservationId);

  let embedding: number[] | null = null;
  let providerName: string | undefined;
  let modelName: string | undefined;
  let outputDimensionality: number | undefined;

  if (request.embed) {
    const adapter = getProviderAdapter(request.provider);
    const embeddingResult = await adapter.embedText({
      text,
      model: request.model,
      outputDimensionality: request.outputDimensionality
    });
    embedding = embeddingResult.embedding;
    providerName = embeddingResult.provider;
    modelName = embeddingResult.model;
    outputDimensionality = embeddingResult.dimensions;
  }

  return withTransaction(async (client) => {
    const result = await client.query<{ derivation_id: string }>(
      `
        INSERT INTO artifact_derivations (
          artifact_observation_id,
          source_chunk_id,
          derivation_type,
          provider,
          model,
          content_text,
          embedding,
          output_dimensionality,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9::jsonb)
        RETURNING id AS derivation_id
      `,
      [
        artifactObservationId,
        request.sourceChunkId ?? null,
        request.derivationType,
        providerName ?? null,
        modelName ?? null,
        text,
        embedding ? `[${embedding.join(",")}]` : null,
        outputDimensionality ?? null,
        JSON.stringify({
          ...(request.metadata ?? {}),
          content_sha256: sha256(text),
          embed_requested: Boolean(request.embed)
        })
      ]
    );

    const derivationId = result.rows[0]?.derivation_id;
    if (!derivationId) {
      throw new Error("Failed to insert artifact derivation");
    }

    return {
      derivationId,
      artifactId: request.artifactId,
      artifactObservationId,
      derivationType: request.derivationType,
      embedded: Boolean(embedding),
      provider: providerName,
      model: modelName,
      outputDimensionality
    };
  });
}

export async function deriveArtifactViaProvider(request: DeriveArtifactRequest): Promise<AttachTextDerivationResult> {
  const artifact = await resolveArtifactContext(request.artifactId, request.artifactObservationId);
  const adapter = getProviderAdapter(request.provider);
  const modality = request.modality ?? inferModality(artifact.artifact_type, artifact.mime_type);
  const derived = await adapter.deriveFromArtifact({
    modality,
    artifactUri: artifact.uri,
    mimeType: artifact.mime_type ?? undefined,
    model: request.model,
    maxOutputTokens: request.maxOutputTokens,
    metadata: request.metadata
  });

  return attachTextDerivation({
    artifactId: request.artifactId,
    artifactObservationId: artifact.observation_id,
    derivationType: request.derivationType ?? `${derived.provider}_${modality}`,
    text: derived.contentAbstract,
    provider: request.embed ? request.provider : undefined,
    model: request.embed ? request.model : undefined,
    outputDimensionality: request.outputDimensionality,
    embed: request.embed,
    metadata: {
      ...(request.metadata ?? {}),
      derivation_provider: derived.provider,
      derivation_model: derived.model,
      derivation_modality: derived.modality,
      derivation_confidence: derived.confidenceScore ?? null,
      derivation_entities: derived.entities ?? [],
      derivation_provenance: derived.provenance,
      derivation_provider_metadata: derived.providerMetadata ?? {}
    }
  });
}
