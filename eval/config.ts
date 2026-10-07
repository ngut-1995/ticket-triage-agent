// SPEC §7 golden eval: provider, model and key for `npm run eval`, resolved like the CLI (src/llm/provider.ts)
// but from the environment only. Kept apart from run.ts so it can be tested offline.
import { errorMessage } from "../src/domain/errors.js";
import { apiKeyEnv, resolveLlmConfig, type LlmConfig } from "../src/llm/provider.js";

/**
 * The eval's LLM config: TRIAGE_PROVIDER (default claude), TRIAGE_MODEL or the provider's default model, and the
 * provider's own key. Unlike the CLI, a missing key is an error here, so the eval fails before its first call.
 */
export function resolveEvalConfig(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: LlmConfig } | { ok: false; error: string } {
  let config: LlmConfig;
  try {
    config = resolveLlmConfig({}, env);
  } catch (error) {
    return { ok: false, error: `eval: ${errorMessage(error)}.` };
  }
  if (!config.apiKey) {
    const variable = apiKeyEnv(config.provider);
    const why = `The golden eval runs against the real model (provider ${config.provider}); set it and retry.`;
    return { ok: false, error: `eval: ${variable} is not set. ${why}` };
  }
  return { ok: true, config };
}

/** The scorecard's first line. */
export const scorecardHeader = (cases: number, { provider, model }: LlmConfig): string =>
  `Golden eval: ${cases} cases, provider ${provider}, model ${model}`;
