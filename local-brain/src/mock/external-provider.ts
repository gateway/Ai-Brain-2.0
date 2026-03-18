import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

interface MockServerOptions {
  readonly host: string;
  readonly port: number;
}

interface MockDeriveRequest {
  readonly model?: string;
  readonly modality?: string;
  readonly artifact_uri?: string;
  readonly mime_type?: string;
  readonly max_output_tokens?: number;
  readonly metadata?: Record<string, unknown>;
}

interface MockEmbeddingRequest {
  readonly model?: string;
  readonly text?: string;
  readonly output_dimensionality?: number;
  readonly metadata?: Record<string, unknown>;
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function deterministicVector(text: string, dimensions: number): number[] {
  const values: number[] = [];
  let seed = createHash("sha256").update(text).digest();

  while (values.length < dimensions) {
    for (const byte of seed) {
      values.push((byte / 255) * 2 - 1);
      if (values.length >= dimensions) {
        break;
      }
    }
    seed = createHash("sha256").update(seed).digest();
  }

  return values;
}

function deriveContent(request: MockDeriveRequest): {
  readonly contentAbstract: string;
  readonly entities: readonly string[];
  readonly pageNumber?: number;
} {
  const artifactUri = normalizeString(request.artifact_uri) ?? "unknown-artifact";
  const basename = path.basename(artifactUri);
  const modality = normalizeString(request.modality) ?? "text";

  if (basename === "Local_Cognitive_Architecture.pdf") {
    return {
      contentAbstract:
        "Local Cognitive Architecture slide deck describing a local-first Brain 2.0 with PostgreSQL 18, tripartite memory, BM25 plus vector hybrid retrieval, pgvectorscale, temporal memory hierarchy, provenance, and relationship-aware recall.",
      entities: ["PostgreSQL 18", "BM25", "pgvectorscale", "TMT", "tripartite memory"],
      pageNumber: 1
    };
  }

  if (modality === "pdf") {
    return {
      contentAbstract: `Mock PDF extraction for ${basename}. This document was processed into a searchable text proxy with provenance.`,
      entities: [basename],
      pageNumber: 1
    };
  }

  if (modality === "image") {
    return {
      contentAbstract: `Mock image caption for ${basename}. The artifact appears to contain a diagram or visual reference worth indexing.`,
      entities: [basename]
    };
  }

  if (modality === "audio") {
    return {
      contentAbstract: `Mock transcript for ${basename}. The audio content was converted into searchable text for the local brain.`,
      entities: [basename]
    };
  }

  return {
    contentAbstract: `Mock derivation for ${basename}. The artifact was converted into a durable text proxy for search and later embedding sync.`,
    entities: [basename]
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { ok: true, mock: true });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/embeddings") {
    const body = (await readJson(request)) as MockEmbeddingRequest;
    const text = normalizeString(body.text) ?? "";
    const dimensions = Number.isFinite(Number(body.output_dimensionality)) ? Number(body.output_dimensionality) : 1536;
    writeJson(response, 200, {
      model: normalizeString(body.model) ?? "mock-embedding-001",
      embedding: deterministicVector(text || "empty", dimensions),
      dimensions,
      normalized: false,
      tokenUsage: {
        inputTokens: text.split(/\s+/u).filter(Boolean).length
      },
      providerMetadata: {
        mock: true
      }
    });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/artifacts/derive") {
    const body = (await readJson(request)) as MockDeriveRequest;
    const derived = deriveContent(body);
    writeJson(response, 200, {
      model: normalizeString(body.model) ?? "mock-derive-001",
      contentAbstract: derived.contentAbstract,
      confidenceScore: 0.81,
      entities: derived.entities,
      provenance: {
        artifactUri: normalizeString(body.artifact_uri),
        pageNumber: derived.pageNumber
      },
      providerMetadata: {
        mock: true,
        mimeType: normalizeString(body.mime_type) ?? null
      }
    });
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

export async function startMockExternalProvider(options: MockServerOptions): Promise<void> {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : "Mock server failure"
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        host: options.host,
        port: options.port,
        mock: true
      },
      null,
      2
    )
  );
}

