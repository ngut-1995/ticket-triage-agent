import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeClient } from "../src/llm/claude.js";
import { LLMError, type StructuredRequest } from "../src/llm/client.js";

// Offline only: every test injects a fake `fetch`. No real network.

const request: StructuredRequest = {
  system: "You triage tickets.",
  messages: [{ role: "user", content: "<ticket>printer jammed</ticket>" }],
  schemaName: "LlmTriageOutput",
  jsonSchema: {
    type: "object",
    properties: { category: { type: "string" } },
    required: ["category"],
    additionalProperties: false,
  },
  maxTokens: 4000,
};

interface Recorded {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function messageBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: JSON.stringify({ category: "hardware" }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 123, output_tokens: 45 },
    ...overrides,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "0", ...headers },
  });
}

function apiError(status: number, type: string) {
  return json(status, { type: "error", error: { type, message: `${type} happened` } });
}

/** A fake fetch that replays scripted responses (or throws scripted errors) and records requests. */
function fakeFetch(script: (Response | Error)[]) {
  const calls: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = script.shift();
    if (next === undefined) throw new Error("fakeFetch out of responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

async function caught(p: Promise<unknown>): Promise<LLMError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LLMError);
    return e as LLMError;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ClaudeClient request shape", () => {
  it("sends system, messages, max_tokens and forces JSON output matching req.jsonSchema", async () => {
    const f = fakeFetch([json(200, messageBody())]);
    const llm = new ClaudeClient({ apiKey: "test-key", model: "claude-opus-5-5", fetch: f.fetch });

    await llm.generateStructured(request);

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toMatch(/\/v1\/messages$/);
    expect(call.headers.get("x-api-key")).toBe("test-key");
    expect(call.body.model).toBe("claude-opus-5-5");
    expect(call.body.system).toBe("You triage tickets.");
    expect(call.body.messages).toEqual(request.messages);
    expect(call.body.max_tokens).toBe(4000);
    expect(call.body.output_config).toEqual({
      format: { type: "json_schema", schema: request.jsonSchema },
    });
  });

  it("defaults the model to claude-sonnet-5-5", async () => {
    vi.stubEnv("TRIAGE_MODEL", undefined);
    const f = fakeFetch([json(200, messageBody())]);
    const llm = new ClaudeClient({ apiKey: "k", fetch: f.fetch });
    await llm.generateStructured(request);
    expect(f.calls[0]!.body.model).toBe("claude-sonnet-5-5");
  });

  it("reads TRIAGE_MODEL from the environment, and an explicit model wins over it", async () => {
    vi.stubEnv("TRIAGE_MODEL", "claude-haiku-4-5");
    const f = fakeFetch([json(200, messageBody()), json(200, messageBody())]);
    await new ClaudeClient({ apiKey: "k", fetch: f.fetch }).generateStructured(request);
    await new ClaudeClient({ apiKey: "k", model: "claude-opus-5-5", fetch: f.fetch }).generateStructured(request);
    expect(f.calls[0]!.body.model).toBe("claude-haiku-4-5");
    expect(f.calls[1]!.body.model).toBe("claude-opus-5-5");
  });

  it("reads ANTHROPIC_API_KEY from the environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    const f = fakeFetch([json(200, messageBody())]);
    await new ClaudeClient({ fetch: f.fetch }).generateStructured(request);
    expect(f.calls[0]!.headers.get("x-api-key")).toBe("env-key");
  });
});

describe("ClaudeClient response parsing", () => {
  it("returns the parsed JSON, the model reported by the API, and usage", async () => {
    const f = fakeFetch([json(200, messageBody({ model: "claude-sonnet-5-5-reported" }))]);
    const llm = new ClaudeClient({ apiKey: "k", model: "claude-sonnet-5-5", fetch: f.fetch });

    const res = await llm.generateStructured(request);

    expect(res).toEqual({
      output: { category: "hardware" },
      model: "claude-sonnet-5-5-reported",
      usage: { inputTokens: 123, outputTokens: 45 },
    });
  });

  it("skips non-text blocks (e.g. thinking) and parses the text block", async () => {
    const f = fakeFetch([
      json(
        200,
        messageBody({
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: '{"category":"network"}' },
          ],
        }),
      ),
    ]);
    const res = await new ClaudeClient({ apiKey: "k", fetch: f.fetch }).generateStructured(request);
    expect(res.output).toEqual({ category: "network" });
  });

  it("fails with a non-retryable LLMError on a refusal", async () => {
    const f = fakeFetch([json(200, messageBody({ stop_reason: "refusal", content: [] }))]);
    const err = await caught(new ClaudeClient({ apiKey: "k", fetch: f.fetch }).generateStructured(request));
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/refus/i);
  });

  it("fails with a non-retryable LLMError when output is cut off at max_tokens", async () => {
    const f = fakeFetch([
      json(200, messageBody({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"cat' }] })),
    ]);
    const err = await caught(new ClaudeClient({ apiKey: "k", fetch: f.fetch }).generateStructured(request));
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/max_tokens/);
  });

  it("fails with an LLMError when the text is not valid JSON", async () => {
    const f = fakeFetch([json(200, messageBody({ content: [{ type: "text", text: "not json" }] }))]);
    const err = await caught(new ClaudeClient({ apiKey: "k", fetch: f.fetch }).generateStructured(request));
    expect(err.message).toMatch(/JSON/);
  });
});

describe("ClaudeClient missing API key", () => {
  it("constructs without a key and fails on the first request, without any HTTP call", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const f = fakeFetch([]);
    const llm = new ClaudeClient({ fetch: f.fetch });
    const err = await caught(llm.generateStructured(request));
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/ANTHROPIC_API_KEY/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("ClaudeClient error mapping and retries", () => {
  it("retries a 429 and a 5xx, then succeeds", async () => {
    const f = fakeFetch([
      apiError(429, "rate_limit_error"),
      apiError(529, "overloaded_error"),
      json(200, messageBody()),
    ]);
    const res = await new ClaudeClient({ apiKey: "k", maxRetries: 2, fetch: f.fetch }).generateStructured(request);
    expect(res.output).toEqual({ category: "hardware" });
    expect(f.calls).toHaveLength(3);
  });

  it("retries a network error, then succeeds", async () => {
    const f = fakeFetch([new TypeError("fetch failed"), json(200, messageBody())]);
    const res = await new ClaudeClient({ apiKey: "k", maxRetries: 2, fetch: f.fetch }).generateStructured(request);
    expect(res.output).toEqual({ category: "hardware" });
    expect(f.calls).toHaveLength(2);
  });

  it("maps an exhausted 429 to a retryable LLMError", async () => {
    const f = fakeFetch([apiError(429, "rate_limit_error")]);
    const err = await caught(new ClaudeClient({ apiKey: "k", maxRetries: 0, fetch: f.fetch }).generateStructured(request));
    expect(err.retryable).toBe(true);
  });

  it("maps a 500 to a retryable LLMError", async () => {
    const f = fakeFetch([apiError(500, "api_error")]);
    const err = await caught(new ClaudeClient({ apiKey: "k", maxRetries: 0, fetch: f.fetch }).generateStructured(request));
    expect(err.retryable).toBe(true);
  });

  it("maps a network failure to a retryable LLMError", async () => {
    const f = fakeFetch([new TypeError("fetch failed")]);
    const err = await caught(new ClaudeClient({ apiKey: "k", maxRetries: 0, fetch: f.fetch }).generateStructured(request));
    expect(err.retryable).toBe(true);
  });

  it("maps 400 and 401 to non-retryable LLMErrors and does not retry them", async () => {
    for (const [status, type] of [
      [400, "invalid_request_error"],
      [401, "authentication_error"],
    ] as const) {
      const f = fakeFetch([apiError(status, type)]);
      const err = await caught(
        new ClaudeClient({ apiKey: "k", maxRetries: 2, fetch: f.fetch }).generateStructured(request),
      );
      expect(err.retryable).toBe(false);
      expect(err.message).toContain(String(status));
      expect(f.calls).toHaveLength(1);
    }
  });
});
