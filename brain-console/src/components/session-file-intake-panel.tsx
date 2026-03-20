"use client";

import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkbenchModelProvider } from "@/lib/operator-workbench";

const providerSelectClassName =
  "h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0";

type RecorderState = "idle" | "requesting" | "recording";
type AttachmentSource = "upload" | "recording";

interface PresetChoice {
  readonly presetId: string;
  readonly displayName: string;
}

interface SessionFileIntakePanelProps {
  readonly sessionId: string;
  readonly defaultAsrModel?: string;
  readonly defaultLlmProvider?: WorkbenchModelProvider;
  readonly defaultLlmModel?: string;
  readonly defaultLlmPreset?: string;
  readonly asrModels: readonly string[];
  readonly llmModels: readonly string[];
  readonly presets: readonly PresetChoice[];
}

interface AttachmentEntry {
  readonly key: string;
  readonly file: File;
  readonly source: AttachmentSource;
}

function attachmentKey(file: File, source: AttachmentSource): string {
  return `${source}:${file.name}:${file.size}:${file.lastModified}`;
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("ogg")) {
    return ".ogg";
  }
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) {
    return ".m4a";
  }
  if (mimeType.includes("wav")) {
    return ".wav";
  }
  return ".webm";
}

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4"
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function AudioWaveformPreview({ file }: { readonly file: File }) {
  const [objectUrl, setObjectUrl] = useState<string>();
  const [bars, setBars] = useState<readonly number[]>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    let cancelled = false;

    async function decodeWaveform() {
      try {
        const AudioContextClass =
          window.AudioContext ||
          (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

        if (!AudioContextClass) {
          throw new Error("AudioContext is unavailable.");
        }

        const context = new AudioContextClass();
        try {
          const buffer = await file.arrayBuffer();
          const audioBuffer = await context.decodeAudioData(buffer.slice(0));
          const channel = audioBuffer.getChannelData(0);
          const sampleCount = 72;
          const blockSize = Math.max(1, Math.floor(channel.length / sampleCount));
          const nextBars = Array.from({ length: sampleCount }, (_, index) => {
            let peak = 0;
            const start = index * blockSize;
            const end = Math.min(channel.length, start + blockSize);
            for (let cursor = start; cursor < end; cursor += 1) {
              peak = Math.max(peak, Math.abs(channel[cursor] ?? 0));
            }
            return Math.max(0.08, Math.min(1, peak));
          });

          if (!cancelled) {
            setBars(nextBars);
            setStatus("ready");
          }
        } finally {
          void context.close();
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    }

    setStatus("loading");
    void decodeWaveform();

    return () => {
      cancelled = true;
    };
  }, [file]);

  return (
    <div className="rounded-[18px] border border-white/8 bg-black/15 p-3">
      <div className="flex h-20 items-end gap-1 rounded-[14px] border border-white/6 bg-[linear-gradient(180deg,_rgba(20,28,38,0.75)_0%,_rgba(7,10,16,0.92)_100%)] px-3 py-2">
        {status === "ready" && bars ? (
          bars.map((bar, index) => (
            <span
              key={`${file.name}:${index}`}
              className="flex-1 rounded-full bg-teal-300/70"
              style={{ height: `${Math.round(bar * 100)}%` }}
            />
          ))
        ) : (
          <p className="text-xs text-slate-400">
            {status === "loading" ? "Preparing waveform..." : "Waveform preview unavailable for this audio."}
          </p>
        )}
      </div>
      {objectUrl ? <audio controls src={objectUrl} className="mt-3 w-full" /> : null}
    </div>
  );
}

export function SessionFileIntakePanel({
  sessionId,
  defaultAsrModel,
  defaultLlmProvider,
  defaultLlmModel,
  defaultLlmPreset,
  asrModels,
  llmModels,
  presets
}: SessionFileIntakePanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const uploadedFilesRef = useRef<File[]>([]);
  const recordedFilesRef = useRef<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [recordedFiles, setRecordedFiles] = useState<File[]>([]);
  const [recorderState, setRecorderState] = useState<RecorderState>("idle");
  const [recorderError, setRecorderError] = useState<string>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const attachmentEntries: readonly AttachmentEntry[] = [
    ...uploadedFiles.map((file) => ({ key: attachmentKey(file, "upload"), file, source: "upload" as const })),
    ...recordedFiles.map((file) => ({ key: attachmentKey(file, "recording"), file, source: "recording" as const }))
  ];

  useEffect(() => {
    if (recorderState !== "recording") {
      return;
    }

    const interval = window.setInterval(() => {
      setElapsedSeconds((value) => value + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [recorderState]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function syncInputFiles(nextUploaded: readonly File[], nextRecorded: readonly File[]) {
    uploadedFilesRef.current = [...nextUploaded];
    recordedFilesRef.current = [...nextRecorded];
    setUploadedFiles([...nextUploaded]);
    setRecordedFiles([...nextRecorded]);

    const input = fileInputRef.current;
    if (!input) {
      return;
    }

    const transfer = new DataTransfer();
    for (const file of [...nextUploaded, ...nextRecorded]) {
      transfer.items.add(file);
    }
    input.files = transfer.files;
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const nextUploaded = Array.from(event.target.files ?? []);
    syncInputFiles(nextUploaded, recordedFilesRef.current);
  }

  function removeAttachment(entry: AttachmentEntry) {
    if (entry.source === "recording") {
      syncInputFiles(
        uploadedFilesRef.current,
        recordedFilesRef.current.filter((file) => attachmentKey(file, "recording") !== entry.key)
      );
      return;
    }

    syncInputFiles(
      uploadedFilesRef.current.filter((file) => attachmentKey(file, "upload") !== entry.key),
      recordedFilesRef.current
    );
  }

  async function startRecording() {
    setRecorderError(undefined);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecorderError("This browser does not expose microphone capture.");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setRecorderError("MediaRecorder is not available in this browser.");
      return;
    }

    setRecorderState("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType();
      const chunks: BlobPart[] = [];
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        const nextMimeType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunks, { type: nextMimeType });
        const file = new File(
          [blob],
          `microphone-${new Date().toISOString().replace(/[:.]/g, "-")}${extensionForMimeType(nextMimeType)}`,
          {
            type: nextMimeType,
            lastModified: Date.now()
          }
        );

        syncInputFiles(uploadedFilesRef.current, [...recordedFilesRef.current, file]);
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setElapsedSeconds(0);
        setRecorderState("idle");
      };

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      setElapsedSeconds(0);
      recorder.start(250);
      setRecorderState("recording");
    } catch (error) {
      setElapsedSeconds(0);
      setRecorderState("idle");
      setRecorderError(error instanceof Error ? error.message : String(error));
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }

  return (
    <form
      action={`/api/operator/sessions/${sessionId}/intake/files`}
      method="post"
      encType="multipart/form-data"
      className="grid gap-4"
      onSubmit={() => setIsSubmitting(true)}
    >
      <input ref={fileInputRef} type="file" name="files" multiple required={attachmentEntries.length === 0} onChange={handleFileSelection} className="sr-only" />

      <div className="rounded-[22px] border border-dashed border-white/16 bg-white/4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="border-white/12 bg-black/15 text-white hover:bg-black/25"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload />
            Choose files
          </Button>

          {recorderState === "recording" ? (
            <Button
              type="button"
              variant="destructive"
              className="border-rose-300/30 bg-rose-300/12 text-rose-50 hover:bg-rose-300/20"
              onClick={stopRecording}
            >
              <Square />
              Stop recording
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="border-teal-300/20 bg-teal-300/10 text-teal-50 hover:bg-teal-300/18"
              onClick={startRecording}
              disabled={recorderState === "requesting"}
            >
              <Mic />
              {recorderState === "requesting" ? "Requesting mic..." : "Record from microphone"}
            </Button>
          )}

          {recorderState === "recording" ? (
            <span className="rounded-full border border-rose-300/25 bg-rose-300/12 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-rose-50">
              Recording {elapsedSeconds}s
            </span>
          ) : null}
        </div>

        <p className="mt-3 text-sm leading-7 text-slate-300">
          Use this area when the source starts as audio or a file. Record microphone notes, upload audio, or add mixed files. Audio previews show a waveform and player before upload so the operator can verify the evidence.
        </p>

        <div className="mt-3 rounded-[16px] border border-white/10 bg-black/15 px-3 py-2 text-sm leading-7 text-slate-300">
          Upload validation is enforced on the server. Allowed types are <code className="rounded bg-white/8 px-1.5 py-0.5 text-xs">.txt</code>, <code className="rounded bg-white/8 px-1.5 py-0.5 text-xs">.md</code>, common audio formats, <code className="rounded bg-white/8 px-1.5 py-0.5 text-xs">.pdf</code>, and common images.
          PDF and image uploads are stored now, but OCR and vision extraction still require an adapter before derived text appears.
        </div>

        {recorderError ? (
          <p className="mt-3 rounded-[16px] border border-rose-300/20 bg-rose-300/10 px-3 py-2 text-sm text-rose-100">{recorderError}</p>
        ) : null}
      </div>

      {attachmentEntries.length > 0 ? (
        <div className="grid gap-3">
          {attachmentEntries.map((entry) => (
            <div key={entry.key} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">{entry.file.name}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">
                    {entry.source === "recording" ? "microphone capture" : "selected file"} · {formatBytes(entry.file.size)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-slate-300 hover:text-white"
                  onClick={() => removeAttachment(entry)}
                >
                  <X />
                  Remove
                </Button>
              </div>

              {entry.file.type.startsWith("audio/") ? (
                <div className="mt-3">
                  <AudioWaveformPreview file={entry.file} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-[18px] border border-white/8 bg-black/15 px-4 py-3 text-sm text-slate-400">
          No files selected yet. Choose files or record a microphone note to build the upload batch.
        </p>
      )}

      <label className="flex items-center gap-3 rounded-[20px] border border-white/10 bg-white/6 px-4 py-3 text-sm text-slate-100">
        <input type="checkbox" name="run_asr" value="true" defaultChecked className="size-4 rounded border-white/20 bg-transparent" />
        Run ASR for audio files
      </label>

      <label className="flex items-center gap-3 rounded-[20px] border border-white/10 bg-white/6 px-4 py-3 text-sm text-slate-100">
        <input type="checkbox" name="run_classification" value="true" defaultChecked className="size-4 rounded border-white/20 bg-transparent" />
        Run LLM classification for text files and transcripts
      </label>

      <details className="group rounded-[20px] border border-white/8 bg-black/15 p-4">
        <summary className="cursor-pointer list-none">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-white">Advanced model options</p>
              <p className="text-xs leading-6 text-slate-400">Only change these when you want this upload batch to override the session defaults.</p>
            </div>
            <span className="text-xs uppercase tracking-[0.2em] text-slate-400 transition group-open:text-amber-100">Expand</span>
          </div>
        </summary>

        <div className="mt-4 grid gap-4 border-t border-white/8 pt-4 md:grid-cols-3">
          <label className="grid gap-2">
            <span className="text-sm font-medium text-slate-100">ASR model override</span>
            <Input
              name="asr_model_id"
              list="session-asr-model-options"
              placeholder={defaultAsrModel ?? "Leave blank to use the session default"}
            />
          </label>
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
              list="session-llm-model-options"
              placeholder={defaultLlmModel ?? "Leave blank to use the session default"}
            />
          </label>
          <label className="grid gap-2">
            <span className="text-sm font-medium text-slate-100">Preset</span>
            <select name="classification_preset_id" defaultValue="" className={providerSelectClassName}>
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

      {asrModels.length > 0 ? (
        <datalist id="session-asr-model-options">
          {asrModels.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ) : null}

      {llmModels.length > 0 ? (
        <datalist id="session-llm-model-options">
          {llmModels.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ) : null}

      <Button
        type="submit"
        variant="outline"
        className="w-fit rounded-2xl border border-teal-400/25 bg-teal-400/12 px-5 py-2.5 text-sm font-medium text-teal-50 hover:border-teal-400/35 hover:bg-teal-400/16"
        disabled={attachmentEntries.length === 0 || recorderState === "requesting" || isSubmitting}
      >
        {isSubmitting ? <Loader2 className="animate-spin" /> : null}
        {isSubmitting ? "Uploading and waiting on runtime..." : "Upload batch"}
      </Button>
      {isSubmitting ? (
        <p className="text-sm text-slate-400">Large audio or LLM classification runs may take time while the local model loads and processes the batch.</p>
      ) : null}
    </form>
  );
}
