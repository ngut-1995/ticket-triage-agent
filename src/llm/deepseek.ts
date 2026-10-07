import { errorMessage } from "../domain/errors.js";
import { LLMError, resolveModel, type LLMClient, type StructuredRequest, type StructuredResponse } from "./client.js";

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
const BASE_URL = "https://api.deepseek.com";
/** First backoff delay; doubles on each retry. */
const BACKOFF_BASE_MS = 500;
/** Upper bound for any single wait, including one asked for by `retry-after`. */
const MAX_BACKOFF_MS = 10_000;

export interface DeepSeekClientOptions {
  /** Defaults to `DEEPSEEK_API_KEY`. A missing key fails the first request, not construction. */
  apiKey?: string;
  /** Defaults to `TRIAGE_MODEL`, then `deepseek-flash`. */
  model?: string;
  /** Per attempt. */
  timeoutMs?: number;
  /** Retries on network errors, timeouts, 429, 5xx and empty content. */
  maxRetries?: number;
  /** Test seam: replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

interface ChatCompletion {
  model: string;
  choices?: { finish_reason: string | null; message?: { content: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * LLMClient on DeepSeek's OpenAI-compatible Chat Completions API (SPEC §6.1), with native `fetch`. DeepSeek only
 * supports `response_format: json_object`, so the JSON Schema goes in the system prompt and the output is NOT
 * guaranteed to match it: the caller's zod parse and repair loop are the only check.
 */
export class DeepSeekClient implements LLMClient {
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: DeepSeekClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.model = resolveModel(options.model, process.env, DEEPSEEK_DEFAULT_MODEL);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new LLMError("DEEPSEEK_API_KEY is not set", { retryable: false });
    }

    // DeepSeek requires the word "json" in the prompt for JSON output.
    const system = `${req.system}\n\nReply with a single JSON object that matches this JSON Schema (${req.schemaName}):\n${JSON.stringify(req.jsonSchema)}`;
    const body = JSON.stringify({
      model: this.model,
      max_tokens: req.maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, ...req.messages],
    });

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(apiKey, body, req);
      } catch (error) {
        const llmError = redact(error, apiKey);
        if (!llmError.retryable || attempt >= this.maxRetries) throw llmError;
        const retryAfter = llmError instanceof RetryableLLMError ? llmError.retryAfterMs : undefined;
        await sleep(retryAfter ?? Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS));
      }
    }
  }

  private async attempt(apiKey: string, body: string, req: StructuredRequest): Promise<StructuredResponse> {
    let res: Response;
    try {
      res = await this.fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Includes the TimeoutError from AbortSignal.timeout.
      throw new RetryableLLMError(`Network error calling DeepSeek: ${errorMessage(error)}`, error);
    }

    if (!res.ok) {
      const detail = await apiErrorDetail(res);
      const message = `DeepSeek API error ${res.status}${detail ? `: ${detail}` : ""}`;
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableLLMError(message, undefined, retryAfterMs(res.headers));
      }
      throw new LLMError(message, { retryable: false });
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (error) {
      // The connection dropped or timed out mid-body: a network error, so retryable.
      throw new RetryableLLMError(`Network error reading the DeepSeek response: ${errorMessage(error)}`, error);
    }
    let completion: ChatCompletion;
    try {
      completion = JSON.parse(raw) as ChatCompletion;
    } catch (error) {
      throw new LLMError(`DeepSeek response body is not valid JSON (${req.schemaName})`, {
        retryable: false,
        cause: error,
      });
    }

    const choice = completion.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new LLMError(`Output truncated at max_tokens=${req.maxTokens} (${req.schemaName})`, { retryable: false });
    }
    if (choice?.finish_reason === "content_filter") {
      throw new LLMError(`Output blocked by DeepSeek's content filter (${req.schemaName})`, { retryable: false });
    }
    const text = choice?.message?.content;
    if (!text?.trim()) {
      // Documented DeepSeek quirk: JSON mode occasionally returns empty content.
      throw new RetryableLLMError(`Empty response (${req.schemaName})`);
    }
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch (error) {
      throw new LLMError(`Response is not valid JSON (${req.schemaName})`, { retryable: false, cause: error });
    }

    return {
      output,
      model: completion.model,
      ...(completion.usage
        ? { usage: { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens } }
        : {}),
    };
  }
}

/** A retryable LLMError that may carry the wait the server asked for. */
class RetryableLLMError extends LLMError {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, cause?: unknown, retryAfterMs?: number) {
    super(message, { retryable: true, cause });
    this.retryAfterMs = retryAfterMs;
  }
}

const REDACTED = "[redacted]";

/**
 * Any thrown value as an LLMError in which neither the message nor any error in the `cause` chain contains the key.
 * Never mutates `error`: a leaking error is rebuilt instead.
 */
function redact(error: unknown, apiKey: string): LLMError {
  if (error instanceof LLMError) {
    const cause = scrub(error.cause, apiKey);
    if (!error.message.includes(apiKey) && cause === error.cause) return error;
    const message = error.message.replaceAll(apiKey, REDACTED);
    return error instanceof RetryableLLMError
      ? new RetryableLLMError(message, cause, error.retryAfterMs)
      : new LLMError(message, { retryable: error.retryable, cause });
  }
  const message = `Unexpected error calling DeepSeek: ${errorMessage(error)}`.replaceAll(apiKey, REDACTED);
  return new LLMError(message, { retryable: false, cause: scrub(error, apiKey) });
}

/** `value` unchanged if it does not leak the key, else a copy (an Error keeps its name) with the key redacted. */
function scrub(value: unknown, apiKey: string, depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (depth >= 8) return undefined; // Deep or cyclic chain: drop the rest rather than risk a leak.
  if (typeof value === "string") return value.replaceAll(apiKey, REDACTED);
  if (!(value instanceof Error)) {
    let text: string;
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
    return text.includes(apiKey) ? REDACTED : value;
  }
  const cause = scrub(value.cause, apiKey, depth + 1);
  const leaks = value.message.includes(apiKey) || (value.stack ?? "").includes(apiKey);
  if (!leaks && cause === value.cause) return value;
  const copy = new Error(value.message.replaceAll(apiKey, REDACTED), cause === undefined ? undefined : { cause });
  copy.name = value.name;
  return copy;
}

/** `error.message` from an OpenAI-style error body, or the raw text, truncated. */
async function apiErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200);
}

/** `retry-after` (seconds or HTTP date) in ms, capped at MAX_BACKOFF_MS. */
function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isNaN(ms) ? undefined : Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
