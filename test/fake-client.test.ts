import { describe, expect, it } from "vitest";
import { LLMError, type StructuredRequest } from "../src/llm/client.js";
import { FakeClient } from "../src/llm/fake.js";

const request = (content: string): StructuredRequest => ({
  system: "sys",
  messages: [{ role: "user", content }],
  schemaName: "LlmTriageOutput",
  jsonSchema: { type: "object" },
  maxTokens: 1000,
});

describe("FakeClient", () => {
  it("returns scripted outputs in order", async () => {
    const llm = new FakeClient([{ n: 1 }, { n: 2 }]);
    expect((await llm.generateStructured(request("a"))).output).toEqual({ n: 1 });
    expect((await llm.generateStructured(request("b"))).output).toEqual({ n: 2 });
  });

  it("reports a model name", async () => {
    const llm = new FakeClient([{}]);
    const res = await llm.generateStructured(request("a"));
    expect(typeof res.model).toBe("string");
    expect(res.model.length).toBeGreaterThan(0);
  });

  it("supports a function that computes the output from the request", async () => {
    const llm = new FakeClient((req) => ({ echo: req.messages[0]?.content }));
    expect((await llm.generateStructured(request("x"))).output).toEqual({ echo: "x" });
    expect((await llm.generateStructured(request("y"))).output).toEqual({ echo: "y" });
  });

  it("records every request in .calls", async () => {
    const llm = new FakeClient([1, 2]);
    const a = request("a");
    const b = request("b");
    await llm.generateStructured(a);
    await llm.generateStructured(b);
    expect(llm.calls).toEqual([a, b]);
  });

  it("throws when it runs out of responses", async () => {
    const llm = new FakeClient([{ n: 1 }]);
    await llm.generateStructured(request("a"));
    await expect(llm.generateStructured(request("b"))).rejects.toThrow(/out of responses/i);
  });

  it("throws a scripted Error instead of returning it", async () => {
    const failure = new LLMError("rate limited", { retryable: true });
    const llm = new FakeClient([failure, { ok: true }]);
    await expect(llm.generateStructured(request("a"))).rejects.toBe(failure);
    expect((await llm.generateStructured(request("b"))).output).toEqual({ ok: true });
    expect(llm.calls).toHaveLength(2);
  });

  it("throws an Error returned by the function form", async () => {
    const llm = new FakeClient(() => new Error("boom"));
    await expect(llm.generateStructured(request("a"))).rejects.toThrow("boom");
  });
});

describe("LLMError", () => {
  it("is an Error carrying retryable", () => {
    const err = new LLMError("bad", { retryable: false });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LLMError");
    expect(err.retryable).toBe(false);
    expect(new LLMError("x", { retryable: true }).retryable).toBe(true);
  });

  it("keeps the cause", () => {
    const cause = new Error("socket hang up");
    expect(new LLMError("network", { retryable: true, cause }).cause).toBe(cause);
  });
});
