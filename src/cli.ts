#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  startStandaloneMcpServer,
  startStdioMcpProxy,
  type McpDietOptions,
} from "./proxy.js";

export interface ParsedCliArgs {
  help: boolean;
  version: boolean;
  selfTestServer: boolean;
  options: McpDietOptions;
  command: string | null;
  commandArgs: string[];
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const allow: string[] = [];
  const deny: string[] = [];
  let readOnly = false;
  let maxDescChars: number | undefined;
  let maxResultKb = 512;
  let redactSecrets = false;
  let spillDir: string | undefined;
  let help = false;
  let version = false;
  let selfTestServer = false;

  let command: string | null = null;
  const commandArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      const rest = argv.slice(i + 1);
      command = rest[0] ?? null;
      commandArgs.push(...rest.slice(1));
      break;
    }

    if (command !== null) {
      commandArgs.push(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--self-test-server" || arg === "--standalone") {
      selfTestServer = true;
    } else if (arg === "--read-only") {
      readOnly = true;
    } else if (arg === "--redact-secrets") {
      redactSecrets = true;
    } else if (arg === "--allow") {
      const val = argv[++i];
      if (!val) throw new Error("--allow requires a tool name or pattern list.");
      allow.push(val);
    } else if (arg.startsWith("--allow=")) {
      allow.push(arg.slice("--allow=".length));
    } else if (arg === "--deny") {
      const val = argv[++i];
      if (!val) throw new Error("--deny requires a tool name or pattern list.");
      deny.push(val);
    } else if (arg.startsWith("--deny=")) {
      deny.push(arg.slice("--deny=".length));
    } else if (arg === "--max-desc") {
      const val = Number(argv[++i]);
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error("--max-desc must be a positive integer.");
      }
      maxDescChars = val;
    } else if (arg.startsWith("--max-desc=")) {
      const val = Number(arg.slice("--max-desc=".length));
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error("--max-desc must be a positive integer.");
      }
      maxDescChars = val;
    } else if (arg === "--max-result-kb") {
      const val = Number(argv[++i]);
      if (!Number.isFinite(val) || val <= 0) {
        throw new Error("--max-result-kb must be a positive number.");
      }
      maxResultKb = val;
    } else if (arg.startsWith("--max-result-kb=")) {
      const val = Number(arg.slice("--max-result-kb=".length));
      if (!Number.isFinite(val) || val <= 0) {
        throw new Error("--max-result-kb must be a positive number.");
      }
      maxResultKb = val;
    } else if (arg === "--spill-dir") {
      const val = argv[++i];
      if (!val) throw new Error("--spill-dir requires a directory path.");
      spillDir = val;
    } else if (arg.startsWith("--spill-dir=")) {
      spillDir = arg.slice("--spill-dir=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      command = arg;
    }
  }

  return {
    help,
    version,
    selfTestServer,
    options: {
      allow,
      deny,
      readOnly,
      maxDescChars,
      maxResultKb,
      redactSecrets,
      spillDir,
    },
    command,
    commandArgs,
  };
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.1.1";
  } catch {
    return "0.1.1";
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "mcp-diet — Zero-dependency stdio MCP proxy & runtime context firewall",
      "",
      "Usage:",
      "  mcp-diet [options] -- <server-command> [server-args...]",
      "  mcp-diet [options] --self-test-server",
      "",
      "Options:",
      "  --allow <t1,t2>         Allow only matching tool names or wildcard patterns",
      "  --deny <t1,t2>          Remove matching tool names or wildcard patterns from tools/list",
      "  --read-only             Keep only read-only tools (annotations.readOnlyHint or read-only heuristic)",
      "  --max-desc <chars>      Deterministically truncate tool and property descriptions",
      "  --max-result-kb <kb>    Spill oversized tools/call results to a temp file (default: 512)",
      "  --redact-secrets        Redact leaked API keys, PATs, and credentials in tools/call output",
      "  --spill-dir <dir>       Custom directory for spilled oversized tool outputs",
      "  --self-test-server      Run standalone diagnostic MCP server over stdio (for introspection/Glama)",
      "  -v, --version           Print version",
      "  -h, --help              Print help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  if (
    parsed.selfTestServer ||
    (!parsed.command &&
      (process.env.MCP_DIET_STANDALONE === "1" || !process.stdin.isTTY))
  ) {
    startStandaloneMcpServer({
      options: parsed.options,
      version: getVersion(),
    });
    return;
  }
  if (!parsed.command) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const proxy = startStdioMcpProxy({
    command: parsed.command,
    args: parsed.commandArgs,
    options: parsed.options,
  });

  proxy.child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
  proxy.child.on("error", (err) => {
    process.stderr.write(`mcp-diet error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  const argPath = resolve(process.argv[1]);
  if (selfPath === argPath) return true;
  try {
    return realpathSync(selfPath) === realpathSync(argPath);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err: unknown) => {
    process.stderr.write(`mcp-diet error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
