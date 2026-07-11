/**
 * Tool-use loop: generate → parse tool_calls → execute → repeat.
 *
 * This is the core agent loop for "direct" mode.
 * It calls the LLM with the current message history and available tools,
 * executes any tool calls, and continues until the agent stops calling tools
 * or calls wait_for_next_day.
 */

import type { SimulationConfig } from "../config.js";
import type { CostTracker } from "../cost-tracker.js";
import { advanceTime, isDayOver, formatDayTime } from "../simulation/time.js";
import type { VendingWorld } from "../simulation/world.js";
import { getToolByName, getOpenAiToolDefs } from "../tools/index.js";
import {
  createProviderMessage,
  resolvePrimaryProviderConfig,
  toAnthropicTools,
  toAnthropicMessages,
  type ChatMessage,
  type ProviderResponse,
} from "./client.js";
import { trimMessages } from "./context.js";

const MEMORY_KEYS = [
  "financial_plan",
  "machine_strategy",
  "inventory_policy",
  "active_commitments",
  "risks",
  "next_actions",
] as const;

type MemoryKey = (typeof MEMORY_KEYS)[number];

type KeyValueStore = {
  get?: (key: string) => unknown;
  set?: (key: string, value: string) => unknown;
  read?: (key: string) => unknown;
  write?: (key: string, value: string) => unknown;
};

const MEMORY_BRIEFING_MAX_CHARS = 1600;
const MEMORY_ENTRY_MAX_CHARS = 600;
const MEMORY_VALUE_MAX_CHARS = 1200;

function getMemoryStore(world: VendingWorld): KeyValueStore | undefined {
  const candidate = world as unknown as {
    kv?: unknown;
    memory?: unknown;
    state?: { kv?: unknown };
  };

  for (const store of [candidate.kv, candidate.memory, candidate.state?.kv]) {
    if (
      store &&
      typeof store === "object" &&
      (typeof (store as KeyValueStore).get === "function" ||
        typeof (store as KeyValueStore).read === "function")
    ) {
      return store as KeyValueStore;
    }
  }

  return undefined;
}

function stringifyMemoryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function readMemoryValue(
  store: KeyValueStore,
  key: MemoryKey,
): Promise<string> {
  const value =
    typeof store.get === "function"
      ? await Promise.resolve(store.get(key))
      : typeof store.read === "function"
        ? await Promise.resolve(store.read(key))
        : undefined;

  return stringifyMemoryValue(value);
}

async function writeMemoryValue(
  store: KeyValueStore,
  key: MemoryKey,
  value: string,
): Promise<void> {
  if (typeof store.set === "function") {
    await Promise.resolve(store.set(key, value));
  } else if (typeof store.write === "function") {
    await Promise.resolve(store.write(key, value));
  }
}

async function buildMemoryBriefing(world: VendingWorld): Promise<string> {
  const store = getMemoryStore(world);
  if (!store) return "";

  try {
    const entries: string[] = [];

    for (const key of MEMORY_KEYS) {
      const value = await readMemoryValue(store, key);
      if (!value) continue;

      const remaining = MEMORY_BRIEFING_MAX_CHARS -
        entries.join("\n").length;
      if (remaining <= 0) break;

      const label = key.replace(/_/g, " ");
      const entry = `${label}: ${value}`;
      entries.push(entry.slice(0, remaining));
    }

    if (entries.length === 0) return "";

    return [
      "Durable operational memory briefing. Treat this as current working context; update plans using tools and current observations.",
      ...entries,
    ].join("\n").slice(0, MEMORY_BRIEFING_MAX_CHARS);
  } catch (error) {
    console.warn(
      `  [MEMORY ERROR] Unable to read operational memory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

function affectedMemoryKeys(
  toolName: string,
  resultOutput: string,
  dayTransition: boolean,
): MemoryKey[] {
  const text = `${toolName} ${resultOutput}`.toLowerCase();
  const keys = new Set<MemoryKey>();

  if (/\b(cash|money|revenue|profit|cost|budget|price|financial|expense|sale)\b/.test(text)) {
    keys.add("financial_plan");
  }
  if (/\b(machine|location|relocat|upgrade|repair|purchase|buy)\b/.test(text)) {
    keys.add("machine_strategy");
  }
  if (/\b(inventory|stock|restock|product|supply|item|capacity)\b/.test(text)) {
    keys.add("inventory_policy");
  }
  if (/\b(commit|order|contract|reservation|scheduled|pending|delivery)\b/.test(text)) {
    keys.add("active_commitments");
  }
  if (/\b(error|failed|failure|warning|risk|low stock|broken|maintenance|unavailable)\b/.test(text)) {
    keys.add("risks");
  }
  if (
    dayTransition ||
    /\b(next action|next step|should|need to|todo|to do|tomorrow)\b/.test(text)
  ) {
    keys.add("next_actions");
  }

  return [...keys];
}

async function updateOperationalMemory(
  world: VendingWorld,
  toolName: string,
  resultOutput: string,
  dayTransition: boolean,
): Promise<void> {
  const store = getMemoryStore(world);
  if (!store) return;

  const keys = affectedMemoryKeys(toolName, resultOutput, dayTransition);
  if (keys.length === 0) return;

  const entry = `${formatDayTime(world.time)} ${toolName}: ${resultOutput}`
    .replace(/\s+/g, " ")
    .slice(0, MEMORY_ENTRY_MAX_CHARS);

  try {
    for (const key of keys) {
      const existing = await readMemoryValue(store, key);
      const value = existing
        ? `${existing}\n${entry}`.slice(-MEMORY_VALUE_MAX_CHARS)
        : entry;

      await writeMemoryValue(store, key, value);
    }
  } catch (error) {
    console.warn(
      `  [MEMORY ERROR] Unable to update operational memory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface ToolLoopResult {
  /** Whether wait_for_next_day was called */
  dayEnded: boolean;
  /** Updated message history */
  messages: ChatMessage[];
  /** Number of LLM calls made this loop */
  llmCalls: number;
  /** Number of tool executions */
  toolExecutions: number;
}

/**
 * Run one iteration of the tool-use loop until the day ends or the agent stops.
 */
export async function runToolLoop(
  world: VendingWorld,
  messages: ChatMessage[],
  config: SimulationConfig,
  costTracker?: CostTracker,
): Promise<ToolLoopResult> {
  const providerConfig = resolvePrimaryProviderConfig(config);
  const oaiToolDefs = getOpenAiToolDefs();
  const anthropicTools = toAnthropicTools(oaiToolDefs);
  let llmCalls = 0;
  let toolExecutions = 0;
  let dayEnded = false;

  const MAX_ITERATIONS = 50; // Safety limit per day

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Check if it's too late in the day
    if (isDayOver(world.time)) {
      dayEnded = true;
      break;
    }

    // Trim messages to fit context window
    const trimmedMessages = trimMessages(messages, config.maxContextTokens);
    const memoryBriefing = await buildMemoryBriefing(world);
    const contextualMessages = memoryBriefing
      ? [{ role: "system" as const, content: memoryBriefing }, ...trimmedMessages]
      : trimmedMessages;

    // Convert to Anthropic format
    const { system, messages: anthropicMessages } =
      toAnthropicMessages(contextualMessages);

    // Call LLM
    let response: ProviderResponse;
    try {
      response = await createProviderMessage({
        providerConfig,
        system,
        messages: anthropicMessages,
        tools: anthropicTools,
        maxTokens: 4096,
        temperature: 0.45,
      });
      llmCalls++;

      // Record token usage
      if (costTracker && response.usage) {
        costTracker.recordUsage({
          model: providerConfig.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          category: "agent",
        });
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`  [LLM ERROR] ${errMsg}`);
      messages.push({
        role: "assistant",
        content: `[System: LLM call failed - ${errMsg}. Please try again or call wait_for_next_day.]`,
      });
      break;
    }

    // Parse response content blocks
    let textContent = "";
    const toolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];

    for (const block of response.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    // Log the agent's thinking
    if (textContent) {
      console.log(`  [AGENT] ${textContent}`);
    }

    // Build assistant message for history
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: textContent || null,
      tool_calls: toolUses.map((tu) => ({
        id: tu.id,
        type: "function" as const,
        function: {
          name: tu.name,
          arguments: JSON.stringify(tu.input),
        },
      })),
    };

    // If no tool calls, drop the empty array
    if (assistantMsg.tool_calls!.length === 0) {
      delete assistantMsg.tool_calls;
    }

    messages.push(assistantMsg);

    // If no tool calls, the agent is done
    if (toolUses.length === 0) {
      break;
    }

    // Execute tool calls sequentially
    for (const toolUse of toolUses) {
      const tool = getToolByName(toolUse.name);

      let resultOutput: string;
      let dayTransition = false;

      if (!tool) {
        resultOutput = `Error: unknown tool "${toolUse.name}". Available tools: ${oaiToolDefs.map((t) => t.function.name).join(", ")}`;
      } else {
        try {
          const result = await tool.execute(toolUse.input, world);
          resultOutput = result.output;
          toolExecutions++;

          // Advance simulated time
          world.time = advanceTime(world.time, tool.timeCost);
          dayTransition = result.endDay || isDayOver(world.time);

          // Log tool execution
          const argsStr = JSON.stringify(toolUse.input);
          const argsPreview = argsStr.length > 80 ? argsStr.slice(0, 80) + "..." : argsStr;
          console.log(
            `  [${formatDayTime(world.time)}] ${toolUse.name}(${argsPreview})`,
          );
          // Log the result (truncated)
          const resultPreview = resultOutput.length > 200 ? resultOutput.slice(0, 200) + "..." : resultOutput;
          console.log(`    → ${resultPreview}`);

          // Check if day ended
          if (result.endDay) {
            dayEnded = true;
          }
        } catch (error) {
          resultOutput = `Error executing ${toolUse.name}: ${error instanceof Error ? error.message : String(error)}`;
          console.log(`  [ERROR] ${resultOutput}`);
        }
      }

      await updateOperationalMemory(
        world,
        toolUse.name,
        resultOutput,
        dayTransition,
      );

      // Add tool result to message history
      messages.push({
        role: "tool",
        tool_call_id: toolUse.id,
        content: resultOutput,
      });

      // Stop processing more tool calls if day ended
      if (dayEnded) break;
    }

    if (dayEnded) break;

    // If the LLM signaled end_turn, stop
    if (response.stopReason === "end_turn" && toolUses.length === 0) {
      break;
    }
  }

  return { dayEnded, messages, llmCalls, toolExecutions };
}