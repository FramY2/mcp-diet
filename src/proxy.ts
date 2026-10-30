import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /(?:^|[_-])(?:delete|remove|drop|destroy|truncate|write|update|create|insert|put|post|patch|exec|execute|run|kill| push|commit|merge|deploy|mutate|set|reset|clear)(?:[_-]|$)/i;

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
  const allowList = (options.allow ?? [])
    .flatMap((item) => item.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const denyList = (options.deny ?? [])
    .flatMap((item) => item.split(","))
    .map((s) => s.trim())
    .filter(Boolean);

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
      /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{14,}\b/g,
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
      /\b(Bearer\s+[A-Za-z0-9._~+/-]{4})[A-Za-z0-9._~+/-]{16,}\b/gi,
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
  if (
    processed &&
    typeof processed === "object" &&
    Array.isArray((processed as Record<string, unknown>).content)
  ) {
    const contentItems = (processed as Record<string, unknown>)
      .content as Array<Record<string, unknown>>;
    const joinedText = contentItems
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
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
    const filtered = filterToolsList(
      resultObj.tools as McpToolDefinition[],
      options,
    );
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

  return rawLine;
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

  const child = spawn(params.command, params.args, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: params.env ?? process.env,
  });

  const pendingRequests = new Map<string | number, string>();

  const clientReader = createInterface({ input: clientIn });
  clientReader.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          (typeof msg.id === "string" || typeof msg.id === "number") &&
          typeof msg.method === "string"
        ) {
          pendingRequests.set(msg.id, msg.method);
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
  const serverReader = createInterface({ input: child.stdout });
  serverReader.on("line", (line) => {
    stdoutQueue = stdoutQueue
      .then(async () => {
        const transformed = await transformJsonRpcMessage(
          line,
          params.options,
          pendingRequests,
        );
        clientOut.write(`${transformed}\n`);
      })
      .catch(() => {
        clientOut.write(`${line}\n`);
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
