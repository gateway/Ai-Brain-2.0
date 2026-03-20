import { NextResponse } from "next/server";
import { getRuntimeBaseUrl } from "@/lib/brain-runtime";

export async function POST(request: Request) {
  const formData = await request.formData();
  const namespaceId = String(formData.get("namespace_id") ?? "");
  const aliasesCsv = String(formData.get("aliases_csv") ?? "");
  const aliases = aliasesCsv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const preserveAliases = formData.get("preserve_aliases") === "on";

  await fetch(new URL("/ops/entities/merge", getRuntimeBaseUrl()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      namespace_id: namespaceId,
      source_entity_id: String(formData.get("source_entity_id") ?? ""),
      target_entity_id: String(formData.get("target_entity_id") ?? ""),
      canonical_name: String(formData.get("canonical_name") ?? ""),
      entity_type: String(formData.get("entity_type") ?? ""),
      aliases,
      preserve_aliases: preserveAliases,
      note: String(formData.get("note") ?? "")
    }),
    cache: "no-store"
  });

  return NextResponse.redirect(new URL(`/console/inbox?namespace_id=${encodeURIComponent(namespaceId)}`, request.url));
}
