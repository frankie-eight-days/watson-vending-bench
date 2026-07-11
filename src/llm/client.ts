import Anthropic from "@anthropic-ai/sdk";
import type { SimulationConfig } from "../config.js";

export type SupportedProvider = "anthropic" | "cerebras" | "openai";

/**
 * Base URL for OpenAI-compatible chat/completions providers.
 * `cerebras` targets the Cerebras cloud; `openai` targets the OpenAI API (or an
 * OpenAI-compatible gateway via OPENAI_BASE_URL) and is how Watson runs the
 * `gpt-5.6-terra` / `gpt-5.6-luna` agents-under-test.
 */
function openAiCompatibleBaseUrl(provider: SupportedProvider): string {
  if (provider === "cerebras") {
    return "https://api.cerebras.ai/v1";
  }
  const base = process.env["OPENAI_BASE_URL"]?.trim();
  return (base && base.length > 0 ? base : "https://api.openai.com/v1").replace(/\/+$/, "");
}

const anthropicClients = new Map<string, Anthropic>();

function getAnthropicClient(apiKey: string): Anthropic {
  let client = anthropicClients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey });
    anthropicClients.set(apiKey, client);
  }
  return client;
}

/** Reset cached clients (useful for tests or config changes). */
export function resetClient(): void {
  anthropicClients.clear();
}

/**
 * Message types for our conversation history.
 * We use a simplified format and convert to provider-specific payloads at call time.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** OpenAI-style function def — we convert to provider-specific formats at call time. */
export interface ToolFunctionDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderConfig {
  provider: SupportedProvider;
  apiKey: string;
  model: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage?: ProviderUsage;
}

type CerebrasMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

type CerebrasResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

export function resolveProviderApiKey(provider: SupportedProvider): string | undefined {
  if (provider === "cerebras") {
    return process.env["CEREBRAS_API_KEY"] ?? undefined;
  }
  if (provider === "openai") {
    return process.env["OPENAI_API_KEY"] ?? undefined;
  }
  return process.env["ANTHROPIC_API_KEY"] ?? process.env["CLAUDE_API_KEY"] ?? undefined;
}

export function resolvePrimaryProviderConfig(config: SimulationConfig): ProviderConfig {
  return resolveProviderConfig({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
  });
}

export function resolveSupplierProviderConfig(config: SimulationConfig): ProviderConfig {
  return resolveProviderConfig({
    provider: config.supplierProvider ?? config.provider,
    model: config.supplierModel ?? config.model,
    apiKey: resolveProviderApiKey(config.supplierProvider ?? config.provider),
  });
}

export function resolveSearchProviderConfig(config?: Partial<SimulationConfig>): ProviderConfig {
  const provider =
    config?.searchProvider ??
    (process.env["VENDING_BENCH_SEARCH_PROVIDER"] as SupportedProvider | undefined) ??
    config?.supplierProvider ??
    config?.provider ??
    (process.env["VENDING_BENCH_SUPPLIER_PROVIDER"] as SupportedProvider | undefined) ??
    (process.env["VENDING_BENCH_PROVIDER"] as SupportedProvider | undefined) ??
    "anthropic";
  const model =
    config?.searchModel ??
    process.env["VENDING_BENCH_SEARCH_MODEL"] ??
    config?.supplierModel ??
    config?.model ??
    process.env["VENDING_BENCH_SUPPLIER_MODEL"] ??
    process.env["VENDING_BENCH_MODEL"] ??
    (provider === "cerebras"
      ? "zai-glm-4.7"
      : provider === "openai"
        ? "gpt-5.6-luna"
        : "claude-haiku-4-5-20251001");
  return resolveProviderConfig({
    provider,
    model,
    apiKey: resolveProviderApiKey(provider),
  });
}

function resolveProviderConfig(params: {
  provider: SupportedProvider;
  model: string;
  apiKey?: string;
}): ProviderConfig {
  const apiKey = params.apiKey ?? resolveProviderApiKey(params.provider);
  if (!apiKey) {
    throw new Error(`Missing API key for provider "${params.provider}"`);
  }
  return {
    provider: params.provider,
    apiKey,
    model: params.model,
  };
}

/**
 * Convert our tool definitions to Anthropic's tool format.
 */
export function toAnthropicTools(
  defs: ToolFunctionDef[],
): Anthropic.Tool[] {
  return defs.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    input_schema: d.function.parameters as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Convert our ChatMessage[] to Anthropic's messages format.
 * Anthropic requires alternating user/assistant roles and separate system param.
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
): { system: string; messages: Anthropic.MessageParam[] } {
  let system = "";
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system += (system ? "\n\n" : "") + (msg.content ?? "");
      continue;
    }

    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content ?? "" });
    } else if (msg.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            // ignore malformed tool arguments
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      if (content.length > 0) {
        out.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: msg.content ?? "",
          },
        ],
      });
    }
  }

  const merged: Anthropic.MessageParam[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      const lastContent = Array.isArray(last.content)
        ? last.content
        : [{ type: "text" as const, text: last.content as string }];
      const newContent = Array.isArray(m.content)
        ? m.content
        : [{ type: "text" as const, text: m.content as string }];
      (last as { content: unknown[] }).content = [
        ...lastContent,
        ...newContent,
      ];
    } else {
      merged.push(m);
    }
  }

  return { system, messages: merged };
}

export async function createProviderMessage(params: {
  providerConfig: ProviderConfig;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  temperature?: number;
}): Promise<ProviderResponse> {
  if (
    params.providerConfig.provider === "cerebras" ||
    params.providerConfig.provider === "openai"
  ) {
    return createOpenAiCompatibleMessage(params);
  }
  return createAnthropicMessage(params);
}

async function createAnthropicMessage(params: {
  providerConfig: ProviderConfig;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  temperature?: number;
}): Promise<ProviderResponse> {
  const client = getAnthropicClient(params.providerConfig.apiKey);
  const response = await client.messages.create({
    model: params.providerConfig.model,
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    max_tokens: params.maxTokens,
    ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
  });

  return {
    content: response.content,
    stopReason: response.stop_reason ?? null,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      : undefined,
  };
}

async function createOpenAiCompatibleMessage(params: {
  providerConfig: ProviderConfig;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  temperature?: number;
}): Promise<ProviderResponse> {
  const provider = params.providerConfig.provider;
  const isOpenAi = provider === "openai";

  // GPT-5.x family (served over the OpenAI API) uses `max_completion_tokens`
  // rather than `max_tokens`, and rejects non-default `temperature`. Cerebras
  // uses the classic `max_tokens` field and accepts `temperature`.
  const tokenLimitField = isOpenAi
    ? { max_completion_tokens: params.maxTokens }
    : { max_tokens: params.maxTokens };
  const temperatureField =
    !isOpenAi && typeof params.temperature === "number"
      ? { temperature: params.temperature }
      : {};

  // GPT-5.6 reasoning models reject function tools on /v1/chat/completions
  // unless reasoning is disabled ("Function tools with reasoning_effort are not
  // supported ... set reasoning_effort to 'none'"). Running the agent-under-test
  // without reasoning also keeps luna fast + cheap, which is what we want here.
  const reasoningField = isOpenAi ? { reasoning_effort: "none" } : {};

  const payload = {
    model: params.providerConfig.model,
    messages: toCerebrasMessages(params.system, params.messages),
    tools: params.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    })),
    ...tokenLimitField,
    ...temperatureField,
    ...reasoningField,
  };

  const res = await fetch(`${openAiCompatibleBaseUrl(provider)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.providerConfig.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${provider} API error ${res.status}: ${body}`);
  }

  const json = await res.json() as CerebrasResponse;
  const choice = json.choices?.[0];
  const message = choice?.message;
  const content: Anthropic.ContentBlock[] = [];

  if (message?.content) {
    content.push({ type: "text", text: message.content } as Anthropic.TextBlock);
  }

  for (const toolCall of message?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(toolCall.function?.arguments ?? "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: toolCall.id ?? `tool_${content.length + 1}`,
      name: toolCall.function?.name ?? "unknown_tool",
      input,
    } as Anthropic.ToolUseBlock);
  }

  return {
    content,
    stopReason: choice?.finish_reason === "tool_calls" ? "tool_use" : (choice?.finish_reason ?? null),
    usage: json.usage
      ? {
          inputTokens: json.usage.prompt_tokens ?? 0,
          outputTokens: json.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

function toCerebrasMessages(
  system: string | undefined,
  messages: Anthropic.MessageParam[],
): CerebrasMessage[] {
  const out: CerebrasMessage[] = [];
  if (system?.trim()) {
    out.push({ role: "system", content: system });
  }

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: NonNullable<CerebrasMessage["tool_calls"]> = [];
      for (const block of message.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      out.push({
        role: "assistant",
        content: textParts.join("\n"),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const toolResults = message.content.filter(
      (block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        });
      }
      continue;
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    out.push({ role: message.role, content: text });
  }

  return out;
}
