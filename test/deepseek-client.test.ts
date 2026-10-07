import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMError, type StructuredRequest } from "../src/llm/client.js";
import { DeepSeekClient } from "../src/llm/deepseek.js";

// Offline only: every test injects a fake `fetch`. No real network. Fake timers skip the retry backoff.

const KEY = "sk-test-secret-key";

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

function completionBody(
  overrides: { content?: string | null; finish_reason?: string; model?: string } = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: overrides.model ?? "deepseek-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "content" in overrides ? overrides.content : JSON.stringify({ category: "hardware" }),
        },
        finish_reason: overrides.finish_reason ?? "stop",
      },
    ],
    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function apiError(status: number, message = `error ${status}`, headers: Record<string, string> = {}) {
  return json(status, { error: { message, type: "invalid_request_error" } }, headers);
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

/** Settles `p` while running the backoff timers, so retries don't wait in real time. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const settled = p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  return settled;
}

async function succeeds<T>(p: Promise<T>): Promise<T> {
  const r = await settle(p);
  if (!r.ok) throw r.error;
  return r.value;
}

async function caught(p: Promise<unknown>): Promise<LLMError> {
  const r = await settle(p);
  if (r.ok) throw new Error("expected the promise to reject");
  expect(r.error).toBeInstanceOf(LLMError);
  return r.error as LLMError;
}

const client = (fetch: ReturnType<typeof fakeFetch>["fetch"], options: { maxRetries?: number; model?: string } = {}) =>
  new DeepSeekClient({ apiKey: KEY, fetch, ...options });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("DeepSeekClient request shape", () => {
  it("posts to Chat Completions with a Bearer key, the model, max_tokens, JSON mode and the user messages", async () => {
    const f = fakeFetch([json(200, completionBody())]);

    await succeeds(client(f.fetch, { model: "deepseek-v4-pro" }).generateStructured(request));

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.deepseek.com/chat/completions");
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.body.model).toBe("deepseek-v4-pro");
    expect(call.body.max_tokens).toBe(4000);
    expect(call.body.response_format).toEqual({ type: "json_object" });
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages[0]!.role).toBe("system");
    expect(messages.slice(1)).toEqual(request.messages);
  });

  it("puts the request's system prompt, the word json and the JSON Schema in the system message", async () => {
    const f = fakeFetch([json(200, completionBody())]);
    await succeeds(client(f.fetch).generateStructured(request));

    const system = (f.calls[0]!.body.messages as { content: string }[])[0]!.content;
    expect(system.startsWith("You triage tickets.")).toBe(true);
    expect(system.toLowerCase()).toContain("json");
    expect(system).toContain(JSON.stringify(request.jsonSchema));
  });

  it("defaults the model to deepseek-flash", async () => {
    vi.stubEnv("TRIAGE_MODEL", undefined);
    const f = fakeFetch([json(200, completionBody())]);
    await succeeds(client(f.fetch).generateStructured(request));
    expect(f.calls[0]!.body.model).toBe("deepseek-flash");
  });

  it("reads TRIAGE_MODEL from the environment, and an explicit model wins over it", async () => {
    vi.stubEnv("TRIAGE_MODEL", "deepseek-v4-pro");
    const f = fakeFetch([json(200, completionBody()), json(200, completionBody())]);
    await succeeds(client(f.fetch).generateStructured(request));
    await succeeds(client(f.fetch, { model: "deepseek-flash" }).generateStructured(request));
    expect(f.calls[0]!.body.model).toBe("deepseek-v4-pro");
    expect(f.calls[1]!.body.model).toBe("deepseek-flash");
  });

  it("reads DEEPSEEK_API_KEY from the environment", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "env-key");
    const f = fakeFetch([json(200, completionBody())]);
    await succeeds(new DeepSeekClient({ fetch: f.fetch }).generateStructured(request));
    expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer env-key");
  });
});

describe("DeepSeekClient response parsing", () => {
  it("returns the parsed JSON, the model reported by the API, and usage", async () => {
    const f = fakeFetch([json(200, completionBody({ model: "deepseek-flash-reported" }))]);

    const res = await succeeds(client(f.fetch).generateStructured(request));

    expect(res).toEqual({
      output: { category: "hardware" },
      model: "deepseek-flash-reported",
      usage: { inputTokens: 123, outputTokens: 45 },
    });
  });

  it("fails with a non-retryable LLMError, without retrying, when output is cut off at max_tokens", async () => {
    const f = fakeFetch([json(200, completionBody({ content: '{"cat', finish_reason: "length" }))]);
    const err = await caught(client(f.fetch).generateStructured(request));
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/max_tokens/);
    expect(f.calls).toHaveLength(1);
  });

  it("fails with a non-retryable LLMError, without retrying, on the content filter", async () => {
    const f = fakeFetch([json(200, completionBody({ content: "", finish_reason: "content_filter" }))]);
    const err = await caught(client(f.fetch).generateStructured(request));
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/content filter/);
    expect(f.calls).toHaveLength(1);
  });

  it("fails with a non-retryable LLMError, without retrying, when the content is not valid JSON", async () => {
    const f = fakeFetch([json(200, completionBody({ content: "not json" }))]);
    const err = await caught(client(f.fetch).generateStructured(request));
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/JSON/);
    expect(f.calls).toHaveLength(1);
  });

  it("retries empty content, then succeeds", async () => {
    const f = fakeFetch([json(200, completionBody({ content: "" })), json(200, completionBody())]);
    const res = await succeeds(client(f.fetch).generateStructured(request));
    expect(res.output).toEqual({ category: "hardware" });
    expect(f.calls).toHaveLength(2);
  });

  it("maps exhausted empty content to a retryable LLMError", async () => {
    const f = fakeFetch([json(200, completionBody({ content: null })), json(200, completionBody({ content: " " }))]);
    const err = await caught(client(f.fetch, { maxRetries: 1 }).generateStructured(request));
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/Empty/);
    expect(f.calls).toHaveLength(2);
  });
});

describe("DeepSeekClient missing API key", () => {
  it("constructs without a key and fails on the first request, without any HTTP call", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    const f = fakeFetch([]);
    const llm = new DeepSeekClient({ fetch: f.fetch });
    const err = await caught(llm.generateStructured(request));
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/DEEPSEEK_API_KEY/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("DeepSeekClient error mapping and retries", () => {
  it("retries a 429 and a 5xx, then succeeds", async () => {
    const f = fakeFetch([apiError(429), apiError(503), json(200, completionBody())]);
    const res = await succeeds(client(f.fetch, { maxRetries: 2 }).generateStructured(request));
    expect(res.output).toEqual({ category: "hardware" });
    expect(f.calls).toHaveLength(3);
  });

  it("retries a network error, then succeeds", async () => {
    const f = fakeFetch([new TypeError("fetch failed"), json(200, completionBody())]);
    const res = await succeeds(client(f.fetch).generateStructured(request));
    expect(res.output).toEqual({ category: "hardware" });
    expect(f.calls).toHaveLength(2);
  });

  it("treats a timeout as a retryable network error", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const f = fakeFetch([timeout, timeout]);
    const err = await caught(client(f.fetch, { maxRetries: 1 }).generateStructured(request));
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/timeout/);
    expect(f.calls).toHaveLength(2);
  });

  it("waits for retry-after before retrying a 429", async () => {
    const f = fakeFetch([apiError(429, "slow down", { "retry-after": "3" }), json(200, completionBody())]);
    const pending = client(f.fetch).generateStructured(request);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    await expect(pending).resolves.toMatchObject({ output: { category: "hardware" } });
  });

  it("retries up to maxRetries, then throws a retryable LLMError", async () => {
    for (const failure of [() => apiError(429), () => apiError(500), () => new TypeError("fetch failed")]) {
      const f = fakeFetch([failure(), failure(), failure()]);
      const err = await caught(client(f.fetch, { maxRetries: 2 }).generateStructured(request));
      expect(err.retryable).toBe(true);
      expect(f.calls).toHaveLength(3);
    }
  });

  it("does not retry when maxRetries is 0", async () => {
    const f = fakeFetch([apiError(500)]);
    const err = await caught(client(f.fetch, { maxRetries: 0 }).generateStructured(request));
    expect(err.retryable).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("maps 400 and 401 to non-retryable LLMErrors and does not retry them", async () => {
    for (const status of [400, 401]) {
      const f = fakeFetch([apiError(status)]);
      const err = await caught(client(f.fetch, { maxRetries: 2 }).generateStructured(request));
      expect(err.retryable).toBe(false);
      expect(err.message).toContain(String(status));
      expect(f.calls).toHaveLength(1);
    }
  });

  it("never puts the key in an error message, even when the API or the network echoes it", async () => {
    const failures: (Response | Error)[] = [
      apiError(401, `Authentication Fails, Your api key: ${KEY} is invalid`),
      new Response(`bad gateway for ${KEY}`, { status: 502 }),
      new TypeError(`connect failed with Bearer ${KEY}`),
    ];
    for (const failure of failures) {
      const f = fakeFetch([failure]);
      const err = await caught(client(f.fetch, { maxRetries: 0 }).generateStructured(request));
      expect(err.message).not.toContain(KEY);
    }
  });
});
