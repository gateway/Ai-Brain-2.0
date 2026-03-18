import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readConfig } from "../config.js";
import { attachTextDerivation, deriveArtifactViaProvider } from "../derivations/service.js";
import { ingestArtifact } from "../ingest/worker.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { ingestDiscordRelayRequest, ingestSlackEventsRequest } from "../producers/live.js";
import { ingestWebhookPayload } from "../producers/webhook.js";
import { getArtifactDetail, getRelationships, searchMemory, timelineMemory } from "../retrieval/service.js";

interface JsonResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function readTextBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, payload: JsonResponse): void {
  response.writeHead(payload.statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(payload.body, null, 2)}\n`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid ${name}.`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function headerMap(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      result[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value[0]) {
      result[key.toLowerCase()] = value[0];
    }
  }

  return result;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Missing or invalid ${name}.`);
  }

  return value as Record<string, unknown>;
}

async function handleRequest(request: IncomingMessage): Promise<JsonResponse> {
  const url = new URL(request.url ?? "/", "http://local-brain");

  if (request.method === "GET" && url.pathname === "/health") {
    return {
      statusCode: 200,
      body: {
        ok: true
      }
    };
  }

  if (request.method === "GET" && url.pathname === "/search") {
    const result = await searchMemory({
      namespaceId: requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      query: requireString(url.searchParams.get("query"), "query"),
      timeStart: optionalString(url.searchParams.get("time_start")),
      timeEnd: optionalString(url.searchParams.get("time_end")),
      limit: optionalNumber(url.searchParams.get("limit")),
      provider: optionalString(url.searchParams.get("provider")),
      model: optionalString(url.searchParams.get("model")),
      outputDimensionality: optionalNumber(url.searchParams.get("dimensions"))
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/timeline") {
    const result = await timelineMemory({
      namespaceId: requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      timeStart: requireString(url.searchParams.get("time_start"), "time_start"),
      timeEnd: requireString(url.searchParams.get("time_end"), "time_end"),
      limit: optionalNumber(url.searchParams.get("limit"))
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname === "/relationships") {
    const result = await getRelationships({
      namespaceId: requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      entityName: requireString(url.searchParams.get("entity_name"), "entity_name"),
      predicate: optionalString(url.searchParams.get("predicate")),
      timeStart: optionalString(url.searchParams.get("time_start")),
      timeEnd: optionalString(url.searchParams.get("time_end")),
      limit: optionalNumber(url.searchParams.get("limit"))
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
    const artifactId = url.pathname.replace("/artifacts/", "");
    const result = await getArtifactDetail({
      artifactId
    });

    return {
      statusCode: result ? 200 : 404,
      body: result ?? {
        error: "Artifact not found."
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/ingest") {
    const body = await readJsonBody(request);
    const result = await ingestArtifact({
      inputUri: requireString(body.input_uri, "input_uri"),
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      sourceType: requireString(body.source_type, "source_type") as never,
      sourceChannel: optionalString(body.source_channel),
      capturedAt: optionalString(body.captured_at) ?? new Date().toISOString(),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: {
        artifact: result.artifact,
        fragments: result.fragments.length,
        candidateWrites: result.candidateWrites.length,
        episodicInsertCount: result.episodicInsertCount
      }
    };
  }

  if (request.method === "POST" && url.pathname === "/consolidate") {
    const body = await readJsonBody(request);
    const result = await runCandidateConsolidation(
      requireString(body.namespace_id, "namespace_id"),
      optionalNumber(body.limit) ?? 50
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/producer/webhook") {
    const body = await readJsonBody(request);
    const providerRaw = optionalString(body.provider) ?? "generic";

    if (providerRaw !== "generic" && providerRaw !== "slack" && providerRaw !== "discord") {
      throw new Error("provider must be one of generic|slack|discord.");
    }

    const result = await ingestWebhookPayload({
      namespaceId: requireString(body.namespace_id, "namespace_id"),
      provider: providerRaw,
      payload: requireObject(body.payload, "payload"),
      sourceChannel: optionalString(body.source_channel),
      capturedAt: optionalString(body.captured_at)
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/producer/slack/events") {
    const rawBody = await readTextBody(request);
    const result = await ingestSlackEventsRequest(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      rawBody,
      headerMap(request),
      optionalString(url.searchParams.get("source_channel")) ?? "slack:events"
    );

    return {
      statusCode: 200,
      body: result.challenge ? { challenge: result.challenge } : result
    };
  }

  if (request.method === "POST" && url.pathname === "/producer/discord/events") {
    const rawBody = await readTextBody(request);
    const result = await ingestDiscordRelayRequest(
      requireString(url.searchParams.get("namespace_id"), "namespace_id"),
      rawBody,
      headerMap(request),
      optionalString(url.searchParams.get("source_channel")) ?? "discord:relay"
    );

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/derive/text") {
    const body = await readJsonBody(request);
    const result = await attachTextDerivation({
      artifactId: requireString(body.artifact_id, "artifact_id"),
      artifactObservationId: optionalString(body.artifact_observation_id),
      sourceChunkId: optionalString(body.source_chunk_id),
      derivationType: optionalString(body.derivation_type) ?? "text_proxy",
      text: requireString(body.text, "text"),
      provider: optionalString(body.provider),
      model: optionalString(body.model),
      outputDimensionality: optionalNumber(body.output_dimensionality),
      embed: Boolean(body.embed),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  if (request.method === "POST" && url.pathname === "/derive/provider") {
    const body = await readJsonBody(request);
    const result = await deriveArtifactViaProvider({
      artifactId: requireString(body.artifact_id, "artifact_id"),
      artifactObservationId: optionalString(body.artifact_observation_id),
      provider: optionalString(body.provider) ?? "external",
      model: optionalString(body.model),
      derivationType: optionalString(body.derivation_type),
      modality: optionalString(body.modality) as never,
      maxOutputTokens: optionalNumber(body.max_output_tokens),
      outputDimensionality: optionalNumber(body.output_dimensionality),
      embed: Boolean(body.embed),
      metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    });

    return {
      statusCode: 200,
      body: result
    };
  }

  return {
    statusCode: 404,
    body: {
      error: "Not found."
    }
  };
}

export function startHttpServer(): void {
  const config = readConfig();
  const server = createServer(async (request, response) => {
    try {
      const payload = await handleRequest(request);
      writeJson(response, payload);
    } catch (error) {
      writeJson(response, {
        statusCode: 400,
        body: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });

  server.listen(config.httpPort, config.httpHost, () => {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          host: config.httpHost,
          port: config.httpPort
        },
        null,
        2
      )}\n`
    );
  });
}
