import type { LLMClient, StructuredRequest, StructuredResponse } from "./client.js";

export const FAKE_MODEL = "fake-model";

/**
 * Offline LLMClient for tests. Returns scripted outputs in order (or computes
 * them with a function), records every request in `.calls`, and throws when it
 * runs out. A scripted `Error` instance is thrown instead of returned.
 */
export class FakeClient implements LLMClient {
  readonly calls: StructuredRequest[] = [];
  private readonly script: unknown[] | ((req: StructuredRequest) => unknown);
  private next = 0;

  constructor(responses: unknown[] | ((req: StructuredRequest) => unknown)) {
    this.script = Array.isArray(responses) ? [...responses] : responses;
  }

  async generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
    this.calls.push(req);
    let output: unknown;
    if (typeof this.script === "function") {
      output = this.script(req);
    } else {
      if (this.next >= this.script.length) {
        throw new Error(
          `FakeClient is out of responses (call ${this.calls.length}, ${this.script.length} scripted)`,
        );
      }
      output = this.script[this.next++];
    }
    if (output instanceof Error) throw output;
    return { output, model: FAKE_MODEL };
  }
}
