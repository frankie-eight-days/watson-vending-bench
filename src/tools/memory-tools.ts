/**
 * Memory tools: scratchpad and key-value store.
 * These are the simplest tools — pure state manipulation.
 */

import type { ToolDefinition } from "./types.js";

interface FailureLesson {
  trigger: string;
  observedResult: string;
  correctedRule: string;
  tags: string[];
  sequence: number;
}

interface FailureLog {
  sequence: number;
  lessons: FailureLesson[];
}

const FAILURE_LOG_KEY = "__failure_log__";
const MAX_FAILURE_LESSONS = 12;
const MAX_LESSON_AGE = 40;
const MAX_RETRIEVED_LESSONS = 4;

function concise(value: string, maximumLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength - 1)}…`
    : normalized;
}

function parseTags(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => concise(tag.toLowerCase(), 48))
        .filter(Boolean),
    ),
  ).slice(0, 12);
}

function tagTokens(tag: string): string[] {
  return tag.split(/[^a-z0-9]+/).filter(Boolean);
}

function readFailureLog(store: Map<string, string>): FailureLog {
  const stored = store.get(FAILURE_LOG_KEY);
  if (!stored) return { sequence: 0, lessons: [] };

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") {
      return { sequence: 0, lessons: [] };
    }

    const record = parsed as { sequence?: unknown; lessons?: unknown };
    const sequence =
      typeof record.sequence === "number" && Number.isFinite(record.sequence)
        ? Math.max(0, record.sequence)
        : 0;

    if (!Array.isArray(record.lessons)) {
      return { sequence, lessons: [] };
    }

    const lessons = record.lessons.flatMap((lesson): FailureLesson[] => {
      if (!lesson || typeof lesson !== "object") return [];
      const candidate = lesson as {
        trigger?: unknown;
        observedResult?: unknown;
        correctedRule?: unknown;
        tags?: unknown;
        sequence?: unknown;
      };

      if (
        typeof candidate.trigger !== "string" ||
        typeof candidate.observedResult !== "string" ||
        typeof candidate.correctedRule !== "string" ||
        typeof candidate.sequence !== "number"
      ) {
        return [];
      }

      return [
        {
          trigger: concise(candidate.trigger),
          observedResult: concise(candidate.observedResult),
          correctedRule: concise(candidate.correctedRule),
          tags: Array.isArray(candidate.tags)
            ? candidate.tags
                .filter((tag): tag is string => typeof tag === "string")
                .map((tag) => concise(tag.toLowerCase(), 48))
                .filter(Boolean)
                .slice(0, 12)
            : [],
          sequence: candidate.sequence,
        },
      ];
    });

    return { sequence, lessons };
  } catch {
    return { sequence: 0, lessons: [] };
  }
}

function saveFailureLog(store: Map<string, string>, log: FailureLog): void {
  store.set(FAILURE_LOG_KEY, JSON.stringify(log));
}

function removeStaleLessons(log: FailureLog): void {
  log.lessons = log.lessons
    .filter((lesson) => log.sequence - lesson.sequence <= MAX_LESSON_AGE)
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, MAX_FAILURE_LESSONS);
}

function relevanceScore(lesson: FailureLesson, stateTags: string[]): number {
  if (stateTags.length === 0) return 0;

  const lessonTokens = new Set(lesson.tags.flatMap(tagTokens));
  let score = 0;

  for (const stateTag of stateTags) {
    if (lesson.tags.includes(stateTag)) {
      score += 10;
    }

    for (const token of tagTokens(stateTag)) {
      if (lessonTokens.has(token)) score += 1;
    }
  }

  return score;
}

export const writeScratchpad: ToolDefinition = {
  name: "write_scratchpad",
  description:
    "Write content to your scratchpad. This overwrites any existing content. Use this to keep notes, plans, and reminders.",
  parameters: {
    content: {
      type: "string",
      description: "The content to write to the scratchpad.",
    },
  },
  timeCost: "memory",
  execute(params, world) {
    const content = String(params["content"] ?? "");
    world.scratchpad = content;
    return { output: `Scratchpad updated (${content.length} characters).` };
  },
};

export const readScratchpad: ToolDefinition = {
  name: "read_scratchpad",
  description: "Read the current contents of your scratchpad.",
  parameters: {},
  timeCost: "memory",
  execute(_params, world) {
    if (!world.scratchpad) {
      return { output: "Scratchpad is empty." };
    }
    return { output: `Scratchpad contents:\n${world.scratchpad}` };
  },
};

export const deleteScratchpad: ToolDefinition = {
  name: "delete_scratchpad",
  description: "Clear all contents of your scratchpad.",
  parameters: {},
  timeCost: "memory",
  execute(_params, world) {
    world.scratchpad = "";
    return { output: "Scratchpad cleared." };
  },
};

export const keyValueStore: ToolDefinition = {
  name: "key_value_store",
  description:
    "A persistent key-value store for saving and retrieving data. Actions: get, set, delete, list, log_failure, retrieve_lessons. After bankruptcy risk, failed purchases, stockouts, unprofitable pricing, or rejected actions, use log_failure with a concise trigger, observed result, and corrected rule. Before the next action, use retrieve_lessons with current cash, debt, inventory, and machine-status tags.",
  parameters: {
    action: {
      type: "string",
      description: "The action to perform.",
      enum: [
        "get",
        "set",
        "delete",
        "list",
        "log_failure",
        "retrieve_lessons",
      ],
    },
    key: {
      type: "string",
      description: "The key to operate on (not needed for 'list').",
      required: false,
    },
    value: {
      type: "string",
      description: "The value to store (only needed for 'set').",
      required: false,
    },
    trigger: {
      type: "string",
      description:
        "For 'log_failure': the event that triggered the failure or risk.",
      required: false,
    },
    observed_result: {
      type: "string",
      description:
        "For 'log_failure': the concise observed result, such as a rejection, loss, stockout, or bankruptcy risk.",
      required: false,
    },
    corrected_rule: {
      type: "string",
      description:
        "For 'log_failure': the concise rule that should guide the corrected next attempt.",
      required: false,
    },
    tags: {
      type: "string",
      description:
        "For 'log_failure': comma-separated state tags relevant to the lesson, such as cash:low, debt:high, inventory:empty, or machine:broken.",
      required: false,
    },
    state_tags: {
      type: "string",
      description:
        "For 'retrieve_lessons': comma-separated current state tags, such as cash:low, debt:high, inventory:empty, or machine:broken.",
      required: false,
    },
  },
  timeCost: "memory",
  execute(params, world) {
    const action = String(params["action"] ?? "");
    const key = String(params["key"] ?? "");
    const value = String(params["value"] ?? "");

    switch (action) {
      case "get": {
        if (!key) return { output: "Error: 'key' is required for 'get'." };
        const stored = world.kvStore.get(key);
        if (stored === undefined) {
          return { output: `Key "${key}" not found.` };
        }
        return { output: `${key} = ${stored}` };
      }
      case "set": {
        if (!key) return { output: "Error: 'key' is required for 'set'." };
        world.kvStore.set(key, value);
        return { output: `Stored: ${key} = ${value}` };
      }
      case "delete": {
        if (!key) return { output: "Error: 'key' is required for 'delete'." };
        const existed = world.kvStore.delete(key);
        return {
          output: existed
            ? `Deleted key "${key}".`
            : `Key "${key}" not found.`,
        };
      }
      case "list": {
        if (world.kvStore.size === 0) {
          return { output: "Key-value store is empty." };
        }
        const entries = Array.from(world.kvStore.entries())
          .map(([k, v]) => `  ${k} = ${v}`)
          .join("\n");
        return {
          output: `Key-value store (${world.kvStore.size} entries):\n${entries}`,
        };
      }
      case "log_failure": {
        const trigger = concise(String(params["trigger"] ?? ""));
        const observedResult = concise(
          String(params["observed_result"] ?? ""),
        );
        const correctedRule = concise(
          String(params["corrected_rule"] ?? ""),
        );

        if (!trigger || !observedResult || !correctedRule) {
          return {
            output:
              "Error: 'trigger', 'observed_result', and 'corrected_rule' are required for 'log_failure'.",
          };
        }

        const log = readFailureLog(world.kvStore);
        log.sequence += 1;
        removeStaleLessons(log);

        const tags = parseTags(String(params["tags"] ?? ""));
        const duplicate = log.lessons.find(
          (lesson) =>
            lesson.trigger.toLowerCase() === trigger.toLowerCase() &&
            lesson.correctedRule.toLowerCase() ===
              correctedRule.toLowerCase(),
        );

        if (duplicate) {
          duplicate.observedResult = observedResult;
          duplicate.tags = Array.from(new Set([...duplicate.tags, ...tags]));
          duplicate.sequence = log.sequence;
        } else {
          log.lessons.push({
            trigger,
            observedResult,
            correctedRule,
            tags,
            sequence: log.sequence,
          });
        }

        removeStaleLessons(log);
        saveFailureLog(world.kvStore, log);

        return {
          output: duplicate
            ? "Failure lesson refreshed and deduplicated."
            : `Failure lesson recorded (${log.lessons.length}/${MAX_FAILURE_LESSONS}).`,
        };
      }
      case "retrieve_lessons": {
        const log = readFailureLog(world.kvStore);
        log.sequence += 1;
        removeStaleLessons(log);
        saveFailureLog(world.kvStore, log);

        const stateTags = parseTags(String(params["state_tags"] ?? ""));
        const lessons = log.lessons
          .map((lesson) => ({
            lesson,
            score: relevanceScore(lesson, stateTags),
          }))
          .filter(({ score }) => stateTags.length === 0 || score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.lesson.sequence - a.lesson.sequence,
          )
          .slice(0, MAX_RETRIEVED_LESSONS)
          .map(({ lesson }) => lesson);

        if (lessons.length === 0) {
          return {
            output:
              "No relevant active failure lessons. Proceed using current state and record any adverse result.",
          };
        }

        return {
          output: `Relevant failure lessons (${lessons.length}):\n${lessons
            .map(
              (lesson) =>
                `- Trigger: ${lesson.trigger} | Result: ${lesson.observedResult} | Rule: ${lesson.correctedRule}`,
            )
            .join("\n")}`,
        };
      }
      default:
        return {
          output: `Error: Unknown action "${action}". Use: get, set, delete, list, log_failure, retrieve_lessons.`,
        };
    }
  },
};