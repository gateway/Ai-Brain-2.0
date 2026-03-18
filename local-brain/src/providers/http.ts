import { ProviderError, type ProviderErrorCode, type ProviderId } from "./types.js";

export interface JsonHttpOptions {
  readonly method?: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface JsonHttpResult<T> {
  readonly status: number;
  readonly data: T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function postJson<T>(
  provider: ProviderId,
  url: string,
  options: JsonHttpOptions
): Promise<JsonHttpResult<T>> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });

    const text = await response.text();
    let parsed: unknown = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { raw: text };
      }
    }

    if (!response.ok) {
      const bodyMessage =
        isObject(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === "string"
            ? parsed.error.message
            : isObject(parsed) && typeof parsed.message === "string"
              ? parsed.message
              : `HTTP ${response.status}`;

      throw new ProviderError({
        message: `Provider HTTP error: ${bodyMessage}`,
        code: toErrorCode(response.status),
        provider,
        statusCode: response.status,
        retryable: response.status === 429 || response.status >= 500
      });
    }

    return {
      status: response.status,
      data: parsed as T
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ProviderError({
        message: `Provider timeout after ${timeoutMs}ms`,
        code: "PROVIDER_TIMEOUT",
        provider,
        retryable: true
      });
    }

    throw new ProviderError({
      message: error instanceof Error ? error.message : "Provider request failed",
      code: "PROVIDER_UNAVAILABLE",
      provider,
      retryable: true
    });
  } finally {
    clearTimeout(timer);
  }
}

function toErrorCode(statusCode: number): ProviderErrorCode {
  if (statusCode === 400 || statusCode === 422) {
    return "PROVIDER_INVALID_REQUEST";
  }
  if (statusCode === 401 || statusCode === 403) {
    return "PROVIDER_AUTH";
  }
  if (statusCode === 429) {
    return "PROVIDER_RATE_LIMIT";
  }
  if (statusCode >= 500) {
    return "PROVIDER_UNAVAILABLE";
  }
  return "PROVIDER_UNKNOWN";
}
