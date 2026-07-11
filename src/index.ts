/**
 * CLI entry point for the vending-bench simulation.
 *
 * Usage:
 *   npx tsx src/index.ts run --days 5                   # Quick test run (direct mode)
 *   npx tsx src/index.ts run --days 365                 # Full run (direct mode)
 *   npx tsx src/index.ts run --mode agent --agent-url http://localhost:3900
 *   npx tsx src/index.ts run --mode openclaw --days 365
 *   npx tsx src/index.ts resume --latest
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfig, type SimulationConfig } from "./config.js";
import { runSimulation, findLatestCheckpoint } from "./runner.js";
import { runOpenClawSimulation, type OpenClawAdapterConfig } from "./_openclaw-reference/adapter.js";
import { runAgentSimulation, type AgentRunnerConfig } from "./agent-runner.js";

// Load .env from clawfarm if available (for CLAUDE_API_KEY)
function loadEnv(): void {
  const envPaths = [
    path.resolve(".env"),
    path.resolve("../clawfarm/.env"),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

interface CliOptions {
  simConfig: Partial<SimulationConfig>;
  openclawDir?: string;
  workspaceDir?: string;
  agentUrl?: string;
  farmUrl?: string;
  agentId?: string;
  checkpointPath?: string;
  useLatestCheckpoint?: boolean;
}

function parseArgs(args: string[]): {
  command: string;
  options: CliOptions;
} {
  let command = args[0] ?? "help";
  const options: CliOptions = { simConfig: {} };

  // "test" is shorthand for "run --days 20"
  if (command === "test") {
    command = "run";
    options.simConfig.totalDays = 20;
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--mode":
        if (next === "direct" || next === "openclaw" || next === "agent") {
          options.simConfig.mode = next === "agent" ? "agent" : next;
        }
        i++;
        break;
      case "--days":
        options.simConfig.totalDays = parseInt(next ?? "365", 10);
        i++;
        break;
      case "--provider":
        if (next === "anthropic" || next === "cerebras" || next === "openai") {
          options.simConfig.provider = next;
        }
        i++;
        break;
      case "--model":
        options.simConfig.model = next;
        i++;
        break;
      case "--supplier-provider":
        if (next === "anthropic" || next === "cerebras" || next === "openai") {
          options.simConfig.supplierProvider = next;
        }
        i++;
        break;
      case "--supplier-model":
        options.simConfig.supplierModel = next;
        i++;
        break;
      case "--search-provider":
        if (next === "anthropic" || next === "cerebras" || next === "openai") {
          options.simConfig.searchProvider = next;
        }
        i++;
        break;
      case "--search-model":
        options.simConfig.searchModel = next;
        i++;
        break;
      case "--checkpoint":
        if (command === "resume") {
          options.checkpointPath = next;
        } else {
          options.simConfig.checkpointInterval = parseInt(next ?? "30", 10);
        }
        i++;
        break;
      case "--latest":
        options.useLatestCheckpoint = true;
        break;
      case "--log-dir":
        options.simConfig.logDir = next;
        i++;
        break;
      case "--no-llm-suppliers":
        options.simConfig.useLlmSuppliers = false;
        break;
      case "--llm-suppliers":
        options.simConfig.useLlmSuppliers = true;
        break;
      case "--openclaw-dir":
        options.openclawDir = next;
        i++;
        break;
      case "--workspace-dir":
        options.workspaceDir = next;
        i++;
        break;
      case "--agent-url":
        options.agentUrl = next;
        i++;
        break;
      case "--farm-url":
        options.farmUrl = next;
        i++;
        break;
      case "--agent-id":
        options.agentId = next;
        i++;
        break;
      case "--event-temp":
        options.simConfig.eventTemperature = parseFloat(next ?? "0.5");
        i++;
        break;
      case "--event-seed":
        options.simConfig.eventSeed = parseInt(next ?? "42", 10);
        i++;
        break;
      case "--no-events":
        options.simConfig.eventTemperature = 0;
        break;
      case "--max-context":
        options.simConfig.maxContextTokens = parseInt(next ?? "69000", 10);
        i++;
        break;
      default:
        break;
    }
  }

  return { command, options };
}

function printUsage(): void {
  console.log("Vending-Bench Simulation");
  console.log("");
  console.log("Commands:");
  console.log("  run                        Start a new simulation");
  console.log("  test                       Quick 20-day test run (estimate costs before a full run)");
  console.log("  resume                     Resume from a checkpoint");
  console.log("");
  console.log("Run Options:");
  console.log("  --mode <direct|agent|openclaw>  Execution mode (default: direct)");
  console.log("  --days <number>            Simulation days (default: 365)");
  console.log("  --provider <anthropic|cerebras|openai>  LLM provider (default: anthropic)");
  console.log("  --model <string>           LLM model (default: claude-sonnet-4-6)");
  console.log("  --supplier-provider <anthropic|cerebras|openai>  Supplier LLM provider");
  console.log("  --supplier-model <string>  Supplier LLM model");
  console.log("  --search-provider <anthropic|cerebras|openai>    Search-classifier provider");
  console.log("  --search-model <string>    Search-classifier model");
  console.log("  --checkpoint <number>      Checkpoint every N days (default: 30)");
  console.log("  --log-dir <path>           Log directory (default: logs)");
  console.log("  --llm-suppliers            Use LLM for supplier email responses");
  console.log("  --no-llm-suppliers         Use static supplier responses (default)");
  console.log("  --event-temp <0-1>         Event temperature (default: 0.5)");
  console.log("  --event-seed <number>      Event random seed (default: 42)");
  console.log("  --no-events                Disable random events (temperature=0)");
  console.log("");
  console.log("Agent Mode Options:");
  console.log("  --agent-url <url>          Agent-base HTTP URL (required for --mode agent)");
  console.log("  --farm-url <url>           Farm dashboard URL (for progress reporting)");
  console.log("  --agent-id <id>            Agent ID (for farm progress reporting)");
  console.log("");
  console.log("OpenClaw Mode Options (deprecated, use agent mode):");
  console.log("  --openclaw-dir <path>      Path to openclaw (default: ../openclaw)");
  console.log("  --workspace-dir <path>     Base workspace dir (default: workspaces)");
  console.log("");
  console.log("Resume Options:");
  console.log("  --checkpoint <path>        Path to checkpoint file");
  console.log("  --latest                   Resume from most recent checkpoint");
  console.log("  --log-dir <path>           Directory to search for checkpoints");
  console.log("");
  console.log("Examples:");
  console.log("  npx tsx src/index.ts test                                     # 20-day test run");
  console.log("  npx tsx src/index.ts run --days 365                           # Full simulation");
  console.log("  npx tsx src/index.ts run --mode agent --agent-url http://localhost:3900");
  console.log("  npx tsx src/index.ts run --mode openclaw");
  console.log("  npx tsx src/index.ts resume --latest");
}

async function main() {
  loadEnv();

  const { command, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "run": {
      const config = resolveConfig(options.simConfig);

      if (config.mode === "agent") {
        // Agent mode: communicate with agent-base via HTTP
        if (!options.agentUrl) {
          console.error("Error: --agent-url is required for --mode agent");
          process.exit(1);
        }

        const agentConfig: AgentRunnerConfig = {
          agentUrl: options.agentUrl,
          farmUrl: options.farmUrl,
          agentId: options.agentId,
        };
        await runAgentSimulation(config, agentConfig);
      } else if (config.mode === "openclaw") {
        // Legacy openclaw mode: spawns openclaw directly
        console.warn("[DEPRECATED] --mode openclaw is deprecated. Use --mode agent with agent-base instead.");

        if (!config.apiKey) {
          console.error("Error: No API key found.");
          console.error(`Set the API key for provider "${config.provider}" in your environment,`);
          console.error("or create a .env file.");
          process.exit(1);
        }

        const adapterConfig: OpenClawAdapterConfig = {
          openclawDir: options.openclawDir ?? "../openclaw",
          workspaceBaseDir: options.workspaceDir ?? "workspaces",
        };
        await runOpenClawSimulation(config, adapterConfig);
      } else {
        // Direct mode: LLM in-process
        if (!config.apiKey) {
          console.error("Error: No API key found.");
          console.error(`Set the API key for provider "${config.provider}" in your environment,`);
          console.error("or create a .env file.");
          process.exit(1);
        }

        await runSimulation(config);
      }
      break;
    }

    case "resume": {
      const config = resolveConfig(options.simConfig);

      if (!config.apiKey) {
        console.error("Error: No API key found.");
        process.exit(1);
      }

      let checkpointPath = options.checkpointPath;

      if (options.useLatestCheckpoint || !checkpointPath) {
        checkpointPath = findLatestCheckpoint(config.logDir) ?? undefined;
        if (!checkpointPath) {
          console.error(`No checkpoint files found in ${config.logDir}/`);
          process.exit(1);
        }
      }

      console.log(`Resuming from: ${checkpointPath}`);
      await runSimulation(config, checkpointPath);
      break;
    }

    case "help":
    default:
      printUsage();
      break;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
