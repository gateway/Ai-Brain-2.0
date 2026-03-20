import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { formValue, postRuntimeJson, redirectToSession, saveUploadFile, validateUploadFile } from "@/lib/operator-server";

export async function POST(
  request: NextRequest,
  { params }: { readonly params: Promise<{ readonly sessionId: string }> }
) {
  const { sessionId } = await params;
  const formData = await request.formData();
  const files = formData.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);

  if (files.length === 0) {
    return NextResponse.redirect(redirectToSession(request, sessionId, "intake", "error", "At least one file is required."), 303);
  }

    try {
      for (const file of files) {
      const validated = await validateUploadFile(file);
      const savedPath = await saveUploadFile(sessionId, file);

      await postRuntimeJson(`/ops/sessions/${sessionId}/intake/file`, {
        input_uri: savedPath,
        source_type: validated.sourceType,
        label: validated.normalizedName,
        file_name: validated.normalizedName,
        mime_type: file.type || null,
        byte_size: file.size,
        run_asr: formData.get("run_asr") === "true",
        run_classification: formData.get("run_classification") === "true",
        asr: {
          model_id: formValue(formData, "asr_model_id") ?? null
        },
        classification: {
          provider: formValue(formData, "classification_provider") ?? null,
          model: formValue(formData, "classification_model") ?? null,
          preset_id: formValue(formData, "classification_preset_id") ?? null
          ,
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
    }

    return NextResponse.redirect(redirectToSession(request, sessionId, "overview", "ok"), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(redirectToSession(request, sessionId, "intake", "error", message), 303);
  }
}
