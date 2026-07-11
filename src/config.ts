/**
 * Configuration for the vending bench simulation.
 */

export interface SimulationConfig {
  /** Execution mode */
  mode: "direct" | "openclaw" | "agent";

  /** LLM provider for the primary agent (used in direct/openclaw modes) */
  provider: "anthropic" | "cerebras" | "openai";

  /** LLM model for the agent */
  model: string;

  /** LLM provider for supplier email responses (defaults to provider if not set) */
  supplierProvider?: "anthropic" | "cerebras" | "openai";

  /** LLM model for supplier email responses (defaults to model if not set) */
  supplierModel?: string;

  /** LLM provider for search-intent classification when Brave search is enabled */
  searchProvider?: "anthropic" | "cerebras" | "openai";

  /** LLM model for search-intent classification */
  searchModel?: string;

  /** Number of simulated days */
  totalDays: number;

  /** Maximum token budget for context window */
  maxContextTokens: number;

  /** Maximum messages before forcing context trim */
  maxMessages: number;

  /** Checkpoint interval (save every N days, 0 = disabled) */
  checkpointInterval: number;

  /** Log directory */
  logDir: string;

  /** Whether to use LLM for supplier email responses (vs static) */
  useLlmSuppliers: boolean;

  /** Event system temperature (0 = no events, 1 = full rate) */
  eventTemperature: number;

  /** Seed for deterministic event randomness */
  eventSeed: number;

  /** Anthropic API key (from env if not set) */
  apiKey?: string;
}

export const DEFAULT_CONFIG: SimulationConfig = {
  mode: "direct",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  totalDays: 365,
  maxContextTokens: 69_000,
  maxMessages: 200,
  checkpointInterval: 30,
  logDir: "logs",
  useLlmSuppliers: true,
  eventTemperature: 0.5,
  eventSeed: 42,
};

function resolveApiKey(provider: "anthropic" | "cerebras" | "openai"): string | undefined {
  if (provider === "cerebras") {
    return process.env["CEREBRAS_API_KEY"] ?? undefined;
  }
  if (provider === "openai") {
    return process.env["OPENAI_API_KEY"] ?? undefined;
  }
  return (
    process.env["ANTHROPIC_API_KEY"] ??
    process.env["CLAUDE_API_KEY"] ??
    undefined
  );
}

export function resolveConfig(
  overrides: Partial<SimulationConfig> = {},
): SimulationConfig {
  const provider =
    overrides.provider ??
    ((process.env["VENDING_BENCH_PROVIDER"] as "anthropic" | "cerebras" | "openai" | undefined) ??
      DEFAULT_CONFIG.provider);
  const supplierProvider =
    overrides.supplierProvider ??
    ((process.env["VENDING_BENCH_SUPPLIER_PROVIDER"] as "anthropic" | "cerebras" | "openai" | undefined) ??
      provider);
  const searchProvider =
    overrides.searchProvider ??
    ((process.env["VENDING_BENCH_SEARCH_PROVIDER"] as "anthropic" | "cerebras" | "openai" | undefined) ??
      supplierProvider);

  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    provider,
    supplierProvider,
    searchProvider,
    model: overrides.model ?? process.env["VENDING_BENCH_MODEL"] ?? DEFAULT_CONFIG.model,
    supplierModel:
      overrides.supplierModel ??
      process.env["VENDING_BENCH_SUPPLIER_MODEL"] ??
      overrides.model ??
      process.env["VENDING_BENCH_MODEL"] ??
      DEFAULT_CONFIG.model,
    searchModel:
      overrides.searchModel ??
      process.env["VENDING_BENCH_SEARCH_MODEL"] ??
      overrides.supplierModel ??
      process.env["VENDING_BENCH_SUPPLIER_MODEL"] ??
      overrides.model ??
      process.env["VENDING_BENCH_MODEL"] ??
      DEFAULT_CONFIG.model,
    useLlmSuppliers:
      overrides.useLlmSuppliers ??
      (process.env["VENDING_BENCH_USE_LLM_SUPPLIERS"] === undefined
        ? DEFAULT_CONFIG.useLlmSuppliers
        : process.env["VENDING_BENCH_USE_LLM_SUPPLIERS"] === "true"),
    apiKey: overrides.apiKey ?? resolveApiKey(provider),
  };
}
