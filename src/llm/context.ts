/**
 * Context window management.
 *
 * Maintains a sliding window of messages that fits within the token budget.
 * Uses a rough character-based estimate (1 token ≈ 4 chars) for simplicity.
 * A proper tokenizer (tiktoken) can be added later for accuracy.
 */

import type { ChatMessage, ProviderConfig } from "./client.js";
import { createProviderMessage, toAnthropicMessages } from "./client.js";
import type { CostTracker } from "../cost-tracker.js";

const CHARS_PER_TOKEN = 4;

/** Marker prefix identifying the pinned running-memory note produced by compaction. */
export const MEMORY_MARKER = "[MEMORY]";

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

/**
 * Trim messages to fit within the token budget.
 * Always keeps the system message (first) and the most recent messages.
 * Removes the oldest non-system messages first.
 */
export function trimMessages(
  messages: ChatMessage[],
  maxTokens: number,
): ChatMessage[] {
  const totalTokens = estimateTotalTokens(messages);
  if (totalTokens <= maxTokens) {
    return messages;
  }

  // Separate system message from the rest
  const systemMessages = messages.filter((m) => m.role === "system");
  const otherMessages = messages.filter((m) => m.role !== "system");

  const systemTokens = estimateTotalTokens(systemMessages);
  const budgetForOther = maxTokens - systemTokens;

  if (budgetForOther <= 0) {
    // System message alone exceeds budget — just return it truncated
    return systemMessages;
  }

  // Keep messages from the end until we exceed the budget
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

  // Drop orphaned messages at the start of the kept window.
  // Anthropic requires every tool_result to have a matching tool_use
  // in the immediately preceding assistant message. If trimming cut
  // away that assistant message, the tool results cause a 400 error.
  // Also drop assistant+tool_call messages whose tool results may be
  // incomplete. We want the window to start with a clean user message.
  let cleaned = false;
  while (!cleaned && kept.length > 0) {
    const first = kept[0]!;
    if (first.role === "tool") {
      // Orphaned tool result — its assistant/tool_use was trimmed
      kept.shift();
    } else if (
      first.role === "assistant" &&
      first.tool_calls &&
      first.tool_calls.length > 0
    ) {
      // Assistant with tool_calls at boundary — tool results may be
      // incomplete, and this creates a broken tool_use/tool_result pair
      const toolCallIds = new Set(first.tool_calls.map((tc) => tc.id));
      kept.shift();
      // Also drop any following tool results for these calls
      while (
        kept.length > 0 &&
        kept[0]!.role === "tool" &&
        kept[0]!.tool_call_id &&
        toolCallIds.has(kept[0]!.tool_call_id)
      ) {
        kept.shift();
      }
    } else {
      cleaned = true;
    }
  }

  return [...systemMessages, ...kept];
}

// ===========================================================================
// Memory compaction (Pitch A — summarize-on-evict instead of lossy drop)
// ===========================================================================
//
// The plain `trimMessages` sliding window HARD-DROPS the oldest messages once
// history overflows `maxContextTokens` — the supplier contacts, agreed unit
// costs, inventory, and open orders the agent discovered early are simply gone.
// Over the Vending-Bench horizon this is the documented coherence collapse
// (Backlund & Petersson, arXiv:2502.15840).
//
// `compactMessages` replaces eviction-by-deletion with eviction-by-summary,
// MemGPT-style (Packer et al., arXiv:2310.08560): when the window overflows we
// take the oldest evictable block, fold it (plus any prior memory) into a single
// pinned `[MEMORY]` note via a cheap LLM call, and keep that note in context
// instead of dropping the facts. The note lives as a pinned system message so it
// survives all future trimming; recursive overflow re-summarizes note + newly
// evicted block into an updated note.

/** Reserve for the pinned running-memory note (tokens). */
const MEMORY_BUDGET_TOKENS = 1400;
/** Max tokens the summarizer may emit for the note. */
const MEMORY_MAX_OUTPUT_TOKENS = 1024;

/** Is this message the pinned running-memory note? */
function isMemoryNote(m: ChatMessage): boolean {
  return m.role === "system" && (m.content ?? "").startsWith(MEMORY_MARKER);
}

/** Render one message to compact plain text for the summarizer input. */
function renderForSummary(m: ChatMessage): string {
  const parts: string[] = [];
  if (m.content) parts.push(m.content);
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      parts.push(`<call ${tc.function.name}> ${tc.function.arguments ?? ""}`);
    }
  }
  const body = parts.join(" ");
  if (m.role === "tool") return `TOOL_RESULT: ${body}`;
  return `${m.role.toUpperCase()}: ${body}`;
}

/**
 * Drop-in replacement for `trimMessages` that summarizes evicted history into a
 * pinned `[MEMORY]` note instead of discarding it. Mutates `messages` in place
 * (so the compaction happens once and history genuinely shrinks) and returns it.
 * On any summarizer failure it falls back to the lossy `trimMessages` so a run
 * never breaks on compaction.
 */
export async function compactMessages(
  messages: ChatMessage[],
  maxTokens: number,
  summarizer: ProviderConfig,
  costTracker?: CostTracker,
): Promise<ChatMessage[]> {
  if (estimateTotalTokens(messages) <= maxTokens) {
    return messages;
  }

  // Partition: pinned system prompt(s), the existing memory note, conversation.
  const primarySystem = messages.filter((m) => m.role === "system" && !isMemoryNote(m));
  const existingMemory = messages.find(isMemoryNote) ?? null;
  const conversation = messages.filter((m) => m.role !== "system");

  const systemTokens = estimateTotalTokens(primarySystem);
  const budgetForTail = maxTokens - systemTokens - MEMORY_BUDGET_TOKENS;

  if (budgetForTail <= 0) {
    // Not enough room even for the note — fall back to lossy trim.
    return trimMessages(messages, maxTokens);
  }

  // Keep the most recent conversation messages that fit the tail budget.
  const keptTail: ChatMessage[] = [];
  let keptTokens = 0;
  let splitIdx = conversation.length; // everything before this index is evicted
  for (let i = conversation.length - 1; i >= 0; i--) {
    const t = estimateTokens(conversation[i]!);
    if (keptTokens + t > budgetForTail) break;
    keptTail.unshift(conversation[i]!);
    keptTokens += t;
    splitIdx = i;
  }
  const evicted = conversation.slice(0, splitIdx);

  if (evicted.length === 0) {
    // Nothing old enough to summarize; just trim safely.
    return trimMessages(messages, maxTokens);
  }

  // Build the summarization request: prior memory + evicted transcript.
  const transcript = evicted.map(renderForSummary).join("\n");
  const priorMemory = existingMemory ? existingMemory.content ?? "" : "(none yet)";
  const instruction =
    "You are the memory compaction module for an autonomous vending-machine " +
    "business agent running a long simulation. Compress the older conversation " +
    "below into an updated, durable running-memory note. PRESERVE every fact the " +
    "agent will need later: known suppliers and their contact emails, agreed unit " +
    "costs and MOQs, current storage and machine inventory, outstanding/expected " +
    "orders and deliveries, cash/bank balance, prices set, and any commitments or " +
    "unresolved problems. Drop chit-chat and redundant reasoning. Be concise and " +
    "factual (bullet points). Merge with the prior memory; do not lose earlier " +
    "facts. Output ONLY the note body.";

  const userText =
    `PRIOR RUNNING MEMORY:\n${priorMemory}\n\n` +
    `OLDER CONVERSATION TO FOLD IN:\n${transcript}`;

  let noteBody: string;
  try {
    const { system } = toAnthropicMessages([]); // no-op; keep import used & explicit
    void system;
    const response = await createProviderMessage({
      providerConfig: summarizer,
      system: instruction,
      messages: [{ role: "user", content: userText }],
      maxTokens: MEMORY_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    });
    if (costTracker && response.usage) {
      costTracker.recordUsage({
        model: summarizer.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        category: "agent",
      });
    }
    noteBody = response.content
      .filter((b): b is { type: "text"; text: string; citations: null } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!noteBody) throw new Error("empty summary");
  } catch (err) {
    console.error(
      `  [COMPACTION] summarizer failed (${err instanceof Error ? err.message : String(err)}); falling back to lossy trim`,
    );
    return trimMessages(messages, maxTokens);
  }

  console.log(
    `  [COMPACTION] folded ${evicted.length} messages into running memory (${estimateTokens({ role: "system", content: noteBody })} tok note)`,
  );

  const memoryNote: ChatMessage = {
    role: "system",
    content: `${MEMORY_MARKER} Running memory (durable facts compacted from earlier days):\n${noteBody}`,
  };

  // Clean orphaned tool results/calls at the tail boundary (same rule as trim).
  let cleaned = false;
  while (!cleaned && keptTail.length > 0) {
    const first = keptTail[0]!;
    if (first.role === "tool") {
      keptTail.shift();
    } else if (first.role === "assistant" && first.tool_calls && first.tool_calls.length > 0) {
      const ids = new Set(first.tool_calls.map((tc) => tc.id));
      keptTail.shift();
      while (
        keptTail.length > 0 &&
        keptTail[0]!.role === "tool" &&
        keptTail[0]!.tool_call_id &&
        ids.has(keptTail[0]!.tool_call_id)
      ) {
        keptTail.shift();
      }
    } else {
      cleaned = true;
    }
  }

  // Rebuild the persistent history in place: pinned system + memory + recent tail.
  const rebuilt: ChatMessage[] = [...primarySystem, memoryNote, ...keptTail];
  messages.length = 0;
  messages.push(...rebuilt);
  return messages;
}
