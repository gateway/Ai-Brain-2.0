import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";

const runtimeBaseUrl = process.env.BRAIN_RUNTIME_BASE_URL ?? "http://127.0.0.1:8787";
const uploadRoot = path.resolve(process.cwd(), "../artifacts/operator-workbench/uploads");

const ALLOWED_EXTENSIONS = {
  text: new Set([".txt", ".md", ".markdown"]),
  audio: new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".webm", ".mp4"]),
  pdf: new Set([".pdf"]),
  image: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic"])
} as const;

const MAX_UPLOAD_BYTES = {
  text: 5 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  image: 20 * 1024 * 1024
} as const;

function sanitizeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "file";
}

function extensionOf(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/octet-stream";
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function hasIsoBoxBrand(bytes: Uint8Array, brands: readonly string[]): boolean {
  if (bytes.length < 12) {
    return false;
  }
  const brand = Buffer.from(bytes.slice(8, 12)).toString("ascii").toLowerCase();
  return brands.includes(brand);
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46]);
}

function looksLikeImage(bytes: Uint8Array, extension: string): boolean {
  if (extension === ".png") {
    return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
  }
  if (extension === ".gif") {
    return startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38]);
  }
  if (extension === ".webp") {
    return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WEBP";
  }
  if (extension === ".heic") {
    return hasIsoBoxBrand(bytes, ["heic", "heix", "hevc", "hevx", "mif1"]);
  }
  return false;
}

function looksLikeAudio(bytes: Uint8Array, extension: string): boolean {
  if (extension === ".wav") {
    return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WAVE";
  }
  if (extension === ".ogg") {
    return startsWithBytes(bytes, [0x4f, 0x67, 0x67, 0x53]);
  }
  if (extension === ".mp3") {
    return startsWithBytes(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }
  if (extension === ".webm") {
    return startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  }
  if (extension === ".m4a" || extension === ".mp4" || extension === ".aac") {
    return hasIsoBoxBrand(bytes, ["isom", "mp41", "mp42", "m4a ", "M4A ", "M4B ", "qt  "]);
  }
  return true;
}

async function fileSignatureMatches(sourceType: "text" | "audio" | "pdf" | "image", extension: string, file: File): Promise<boolean> {
  if (sourceType === "text") {
    return true;
  }

  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (sourceType === "pdf") {
    return looksLikePdf(bytes);
  }
  if (sourceType === "image") {
    return looksLikeImage(bytes, extension);
  }
  return looksLikeAudio(bytes, extension);
}

export async function validateUploadFile(file: File): Promise<{ readonly sourceType: "text" | "audio" | "pdf" | "image"; readonly normalizedName: string }> {
  const normalizedName = file.name.trim();
  if (!normalizedName) {
    throw new Error("Uploaded files must have a valid name.");
  }

  if (normalizedName !== path.basename(normalizedName)) {
    throw new Error(`Invalid file name: ${normalizedName}`);
  }

  const extension = extensionOf(normalizedName);
  const mimeType = file.type.trim().toLowerCase();
  const sourceType = inferSourceType(normalizedName, mimeType);

  if (!ALLOWED_EXTENSIONS[sourceType].has(extension)) {
    throw new Error(
      `Unsupported file type for ${normalizedName}. Allowed uploads are text (.txt, .md), audio (.mp3, .wav, .m4a, .aac, .ogg, .webm), PDF, and common images.`
    );
  }

  if (file.size <= 0) {
    throw new Error(`${normalizedName} is empty.`);
  }

  if (file.size > MAX_UPLOAD_BYTES[sourceType]) {
    const maxMb = Math.round(MAX_UPLOAD_BYTES[sourceType] / (1024 * 1024));
    throw new Error(`${normalizedName} exceeds the ${maxMb} MB limit for ${sourceType} uploads.`);
  }

  if (mimeType) {
    const mimeMatches =
      (sourceType === "audio" && mimeType.startsWith("audio/")) ||
      (sourceType === "image" && mimeType.startsWith("image/")) ||
      (sourceType === "pdf" && mimeType === "application/pdf") ||
      (sourceType === "text" && isTextMimeType(mimeType));

    if (!mimeMatches) {
      throw new Error(`${normalizedName} has a file type mismatch between its extension and reported media type.`);
    }
  }

  if (!(await fileSignatureMatches(sourceType, extension, file))) {
    throw new Error(`${normalizedName} does not match the expected file signature for a ${sourceType} upload.`);
  }

  return {
    sourceType,
    normalizedName
  };
}

export async function postRuntimeJson<T>(pathname: string, body: unknown): Promise<T> {
  const response = await fetch(new URL(pathname, runtimeBaseUrl), {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${pathname} returned ${response.status}: ${errorText.slice(0, 500)}`);
  }

  return (await response.json()) as T;
}

export async function saveUploadFile(sessionId: string, file: File): Promise<string> {
  const ext = path.extname(file.name);
  const baseName = sanitizeFileComponent(path.basename(file.name, ext));
  const targetDir = path.resolve(uploadRoot, sessionId);
  await mkdir(targetDir, { recursive: true });
  const targetPath = path.resolve(targetDir, `${baseName}-${randomUUID()}${ext}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(targetPath, buffer);
  return targetPath;
}

export function inferSourceType(fileName: string, mimeType: string): "text" | "audio" | "pdf" | "image" {
  const extension = extensionOf(fileName);

  if (mimeType.startsWith("audio/") || ALLOWED_EXTENSIONS.audio.has(extension)) {
    return "audio";
  }

  if (mimeType.startsWith("image/") || ALLOWED_EXTENSIONS.image.has(extension)) {
    return "image";
  }

  if (mimeType === "application/pdf" || ALLOWED_EXTENSIONS.pdf.has(extension)) {
    return "pdf";
  }

  return "text";
}

export function formValue(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function redirectToSession(
  request: NextRequest,
  sessionId: string,
  section: "overview" | "intake" | "review",
  status: "ok" | "error",
  message?: string
) {
  const redirectUrl = new URL(`/sessions/${sessionId}/${section}`, request.url);
  redirectUrl.searchParams.set("status", status);
  if (message) {
    redirectUrl.searchParams.set("message", message);
  }
  return redirectUrl;
}
