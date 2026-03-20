import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { formValue, postRuntimeJson, redirectToSession } from "@/lib/operator-server";

export async function POST(
  request: NextRequest,
  { params }: { readonly params: Promise<{ readonly sessionId: string }> }
) {
  const { sessionId } = await params;
  const formData = await request.formData();
  const text = formValue(formData, "text");

  if (!text) {
    return NextResponse.redirect(redirectToSession(request, sessionId, "intake", "error", "Text is required."), 303);
  }

  try {
    const runClassification = formData.get("run_classification") === "on";

    await postRuntimeJson(`/ops/sessions/${sessionId}/intake/text`, {
      label: formValue(formData, "label") ?? null,
      text,
      run_classification: runClassification,
      classification: {
        provider: formValue(formData, "classification_provider") ?? null,
        model: formValue(formData, "classification_model") ?? null,
        preset_id: formValue(formData, "classification_preset") ?? null,
        max_output_tokens: (() => {
          const value = formValue(formData, "classification_max_tokens");
          if (!value) {
            return null;
          }
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        })()
      }
    });

    return NextResponse.redirect(redirectToSession(request, sessionId, runClassification ? "review" : "overview", "ok"), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(redirectToSession(request, sessionId, "intake", "error", message), 303);
  }
}
