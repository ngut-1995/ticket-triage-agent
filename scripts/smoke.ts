// Smoke test against a real API: `npm run smoke -- <ticket.json> [--provider deepseek|claude]`.
// One LLM call with the production prompt (buildTriagePrompt, no corpus, no repair call), then the quality
// validator. Prints the output, quality warnings, tokens, cost and ms.
// Defaults to DeepSeek (DEEPSEEK_API_KEY); `--provider claude` uses ClaudeClient (ANTHROPIC_API_KEY).
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { errorMessage, formatZodIssues } from "../src/domain/errors.js";
import { LlmTriageOutputSchema, parseTicket } from "../src/domain/schemas.js";
import { createLlmClient, PROVIDERS, resolveLlmConfig, UnknownProviderError, type LlmConfig } from "../src/llm/provider.js";
import { buildTriagePrompt } from "../src/prompt/build.js";
import { validateResult } from "../src/quality/validate.js";
import { toResult } from "../src/triage.js";

/** USD per million tokens (input, output). DeepSeek: peak cache-miss rates, so an upper bound. */
const PRICES: Record<string, { input: number; output: number }> = {
  "deepseek-flash": { input: 0.3, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

const USAGE = `Usage: npm run smoke -- <ticket.json> [--provider ${PROVIDERS.join("|")}] (default: deepseek)\n`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { provider: { type: "string", default: "deepseek" } },
  });
  const file = positionals[0];
  if (file === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }

  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env: rely on the environment.
  }

  let config: LlmConfig;
  try {
    config = resolveLlmConfig({ provider: values.provider });
  } catch (error) {
    if (!(error instanceof UnknownProviderError)) throw error;
    process.stderr.write(`smoke: ${error.message}\n${USAGE}`);
    return 2;
  }

  const ticket = parseTicket(JSON.parse(await readFile(file, "utf8")));
  const client = createLlmClient(config);

  const start = performance.now();
  const response = await client.generateStructured(buildTriagePrompt(ticket));
  const ms = Math.round(performance.now() - start);

  process.stdout.write(`${JSON.stringify(response.output, null, 2)}\n\n`);

  const parsed = LlmTriageOutputSchema.safeParse(response.output);
  let quality: string;
  if (parsed.success) {
    const warnings = validateResult(toResult(parsed.data, ticket, false, response.model), ticket);
    quality = warnings.length
      ? `${warnings.length}\n${warnings.map((w) => `  - ${w.code}${w.requirementId ? ` (${w.requirementId})` : ""}: ${w.message}`).join("\n")}`
      : "0";
  } else {
    quality = "skipped (schema invalid)";
  }

  const input = response.usage?.inputTokens ?? 0;
  const output = response.usage?.outputTokens ?? 0;
  const price = PRICES[config.model];
  const cost = price ? `$${((input * price.input + output * price.output) / 1e6).toFixed(4)}` : "unknown (no price for model)";
  process.stdout.write(
    [
      `model:    ${response.model}`,
      `schema:   ${parsed.success ? "valid" : `INVALID: ${formatZodIssues(parsed.error.issues)}`}`,
      `warnings: ${quality}`,
      `tokens:   ${input} in / ${output} out`,
      `cost:     ${cost}`,
      `time:     ${ms} ms`,
    ].join("\n") + "\n",
  );
  return parsed.success ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`smoke: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
