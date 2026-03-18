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

interface MockChatRequest {
  readonly model?: string;
  readonly preset_id?: string;
  readonly messages?: Array<{
    readonly role?: string;
    readonly content?: string;
  }>;
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

function classifyContent(request: MockChatRequest): Record<string, unknown> {
  const content = request.messages?.map((message) => message.content ?? "").join("\n") ?? "";

  if (content.includes("Gummi") || content.includes("Gumee") || content.includes("Two-Way")) {
    return {
      summary: "Friendship and project note connecting Steve, Gummi, Dan, Ben, Tim, and Two-Way.",
      tripartite: {
        episodic_hints: ["Steve and friends met in Chiang Mai and spend Sundays together."],
        semantic_hints: ["Dan connects the Chiang Mai friend circle."],
        procedural_hints: [
          {
            state_type: "project_role",
            content: "Steve is acting CTO for Two-Way",
            confidence: 0.93
          }
        ]
      },
      entities: [
        { name: "Steve", entity_type: "person", role: "subject", confidence: 0.99 },
        { name: "Gummi", entity_type: "person", aliases: ["Gumee"], confidence: 0.96 },
        { name: "Dan", entity_type: "person", confidence: 0.92 },
        { name: "Mexico City", entity_type: "place", confidence: 0.9 },
        { name: "Chiang Mai", entity_type: "place", confidence: 0.91 },
        { name: "Thailand", entity_type: "place", confidence: 0.91 },
        { name: "Tim", entity_type: "person", confidence: 0.89 },
        { name: "Ben", entity_type: "person", confidence: 0.9 },
        { name: "Two-Way", entity_type: "project", confidence: 0.95 },
        { name: "Pilot Association", entity_type: "org", confidence: 0.86 },
        { name: "Turkey", entity_type: "place", confidence: 0.84 }
      ],
      relationships: [
        {
          subject: "Steve",
          subject_type: "person",
          predicate: "friend_of",
          object: "Gummi",
          object_type: "person",
          confidence: 0.93
        },
        {
          subject: "Steve",
          subject_type: "person",
          predicate: "works_on",
          object: "Two-Way",
          object_type: "project",
          confidence: 0.94
        },
        {
          subject: "Gummi",
          subject_type: "person",
          predicate: "member_of",
          object: "Pilot Association",
          object_type: "org",
          confidence: 0.88
        },
        {
          subject: "Dan",
          subject_type: "person",
          predicate: "from",
          object: "Mexico City",
          object_type: "place",
          confidence: 0.89
        },
        {
          subject: "Chiang Mai",
          subject_type: "place",
          predicate: "contained_in",
          object: "Thailand",
          object_type: "place",
          confidence: 0.97
        }
      ],
      claims: [
        {
          candidate_type: "project_role",
          content: "Steve is the acting CTO for Two-Way",
          subject: "Steve",
          subject_type: "person",
          predicate: "project_role",
          object: "Two-Way",
          object_type: "project",
          confidence: 0.93
        },
        {
          candidate_type: "project_focus",
          content: "Two-Way is preparing for a conference in Turkey",
          subject: "Two-Way",
          subject_type: "project",
          predicate: "project_focus",
          object: "Turkey",
          object_type: "place",
          confidence: 0.84
        }
      ],
      ambiguities: content.includes("Gumee")
        ? [
            {
              text: "Gumee",
              ambiguity_type: "possible_misspelling",
              reason: "Likely refers to Gummi"
            }
          ]
        : []
    };
  }

  return {
    summary: "Generic mock classification output.",
    tripartite: {
      episodic_hints: ["A text artifact was classified."],
      semantic_hints: ["The note contains portable memory candidates."],
      procedural_hints: []
    },
    entities: [],
    relationships: [],
    claims: [],
    ambiguities: []
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

  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    const body = (await readJson(request)) as MockChatRequest;
    const payload = classifyContent(body);
    writeJson(response, 200, {
      model: normalizeString(body.model) ?? "mock-chat-001",
      choices: [
        {
          message: {
            content: JSON.stringify(payload)
          }
        }
      ],
      usage: {
        prompt_tokens: JSON.stringify(body).length / 4,
        completion_tokens: JSON.stringify(payload).length / 4,
        total_tokens: (JSON.stringify(body).length + JSON.stringify(payload).length) / 4
      },
      metrics: {
        mock: true,
        preset_id: normalizeString(body.preset_id) ?? null
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
