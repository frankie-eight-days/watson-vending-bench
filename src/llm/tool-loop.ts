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
  resolveSupplierProviderConfig,
  toAnthropicTools,
  toAnthropicMessages,
  type ChatMessage,
  type ProviderResponse,
} from "./client.js";
import { trimMessages, compactMessages } from "./context.js";

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
  // Pitch A: a cheap summarizer for memory compaction (reuse the supplier model,
  // which is the same small gpt-5.6-luna in the demo profile).
  const summarizerConfig = resolveSupplierProviderConfig(config);
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

    // Fit the context window. With memory compaction on (Pitch A), overflow is
    // summarized into a pinned [MEMORY] note (mutating `messages` in place) so
    // durable facts survive the horizon; otherwise fall back to lossy trimming.
    const trimmedMessages = config.useMemoryCompaction
      ? await compactMessages(messages, config.maxContextTokens, summarizerConfig, costTracker)
      : trimMessages(messages, config.maxContextTokens);

    // Convert to Anthropic format
    const { system, messages: anthropicMessages } =
      toAnthropicMessages(trimmedMessages);

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

      if (!tool) {
        resultOutput = `Error: unknown tool "${toolUse.name}". Available tools: ${oaiToolDefs.map((t) => t.function.name).join(", ")}`;
      } else {
        try {
          const result = await tool.execute(toolUse.input, world);
          resultOutput = result.output;
          toolExecutions++;

          // Advance simulated time
          world.time = advanceTime(world.time, tool.timeCost);

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
