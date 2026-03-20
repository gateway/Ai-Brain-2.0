import { stdin, stdout } from "node:process";
import { withTransaction } from "../db/client.js";
import { getOpsClarificationInbox } from "../ops/service.js";
import { getArtifactDetail, getRelationships, searchMemory, timelineMemory } from "../retrieval/service.js";
import { toolDescriptors } from "./tool-contracts.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorBody;
}

interface ToolCallArgs {
  [key: string]: unknown;
}

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface McpResultPayload {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid ${name}.`);
  }

  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFrame(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
  const body = JSON.stringify(message);
  stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function ok(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function toolSchema(name: string): Record<string, unknown> {
  switch (name) {
    case "memory.search":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          namespace_id: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["query", "namespace_id"]
      };
    case "memory.timeline":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["namespace_id", "time_start", "time_end"]
      };
    case "memory.get_artifact":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          artifact_id: { type: "string" }
        },
        required: ["artifact_id"]
      };
    case "memory.get_relationships":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_name: { type: "string" },
          namespace_id: { type: "string" },
          predicate: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["entity_name", "namespace_id"]
      };
    case "memory.get_clarifications":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: ["namespace_id"]
      };
    case "memory.save_candidate":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          content: { type: "string" },
          candidate_type: { type: "string" },
          source_memory_id: { type: "string" },
          source_chunk_id: { type: "string" },
          confidence: { type: "number" },
          metadata: { type: "object" }
        },
        required: ["namespace_id", "content", "candidate_type"]
      };
    case "memory.upsert_state":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace_id: { type: "string" },
          state_type: { type: "string" },
          state_key: { type: "string" },
          state_value: {},
          metadata: { type: "object" }
        },
        required: ["namespace_id", "state_type", "state_key", "state_value"]
      };
    default:
      return {
        type: "object",
        additionalProperties: true
      };
  }
}

function listTools(): McpToolDefinition[] {
  return toolDescriptors.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolSchema(tool.name)
  }));
}

function wrapResult(payload: unknown): McpResultPayload {
  return {
    content: [
      {
        type: "text",
        text: jsonText(payload)
      }
    ],
    structuredContent: payload
  };
}

async function saveCandidate(args: ToolCallArgs): Promise<unknown> {
  const result = await withTransaction(async (client) => {
    const insertResult = await client.query(
      `
        INSERT INTO memory_candidates (
          namespace_id,
          source_memory_id,
          source_chunk_id,
          candidate_type,
          content,
          confidence,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT ON CONSTRAINT memory_candidates_namespace_source_memory_id_source_chunk_key
        DO UPDATE SET
          confidence = COALESCE(EXCLUDED.confidence, memory_candidates.confidence),
          metadata = memory_candidates.metadata || EXCLUDED.metadata,
          status = 'pending'
        RETURNING
          id,
          namespace_id,
          source_memory_id,
          source_chunk_id,
          candidate_type,
          content,
          confidence,
          status,
          created_at,
          metadata
      `,
      [
        requireString(args.namespace_id, "namespace_id"),
        optionalString(args.source_memory_id) ?? null,
        optionalString(args.source_chunk_id) ?? null,
        requireString(args.candidate_type, "candidate_type"),
        requireString(args.content, "content"),
        optionalNumber(args.confidence) ?? null,
        JSON.stringify(optionalObject(args.metadata) ?? {})
      ]
    );

    const row = insertResult.rows[0];
    if (!row) {
      throw new Error("Failed to save candidate.");
    }

    return row;
  });

  return {
    content: [
      {
        type: "text",
        text: jsonText(result)
      }
    ],
    structuredContent: result
  };
}

async function upsertState(args: ToolCallArgs): Promise<unknown> {
  const result = await withTransaction(async (client) => {
    const activeState = await client.query<{ id: string; version: number }>(
      `
        SELECT id, version
        FROM procedural_memory
        WHERE namespace_id = $1
          AND state_type = $2
          AND state_key = $3
          AND valid_until IS NULL
        ORDER BY version DESC
        LIMIT 1
      `,
      [requireString(args.namespace_id, "namespace_id"), requireString(args.state_type, "state_type"), requireString(args.state_key, "state_key")]
    );

    const activeRow = activeState.rows[0];
    const occurredAt = new Date().toISOString();

    if (activeRow) {
      await client.query(
        `
          UPDATE procedural_memory
          SET valid_until = $2
          WHERE id = $1
        `,
        [activeRow.id, occurredAt]
      );
    }

    const nextVersion = (activeRow?.version ?? 0) + 1;
    const insertResult = await client.query(
      `
        INSERT INTO procedural_memory (
          namespace_id,
          state_type,
          state_key,
          state_value,
          version,
          updated_at,
          valid_from,
          valid_until,
          supersedes_id,
          metadata
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6, NULL, $7, $8::jsonb)
        RETURNING id, namespace_id, state_type, state_key, state_value, version, updated_at, valid_from, valid_until, supersedes_id, metadata
      `,
      [
        requireString(args.namespace_id, "namespace_id"),
        requireString(args.state_type, "state_type"),
        requireString(args.state_key, "state_key"),
        JSON.stringify(args.state_value ?? {}),
        nextVersion,
        occurredAt,
        activeRow?.id ?? null,
        JSON.stringify(optionalObject(args.metadata) ?? {})
      ]
    );

    const row = insertResult.rows[0];
    if (!row) {
      throw new Error("Failed to upsert procedural state.");
    }

    return row;
  });

  return {
    content: [
      {
        type: "text",
        text: jsonText(result)
      }
    ],
    structuredContent: result
  };
}

async function callTool(name: string, args: ToolCallArgs): Promise<unknown> {
  switch (name) {
    case "memory.search":
      return wrapResult(
        await searchMemory({
          query: requireString(args.query, "query"),
          namespaceId: requireString(args.namespace_id, "namespace_id"),
          timeStart: optionalString(args.time_start),
          timeEnd: optionalString(args.time_end),
          limit: optionalNumber(args.limit)
        })
      );
    case "memory.timeline":
      return wrapResult(
        await timelineMemory({
          namespaceId: requireString(args.namespace_id, "namespace_id"),
          timeStart: requireString(args.time_start, "time_start"),
          timeEnd: requireString(args.time_end, "time_end"),
          limit: optionalNumber(args.limit)
        })
      );
    case "memory.get_artifact":
      return wrapResult(await getArtifactDetail({ artifactId: requireString(args.artifact_id, "artifact_id") }));
    case "memory.get_relationships":
      return wrapResult(
        await getRelationships({
          namespaceId: requireString(args.namespace_id, "namespace_id"),
          entityName: requireString(args.entity_name, "entity_name"),
          predicate: optionalString(args.predicate),
          timeStart: optionalString(args.time_start),
          timeEnd: optionalString(args.time_end),
          limit: optionalNumber(args.limit)
        })
      );
    case "memory.get_clarifications": {
      const namespaceId = requireString(args.namespace_id, "namespace_id");
      const rawQuery = optionalString(args.query)?.toLowerCase() ?? null;
      const inbox = await getOpsClarificationInbox(namespaceId, optionalNumber(args.limit) ?? 10);
      const items = rawQuery
        ? inbox.items.filter((item) => {
            const haystacks = [
              item.rawText,
              item.claimType,
              item.predicate,
              item.ambiguityType,
              item.ambiguityReason ?? "",
              item.sceneText ?? ""
            ].join(" ").toLowerCase();
            return rawQuery.split(/\s+/u).every((token) => token.length < 2 || haystacks.includes(token));
          })
        : inbox.items;

      return wrapResult({
        namespaceId,
        summary: inbox.summary,
        items,
        guidance: {
          suggestedPrompt:
            items.length > 0
              ? `The brain needs clarification before it can answer confidently about: ${optionalString(args.query) ?? "the requested topic"}`
              : `No open clarification items matched ${optionalString(args.query) ?? "the requested topic"}.`
        }
      });
    }
    case "memory.save_candidate":
      return saveCandidate(args);
    case "memory.upsert_state":
      return upsertState(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function parseToolArgs(params: unknown): ToolCallArgs {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }

  const record = params as Record<string, unknown>;
  const argumentsValue = optionalObject(record.arguments);
  const directArgs = optionalObject(record.args);
  return {
    ...(directArgs ?? {}),
    ...(argumentsValue ?? {}),
    ...(record.arguments && !argumentsValue ? { arguments: record.arguments } : {}),
    ...(record.args && !directArgs ? { args: record.args } : {})
  };
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse | null> {
  if (request.method === "initialize") {
    return ok(request.id ?? null, {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "ai-brain-local-mcp",
        version: "0.1.0"
      },
      capabilities: {
        tools: {}
      }
    });
  }

  if (request.method === "tools/list") {
    return ok(request.id ?? null, {
      tools: listTools()
    });
  }

  if (request.method === "tools/call") {
    const params = optionalObject(request.params) ?? {};
    const toolName = requireString(params.name, "name");
    const toolArgs = parseToolArgs(params);
    const result = await callTool(toolName, toolArgs);
    return ok(request.id ?? null, result);
  }

  if (request.id === undefined) {
    return null;
  }

  return fail(request.id ?? null, -32601, `Method not found: ${request.method}`);
}

export async function startMcpStdioServer(): Promise<void> {
  stdin.setEncoding("utf8");

  let buffer = "";

  const drain = async (): Promise<void> => {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headerBlock = buffer.slice(0, headerEnd);
      const contentLengthLine = headerBlock
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));

      if (!contentLengthLine) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(contentLengthLine.split(":")[1]?.trim());
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) {
        return;
      }

      const body = buffer.slice(bodyStart, bodyEnd);
      buffer = buffer.slice(bodyEnd);

      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(body) as JsonRpcRequest;
      } catch (error) {
        writeFrame(fail(null, -32700, "Parse error", error instanceof Error ? error.message : String(error)));
        continue;
      }

      if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
        writeFrame(fail(parsed.id ?? null, -32600, "Invalid Request"));
        continue;
      }

      try {
        const response = await handleRequest(parsed);
        if (response) {
          writeFrame(response);
        }
      } catch (error) {
        writeFrame(
          fail(
            parsed.id ?? null,
            -32000,
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? { name: error.name } : undefined
          )
        );
      }
    }
  };

  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    void drain();
  });

  stdin.on("end", () => {
    process.exit(0);
  });

  process.on("SIGINT", () => {
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.exit(0);
  });
}
