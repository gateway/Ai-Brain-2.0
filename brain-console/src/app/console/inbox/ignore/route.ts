import { NextResponse } from "next/server";
import { getRuntimeBaseUrl } from "@/lib/brain-runtime";

export async function POST(request: Request) {
  const formData = await request.formData();
  const namespaceId = String(formData.get("namespace_id") ?? "");

  const response = await fetch(new URL("/ops/inbox/ignore", getRuntimeBaseUrl()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      namespace_id: namespaceId,
      candidate_id: String(formData.get("candidate_id") ?? ""),
      note: String(formData.get("note") ?? "")
    }),
    cache: "no-store"
  });

  const payload = (await response.json()) as { readonly outbox?: { readonly failed?: number; readonly processed?: number } };
  const rebuildState =
    (payload.outbox?.failed ?? 0) > 0 ? "partial" : (payload.outbox?.processed ?? 0) > 0 ? "done" : "queued";

  return NextResponse.redirect(
    new URL(`/console/inbox?namespace_id=${encodeURIComponent(namespaceId)}&clarification=ignored&rebuild=${rebuildState}`, request.url)
  );
}
