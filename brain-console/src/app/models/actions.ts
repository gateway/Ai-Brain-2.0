"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { loadModelRuntimeModel, unloadModelRuntimeModel } from "@/lib/model-runtime";

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function redirectWithStatus(status: "ok" | "error", message: string): never {
  redirect(`/models?status=${encodeURIComponent(status)}&message=${encodeURIComponent(message)}`);
}

export async function loadModelAction(formData: FormData): Promise<void> {
  const family = readString(formData, "family");
  const model = readString(formData, "model");
  const rawContextLength = readString(formData, "context_length");
  const parsedContextLength = rawContextLength ? Number(rawContextLength) : undefined;

  if (!family || !model) {
    redirectWithStatus("error", "Family and model are required.");
  }

  try {
    await loadModelRuntimeModel({
      family,
      model,
      contextLength: parsedContextLength && Number.isFinite(parsedContextLength) ? parsedContextLength : undefined
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model load failed.";
    redirectWithStatus("error", message);
  }

  revalidatePath("/models");
  redirectWithStatus("ok", `Load requested for ${model}.`);
}

export async function unloadModelAction(formData: FormData): Promise<void> {
  const family = readString(formData, "family");
  const model = readString(formData, "model") || undefined;

  if (!family) {
    redirectWithStatus("error", "Family is required.");
  }

  try {
    await unloadModelRuntimeModel({ family, model });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model unload failed.";
    redirectWithStatus("error", message);
  }

  revalidatePath("/models");
  redirectWithStatus("ok", `Unload requested for ${model ?? family}.`);
}
