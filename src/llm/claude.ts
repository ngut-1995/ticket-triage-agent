import Anthropic, { APIConnectionError, APIError, type ClientOptions } from "@anthropic-ai/sdk";
import { errorMessage } from "../domain/errors.js";
import { LLMError, resolveModel, type LLMClient, type StructuredRequest, type StructuredResponse } from "./client.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export interface ClaudeClientOptions {
  /** Defaults to `ANTHROPIC_API_KEY`. A missing key fails the first request, not construction. */
  apiKey?: string;
  /** Defaults to `TRIAGE_MODEL`, then `claude-sonnet-5-5`. */
  model?: string;
  timeoutMs?: number;
  /** SDK-level retries on network errors, 408/409/429 and 5xx. */
  maxRetries?: number;
  /** Test seam: replaces the global `fetch`. */
  fetch?: ClientOptions["fetch"];
}

/**
 * LLMClient on the Anthropic Messages API (SPEC §6.1). Structured output is
 * forced with `output_config.format` (`json_schema`), so the reply's text block
 * is JSON constrained to `req.jsonSchema`.
 */
export class ClaudeClient implements LLMClient {
  readonly model: string;
  private readonly sdk: Anthropic | undefined;

  constructor(options: ClaudeClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = resolveModel(options.model, process.env, DEFAULT_MODEL);
    this.sdk = apiKey
      ? new Anthropic({
          apiKey,
          timeout: options.timeoutMs ?? 60_000,
          maxRetries: options.maxRetries ?? 2,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : undefined;
  }

  async generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
    if (!this.sdk) {
      throw new LLMError("ANTHROPIC_API_KEY is not set", { retryable: false });
    }

    let message: Anthropic.Message;
    try {
      message = await this.sdk.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
        output_config: { format: { type: "json_schema", schema: req.jsonSchema } },
      });
    } catch (error) {
      throw toLLMError(error);
    }

    if (message.stop_reason === "refusal") {
      throw new LLMError(`Model refused the request (${req.schemaName})`, { retryable: false });
    }
    if (message.stop_reason === "max_tokens") {
      throw new LLMError(`Output truncated at max_tokens=${req.maxTokens} (${req.schemaName})`, {
        retryable: false,
      });
    }

    const text = message.content.find((block) => block.type === "text")?.text;
    if (text === undefined) {
      throw new LLMError(`No text block in the response (${req.schemaName})`, { retryable: false });
    }
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch (error) {
      throw new LLMError(`Response is not valid JSON (${req.schemaName})`, { retryable: false, cause: error });
    }

    return {
      output,
      model: message.model,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

function toLLMError(error: unknown): LLMError {
  // APIConnectionError (incl. timeouts) extends APIError, so check it first.
  if (error instanceof APIConnectionError) {
    return new LLMError(`Network error calling Claude: ${error.message}`, { retryable: true, cause: error });
  }
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    const retryable = status === 429 || status >= 500;
    return new LLMError(`Claude API error ${status}: ${error.message}`, { retryable, cause: error });
  }
  return new LLMError(`Unexpected error calling Claude: ${errorMessage(error)}`, { retryable: false, cause: error });
}
