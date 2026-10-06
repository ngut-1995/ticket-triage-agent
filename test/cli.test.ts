import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliClientFactory } from "../src/cli.js";
import { TriageResultSchema } from "../src/domain/schemas.js";
import { LLMError, type LLMClient } from "../src/llm/client.js";
import { FakeClient } from "../src/llm/fake.js";
import { notActionableLlmOutput, validLlmOutput } from "./support/builders.js";

const BUG_CLEAR = "fixtures/tickets/bug-clear.json";

class Sink {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

async function run(argv: string[], options: { llm?: LLMClient | CliClientFactory; env?: Record<string, string> } = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(argv, { llm: options.llm, stdout, stderr, env: options.env ?? {} });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** A client factory that records the model it was built with and reports it back as the model used. */
function recordingFactory() {
  const models: string[] = [];
  const factory: CliClientFactory = ({ model }) => {
    models.push(model);
    return { generateStructured: async () => ({ output: validLlmOutput(), model }) };
  };
  return { factory, models };
}

describe("runCli: invalid input and usage (exit 2, no LLM call)", () => {
  it.each([
    ["no arguments", []],
    ["two ticket files", [BUG_CLEAR, BUG_CLEAR]],
    ["an unknown flag", [BUG_CLEAR, "--verbose"]],
    ["a flag without its value", [BUG_CLEAR, "--out"]],
  ])("exits 2 on a usage error: %s", async (_name, argv) => {
    const llm = new FakeClient([validLlmOutput()]);
    const { code, stdout, stderr } = await run(argv, { llm });
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage: triage/i);
    expect(stdout).toBe("");
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    ["a missing file", "fixtures/does-not-exist.json", /does-not-exist\.json/],
    ["unparseable JSON", "fixtures/invalid/bad-json.json", /not valid JSON/i],
    ["a missing body", "fixtures/invalid/missing-body.json", /body/],
    ["a bad createdAt", "fixtures/invalid/bad-created-at.json", /createdAt/],
  ])("exits 2 for %s", async (_name, file, message) => {
    const llm = new FakeClient([validLlmOutput()]);
    const { code, stdout, stderr } = await run([file], { llm });
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
    expect(stdout).toBe("");
    expect(llm.calls).toHaveLength(0);
  });

  it("reports the validation error, not an auth error, when ANTHROPIC_API_KEY is unset", async () => {
    const { code, stderr } = await run(["fixtures/invalid/missing-body.json"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/body/);
    expect(stderr).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("exits 2 when the --corpus file is not a valid ticket array", async () => {
    const llm = new FakeClient([validLlmOutput()]);
    const { code, stderr } = await run([BUG_CLEAR, "--corpus", "fixtures/invalid/missing-body.json"], { llm });
    expect(code).toBe(2);
    expect(stderr).toMatch(/corpus/i);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("runCli: success (exit 0)", () => {
  it("writes a TriageResultSchema-valid result to stdout", async () => {
    const llm = new FakeClient([validLlmOutput()]);
    const { code, stdout } = await run([BUG_CLEAR], { llm });
    expect(code).toBe(0);
    const result = TriageResultSchema.parse(JSON.parse(stdout));
    expect(result.ticketId).toBe("3001");
    expect(result.priority.value).toBe("P3");
    expect(llm.calls).toHaveLength(1);
  });

  it("exits 0 for a not_actionable disposition too", async () => {
    const llm = new FakeClient(() => notActionableLlmOutput());
    const { code, stdout } = await run(["fixtures/tickets/auto-reply.json"], { llm });
    expect(code).toBe(0);
    expect(TriageResultSchema.parse(JSON.parse(stdout)).disposition).toBe("not_actionable");
  });

  it("writes a human summary with every §6.4 field to stderr", async () => {
    const out = validLlmOutput();
    const llm = new FakeClient(() => ({
      ...out,
      flags: { containsSensitiveData: true, possiblePromptInjection: false },
    }));
    const { stderr } = await run([BUG_CLEAR], { llm });
    expect(stderr).toMatch(/disposition: actionable/);
    expect(stderr).toMatch(/category: software_bug/);
    expect(stderr).toMatch(/priority: P3/);
    expect(stderr).toMatch(/team: apps/);
    expect(stderr).toMatch(/duplicates: none/);
    expect(stderr).toMatch(/questions: 0/);
    expect(stderr).toMatch(/warnings: 0/);
    expect(stderr).toMatch(/flags: containsSensitiveData/);
  });

  it("--out writes the JSON to the file instead of stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-cli-"));
    try {
      const file = join(dir, "result.json");
      const llm = new FakeClient([validLlmOutput()]);
      const { code, stdout, stderr } = await run([BUG_CLEAR, "--out", file], { llm });
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(TriageResultSchema.parse(JSON.parse(readFileSync(file, "utf8"))).ticketId).toBe("3001");
      expect(stderr).toMatch(/disposition: actionable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--corpus sends prefiltered candidates and lists duplicates in the summary", async () => {
    const out = validLlmOutput();
    // Function form: the repair (if the validator objects to these bug-clear quotes) gets the same output.
    const llm = new FakeClient(() => ({
      ...out,
      disposition: "suspected_duplicate",
      possibleDuplicates: [{ ticketId: "1042", confidence: "high", reason: "Same printer jam on 3F." }],
    }));
    const { code, stdout, stderr } = await run(
      ["fixtures/tickets/duplicate-of-1042.json", "--corpus", "fixtures/corpus/open-tickets.json"],
      { llm },
    );
    expect(code).toBe(0);
    expect(llm.calls[0]?.messages.map((m) => m.content).join("\n")).toContain("<candidate_tickets>");
    expect(JSON.parse(stdout).possibleDuplicates).toEqual([
      expect.objectContaining({ ticketId: "1042", confidence: "high" }),
    ]);
    expect(stderr).toMatch(/duplicates: 1042 \(high\)/);
  });
});

describe("runCli: LLM and output errors (exit 3)", () => {
  it("exits 3 on an LLMError", async () => {
    const llm = new FakeClient([new LLMError("overloaded after retries", { retryable: true })]);
    const { code, stdout, stderr } = await run([BUG_CLEAR], { llm });
    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/overloaded after retries/);
  });

  it("exits 3 when the output is unparseable after the repair (TriageOutputError)", async () => {
    const llm = new FakeClient([{ nonsense: true }, { still: "nonsense" }]);
    const { code, stdout } = await run([BUG_CLEAR], { llm });
    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(llm.calls).toHaveLength(2);
  });

  it("exits 3 with the auth error for a valid ticket when ANTHROPIC_API_KEY is unset", async () => {
    const { code, stderr } = await run([BUG_CLEAR]);
    expect(code).toBe(3);
    expect(stderr).toMatch(/ANTHROPIC_API_KEY is not set/);
  });
});

describe("runCli: model selection", () => {
  it("builds the client with --model, overriding TRIAGE_MODEL, and reports it in meta.model", async () => {
    const { factory, models } = recordingFactory();
    const { code, stdout } = await run([BUG_CLEAR, "--model", "claude-opus-5-5"], {
      llm: factory,
      env: { TRIAGE_MODEL: "claude-haiku-5" },
    });
    expect(code).toBe(0);
    expect(models).toEqual(["claude-opus-5-5"]);
    expect(JSON.parse(stdout).meta.model).toBe("claude-opus-5-5");
  });

  it("falls back to TRIAGE_MODEL, then the default model", async () => {
    const a = recordingFactory();
    await run([BUG_CLEAR], { llm: a.factory, env: { TRIAGE_MODEL: "claude-haiku-5" } });
    expect(a.models).toEqual(["claude-haiku-5"]);

    const b = recordingFactory();
    await run([BUG_CLEAR], { llm: b.factory });
    expect(b.models).toEqual(["claude-sonnet-5-5"]);
  });

  it("does not build a client when the input is invalid", async () => {
    const { factory, models } = recordingFactory();
    const { code } = await run(["fixtures/invalid/missing-body.json"], { llm: factory });
    expect(code).toBe(2);
    expect(models).toEqual([]);
  });
});
