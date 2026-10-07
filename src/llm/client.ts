/** Seam between triage logic and the model provider (SPEC §6.1). */

export interface StructuredRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  schemaName: string;
  /** JSON Schema generated from the zod schema. */
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
}

export interface StructuredResponse {
  /** Parsed JSON, not yet validated. */
  output: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMClient {
  generateStructured(req: StructuredRequest): Promise<StructuredResponse>;
}

/** The model to use: `explicit`, then `TRIAGE_MODEL`, then `fallback` (the provider's default). */
export const resolveModel = (
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  fallback: string,
): string => explicit ?? env.TRIAGE_MODEL ?? fallback;

export class LLMError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LLMError";
    this.retryable = options.retryable;
  }
}
