import { NextResponse } from "next/server";
import { getRuntimeBaseUrl } from "@/lib/brain-runtime";

export async function POST(request: Request) {
  const formData = await request.formData();
  const namespaceId = String(formData.get("namespace_id") ?? "");

  await fetch(new URL("/ops/identity-conflicts/keep-separate", getRuntimeBaseUrl()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      left_entity_id: String(formData.get("left_entity_id") ?? ""),
      right_entity_id: String(formData.get("right_entity_id") ?? ""),
      note: String(formData.get("note") ?? "")
    }),
    cache: "no-store"
  });

  return NextResponse.redirect(new URL(`/console/inbox?namespace_id=${encodeURIComponent(namespaceId)}`, request.url));
}
