// Provider, model and key resolution shared by the CLI and the golden eval (SPEC §6.4, §7).
import { ClaudeClient, DEFAULT_MODEL } from "./claude.js";
import { resolveModel, type LLMClient } from "./client.js";
import { DEEPSEEK_DEFAULT_MODEL, DeepSeekClient } from "./deepseek.js";

export const PROVIDERS = ["claude", "deepseek"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const DEFAULT_PROVIDER: Provider = "claude";

/** What createLlmClient passes to a provider's client. `fetch` is a test seam. */
interface ClientInit {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch | undefined;
}

interface ProviderDefaults {
  model: string;
  apiKeyEnv: string;
  create: (init: ClientInit) => LLMClient;
}

/** Default model, API key variable and client constructor of each provider. */
const PROVIDER_DEFAULTS: Record<Provider, ProviderDefaults> = {
  claude: {
    model: DEFAULT_MODEL,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    create: ({ apiKey, model, fetch }) => new ClaudeClient({ apiKey, model, ...(fetch ? { fetch } : {}) }),
  },
  deepseek: {
    model: DEEPSEEK_DEFAULT_MODEL,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    create: ({ apiKey, model, fetch }) => new DeepSeekClient({ apiKey, model, ...(fetch ? { fetch } : {}) }),
  },
};

/** What a client is built from. `apiKey` is `""` when the provider's variable is unset. */
export interface LlmConfig {
  provider: Provider;
  model: string;
  apiKey: string;
}

/** `--provider` or `TRIAGE_PROVIDER` is not one of PROVIDERS. A usage error. */
export class UnknownProviderError extends Error {
  constructor(value: string) {
    super(`unknown provider "${value}" (expected one of: ${PROVIDERS.join(", ")})`);
    this.name = "UnknownProviderError";
  }
}

const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value);

/** The provider to use: `explicit`, then `TRIAGE_PROVIDER`, then DEFAULT_PROVIDER. Throws UnknownProviderError. */
export function resolveProvider(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Provider {
  const value = explicit ?? env.TRIAGE_PROVIDER ?? DEFAULT_PROVIDER;
  if (!isProvider(value)) throw new UnknownProviderError(value);
  return value;
}

/** The environment variable that holds `provider`'s API key. */
export const apiKeyEnv = (provider: Provider): string => PROVIDER_DEFAULTS[provider].apiKeyEnv;

/**
 * Provider (`--provider` > TRIAGE_PROVIDER > claude), model (`--model` > TRIAGE_MODEL > the provider's default) and
 * the provider's own key. Throws UnknownProviderError. A missing key is not an error here: the client fails its first
 * request with a message that names the variable.
 */
export function resolveLlmConfig(
  explicit: { provider?: string | undefined; model?: string | undefined },
  env: Record<string, string | undefined> = process.env,
): LlmConfig {
  const provider = resolveProvider(explicit.provider, env);
  const defaults = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    model: resolveModel(explicit.model, env, defaults.model),
    apiKey: env[defaults.apiKeyEnv] ?? "",
  };
}

/**
 * The real client for `config`. Builds nothing that touches the network until the first request. `options.fetch` is a
 * test seam that replaces the global `fetch`.
 */
export function createLlmClient(
  { provider, model, apiKey }: LlmConfig,
  options: { fetch?: typeof globalThis.fetch } = {},
): LLMClient {
  return PROVIDER_DEFAULTS[provider].create({ apiKey, model, fetch: options.fetch });
}
