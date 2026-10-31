import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  [key: string]: unknown;
}

export interface McpDietOptions {
  allow?: string[];
  deny?: string[];
  readOnly?: boolean;
  maxDescChars?: number;
  maxResultKb?: number;
  redactSecrets?: boolean;
  spillDir?: string;
}

export interface TreeShakeStats {
  originalCount: number;
  keptCount: number;
  removedTools: string[];
  originalBytes: number;
  filteredBytes: number;
  savedBytes: number;
  estimatedSavedTokens: number;
}

const READ_ONLY_NAME_PATTERN =
  /^(?:get|list|read|search|find|query|inspect|view|fetch|describe|check|count|show|stat|status|head|tail|cat|ls)(?:[_-]|$)/i;

const DESTRUCTIVE_NAME_PATTERN =
  /(?:^|[_-])(?:delete|remove|drop|destroy|truncate|write|update|create|insert|put|post|patch|exec|execute|run|kill|push|commit|merge|deploy|mutate|set|reset|clear)(?:[_-]|$)/i;

function matchesPattern(name: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;
  if (trimmed.includes("*")) {
    const escaped = trimmed
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(name);
  }
  return name.toLowerCase() === trimmed.toLowerCase();
}

function normalizePatternList(patterns?: string[]): string[] {
  return (patterns ?? [])
    .flatMap((item) => item.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isReadOnlyTool(tool: McpToolDefinition): boolean {
  if (tool.annotations?.readOnlyHint === true) {
    return true;
  }
  if (
    tool.annotations?.readOnlyHint === false ||
    tool.annotations?.destructiveHint === true
  ) {
    return false;
  }
  if (DESTRUCTIVE_NAME_PATTERN.test(tool.name)) {
    return false;
  }
  return READ_ONLY_NAME_PATTERN.test(tool.name);
}

export function isToolCallAllowed(
  toolName: string,
  options: McpDietOptions = {},
  knownTools?: Map<string, McpToolDefinition>,
): boolean {
  const allowList = normalizePatternList(options.allow);
  const denyList = normalizePatternList(options.deny);

  if (
    allowList.length > 0 &&
    !allowList.some((p) => matchesPattern(toolName, p))
  ) {
    return false;
  }

  if (
    denyList.length > 0 &&
    denyList.some((p) => matchesPattern(toolName, p))
  ) {
    return false;
  }

  if (options.readOnly) {
    const known = knownTools?.get(toolName);
    if (known) {
      return isReadOnlyTool(known);
    }
    return isReadOnlyTool({ name: toolName });
  }

  return true;
}

export function truncateDeterministic(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function compactInputSchemaDescriptions(
  schema: Record<string, unknown> | undefined,
  maxDescChars?: number,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return schema;
  if (maxDescChars === undefined || maxDescChars <= 0) return schema;

  const clone: Record<string, unknown> = { ...schema };
  if (typeof clone.description === "string") {
    clone.description = truncateDeterministic(clone.description, maxDescChars);
  }
  if (clone.properties && typeof clone.properties === "object") {
    const props = clone.properties as Record<string, unknown>;
    const nextProps: Record<string, unknown> = {};
    for (const key of Object.keys(props).sort()) {
      const propVal = props[key];
      if (propVal && typeof propVal === "object") {
        const propCopy = { ...(propVal as Record<string, unknown>) };
        if (typeof propCopy.description === "string") {
          propCopy.description = truncateDeterministic(
            propCopy.description,
            Math.max(40, Math.floor(maxDescChars / 2)),
          );
        }
        nextProps[key] = propCopy;
      } else {
        nextProps[key] = propVal;
      }
    }
    clone.properties = nextProps;
  }
  return clone;
}

export function filterToolsList(
  tools: McpToolDefinition[],
  options: McpDietOptions = {},
): { tools: McpToolDefinition[]; stats: TreeShakeStats } {
  const originalSerialized = JSON.stringify(tools);
  const allowList = normalizePatternList(options.allow);
  const denyList = normalizePatternList(options.deny);

  const kept: McpToolDefinition[] = [];
  const removedTools: string[] = [];

  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string") continue;

    if (
      allowList.length > 0 &&
      !allowList.some((p) => matchesPattern(tool.name, p))
    ) {
      removedTools.push(tool.name);
      continue;
    }

    if (
      denyList.length > 0 &&
      denyList.some((p) => matchesPattern(tool.name, p))
    ) {
      removedTools.push(tool.name);
      continue;
    }

    if (options.readOnly && !isReadOnlyTool(tool)) {
      removedTools.push(tool.name);
      continue;
    }

    const transformed: McpToolDefinition = { ...tool };
    if (
      options.maxDescChars !== undefined &&
      options.maxDescChars > 0 &&
      typeof transformed.description === "string"
    ) {
      transformed.description = truncateDeterministic(
        transformed.description,
        options.maxDescChars,
      );
    }
    if (
      options.maxDescChars !== undefined &&
      options.maxDescChars > 0 &&
      transformed.inputSchema &&
      typeof transformed.inputSchema === "object"
    ) {
      transformed.inputSchema = compactInputSchemaDescriptions(
        transformed.inputSchema,
        options.maxDescChars,
      );
    }

    kept.push(transformed);
  }

  // Deterministic alphabetical sort by tool name to preserve prompt prefix caching
  kept.sort((a, b) => a.name.localeCompare(b.name));

  const filteredSerialized = JSON.stringify(kept);
  const originalBytes = Buffer.byteLength(originalSerialized, "utf8");
  const filteredBytes = Buffer.byteLength(filteredSerialized, "utf8");
  const savedBytes = Math.max(0, originalBytes - filteredBytes);

  return {
    tools: kept,
    stats: {
      originalCount: tools.length,
      keptCount: kept.length,
      removedTools,
      originalBytes,
      filteredBytes,
      savedBytes,
      estimatedSavedTokens: Math.ceil(savedBytes / 4),
    },
  };
}

export function redactSecretsInText(input: string): string {
  return input
    .replace(
      /\b(sk-ant-(?:api03-)?[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{14,}\b/g,
      "$1***REDACTED***",
    )
    .replace(
      /\b(sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{14,}\b/g,
      "$1***REDACTED***",
    )
    .replace(
      /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{4})[A-Za-z0-9]{20,}\b/g,
      "$1***REDACTED***",
    )
    .replace(
      /\b(github_pat_[A-Za-z0-9_]{6})[A-Za-z0-9_]{20,}\b/g,
      "$1***REDACTED***",
    )
    .replace(
      /\b((?:AKIA|ASIA)[0-9A-Z]{4})[0-9A-Z]{12}\b/g,
      "$1***REDACTED***",
    )
    .replace(
      /(:\/\/[^\s"'/@]*:)([^\s"'/@]{2})[^\s"'/@]{4,}(@)/gi,
      "$1$2***REDACTED***$3",
    )
    .replace(
      /(AccountKey=)([A-Za-z0-9+/=]{4})[A-Za-z0-9+/=]{12,}/gi,
      "$1$2***REDACTED***",
    )
    .replace(
      /\b(Bearer\s+[A-Za-z0-9._~+/=-]{4})[A-Za-z0-9._~+/=-]{16,}/gi,
      "$1***REDACTED***",
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
      "-----BEGIN PRIVATE KEY-----[REDACTED BY MCP-DIET]-----END PRIVATE KEY-----",
    );
}

export function redactSecretsInValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretsInText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsInValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretsInValue(v);
    }
    return out;
  }
  return value;
}

function summarizeContentItemForPreview(item: Record<string, unknown>): string {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (
    item.type === "resource" &&
    item.resource &&
    typeof item.resource === "object"
  ) {
    const res = item.resource as Record<string, unknown>;
    if (typeof res.text === "string") {
      return res.text;
    }
    if (typeof res.blob === "string") {
      const uri = typeof res.uri === "string" ? res.uri : "unknown";
      return `[binary resource blob (${res.blob.length} base64 chars, uri=${uri})]`;
    }
  }
  if (item.type === "image" || item.type === "audio") {
    const mime = typeof item.mimeType === "string" ? item.mimeType : "binary";
    const dataLen = typeof item.data === "string" ? item.data.length : 0;
    return `[${item.type} block (${mime}, ${dataLen} base64 chars)]`;
  }
  return "";
}

export async function guardToolCallResult(
  result: unknown,
  options: McpDietOptions = {},
): Promise<{
  result: unknown;
  spilledPath: string | null;
  originalBytes: number;
}> {
  const processed = options.redactSecrets
    ? redactSecretsInValue(result)
    : result;
  const serialized = JSON.stringify(processed ?? null);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  const maxKb = options.maxResultKb ?? 512;
  const maxBytes = maxKb * 1024;

  if (maxKb <= 0 || originalBytes <= maxBytes) {
    return {
      result: processed,
      spilledPath: null,
      originalBytes,
    };
  }

  const spillDir = options.spillDir ?? join(tmpdir(), "mcp-diet-spills");
  await mkdir(spillDir, { recursive: true });

  const digest = createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 12);
  const spilledPath = join(
    spillDir,
    `mcp-tool-output-${Date.now()}-${digest}.json`,
  );
  await writeFile(spilledPath, serialized, "utf8");

  let previewText = serialized;
  const processedRecord =
    processed && typeof processed === "object"
      ? (processed as Record<string, unknown>)
      : null;

  if (processedRecord && Array.isArray(processedRecord.content)) {
    const contentItems = processedRecord.content as Array<
      Record<string, unknown>
    >;
    const joinedText = contentItems
      .map((item) =>
        item && typeof item === "object"
          ? summarizeContentItemForPreview(item)
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (joinedText) {
      previewText = joinedText;
    }
  }

  const previewChars = Math.min(2048, Math.max(256, Math.floor(maxBytes / 4)));
  const preview = previewText.slice(0, previewChars);

  return {
    spilledPath,
    originalBytes,
    result: {
      ...(processedRecord?.isError === true ? { isError: true } : {}),
      content: [
        {
          type: "text",
          text: [
            `[mcp-diet] Oversized tool output intercepted (${(originalBytes / 1024).toFixed(1)} KiB > ${maxKb} KiB limit).`,
            `Full output saved to local file: ${spilledPath}`,
            `Preview (first ${preview.length} chars):`,
            preview,
          ].join("\n"),
        },
      ],
      _mcpDietSpilled: {
        path: spilledPath,
        originalBytes,
        maxBytes,
      },
    },
  };
}

export async function transformJsonRpcMessage(
  rawLine: string,
  options: McpDietOptions = {},
  pendingRequests?: Map<string | number, string>,
  knownTools?: Map<string, McpToolDefinition>,
): Promise<string> {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("{")) {
    return rawLine;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return rawLine;
  }

  const id =
    typeof parsed.id === "string" || typeof parsed.id === "number"
      ? parsed.id
      : undefined;
  const method = id !== undefined ? pendingRequests?.get(id) : undefined;
  if (id !== undefined && pendingRequests) {
    pendingRequests.delete(id);
  }

  const resultObj =
    parsed.result && typeof parsed.result === "object"
      ? (parsed.result as Record<string, unknown>)
      : null;

  if (resultObj && Array.isArray(resultObj.tools)) {
    const rawTools = resultObj.tools as McpToolDefinition[];
    if (knownTools) {
      for (const tool of rawTools) {
        if (tool && typeof tool.name === "string") {
          knownTools.set(tool.name, tool);
        }
      }
    }
    const filtered = filterToolsList(rawTools, options);
    return JSON.stringify({
      ...parsed,
      result: {
        ...resultObj,
        tools: filtered.tools,
      },
    });
  }

  if (
    resultObj &&
    (method === "tools/call" || Array.isArray(resultObj.content))
  ) {
    const guarded = await guardToolCallResult(resultObj, options);
    return JSON.stringify({
      ...parsed,
      result: guarded.result,
    });
  }

  if (options.redactSecrets && resultObj) {
    return JSON.stringify({
      ...parsed,
      result: redactSecretsInValue(resultObj),
    });
  }

  return JSON.stringify(parsed);
}

function resolveWindowsSpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") {
    return { command, args, shell: false };
  }
  const lower = command.toLowerCase();
  if (lower === "npx" || lower === "npm") {
    const cliScript = join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      lower === "npx" ? "npx-cli.js" : "npm-cli.js",
    );
    if (existsSync(cliScript)) {
      return {
        command: process.execPath,
        args: [cliScript, ...args],
        shell: false,
      };
    }
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return { command, args, shell: true };
  }
  if (!lower.endsWith(".exe") && !lower.includes("/") && !lower.includes("\\")) {
    const pathDirs = (env.PATH ?? env.Path ?? "").split(delimiter);
    for (const dir of pathDirs) {
      if (!dir) continue;
      if (existsSync(join(dir, `${command}.exe`))) {
        return { command, args, shell: false };
      }
      if (
        existsSync(join(dir, `${command}.cmd`)) ||
        existsSync(join(dir, `${command}.bat`))
      ) {
        return { command, args, shell: true };
      }
    }
  }
  return { command, args, shell: false };
}

export interface StdioProxyHandle {
  child: ChildProcessWithoutNullStreams;
  close: () => void;
}

export function startStdioMcpProxy(params: {
  command: string;
  args: string[];
  options: McpDietOptions;
  clientIn?: Readable;
  clientOut?: Writable;
  clientErr?: Writable;
  env?: NodeJS.ProcessEnv;
}): StdioProxyHandle {
  const clientIn = params.clientIn ?? process.stdin;
  const clientOut = params.clientOut ?? process.stdout;
  const clientErr = params.clientErr ?? process.stderr;
  const env = params.env ?? process.env;

  const resolved = resolveWindowsSpawn(params.command, params.args, env);
  const child = spawn(resolved.command, resolved.args, {
    shell: resolved.shell,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const pendingRequests = new Map<string | number, string>();
  const knownTools = new Map<string, McpToolDefinition>();

  const clientReader = createInterface({ input: clientIn });
  clientReader.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        const msgId =
          typeof msg.id === "string" || typeof msg.id === "number"
            ? msg.id
            : undefined;
        const msgMethod =
          typeof msg.method === "string" ? msg.method : undefined;

        if (msgMethod === "tools/call" && msgId !== undefined) {
          const msgParams =
            msg.params && typeof msg.params === "object"
              ? (msg.params as Record<string, unknown>)
              : null;
          const toolName =
            msgParams && typeof msgParams.name === "string"
              ? msgParams.name
              : null;
          if (
            toolName &&
            !isToolCallAllowed(toolName, params.options, knownTools)
          ) {
            const blockedResponse = JSON.stringify({
              jsonrpc: "2.0",
              id: msgId,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `[mcp-diet] Tool call "${toolName}" blocked by runtime firewall policy.`,
                  },
                ],
              },
            });
            clientOut.write(`${blockedResponse}\n`);
            return;
          }
        }

        if (msgId !== undefined && msgMethod !== undefined) {
          pendingRequests.set(msgId, msgMethod);
        }
      } catch {
        // Forward verbatim
      }
    }
    if (!child.stdin.destroyed) {
      child.stdin.write(`${line}\n`);
    }
  });

  clientReader.on("close", () => {
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
  });

  let stdoutQueue = Promise.resolve();
  let multiLineBuffer: string[] = [];

  const flushMultiLineRaw = () => {
    if (multiLineBuffer.length === 0) return;
    for (const raw of multiLineBuffer) {
      clientOut.write(`${raw}\n`);
    }
    multiLineBuffer = [];
  };

  const serverReader = createInterface({ input: child.stdout });
  serverReader.on("line", (line) => {
    stdoutQueue = stdoutQueue
      .then(async () => {
        const trimmed = line.trim();

        if (multiLineBuffer.length === 0) {
          if (!trimmed.startsWith("{")) {
            clientOut.write(`${line}\n`);
            return;
          }
          try {
            JSON.parse(trimmed);
            const transformed = await transformJsonRpcMessage(
              trimmed,
              params.options,
              pendingRequests,
              knownTools,
            );
            clientOut.write(`${transformed}\n`);
            return;
          } catch {
            if (trimmed.endsWith("}")) {
              clientOut.write(`${line}\n`);
              return;
            }
            multiLineBuffer.push(line);
            return;
          }
        }

        multiLineBuffer.push(line);
        const combined = multiLineBuffer.join("\n").trim();
        try {
          JSON.parse(combined);
          multiLineBuffer = [];
          const transformed = await transformJsonRpcMessage(
            combined,
            params.options,
            pendingRequests,
            knownTools,
          );
          clientOut.write(`${transformed}\n`);
        } catch {
          if (multiLineBuffer.length >= 128 || combined.length > 4_194_304) {
            flushMultiLineRaw();
          }
        }
      })
      .catch(() => {
        clientOut.write(`${line}\n`);
      });
  });

  serverReader.on("close", () => {
    stdoutQueue = stdoutQueue.then(() => {
      flushMultiLineRaw();
    });
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    clientErr.write(chunk);
  });

  const close = () => {
    clientReader.close();
    serverReader.close();
    child.kill();
  };

  return { child, close };
}

export const STANDALONE_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "mcp_diet_analyze_tools",
    description:
      "Analyze an array of MCP tool definitions and compute deterministic tree-shaking byte and token savings under mcp-diet policies.",
    inputSchema: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          description: "Array of MCP tool definition objects to analyze.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Tool name" },
              description: { type: "string", description: "Tool description" },
            },
            required: ["name"],
          },
        },
        readOnly: {
          type: "boolean",
          description: "Keep only read-only tools.",
        },
        maxDescChars: {
          type: "number",
          description: "Maximum description length in characters.",
        },
      },
      required: ["tools"],
    },
    annotations: {
      title: "Analyze MCP Tool Schemas",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "mcp_diet_redact_text",
    description:
      "Redact leaked API keys, GitHub PATs, AWS keys, connection URL passwords, bearer tokens, and private keys from text.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Input text to sanitize against secret leakage.",
        },
      },
      required: ["text"],
    },
    annotations: {
      title: "Redact Secrets in Text",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "mcp_diet_status",
    description:
      "Inspect the active mcp-diet runtime firewall configuration, version, and crash-guard thresholds.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      title: "Inspect mcp-diet Firewall Policy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export interface StandaloneServerHandle {
  close: () => void;
}

export function startStandaloneMcpServer(params?: {
  options?: McpDietOptions;
  version?: string;
  clientIn?: Readable;
  clientOut?: Writable;
}): StandaloneServerHandle {
  const options = params?.options ?? {};
  const version = params?.version ?? "0.1.1";
  const clientIn = params?.clientIn ?? process.stdin;
  const clientOut = params?.clientOut ?? process.stdout;

  const knownTools = new Map<string, McpToolDefinition>(
    STANDALONE_MCP_TOOLS.map((t) => [t.name, t]),
  );

  let queue = Promise.resolve();
  const reader = createInterface({ input: clientIn });

  reader.on("line", (line) => {
    queue = queue
      .then(async () => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          return;
        }

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }

        const hasId =
          typeof msg.id === "string" ||
          typeof msg.id === "number" ||
          msg.id === null;
        if (!hasId) {
          // JSON-RPC 2.0 notification (e.g. notifications/initialized)
          return;
        }

        const id = msg.id;
        const method = typeof msg.method === "string" ? msg.method : "";
        const msgParams =
          msg.params && typeof msg.params === "object"
            ? (msg.params as Record<string, unknown>)
            : {};

        if (method === "initialize") {
          const requestedProtocol =
            typeof msgParams.protocolVersion === "string" &&
            msgParams.protocolVersion.trim().length > 0
              ? msgParams.protocolVersion
              : "2024-11-05";
          clientOut.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: requestedProtocol,
                capabilities: {
                  tools: { listChanged: false },
                  resources: { listChanged: false },
                  prompts: { listChanged: false },
                },
                serverInfo: {
                  name: "@framy2/mcp-diet",
                  version,
                },
              },
            })}\n`,
          );
          return;
        }

        if (method === "ping") {
          clientOut.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`,
          );
          return;
        }

        if (method === "tools/list") {
          const filtered = filterToolsList(STANDALONE_MCP_TOOLS, options);
          clientOut.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { tools: filtered.tools },
            })}\n`,
          );
          return;
        }

        if (method === "resources/list") {
          clientOut.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { resources: [] },
            })}\n`,
          );
          return;
        }

        if (method === "resources/templates/list") {
          clientOut.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { resourceTemplates: [] },
            })}\n`,
          );
          return;
        }

        if (method === "prompts/list") {
          clientOut.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { prompts: [] },
            })}\n`,
          );
          return;
        }

        if (method === "tools/call") {
          const toolName =
            typeof msgParams.name === "string" ? msgParams.name : "";
          const toolArgs =
            msgParams.arguments && typeof msgParams.arguments === "object"
              ? (msgParams.arguments as Record<string, unknown>)
              : {};

          if (!toolName || !isToolCallAllowed(toolName, options, knownTools)) {
            clientOut.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `[mcp-diet] Tool call "${toolName}" blocked by runtime firewall policy.`,
                    },
                  ],
                },
              })}\n`,
            );
            return;
          }

          let rawToolResult: Record<string, unknown>;
          if (toolName === "mcp_diet_analyze_tools") {
            const inputTools = Array.isArray(toolArgs.tools)
              ? (toolArgs.tools as McpToolDefinition[])
              : [];
            const callOptions: McpDietOptions = {
              ...options,
              ...(typeof toolArgs.readOnly === "boolean"
                ? { readOnly: toolArgs.readOnly }
                : {}),
              ...(typeof toolArgs.maxDescChars === "number"
                ? { maxDescChars: toolArgs.maxDescChars }
                : {}),
            };
            const analyzed = filterToolsList(inputTools, callOptions);
            rawToolResult = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(analyzed.stats, null, 2),
                },
              ],
            };
          } else if (toolName === "mcp_diet_redact_text") {
            const text = typeof toolArgs.text === "string" ? toolArgs.text : "";
            rawToolResult = {
              content: [
                {
                  type: "text",
                  text: redactSecretsInText(text),
                },
              ],
            };
          } else if (toolName === "mcp_diet_status") {
            rawToolResult = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      mode: "standalone",
                      version,
                      options,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          } else {
            rawToolResult = {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `[mcp-diet] Unknown tool: ${toolName}`,
                },
              ],
            };
          }

          const guarded = await guardToolCallResult(rawToolResult, options);
          clientOut.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: guarded.result,
            })}\n`,
          );
          return;
        }

        clientOut.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          })}\n`,
        );
      })
      .catch(() => {
        // Ignore unexpected line handling errors
      });
  });

  const close = () => {
    reader.close();
  };

  return { close };
}
