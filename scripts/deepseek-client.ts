// Dev-only LLMClient on DeepSeek's OpenAI-compatible Chat Completions API, for the smoke script.
// Lives outside src/ on purpose: SPEC §9 keeps providers other than Claude out of the shipped code.
import { LLMError, type LLMClient, type StructuredRequest, type StructuredResponse } from "../src/llm/client.js";

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
const BASE_URL = "https://api.deepseek.com";

interface ChatCompletion {
  model: string;
  choices: { finish_reason: string; message: { content: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * DeepSeek only supports `response_format: json_object` (no json_schema), so the schema goes in the
 * system prompt and the output must still be validated with zod by the caller.
 */
export class DeepSeekClient implements LLMClient {
  readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  }

  async generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
    if (!this.apiKey) {
      throw new LLMError("DEEPSEEK_API_KEY is not set", { retryable: false });
    }

    // DeepSeek requires the word "json" in the prompt for JSON output.
    const system = `${req.system}\n\nReply with a single JSON object that matches this JSON Schema (${req.schemaName}):\n${JSON.stringify(req.jsonSchema)}`;

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, ...req.messages],
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new LLMError(`Network error calling DeepSeek: ${String(error)}`, { retryable: true, cause: error });
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new LLMError(`DeepSeek API error ${res.status}: ${await res.text()}`, { retryable });
    }

    const completion = (await res.json()) as ChatCompletion;
    const choice = completion.choices[0];
    if (choice?.finish_reason === "length") {
      throw new LLMError(`Output truncated at max_tokens=${req.maxTokens} (${req.schemaName})`, { retryable: false });
    }
    const text = choice?.message.content;
    if (!text) {
      // Documented DeepSeek quirk: JSON mode occasionally returns empty content.
      throw new LLMError(`Empty response (${req.schemaName})`, { retryable: true });
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
