/**
 * API cost tracking — records token usage per run and accumulates across runs.
 *
 * Writes to logs/cost-log.json with per-run entries and a running total.
 * Pricing is based on Anthropic's published rates (updated March 2025).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Per-model pricing in dollars per million tokens. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":     { input: 15.00, output: 75.00 },
  "claude-sonnet-4-6":   { input: 3.00,  output: 15.00 },
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00 },
  // OpenAI GPT-5.6 family (agents-under-test for Watson)
  "gpt-5.6-terra":       { input: 2.50,  output: 15.00 },
  "gpt-5.6-luna":        { input: 1.00,  output: 6.00 },
  // Fallback for unknown models
  default:               { input: 3.00,  output: 15.00 },
};

function getModelPricing(model: string): { input: number; output: number } {
  return PRICING[model] ?? PRICING["default"]!;
}

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = getModelPricing(model);
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/** A single API call's usage. */
export interface ApiCallUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  category: "agent" | "supplier";
}

/** Summary for one simulation run. */
export interface RunCostEntry {
  runId: string;
  startedAt: string;
  endedAt: string;
  model: string;
  supplierModel?: string;
  daysSimulated: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  agentInputTokens: number;
  agentOutputTokens: number;
  supplierInputTokens: number;
  supplierOutputTokens: number;
  agentCalls: number;
  supplierCalls: number;
  estimatedCostUsd: number;
}

/** The cumulative cost log file structure. */
interface CostLog {
  runs: RunCostEntry[];
  totals: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCalls: number;
    totalEstimatedCostUsd: number;
  };
}

/**
 * In-memory tracker for the current run. Create one per simulation run.
 */
export class CostTracker {
  private calls: ApiCallUsage[] = [];
  private runId: string;
  private startedAt: string;
  private model: string;
  private supplierModel?: string;
  private logDir: string;

  constructor(opts: {
    model: string;
    supplierModel?: string;
    logDir: string;
  }) {
    this.runId = `run-${Date.now()}`;
    this.startedAt = new Date().toISOString();
    this.model = opts.model;
    this.supplierModel = opts.supplierModel;
    this.logDir = opts.logDir;
  }

  /** Record usage from a single API call. */
  recordUsage(usage: ApiCallUsage): void {
    this.calls.push(usage);
  }

  /** Get running totals for the current run. */
  getCurrentTotals(): { inputTokens: number; outputTokens: number; estimatedCost: number; calls: number } {
    let inputTokens = 0;
    let outputTokens = 0;
    let estimatedCost = 0;

    for (const call of this.calls) {
      inputTokens += call.inputTokens;
      outputTokens += call.outputTokens;
      estimatedCost += calculateCost(call.model, call.inputTokens, call.outputTokens);
    }

    return { inputTokens, outputTokens, estimatedCost, calls: this.calls.length };
  }

  /** Format a short cost summary string for console output. */
  formatSummary(): string {
    const t = this.getCurrentTotals();
    return `API Cost: ~$${t.estimatedCost.toFixed(4)} (${t.calls} calls, ${(t.inputTokens / 1000).toFixed(1)}k in / ${(t.outputTokens / 1000).toFixed(1)}k out)`;
  }

  /** Finalize the run and append to the cumulative cost log file. */
  finalize(daysSimulated: number): RunCostEntry {
    const entry: RunCostEntry = {
      runId: this.runId,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      model: this.model,
      supplierModel: this.supplierModel,
      daysSimulated,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      agentInputTokens: 0,
      agentOutputTokens: 0,
      supplierInputTokens: 0,
      supplierOutputTokens: 0,
      agentCalls: 0,
      supplierCalls: 0,
      estimatedCostUsd: 0,
    };

    for (const call of this.calls) {
      entry.totalInputTokens += call.inputTokens;
      entry.totalOutputTokens += call.outputTokens;
      const cost = calculateCost(call.model, call.inputTokens, call.outputTokens);
      entry.estimatedCostUsd += cost;

      if (call.category === "agent") {
        entry.agentInputTokens += call.inputTokens;
        entry.agentOutputTokens += call.outputTokens;
        entry.agentCalls++;
      } else {
        entry.supplierInputTokens += call.inputTokens;
        entry.supplierOutputTokens += call.outputTokens;
        entry.supplierCalls++;
      }
    }

    // Round cost to 6 decimal places
    entry.estimatedCostUsd = Math.round(entry.estimatedCostUsd * 1_000_000) / 1_000_000;

    // Append to cumulative log
    this.appendToLog(entry);

    return entry;
  }

  private appendToLog(entry: RunCostEntry): void {
    const logPath = path.join(this.logDir, "cost-log.json");

    let log: CostLog;
    try {
      const raw = fs.readFileSync(logPath, "utf-8");
      log = JSON.parse(raw) as CostLog;
    } catch {
      log = {
        runs: [],
        totals: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCalls: 0,
          totalEstimatedCostUsd: 0,
        },
      };
    }

    log.runs.push(entry);
    log.totals.totalInputTokens += entry.totalInputTokens;
    log.totals.totalOutputTokens += entry.totalOutputTokens;
    log.totals.totalCalls += entry.agentCalls + entry.supplierCalls;
    log.totals.totalEstimatedCostUsd += entry.estimatedCostUsd;
    log.totals.totalEstimatedCostUsd =
      Math.round(log.totals.totalEstimatedCostUsd * 1_000_000) / 1_000_000;

    fs.mkdirSync(this.logDir, { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  }
}
