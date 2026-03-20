import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { formValue, postRuntimeJson } from "@/lib/operator-server";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const title = formValue(formData, "title");

  if (!title) {
    return NextResponse.redirect(new URL("/sessions/new?status=error&message=Session%20title%20is%20required", request.url), 303);
  }

  try {
    const response = await postRuntimeJson<{ readonly session: { readonly id: string } }>("/ops/sessions", {
      title,
      notes: formValue(formData, "notes") ?? null,
      namespace_id: formValue(formData, "namespace_id") ?? "personal",
      tags: (formValue(formData, "tags") ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      default_asr_model: formValue(formData, "default_asr_model") ?? null,
      default_llm_model: formValue(formData, "default_llm_model") ?? null,
      default_llm_preset: formValue(formData, "default_llm_preset") ?? null
    });

    return NextResponse.redirect(new URL(`/sessions/${response.session.id}/intake?status=ok`, request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(new URL(`/sessions/new?status=error&message=${encodeURIComponent(message)}`, request.url), 303);
  }
}
