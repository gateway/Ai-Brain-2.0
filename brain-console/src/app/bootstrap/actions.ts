"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  type BootstrapMetadata,
  type BrainPurposeMode,
  createWorkbenchSession,
  createWorkbenchSource,
  deleteWorkbenchSource,
  getBootstrapState,
  getWorkbenchSelfProfile,
  getWorkbenchSession,
  getWorkbenchSessionReview,
  ignoreWorkbenchClarification,
  importWorkbenchSource,
  processWorkbenchOutbox,
  processWorkbenchSourceMonitor,
  rebuildWorkbenchNamespaceEmbeddings,
  resolveBootstrapEmbeddingSettings,
  resolveWorkbenchOperationsSettings,
  resolveWorkbenchClarification,
  runWorkbenchTemporalSummaries,
  scanWorkbenchSource,
  saveWorkbenchSelfProfile,
  testWorkbenchEmbeddings,
  updateWorkbenchBootstrapState,
  updateWorkbenchSource
} from "@/lib/operator-workbench";
import { runBootstrapSmokePack } from "@/lib/bootstrap-verification";

const PURPOSE_DEFAULTS: Record<
  BrainPurposeMode,
  {
    readonly namespaceId: string;
    readonly sourceIntent: "owner_bootstrap" | "ongoing_folder_monitor" | "historical_archive" | "project_source";
    readonly monitorEnabled: boolean;
    readonly scanSchedule: string;
    readonly ingestEmphasis: string;
    readonly verificationHints: readonly string[];
  }
> = {
  personal: {
    namespaceId: "personal",
    sourceIntent: "owner_bootstrap",
    monitorEnabled: false,
    scanSchedule: "disabled",
    ingestEmphasis: "life history, relationships, places, preferences, and durable personal context",
    verificationHints: ["home base", "important people", "preferences", "current life context"]
  },
  business: {
    namespaceId: "business",
    sourceIntent: "ongoing_folder_monitor",
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    ingestEmphasis: "projects, work relationships, product state, and active operational context",
    verificationHints: ["projects", "collaborators", "customers", "current work streams"]
  },
  creative: {
    namespaceId: "creative",
    sourceIntent: "project_source",
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    ingestEmphasis: "ideas, references, works in progress, inspirations, and creative collaborators",
    verificationHints: ["current pieces", "inspirations", "creative partners", "themes and interests"]
  },
  hybrid: {
    namespaceId: "hybrid",
    sourceIntent: "ongoing_folder_monitor",
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    ingestEmphasis: "blended life and work context with careful provenance and review",
    verificationHints: ["where I live", "friends", "projects", "preferences"]
  }
};

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(formData: FormData, key: string): boolean {
  return formData.get(key) === "on";
}

function readNumberValue(formData: FormData, key: string): number | null {
  const raw = readString(formData, key);
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function refreshBootstrapPaths(): void {
  revalidatePath("/");
  revalidatePath("/setup");
  revalidatePath("/bootstrap");
  revalidatePath("/bootstrap/purpose");
  revalidatePath("/bootstrap/owner");
  revalidatePath("/bootstrap/import");
  revalidatePath("/bootstrap/verify");
  revalidatePath("/models");
  revalidatePath("/settings");
}

export async function saveBootstrapPurposeAction(formData: FormData): Promise<void> {
  const purpose = (readString(formData, "brain_purpose") || "personal") as BrainPurposeMode;
  const purposeNotes = readString(formData, "brain_purpose_notes");
  const bootstrap = await getBootstrapState();
  const defaults = PURPOSE_DEFAULTS[purpose] ?? PURPOSE_DEFAULTS.personal;
  const metadata: BootstrapMetadata = {
    ...bootstrap.metadata,
    brainPurposeMode: purpose,
    brainPurposeNotes: purposeNotes || null,
    defaultNamespaceId: defaults.namespaceId,
    sourceDefaults: {
      intent: defaults.sourceIntent,
      monitorEnabled: defaults.monitorEnabled,
      scanSchedule: defaults.scanSchedule
    },
    ingestEmphasis: defaults.ingestEmphasis,
    verificationHints: defaults.verificationHints
  };

  await updateWorkbenchBootstrapState({
    metadata: {
      ...metadata
    }
  });

  refreshBootstrapPaths();
  redirect("/bootstrap");
}

export async function launchOwnerBootstrapAction(): Promise<void> {
  const bootstrap = await getBootstrapState();
  const existingSessionId =
    typeof bootstrap.metadata.ownerBootstrapSessionId === "string" ? bootstrap.metadata.ownerBootstrapSessionId : undefined;
  const namespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";

  if (existingSessionId) {
    redirect("/bootstrap/owner");
  }

  const session = await createWorkbenchSession({
    title: "Owner bootstrap intake",
    namespaceId,
    notes: "Protected first-run owner bootstrap session created from the onboarding flow.",
    tags: ["bootstrap", "owner-profile"]
  });

  await updateWorkbenchBootstrapState({
    metadata: {
      ...bootstrap.metadata,
      ownerBootstrapSessionId: session.id,
      ownerBootstrapStartedAt: new Date().toISOString()
    }
  });

  refreshBootstrapPaths();
  redirect("/bootstrap/owner");
}

export async function saveBootstrapSelfProfileAction(formData: FormData): Promise<void> {
  const bootstrap = await getBootstrapState();
  const namespaceId = readString(formData, "namespace_id") || bootstrap.metadata.defaultNamespaceId || "personal";
  const canonicalName = readString(formData, "canonical_name");
  const aliases = readString(formData, "aliases")
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
  const note = readString(formData, "note");

  if (!canonicalName) {
    redirect("/bootstrap/owner?error=missing-self-name");
  }

  await saveWorkbenchSelfProfile({
    namespaceId,
    canonicalName,
    aliases,
    note: note || undefined
  });

  const metadata: BootstrapMetadata = {
    ...bootstrap.metadata,
    ownerSelfProfileSavedAt: new Date().toISOString()
  };
  await updateWorkbenchBootstrapState({ metadata });
  refreshBootstrapPaths();
  redirect("/bootstrap/owner?saved=self");
}

export async function runBootstrapVerificationSmokePackAction(): Promise<void> {
  const bootstrap = await getBootstrapState();
  const namespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";
  const sessionId =
    typeof bootstrap.metadata.ownerBootstrapSessionId === "string" ? bootstrap.metadata.ownerBootstrapSessionId : undefined;
  if (!sessionId) {
    redirect("/bootstrap/owner?error=missing-session");
  }
  const [session, review, selfProfile] = await Promise.all([
    getWorkbenchSession(sessionId),
    getWorkbenchSessionReview(sessionId).catch(() => null),
    getWorkbenchSelfProfile(namespaceId)
  ]);
  const results = await runBootstrapSmokePack({
    namespaceId,
    session,
    review,
    selfProfile
  });

  const metadata: BootstrapMetadata = {
    ...bootstrap.metadata,
    verificationSmokePackRunAt: new Date().toISOString(),
    verificationPassedCount: results.filter((item) => item.pass).length,
    verificationSmokePack: results
  };

  await updateWorkbenchBootstrapState({ metadata });
  refreshBootstrapPaths();
  redirect("/bootstrap/owner?smoke=done");
}

export async function resolveOwnerClarificationAction(formData: FormData): Promise<void> {
  const namespaceId = readString(formData, "namespace_id");
  const redirectPath = readString(formData, "redirect_path") || "/bootstrap/owner";
  const candidateId = readString(formData, "candidate_id");
  const targetRole = readString(formData, "target_role");
  const canonicalName = readString(formData, "canonical_name");
  const entityType = readString(formData, "entity_type") || "person";
  const aliases = readString(formData, "aliases_csv")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const note = readString(formData, "note");

  await resolveWorkbenchClarification({
    namespaceId,
    candidateId,
    targetRole,
    canonicalName,
    entityType,
    aliases,
    note: note || undefined
  });

  refreshBootstrapPaths();
  redirect(`${redirectPath}?clarification=resolved`);
}

export async function ignoreOwnerClarificationAction(formData: FormData): Promise<void> {
  const namespaceId = readString(formData, "namespace_id");
  const redirectPath = readString(formData, "redirect_path") || "/bootstrap/owner";
  const candidateId = readString(formData, "candidate_id");
  const note = readString(formData, "note");

  await ignoreWorkbenchClarification({
    namespaceId,
    candidateId,
    note: note || undefined
  });

  refreshBootstrapPaths();
  redirect(`${redirectPath}?clarification=ignored`);
}

export async function saveOpenRouterDefaultsAction(formData: FormData): Promise<void> {
  const bootstrap = await getBootstrapState();
  const llmModel = readString(formData, "openrouter_llm_model");
  const embeddingModel = readString(formData, "openrouter_embedding_model");

  await updateWorkbenchBootstrapState({
    metadata: {
      ...bootstrap.metadata,
      preferredOpenRouterLlmModel: llmModel || null,
      preferredOpenRouterEmbeddingModel: embeddingModel || null
    }
  });

  refreshBootstrapPaths();
  redirect("/settings?saved=openrouter-defaults");
}

export async function saveSystemOperationsSettingsAction(formData: FormData): Promise<void> {
  const bootstrap = await getBootstrapState();
  const existing = resolveWorkbenchOperationsSettings(bootstrap.metadata);

  await updateWorkbenchBootstrapState({
    metadata: {
      ...bootstrap.metadata,
      operationsSettings: {
        sourceMonitor: {
          enabled: readBoolean(formData, "source_monitor_enabled"),
          workerIntervalSeconds: readNumberValue(formData, "source_monitor_interval_seconds") ?? existing.sourceMonitor.workerIntervalSeconds,
          defaultScanSchedule: readString(formData, "source_monitor_default_schedule") || existing.sourceMonitor.defaultScanSchedule,
          autoImportOnScan: readBoolean(formData, "source_monitor_auto_import")
        },
        outbox: {
          workerIntervalSeconds: readNumberValue(formData, "outbox_interval_seconds") ?? existing.outbox.workerIntervalSeconds,
          batchLimit: readNumberValue(formData, "outbox_batch_limit") ?? existing.outbox.batchLimit
        },
        temporalSummary: {
          enabled: readBoolean(formData, "temporal_summary_enabled"),
          workerIntervalSeconds: readNumberValue(formData, "temporal_summary_interval_seconds") ?? existing.temporalSummary.workerIntervalSeconds,
          lookbackDays: readNumberValue(formData, "temporal_summary_lookback_days") ?? existing.temporalSummary.lookbackDays,
          strategy:
            (readString(formData, "temporal_summary_strategy") as "deterministic" | "deterministic_plus_llm") || existing.temporalSummary.strategy,
          summarizerProvider:
            (readString(formData, "temporal_summary_provider") as "external" | "openrouter" | "gemini") || existing.temporalSummary.summarizerProvider,
          summarizerModel: readString(formData, "temporal_summary_model") || null,
          summarizerPreset: readString(formData, "temporal_summary_preset") || null,
          systemPrompt: readString(formData, "temporal_summary_system_prompt") || existing.temporalSummary.systemPrompt || null
        }
      }
    }
  });

  refreshBootstrapPaths();
  redirect("/settings?saved=operations-settings");
}

export async function processSourceMonitorNowAction(formData: FormData): Promise<void> {
  const sourceId = readString(formData, "source_id");
  const scanOnly = readBoolean(formData, "scan_only");

  try {
    const result = await processWorkbenchSourceMonitor({
      sourceId: sourceId || undefined,
      scanOnly
    });
    refreshBootstrapPaths();
    redirect(`/settings?monitor=success&monitor_checked=${encodeURIComponent(result.checkedAt)}&monitor_processed=${result.processedCount}&monitor_due=${result.dueSourceCount}`);
  } catch (error) {
    redirect(`/settings?monitor=failed&monitor_reason=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
}

export async function processOutboxNowAction(formData: FormData): Promise<void> {
  const namespaceId = readString(formData, "namespace_id");
  const limit = readNumberValue(formData, "outbox_batch_limit");

  try {
    const result = await processWorkbenchOutbox({
      namespaceId: namespaceId || undefined,
      limit: limit ?? undefined
    });
    refreshBootstrapPaths();
    redirect(`/settings?outbox=success&outbox_processed=${result.processed}&outbox_failed=${result.failed}&outbox_scanned=${result.scanned}`);
  } catch (error) {
    redirect(`/settings?outbox=failed&outbox_reason=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
}

export async function runTemporalSummariesNowAction(formData: FormData): Promise<void> {
  const namespaceId = readString(formData, "namespace_id");
  const lookbackDays = readNumberValue(formData, "temporal_summary_lookback_days");
  const bootstrap = await getBootstrapState();
  const operations = resolveWorkbenchOperationsSettings(bootstrap.metadata);

  try {
    const result = await runWorkbenchTemporalSummaries({
      namespaceId,
      lookbackDays: lookbackDays ?? undefined,
      strategy: operations.temporalSummary.strategy,
      provider: operations.temporalSummary.summarizerProvider,
      model: operations.temporalSummary.summarizerModel ?? undefined,
      presetId: operations.temporalSummary.summarizerPreset ?? undefined,
      systemPrompt: operations.temporalSummary.systemPrompt ?? undefined
    });
    const upserted = result.summaries.reduce((sum, item) => sum + item.upsertedNodes, 0);
    refreshBootstrapPaths();
    redirect(`/settings?temporal=success&temporal_layers=${result.summaries.length}&temporal_upserted=${upserted}&temporal_semantic=${result.semanticOverlayUpdatedNodes}`);
  } catch (error) {
    redirect(`/settings?temporal=failed&temporal_reason=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
}

export async function saveEmbeddingSettingsAction(formData: FormData): Promise<void> {
  const bootstrap = await getBootstrapState();
  const existing = resolveBootstrapEmbeddingSettings(bootstrap.metadata);
  const provider = (readString(formData, "embedding_provider") || existing.provider) as "none" | "external" | "openrouter" | "gemini";
  const model = readString(formData, "embedding_model");
  const dimensions = readNumberValue(formData, "embedding_dimensions");
  const instruction = readString(formData, "embedding_instruction");
  const normalize = readBoolean(formData, "embedding_normalize");

  await updateWorkbenchBootstrapState({
    metadata: {
      ...bootstrap.metadata,
      embeddingSettings: {
        provider,
        model: model || null,
        dimensions,
        normalize,
        instruction: instruction || null
      }
    }
  });

  refreshBootstrapPaths();
  redirect("/settings?saved=embedding-settings");
}

export async function testEmbeddingSettingsAction(formData: FormData): Promise<void> {
  const bootstrap = await getBootstrapState();
  const provider = (readString(formData, "embedding_provider") || "external") as "none" | "external" | "openrouter" | "gemini";
  const model = readString(formData, "embedding_model");
  const dimensions = readNumberValue(formData, "embedding_dimensions") ?? undefined;
  const instruction = readString(formData, "embedding_instruction");
  const normalize = readBoolean(formData, "embedding_normalize");
  const text = readString(formData, "embedding_test_text");

  try {
    const result = await testWorkbenchEmbeddings({
      provider,
      model: model || undefined,
      dimensions,
      instruction: instruction || undefined,
      normalize,
      text: text || undefined
    });

    await updateWorkbenchBootstrapState({
      metadata: {
        ...bootstrap.metadata,
        lastEmbeddingTest: {
          success: result.success,
          provider: result.provider,
          model: result.model ?? null,
          dimensions: result.dimensions ?? null,
          latencyMs: result.latencyMs,
          retrievalMode: result.retrievalMode,
          reason: result.fallbackReason ?? null,
          testedAt: new Date().toISOString()
        }
      }
    });

    const params = new URLSearchParams({
      test: result.success ? "success" : "failure",
      test_mode: result.retrievalMode,
      test_provider: result.provider,
      test_latency: String(result.latencyMs),
      test_model: result.model ?? "",
      test_dimensions: result.dimensions ? String(result.dimensions) : "",
      test_reason: result.fallbackReason ?? ""
    });
    redirect(`/settings?${params.toString()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "embedding-test-failed";
    await updateWorkbenchBootstrapState({
      metadata: {
        ...bootstrap.metadata,
        lastEmbeddingTest: {
          success: false,
          provider,
          model: model || null,
          dimensions: dimensions ?? null,
          reason: message,
          testedAt: new Date().toISOString()
        }
      }
    });
    redirect(`/settings?test=failure&test_reason=${encodeURIComponent(message)}`);
  }
}

export async function rebuildNamespaceEmbeddingsAction(formData: FormData): Promise<void> {
  const bootstrap = await getBootstrapState();
  const namespaceId = readString(formData, "namespace_id") || bootstrap.metadata.defaultNamespaceId || "personal";
  const provider = (readString(formData, "embedding_provider") || "external") as "none" | "external" | "openrouter" | "gemini";
  const model = readString(formData, "embedding_model");
  const dimensions = readNumberValue(formData, "embedding_dimensions") ?? undefined;
  const instruction = readString(formData, "embedding_instruction");
  const normalize = readBoolean(formData, "embedding_normalize");

  try {
    const result = await rebuildWorkbenchNamespaceEmbeddings({
      namespaceId,
      provider,
      model: model || undefined,
      dimensions,
      instruction: instruction || undefined,
      normalize
    });

    await updateWorkbenchBootstrapState({
      metadata: {
        ...bootstrap.metadata,
        lastEmbeddingRebuild: {
          success: true,
          namespaceId: result.rebuild.namespaceId,
          provider,
          model: result.rebuild.model,
          semanticQueued: result.rebuild.semanticQueued,
          derivationQueued: result.rebuild.derivationQueued,
          queuedAt: new Date().toISOString()
        }
      }
    });

    const params = new URLSearchParams({
      reembed: "queued",
      reembed_namespace: result.rebuild.namespaceId,
      reembed_provider: result.rebuild.provider,
      reembed_model: result.rebuild.model,
      reembed_semantic: String(result.rebuild.semanticQueued),
      reembed_derivations: String(result.rebuild.derivationQueued)
    });
    refreshBootstrapPaths();
    redirect(`/settings?${params.toString()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "reembed-failed";
    await updateWorkbenchBootstrapState({
      metadata: {
        ...bootstrap.metadata,
        lastEmbeddingRebuild: {
          success: false,
          namespaceId,
          provider,
          model: model || null,
          reason: message,
          queuedAt: new Date().toISOString()
        }
      }
    });
    redirect(`/settings?reembed=failed&reembed_reason=${encodeURIComponent(message)}`);
  }
}

export async function markOwnerBootstrapCompleteAction(): Promise<void> {
  const bootstrap = await getBootstrapState();
  const sessionId =
    typeof bootstrap.metadata.ownerBootstrapSessionId === "string" ? bootstrap.metadata.ownerBootstrapSessionId : undefined;
  const namespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";

  if (!sessionId) {
    redirect("/bootstrap/owner?error=missing-session");
  }

  const [selfProfile, session, review] = await Promise.all([
    getWorkbenchSelfProfile(namespaceId),
    getWorkbenchSession(sessionId),
    getWorkbenchSessionReview(sessionId).catch(() => null)
  ]);

  const hasSelfProfile = Boolean(selfProfile);
  const hasEvidence = (session.counts?.inputs ?? 0) > 0 || (session.artifacts?.length ?? 0) > 0;
  const hasReviewData = Boolean(review && (review.summary.entityCount > 0 || review.summary.relationshipCount > 0 || review.summary.claimCount > 0));
  const hasSmokePack = Array.isArray(bootstrap.metadata.verificationSmokePack) && Boolean(bootstrap.metadata.verificationSmokePackRunAt);

  if (!hasSelfProfile || !hasEvidence || !hasReviewData || !hasSmokePack) {
    const missing = [
      !hasSelfProfile ? "self-profile" : null,
      !hasEvidence ? "evidence" : null,
      !hasReviewData ? "review" : null,
      !hasSmokePack ? "smoke-pack" : null
    ]
      .filter(Boolean)
      .join(",");
    redirect(`/bootstrap/owner?error=incomplete&missing=${encodeURIComponent(missing)}`);
  }

  await updateWorkbenchBootstrapState({
    ownerProfileCompleted: true,
    metadata: {
      ...bootstrap.metadata,
      ownerBootstrapCompletedAt: new Date().toISOString()
    }
  });

  refreshBootstrapPaths();
  redirect("/bootstrap");
}

export async function saveSourceAction(formData: FormData): Promise<void> {
  const sourceId = readString(formData, "source_id");
  const intent = readString(formData, "intent") || "save";
  const nextUrlBase = readString(formData, "next_url") || "/bootstrap/import";

  const sourceInput = {
    namespaceId: readString(formData, "namespace_id") || "personal",
    label: readString(formData, "label") || undefined,
    rootPath: readString(formData, "root_path"),
    includeSubfolders: readBoolean(formData, "include_subfolders"),
    monitorEnabled: readBoolean(formData, "monitor_enabled"),
    scanSchedule: readBoolean(formData, "monitor_enabled") ? "every_30_minutes" : "disabled",
    notes: readString(formData, "notes") || undefined,
    metadata: {
      source_intent: readString(formData, "source_intent") || "ongoing_folder_monitor"
    }
  };

  const source = sourceId
    ? await updateWorkbenchSource(sourceId, sourceInput)
    : await createWorkbenchSource({
        sourceType: readString(formData, "source_type") === "openclaw" ? "openclaw" : "folder",
        ...sourceInput
      });

  if (intent === "save-scan") {
    await scanWorkbenchSource(source.id);
  }

  if (intent === "save-import") {
    await importWorkbenchSource(source.id, "onboarding");
    const bootstrap = await getBootstrapState();
    await updateWorkbenchBootstrapState({
      sourceImportCompleted: true,
      metadata: {
        ...bootstrap.metadata,
        latestImportedSourceId: source.id
      }
    });
  }

  refreshBootstrapPaths();
  redirect(`${nextUrlBase}?source=${source.id}`);
}

export async function scanSourceAction(formData: FormData): Promise<void> {
  const sourceId = readString(formData, "source_id");
  const nextUrlBase = readString(formData, "next_url") || "/bootstrap/import";
  await scanWorkbenchSource(sourceId);
  refreshBootstrapPaths();
  redirect(`${nextUrlBase}?source=${sourceId}`);
}

export async function importSourceAction(formData: FormData): Promise<void> {
  const sourceId = readString(formData, "source_id");
  const nextUrlBase = readString(formData, "next_url") || "/bootstrap/import";
  await importWorkbenchSource(sourceId, nextUrlBase.startsWith("/bootstrap") ? "onboarding" : "manual");
  const bootstrap = await getBootstrapState();
  await updateWorkbenchBootstrapState({
    sourceImportCompleted: true,
    metadata: {
      ...bootstrap.metadata,
      latestImportedSourceId: sourceId
    }
  });
  refreshBootstrapPaths();
  redirect(`${nextUrlBase}?source=${sourceId}`);
}

export async function toggleSourceMonitoringAction(formData: FormData): Promise<void> {
  const sourceId = readString(formData, "source_id");
  const enabled = readString(formData, "enabled") === "true";
  const nextUrlBase = readString(formData, "next_url") || "/bootstrap/import";
  await updateWorkbenchSource(sourceId, {
    monitorEnabled: enabled,
    scanSchedule: enabled ? "every_30_minutes" : "disabled"
  });
  refreshBootstrapPaths();
  redirect(`${nextUrlBase}?source=${sourceId}`);
}

export async function deleteSourceAction(formData: FormData): Promise<void> {
  const sourceId = readString(formData, "source_id");
  const nextUrlBase = readString(formData, "next_url") || "/bootstrap/import";
  await deleteWorkbenchSource(sourceId);
  refreshBootstrapPaths();
  redirect(nextUrlBase);
}

export async function completeVerificationAction(): Promise<void> {
  const bootstrap = await getBootstrapState();
  const hasSmokePack = Array.isArray(bootstrap.metadata.verificationSmokePack) && Boolean(bootstrap.metadata.verificationSmokePackRunAt);
  if (!hasSmokePack) {
    redirect("/bootstrap/verify?error=missing-smoke-pack");
  }
  await updateWorkbenchBootstrapState({
    verificationCompleted: true,
    metadata: {
      ...bootstrap.metadata,
      verificationCompletedAt: new Date().toISOString()
    }
  });

  refreshBootstrapPaths();
  redirect("/");
}
