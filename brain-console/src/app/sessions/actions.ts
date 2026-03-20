"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createWorkbenchSession, submitWorkbenchTextIntake, type WorkbenchModelProvider } from "@/lib/operator-workbench";

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readProvider(formData: FormData, key: string): WorkbenchModelProvider | undefined {
  const value = readString(formData, key);
  return value === "external" || value === "openrouter" || value === "gemini" ? value : undefined;
}

export async function createSessionAction(formData: FormData): Promise<void> {
  const tags = readString(formData, "tags")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const session = await createWorkbenchSession({
    title: readString(formData, "title"),
    namespaceId: readString(formData, "namespace_id") || "personal",
    notes: readString(formData, "notes") || undefined,
    tags,
    defaultLlmProvider: readProvider(formData, "default_llm_provider"),
    defaultLlmModel: readString(formData, "default_llm_model") || undefined,
    defaultLlmPreset: readString(formData, "default_llm_preset") || undefined,
    defaultAsrModel: readString(formData, "default_asr_model") || undefined,
    defaultEmbeddingProvider: readProvider(formData, "default_embedding_provider"),
    defaultEmbeddingModel: readString(formData, "default_embedding_model") || undefined
  });

  revalidatePath("/");
  revalidatePath("/sessions");
  redirect(`/sessions/${session.id}/intake`);
}

export async function submitTextIntakeAction(formData: FormData): Promise<void> {
  const sessionId = readString(formData, "session_id");
  const runClassification = formData.get("run_classification") === "on";

  await submitWorkbenchTextIntake({
    sessionId,
    label: readString(formData, "label") || undefined,
    text: readString(formData, "text"),
    runClassification,
    provider: readProvider(formData, "classification_provider"),
    model: readString(formData, "classification_model") || undefined,
    presetId: readString(formData, "classification_preset") || undefined,
    maxOutputTokens: (() => {
      const raw = readString(formData, "classification_max_tokens");
      if (!raw) {
        return undefined;
      }
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    })()
  });

  revalidatePath("/");
  revalidatePath("/sessions");
  revalidatePath(`/sessions/${sessionId}/overview`);
  revalidatePath(`/sessions/${sessionId}/review`);
  redirect(runClassification ? `/sessions/${sessionId}/review` : `/sessions/${sessionId}/overview`);
}
