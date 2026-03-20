"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WorkbenchModelProvider } from "@/lib/operator-workbench";

const providerSelectClassName =
  "h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0";

interface PresetChoice {
  readonly presetId: string;
  readonly displayName: string;
}

interface OwnerNarrativeFormProps {
  readonly sessionId: string;
  readonly defaultLlmProvider?: WorkbenchModelProvider;
  readonly defaultLlmModel?: string;
  readonly defaultLlmPreset?: string;
  readonly defaultRunClassification?: boolean;
  readonly llmModels: readonly string[];
  readonly presets: readonly PresetChoice[];
}

export function OwnerNarrativeForm({
  sessionId,
  defaultLlmProvider,
  defaultLlmModel,
  defaultLlmPreset,
  defaultRunClassification = true,
  llmModels,
  presets
}: OwnerNarrativeFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const llmModelOptionsId = `bootstrap-owner-${sessionId}-llm-models`;

  return (
    <form
      action={`/api/operator/sessions/${sessionId}/intake/text`}
      method="post"
      encType="multipart/form-data"
      className="grid gap-4"
      onSubmit={() => setIsSubmitting(true)}
    >
      <div className="rounded-[20px] border border-white/10 bg-white/4 p-4 text-sm leading-7 text-slate-300">
        Good owner-bootstrap evidence includes names, places, relationships, current work, ongoing projects, and stable preferences. Classification is optional, but provenance is not.
      </div>

      <label className="grid gap-2 md:max-w-sm">
        <span className="text-sm font-medium text-slate-100">Label</span>
        <Input name="label" placeholder="Steve owner profile" />
      </label>

      <label className="grid gap-2">
        <span className="text-sm font-medium text-slate-100">About me text</span>
        <Textarea
          name="text"
          rows={14}
          required
          placeholder="Example: I am Steve Tietze. I spend time between Thailand and project work. Important people in my life include..."
        />
      </label>

      <label className="flex items-center gap-3 rounded-[20px] border border-white/10 bg-white/6 px-4 py-3 text-sm text-slate-100">
        <input type="checkbox" name="run_classification" defaultChecked={defaultRunClassification} className="size-4 rounded border-white/20 bg-transparent" />
        Run LLM classification after ingest
      </label>

      <details className="group rounded-[20px] border border-white/8 bg-black/15 p-4">
        <summary className="cursor-pointer list-none">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-white">Advanced model options</p>
              <p className="text-xs leading-6 text-slate-400">Only change these when this run should override the session defaults.</p>
            </div>
            <span className="text-xs uppercase tracking-[0.2em] text-slate-400 transition group-open:text-amber-100">Expand</span>
          </div>
        </summary>

        <div className="mt-4 grid gap-4 border-t border-white/8 pt-4 md:grid-cols-3">
          <label className="grid gap-2">
            <span className="text-sm font-medium text-slate-100">Classification provider</span>
            <select name="classification_provider" defaultValue={defaultLlmProvider ?? "external"} className={providerSelectClassName}>
              <option value="external">Local runtime</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-slate-100">LLM model override</span>
            <Input
              name="classification_model"
              list={llmModelOptionsId}
              placeholder={defaultLlmModel ?? "Leave blank to use the session default"}
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-slate-100">Preset</span>
            <select name="classification_preset" defaultValue="" className={providerSelectClassName}>
              <option value="">Use session default ({defaultLlmPreset ?? "research-analyst"})</option>
              {presets.map((preset) => (
                <option key={preset.presetId} value={preset.presetId}>
                  {preset.displayName} ({preset.presetId})
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 md:max-w-sm">
            <span className="text-sm font-medium text-slate-100">Max output tokens</span>
            <Input name="classification_max_tokens" defaultValue="4096" placeholder="4096" />
          </label>
        </div>
      </details>

      {llmModels.length > 0 ? (
        <datalist id={llmModelOptionsId}>
          {llmModels.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="inline-flex w-fit items-center gap-2 rounded-2xl border border-amber-300/25 bg-amber-300/12 px-5 py-2.5 text-sm font-medium text-amber-50 hover:border-amber-300/35 hover:bg-amber-300/16 disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isSubmitting}
        >
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {isSubmitting ? "Ingesting and waiting on model..." : "Ingest owner narrative"}
        </button>
        {isSubmitting ? (
          <p className="text-sm text-slate-400">Local models may need time to load and classify. Keep this page open while the request completes.</p>
        ) : null}
      </div>
    </form>
  );
}
