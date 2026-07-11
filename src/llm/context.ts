/**
 * Context window management.
 *
 * Maintains a sliding window of messages that fits within the token budget.
 * Uses a rough character-based estimate (1 token ≈ 4 chars) for simplicity.
 * A proper tokenizer (tiktoken) can be added later for accuracy.
 */

import type { ChatMessage } from "./client.js";

const CHARS_PER_TOKEN = 4;
const DURABLE_MEMORY_PREFIX = "[[vending-bench-durable-memory]]";
const MEMORY_NAMESPACE = "vending-bench:durable-memory";
const MEMORY_FIELDS = [
  "decisions",
  "inventoryPricingPolicy",
  "debts",
  "recurringObligations",
  "unresolvedTasks",
  "recentOutcomes",
] as const;
const MAX_MEMORY_ITEMS_PER_FIELD = 2;
const MAX_MEMORY_ITEM_CHARS = 80;

type MemoryField = (typeof MEMORY_FIELDS)[number];

interface DurableMemory {
  version: 1;
  decisions: string[];
  inventoryPricingPolicy: string[];
  debts: string[];
  recurringObligations: string[];
  unresolvedTasks: string[];
  recentOutcomes: string[];
}

interface CompactionWorld {
  scratchpad?: unknown;
  kv?: {
    set?: (key: string, value: string) => unknown;
  };
}

/**
 * Estimate token count for a message.
 */
export function estimateTokens(message: ChatMessage): number {
  let chars = 0;
  if (message.content) {
    chars += message.content.length;
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      chars += tc.function.name.length + (tc.function.arguments?.length ?? 0);
    }
  }
  // Add overhead for role, metadata
  chars += 20;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate total tokens for a list of messages.
 */
export function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

function emptyDurableMemory(): DurableMemory {
  return {
    version: 1,
    decisions: [],
    inventoryPricingPolicy: [],
    debts: [],
    recurringObligations: [],
    unresolvedTasks: [],
    recentOutcomes: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMemoryItems(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.replace(/\s+/g, " ").trim();
    if (
      normalized &&
      !items.includes(normalized) &&
      items.length < MAX_MEMORY_ITEMS_PER_FIELD
    ) {
      items.push(normalized.slice(0, MAX_MEMORY_ITEM_CHARS));
    }
  }
  return items;
}

function parseDurableMemory(value: unknown): DurableMemory | undefined {
  let candidate = value;

  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }

  if (!isRecord(candidate)) {
    return undefined;
  }

  const memory = emptyDurableMemory();
  for (const field of MEMORY_FIELDS) {
    memory[field] = normalizeMemoryItems(candidate[field]);
  }

  return memory;
}

function readDurableMemory(
  messages: ChatMessage[],
  world?: CompactionWorld,
): DurableMemory | undefined {
  if (world?.scratchpad !== undefined) {
    const scratchpad = world.scratchpad;
    if (isRecord(scratchpad) && scratchpad.durableMemory !== undefined) {
      const memory = parseDurableMemory(scratchpad.durableMemory);
      if (memory) {
        return memory;
      }
    }

    const memory = parseDurableMemory(scratchpad);
    if (memory) {
      return memory;
    }
  }

  for (const message of messages) {
    if (
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(DURABLE_MEMORY_PREFIX)
    ) {
      const memory = parseDurableMemory(
        message.content.slice(DURABLE_MEMORY_PREFIX.length).trim(),
      );
      if (memory) {
        return memory;
      }
    }
  }

  return undefined;
}

function isDurableMemoryMessage(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    typeof message.content === "string" &&
    message.content.startsWith(DURABLE_MEMORY_PREFIX)
  );
}

function addMemoryItem(
  memory: DurableMemory,
  field: MemoryField,
  text: string,
): void {
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_ITEM_CHARS);
  if (!normalized || memory[field].includes(normalized)) {
    return;
  }

  memory[field].push(normalized);
  if (memory[field].length > MAX_MEMORY_ITEMS_PER_FIELD) {
    memory[field].shift();
  }
}

function compactMemory(
  previous: DurableMemory | undefined,
  evictedMessages: ChatMessage[],
): DurableMemory {
  const memory = previous
    ? {
        version: 1 as const,
        decisions: [...previous.decisions],
        inventoryPricingPolicy: [...previous.inventoryPricingPolicy],
        debts: [...previous.debts],
        recurringObligations: [...previous.recurringObligations],
        unresolvedTasks: [...previous.unresolvedTasks],
        recentOutcomes: [...previous.recentOutcomes],
      }
    : emptyDurableMemory();

  for (const message of evictedMessages) {
    if (typeof message.content !== "string") {
      continue;
    }

    const text = message.content.replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    if (/\b(decid(?:e|ed|ing)|choice|choose|chosen|plan|policy)\b/i.test(text)) {
      addMemoryItem(memory, "decisions", text);
    }
    if (
      /\b(inventory|stock|restock|sku|price|pricing|margin|discount|cost)\b/i.test(
        text,
      )
    ) {
      addMemoryItem(memory, "inventoryPricingPolicy", text);
    }
    if (/\b(debt|owe[sd]?|loan|creditor|arrears|balance due)\b/i.test(text)) {
      addMemoryItem(memory, "debts", text);
    }
    if (
      /\b(recurring|monthly|weekly|daily|subscription|rent|payroll|schedule)\b/i.test(
        text,
      )
    ) {
      addMemoryItem(memory, "recurringObligations", text);
    }
    if (
      /\b(todo|task|pending|unresolved|follow up|follow-up|need to|remaining|blocked)\b/i.test(
        text,
      )
    ) {
      addMemoryItem(memory, "unresolvedTasks", text);
    }
    if (
      /\b(outcome|sold|sale|revenue|profit|loss|completed|success|failed|result)\b/i.test(
        text,
      )
    ) {
      addMemoryItem(memory, "recentOutcomes", text);
    }
  }

  return memory;
}

function memoryMessage(memory: DurableMemory): ChatMessage {
  return {
    role: "system",
    content: `${DURABLE_MEMORY_PREFIX}\n${JSON.stringify(memory)}`,
  };
}

async function persistDurableMemory(
  world: CompactionWorld | undefined,
  memory: DurableMemory,
): Promise<void> {
  if (!world) {
    return;
  }

  try {
    if (isRecord(world.scratchpad)) {
      world.scratchpad = {
        ...world.scratchpad,
        durableMemory: memory,
      };
    } else {
      world.scratchpad = { durableMemory: memory };
    }
  } catch {
    // Context compaction must not prevent a model request when persistence fails.
  }

  if (!world.kv?.set) {
    return;
  }

  try {
    await world.kv.set(`${MEMORY_NAMESPACE}:record`, JSON.stringify(memory));
    for (const field of MEMORY_FIELDS) {
      await world.kv.set(
        `${MEMORY_NAMESPACE}:${field}`,
        JSON.stringify(memory[field]),
      );
    }
  } catch {
    // Scratchpad persistence remains available when the optional KV store fails.
  }
}

/**
 * Trim messages to fit within the token budget.
 * Always keeps system messages, the durable memory record, and the most recent
 * messages. Before older turns are evicted, relevant business state is compacted
 * into a bounded durable record.
 */
export async function trimMessages(
  messages: ChatMessage[],
  maxTokens: number,
  world?: CompactionWorld,
): Promise<ChatMessage[]> {
  const nonMemoryMessages = messages.filter(
    (message) => !isDurableMemoryMessage(message),
  );
  const existingMemory = readDurableMemory(messages, world);
  const existingMemoryMessage = existingMemory
    ? memoryMessage(existingMemory)
    : undefined;
  const messagesWithMemory = existingMemoryMessage
    ? [existingMemoryMessage, ...nonMemoryMessages]
    : nonMemoryMessages;

  if (estimateTotalTokens(messagesWithMemory) <= maxTokens) {
    return messagesWithMemory;
  }

  const systemMessages = nonMemoryMessages.filter((m) => m.role === "system");
  const otherMessages = nonMemoryMessages.filter((m) => m.role !== "system");

  const provisionalMemory = existingMemory ?? emptyDurableMemory();
  const durableMessage = memoryMessage(provisionalMemory);
  const systemTokens = estimateTotalTokens(systemMessages);
  const memoryTokens = estimateTokens(durableMessage);
  const budgetForOther = maxTokens - systemTokens - memoryTokens;

  if (budgetForOther <= 0) {
    return systemTokens <= maxTokens
      ? [durableMessage, ...systemMessages]
      : systemMessages;
  }

  const kept: ChatMessage[] = [];
  let keptTokens = 0;

  for (let i = otherMessages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(otherMessages[i]!);
    if (keptTokens + msgTokens > budgetForOther) {
      break;
    }
    kept.unshift(otherMessages[i]!);
    keptTokens += msgTokens;
  }

  while (kept.length > 0) {
    const first = kept[0]!;
    if (first.role === "tool") {
      kept.shift();
    } else if (
      first.role === "assistant" &&
      first.tool_calls &&
      first.tool_calls.length > 0
    ) {
      const toolCallIds = new Set(first.tool_calls.map((tc) => tc.id));
      kept.shift();
      while (
        kept.length > 0 &&
        kept[0]!.role === "tool" &&
        kept[0]!.tool_call_id &&
        toolCallIds.has(kept[0]!.tool_call_id)
      ) {
        kept.shift();
      }
    } else {
      break;
    }
  }

  const evictedMessages = otherMessages.slice(
    0,
    otherMessages.length - kept.length,
  );
  const compactedMemory = compactMemory(existingMemory, evictedMessages);
  await persistDurableMemory(world, compactedMemory);

  return [memoryMessage(compactedMemory), ...systemMessages, ...kept];
}