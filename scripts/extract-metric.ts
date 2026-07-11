/**
 * Programmatic metric extraction for Watson.
 *
 * Reads a run transcript (the JSON the runner writes to logs/) and emits a
 * small, STABLE canonical metric object that the Watson sandbox-runner parses
 * and streams as `metric` events. The transcript schema may grow; this file is
 * the contract boundary — keep the output shape stable.
 *
 * Usage:
 *   tsx scripts/extract-metric.ts --file logs/run-123-transcript.json
 *   tsx scripts/extract-metric.ts --log-dir logs            # latest transcript
 *   tsx scripts/extract-metric.ts --log-dir logs --out logs/metric.json
 *
 * The headline metric is Total Assets (the benchmark's score). `daysCompleted`
 * is the time-horizon / survival proxy. `series` drives the live baseline-vs-
 * candidate chart in the Lab view.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CanonicalMetric {
  schemaVersion: 1;
  metricName: "totalAssets";
  /** Headline number for the N->M chart. */
  metric: number;
  totalAssets: number;
  /** Time-horizon proxy: days survived before end/bankruptcy. */
  daysCompleted: number;
  totalDays: number;
  gameOverReason: string | null;
  totalRevenue: number;
  totalItemsSold: number;
  model: string;
  provider: string;
  runId: string;
  estimatedCostUsd: number;
  wallTimeSeconds: number;
  /** Per-day total-assets trajectory for the live chart. */
  series: Array<{ day: number; totalAssets: number }>;
}

interface Transcript {
  config?: { totalDays?: number; model?: string; provider?: string };
  score?: {
    totalAssets?: number;
    daysCompleted?: number;
    gameOverReason?: string | null;
    totalRevenue?: number;
    totalItemsSold?: number;
  };
  cost?: { runId?: string; estimatedCostUsd?: number; model?: string };
  wallTimeSeconds?: number;
  dailySnapshots?: Array<{ day?: number; totalAssets?: number }>;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Find the most recently modified run transcript in a directory. */
export function findLatestTranscript(logDir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(logDir);
  } catch {
    return null;
  }
  const transcripts = entries
    .filter((f) => f.startsWith("run-") && f.endsWith("-transcript.json"))
    .map((f) => {
      const full = path.join(logDir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return transcripts[0]?.full ?? null;
}

/** Reduce a raw transcript to the stable canonical metric object. */
export function extractMetric(transcript: Transcript): CanonicalMetric {
  const score = transcript.score ?? {};
  const cost = transcript.cost ?? {};
  const config = transcript.config ?? {};

  const series = (transcript.dailySnapshots ?? [])
    .filter((s) => typeof s.day === "number")
    .map((s) => ({ day: num(s.day), totalAssets: num(s.totalAssets) }));

  return {
    schemaVersion: 1,
    metricName: "totalAssets",
    metric: num(score.totalAssets),
    totalAssets: num(score.totalAssets),
    daysCompleted: num(score.daysCompleted),
    totalDays: num(config.totalDays),
    gameOverReason: score.gameOverReason ?? null,
    totalRevenue: num(score.totalRevenue),
    totalItemsSold: num(score.totalItemsSold),
    model: config.model ?? cost.model ?? "unknown",
    provider: config.provider ?? "unknown",
    runId: cost.runId ?? "unknown",
    estimatedCostUsd: num(cost.estimatedCostUsd),
    wallTimeSeconds: num(transcript.wallTimeSeconds),
    series,
  };
}

function parseArgs(argv: string[]): { file?: string; logDir?: string; out?: string } {
  const out: { file?: string; logDir?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--log-dir") out.logDir = argv[++i];
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ?? findLatestTranscript(args.logDir ?? "logs");

  if (!file) {
    console.error(
      `No transcript found. Pass --file <path> or --log-dir <dir> containing run-*-transcript.json.`,
    );
    process.exit(1);
  }

  let transcript: Transcript;
  try {
    transcript = JSON.parse(fs.readFileSync(file, "utf-8")) as Transcript;
  } catch (err) {
    console.error(`Failed to read/parse transcript ${file}: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const metric = extractMetric(transcript);
  const json = JSON.stringify(metric, null, 2);

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json + "\n");
    console.error(`Wrote metric -> ${args.out}`);
  }
  console.log(json);
}

// Run only when invoked directly (allows importing extractMetric elsewhere).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === `file://${invokedPath}`) {
  main();
}
