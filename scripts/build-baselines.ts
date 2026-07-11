/**
 * Aggregate the demo-profile baseline runs into baselines.json (the "N" in the
 * N->M chart). Reads every run-*-transcript.json under a base dir (default
 * logs/baseline/*), reduces each via the shared metric extractor, and writes
 * per-run rows + summary stats (mean/min/max/stdev).
 *
 * Usage:
 *   tsx scripts/build-baselines.ts                       # logs/baseline/*, writes baselines.json
 *   tsx scripts/build-baselines.ts --base logs/baseline --out baselines.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractMetric, findLatestTranscript, type CanonicalMetric } from "./extract-metric.js";

function parseArgs(argv: string[]): { base: string; out: string } {
  let base = "logs/baseline";
  let out = "baselines.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i] ?? base;
    else if (argv[i] === "--out") out = argv[++i] ?? out;
  }
  return { base, out };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / (xs.length - 1)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function main(): void {
  const { base, out } = parseArgs(process.argv.slice(2));

  // Each immediate subdir of `base` is one run; fall back to `base` itself.
  const subdirs = fs.existsSync(base)
    ? fs
        .readdirSync(base)
        .map((d) => path.join(base, d))
        .filter((p) => fs.statSync(p).isDirectory())
    : [];
  const dirs = subdirs.length > 0 ? subdirs.sort() : [base];

  const runs: CanonicalMetric[] = [];
  for (const dir of dirs) {
    const t = findLatestTranscript(dir);
    if (!t) continue;
    runs.push(extractMetric(JSON.parse(fs.readFileSync(t, "utf-8"))));
  }

  if (runs.length === 0) {
    console.error(`No transcripts found under ${base}. Run the demo profile first.`);
    process.exit(1);
  }

  const assets = runs.map((r) => r.totalAssets);
  const first = runs[0]!;

  const baselines = {
    schemaVersion: 1,
    metricName: "totalAssets" as const,
    profile: {
      days: first.totalDays,
      model: first.model,
      provider: first.provider,
      suppliers: "static",
      eventSeed: 42,
      command:
        "tsx src/index.ts run --provider openai --model gpt-5.6-luna --days 30 --no-llm-suppliers --event-seed 42",
    },
    summary: {
      n: runs.length,
      mean: round2(mean(assets)),
      min: round2(Math.min(...assets)),
      max: round2(Math.max(...assets)),
      stdev: round2(stdev(assets)),
      meanDaysCompleted: round2(mean(runs.map((r) => r.daysCompleted))),
      meanCostUsd: round2(mean(runs.map((r) => r.estimatedCostUsd)) * 100) / 100,
      meanWallSeconds: round2(mean(runs.map((r) => r.wallTimeSeconds))),
    },
    runs: runs.map((r) => ({
      runId: r.runId,
      totalAssets: r.totalAssets,
      daysCompleted: r.daysCompleted,
      totalItemsSold: r.totalItemsSold,
      totalRevenue: r.totalRevenue,
      estimatedCostUsd: r.estimatedCostUsd,
      wallTimeSeconds: r.wallTimeSeconds,
      gameOverReason: r.gameOverReason,
    })),
  };

  fs.writeFileSync(out, JSON.stringify(baselines, null, 2) + "\n");
  console.log(
    `Wrote ${out}: n=${baselines.summary.n} mean=$${baselines.summary.mean} ` +
      `(min $${baselines.summary.min} / max $${baselines.summary.max}, stdev $${baselines.summary.stdev})`,
  );
}

main();
