import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getRuntimeBaseUrl } from "@/lib/brain-runtime";

export async function GET(request: NextRequest) {
  const url = new URL("/ops/entity-dossier", getRuntimeBaseUrl());
  const namespaceId = request.nextUrl.searchParams.get("namespace_id");
  const entityId = request.nextUrl.searchParams.get("entity_id");

  if (!namespaceId || !entityId) {
    return NextResponse.json({ error: "namespace_id and entity_id are required" }, { status: 400 });
  }

  url.searchParams.set("namespace_id", namespaceId);
  url.searchParams.set("entity_id", entityId);

  for (const key of ["time_start", "time_end", "limit"] as const) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();

  return new NextResponse(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json"
    }
  });
}
