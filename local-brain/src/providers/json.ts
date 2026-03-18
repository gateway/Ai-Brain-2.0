import { ProviderError, type ProviderId } from "./types.js";

function unwrapCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function parseJsonObjectText(provider: ProviderId, rawText: string): Record<string, unknown> {
  const trimmed = unwrapCodeFence(rawText);

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to first-object extraction.
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // handled below
    }
  }

  throw new ProviderError({
    provider,
    code: "PROVIDER_UNKNOWN",
    message: `Provider ${provider} returned non-JSON classification output`
  });
}
