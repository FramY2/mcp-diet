import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
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

export const DEFAULT_MAX_IMAGE_DIMENSION_PX = 2000;

export interface ImageDimensions {
  format: "png" | "jpeg" | "gif" | "webp";
  width: number;
  height: number;
  byteLength: number;
}

export interface SpilledImageMetadata {
  index: number;
  path: string;
  mimeType: string;
  format: ImageDimensions["format"];
  width: number;
  height: number;
  byteLength: number;
  maxDimensionPx: number;
  sha256: string;
}

export interface SpillTelemetryStats {
  toolCallsInspected: number;
  byteSpillsTriggered: number;
  imageDimensionSpillsTriggered: number;
  spillReadsCount: number;
  uniqueSpillsReadCount: number;
  previewOnlySpillsCount: number;
  spillReadFollowUpRate: number;
}

export interface SpillTelemetryTracker {
  recordToolCall: (params: {
    spilledPath: string | null;
    imageSpillCount: number;
  }) => void;
  recordSpillRead: (path?: string) => void;
  getStats: () => SpillTelemetryStats;
}

function normalizeTrackablePath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

export function createSpillTelemetryTracker(): SpillTelemetryTracker {
  let toolCallsInspected = 0;
  let byteSpillsTriggered = 0;
  let imageDimensionSpillsTriggered = 0;
  let spillReadsCount = 0;
  const spilledPaths = new Set<string>();
  const readPaths = new Set<string>();

  return {
    recordToolCall({ spilledPath, imageSpillCount }) {
      toolCallsInspected += 1;
      if (spilledPath) {
        byteSpillsTriggered += 1;
        spilledPaths.add(normalizeTrackablePath(spilledPath));
      }
      if (imageSpillCount > 0) {
        imageDimensionSpillsTriggered += imageSpillCount;
      }
    },
    recordSpillRead(filePath?: string) {
      spillReadsCount += 1;
      if (filePath) {
        readPaths.add(normalizeTrackablePath(filePath));
      }
    },
    getStats(): SpillTelemetryStats {
      let uniqueSpillsReadCount = 0;
      for (const path of spilledPaths) {
        if (readPaths.has(path)) {
          uniqueSpillsReadCount += 1;
        }
      }
      const previewOnlySpillsCount = Math.max(
        0,
        byteSpillsTriggered - uniqueSpillsReadCount,
      );
      const spillReadFollowUpRate =
        byteSpillsTriggered > 0
          ? Number((uniqueSpillsReadCount / byteSpillsTriggered).toFixed(4))
          : 0;
      return {
        toolCallsInspected,
        byteSpillsTriggered,
        imageDimensionSpillsTriggered,
        spillReadsCount,
        uniqueSpillsReadCount,
        previewOnlySpillsCount,
        spillReadFollowUpRate,
      };
    },
  };
}

export interface McpDietOptions {
  allow?: string[];
  deny?: string[];
  readOnly?: boolean;
  maxDescChars?: number;
  maxResultKb?: number;
  maxImageDimension?: number;
  redactSecrets?: boolean;
  spillDir?: string;
  disableSpillReader?: boolean;
}

export interface SpillSectionEntry {
  label: string;
  kind: "json-key" | "json-item" | "heading" | "log-block";
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

export interface SpillStructureMap {
  totalBytes: number;
  totalLines: number;
  sha256: string;
  sections: SpillSectionEntry[];
  headPreview: string;
  tailPreview?: string;
}

export interface ReadSpillArgs {
  path: string;
  startLine?: number;
  endLine?: number;
  offsetBytes?: number;
  maxBytes?: number;
  jsonPointer?: string;
}

export interface ReadSpillToolResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  _mcpDietRead?: {
    path: string;
    totalBytes: number;
    totalLines: number;
    returnedBytes: number;
    truncated: boolean;
  };
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

const HEAD_PREVIEW_CHARS = 1200;
const TAIL_PREVIEW_THRESHOLD = 1600;
const TAIL_PREVIEW_CHARS = 400;
const DEFAULT_READ_SPILL_LIMIT_BYTES = 64 * 1024;
const SPILL_FILENAME_REGEX = /^mcp-tool-output-\d+-[a-f0-9]{12}\.json$/;
const LOG_HEADER_REGEX = /^(?:ERROR|WARN|FAIL|===|---|\[\d{4}-\d{2}-\d{2})/;
const MARKDOWN_HEADING_REGEX = /^#{1,4}\s+.+/;

export const MCP_DIET_READ_SPILL_TOOL: McpToolDefinition = {
  name: "mcp_diet_read_spill",
  description:
    "Safely read a bounded slice from an oversized mcp-diet spill file by 1-based line range, UTF-8 byte offset, or RFC 6901 JSON Pointer.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to the mcp-tool-output-*.json spill file inside the configured spill directory.",
      },
      startLine: {
        type: "number",
        description: "1-based inclusive start line number to read.",
      },
      endLine: {
        type: "number",
        description: "1-based inclusive end line number to read.",
      },
      offsetBytes: {
        type: "number",
        description: "0-based UTF-8 byte offset to begin reading from.",
      },
      maxBytes: {
        type: "number",
        description:
          "Maximum UTF-8 bytes to return (capped by the active mcp-diet limit).",
      },
      jsonPointer: {
        type: "string",
        description:
          "RFC 6901 JSON Pointer (e.g. /results/0/title) to extract a nested value from JSON spills.",
      },
    },
    required: ["path"],
  },
  annotations: {
    title: "Read Spilled Tool Output",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const DATA_URL_BASE64_PREFIX = /^data:[^;,]+;base64,/i;

function decodeBase64Payload(base64Data: string): Buffer {
  const withoutDataUrl = base64Data.replace(DATA_URL_BASE64_PREFIX, "");
  const cleaned = withoutDataUrl.replace(/\s+/g, "");
  if (!cleaned) {
    return Buffer.alloc(0);
  }
  return Buffer.from(cleaned, "base64");
}

function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) {
      break;
    }
    while (offset < buf.length && buf[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buf.length) {
      break;
    }
    const marker = buf[offset]!;
    offset += 1;

    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (offset + 2 > buf.length) {
      break;
    }

    const segLen = buf.readUInt16BE(offset);
    if (segLen < 2 || offset + segLen > buf.length) {
      break;
    }

    const isSofMarker =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSofMarker) {
      if (segLen < 7 || offset + 7 > buf.length) {
        return null;
      }
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    offset += segLen;
  }

  return null;
}

function parseWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (
    buf.length < 25 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buf.length >= 30) {
    const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
    const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (
    chunk === "VP8 " &&
    buf.length >= 30 &&
    buf[23] === 0x9d &&
    buf[24] === 0x01 &&
    buf[25] === 0x2a
  ) {
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  return null;
}

export function inspectImageDimensions(
  base64Data: string,
): ImageDimensions | null {
  const buf = decodeBase64Payload(base64Data);
  if (buf.length === 0) {
    return null;
  }

  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a &&
    buf.toString("ascii", 12, 16) === "IHDR"
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0
      ? { format: "png", width, height, byteLength: buf.length }
      : null;
  }

  if (buf.length >= 10) {
    const gifHeader = buf.toString("ascii", 0, 6);
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      const width = buf.readUInt16LE(6);
      const height = buf.readUInt16LE(8);
      return width > 0 && height > 0
        ? { format: "gif", width, height, byteLength: buf.length }
        : null;
    }
  }

  const jpegDims = parseJpegDimensions(buf);
  if (jpegDims) {
    return {
      format: "jpeg",
      width: jpegDims.width,
      height: jpegDims.height,
      byteLength: buf.length,
    };
  }

  const webpDims = parseWebpDimensions(buf);
  if (webpDims) {
    return {
      format: "webp",
      width: webpDims.width,
      height: webpDims.height,
      byteLength: buf.length,
    };
  }

  return null;
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
  if (item.type === "image") {
    const mime = typeof item.mimeType === "string" ? item.mimeType : "binary";
    const dataLen = typeof item.data === "string" ? item.data.length : 0;
    const dims =
      typeof item.data === "string" ? inspectImageDimensions(item.data) : null;
    if (dims) {
      return `[image block (${mime}, ${dims.width}x${dims.height}px, ${dataLen} base64 chars)]`;
    }
    return `[image block (${mime}, ${dataLen} base64 chars)]`;
  }
  if (item.type === "audio") {
    const mime = typeof item.mimeType === "string" ? item.mimeType : "binary";
    const dataLen = typeof item.data === "string" ? item.data.length : 0;
    return `[audio block (${mime}, ${dataLen} base64 chars)]`;
  }
  return "";
}

function extractMcpContentText(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.content) || record.content.length === 0) {
    return null;
  }
  const isMcpEnvelope = record.content.every(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).type === "string" &&
      ["text", "image", "audio", "resource", "resource_link"].includes(
        (item as Record<string, unknown>).type as string,
      ),
  );
  if (!isMcpEnvelope) {
    return null;
  }
  const joinedText = (record.content as Array<Record<string, unknown>>)
    .map((item) => summarizeContentItemForPreview(item))
    .filter(Boolean)
    .join("\n");
  return joinedText.length > 0 ? joinedText : null;
}

interface LineSpan {
  lineNum: number;
  cleanText: string;
  startByte: number;
  endByte: number;
}

function computeLineSpans(text: string): LineSpan[] {
  if (text.length === 0) return [];
  const spans: LineSpan[] = [];
  let charStart = 0;
  let byteOffset = 0;
  let lineNum = 1;

  while (charStart <= text.length) {
    if (charStart === text.length) {
      break;
    }
    const nlIdx = text.indexOf("\n", charStart);
    const hasNewline = nlIdx !== -1;
    const rawEnd = hasNewline ? nlIdx + 1 : text.length;
    const contentEnd = hasNewline ? nlIdx : text.length;
    let rawLine = text.slice(charStart, contentEnd);
    if (rawLine.endsWith("\r")) {
      rawLine = rawLine.slice(0, -1);
    }
    const lineBytes = Buffer.byteLength(text.slice(charStart, rawEnd), "utf8");
    spans.push({
      lineNum,
      cleanText: rawLine,
      startByte: byteOffset,
      endByte: byteOffset + lineBytes,
    });
    byteOffset += lineBytes;
    lineNum += 1;
    charStart = rawEnd;
  }

  return spans;
}

function splitLinesForSlicing(text: string): string[] {
  if (text.length === 0) return [];
  const rawLines = text.split("\n").map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line,
  );
  if (text.endsWith("\n")) {
    rawLines.pop();
  }
  return rawLines;
}

function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `array[${value.length}]`;
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function skipJsonString(text: string, start: number): number {
  let i = start + 1;
  const len = text.length;
  while (i < len) {
    const ch = text.charCodeAt(i);
    if (ch === 0x5c /* \ */) {
      i += 2;
      continue;
    }
    if (ch === 0x22 /* " */) {
      return i + 1;
    }
    i++;
  }
  return len;
}

function skipJsonWhitespace(text: string, start: number): number {
  let i = start;
  const len = text.length;
  while (i < len) {
    const ch = text.charCodeAt(i);
    if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d) {
      break;
    }
    i++;
  }
  return i;
}

function skipJsonValue(text: string, start: number): number {
  let i = skipJsonWhitespace(text, start);
  const len = text.length;
  if (i >= len) return len;

  const first = text.charCodeAt(i);
  if (first === 0x22 /* " */) {
    return skipJsonString(text, i);
  }
  if (first === 0x7b /* { */ || first === 0x5b /* [ */) {
    let depth = 1;
    i++;
    while (i < len && depth > 0) {
      const ch = text.charCodeAt(i);
      if (ch === 0x22 /* " */) {
        i = skipJsonString(text, i);
        continue;
      }
      if (ch === 0x7b || ch === 0x5b) {
        depth++;
      } else if (ch === 0x7d || ch === 0x5d) {
        depth--;
      }
      i++;
    }
    return i;
  }

  while (i < len) {
    const ch = text.charCodeAt(i);
    if (
      ch === 0x2c ||
      ch === 0x7d ||
      ch === 0x5d ||
      ch === 0x20 ||
      ch === 0x09 ||
      ch === 0x0a ||
      ch === 0x0d
    ) {
      break;
    }
    i++;
  }
  return i;
}

interface CursorState {
  charIdx: number;
  byteOffset: number;
  line: number;
}

function advanceCursor(
  text: string,
  state: CursorState,
  targetCharIdx: number,
): void {
  if (targetCharIdx <= state.charIdx) return;
  const slice = text.slice(state.charIdx, targetCharIdx);
  state.byteOffset += Buffer.byteLength(slice, "utf8");
  let pos = 0;
  while (true) {
    const nl = slice.indexOf("\n", pos);
    if (nl === -1) break;
    state.line += 1;
    pos = nl + 1;
  }
  state.charIdx = targetCharIdx;
}

function parseJsonStructureSections(
  text: string,
  maxEntries: number,
): SpillSectionEntry[] | null {
  const firstNonWs = skipJsonWhitespace(text, 0);
  if (firstNonWs >= text.length) return null;
  const opener = text.charCodeAt(firstNonWs);
  if (opener !== 0x7b /* { */ && opener !== 0x5b /* [ */) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (maxEntries <= 0) return [];

  const cursor: CursorState = { charIdx: 0, byteOffset: 0, line: 1 };
  const len = text.length;

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const sections: SpillSectionEntry[] = [];
    let i = skipJsonWhitespace(text, firstNonWs + 1);

    while (i < len && text.charCodeAt(i) !== 0x7d /* } */) {
      if (text.charCodeAt(i) !== 0x22 /* " */) {
        break;
      }
      const entryStartChar = i;
      const keyEndChar = skipJsonString(text, i);
      const rawKey = text.slice(entryStartChar, keyEndChar);
      let keyName = rawKey;
      try {
        keyName = String(JSON.parse(rawKey));
      } catch {
        // Keep rawKey fallback
      }

      i = skipJsonWhitespace(text, keyEndChar);
      if (text.charCodeAt(i) === 0x3a /* : */) {
        i++;
      }
      const valStartChar = skipJsonWhitespace(text, i);
      const valEndChar = skipJsonValue(text, valStartChar);

      advanceCursor(text, cursor, entryStartChar);
      const startByte = cursor.byteOffset;
      const startLine = cursor.line;

      advanceCursor(text, cursor, valEndChar);
      const endByte = cursor.byteOffset;
      const endLine = cursor.line;

      const valHint = Object.prototype.hasOwnProperty.call(obj, keyName)
        ? describeJsonValue(obj[keyName])
        : "unknown";
      sections.push({
        label: truncateDeterministic(`${keyName} (${valHint})`, 80),
        kind: "json-key",
        startByte,
        endByte,
        startLine,
        endLine,
      });

      if (sections.length >= maxEntries) {
        break;
      }

      i = skipJsonWhitespace(text, valEndChar);
      if (text.charCodeAt(i) === 0x2c /* , */) {
        i = skipJsonWhitespace(text, i + 1);
      }
    }

    return sections;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return [];

    const itemSpans: Array<{
      index: number;
      startByte: number;
      endByte: number;
      startLine: number;
      endLine: number;
    }> = [];

    let i = skipJsonWhitespace(text, firstNonWs + 1);
    let idx = 0;
    while (i < len && text.charCodeAt(i) !== 0x5d /* ] */) {
      const itemStartChar = i;
      const itemEndChar = skipJsonValue(text, itemStartChar);

      advanceCursor(text, cursor, itemStartChar);
      const startByte = cursor.byteOffset;
      const startLine = cursor.line;

      advanceCursor(text, cursor, itemEndChar);
      const endByte = cursor.byteOffset;
      const endLine = cursor.line;

      itemSpans.push({
        index: idx,
        startByte,
        endByte,
        startLine,
        endLine,
      });
      idx++;

      i = skipJsonWhitespace(text, itemEndChar);
      if (text.charCodeAt(i) === 0x2c /* , */) {
        i = skipJsonWhitespace(text, i + 1);
      }
    }

    if (itemSpans.length <= maxEntries) {
      return itemSpans.map((span) => ({
        label: `[${span.index}] (${describeJsonValue(parsed[span.index])})`,
        kind: "json-item" as const,
        startByte: span.startByte,
        endByte: span.endByte,
        startLine: span.startLine,
        endLine: span.endLine,
      }));
    }

    const chunkSize = Math.ceil(itemSpans.length / maxEntries);
    const sections: SpillSectionEntry[] = [];
    for (let startIdx = 0; startIdx < itemSpans.length; startIdx += chunkSize) {
      const endIdx = Math.min(itemSpans.length - 1, startIdx + chunkSize - 1);
      const firstSpan = itemSpans[startIdx]!;
      const lastSpan = itemSpans[endIdx]!;
      const count = endIdx - startIdx + 1;
      sections.push({
        label: `items[${startIdx}..${endIdx}] (${count} items)`,
        kind: "json-item",
        startByte: firstSpan.startByte,
        endByte: lastSpan.endByte,
        startLine: firstSpan.startLine,
        endLine: lastSpan.endLine,
      });
      if (sections.length >= maxEntries) {
        break;
      }
    }

    return sections;
  }

  return [];
}

export function buildSpillStructureMap(
  text: string,
  maxEntries = 20,
): SpillStructureMap {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const headPreview = text.slice(0, HEAD_PREVIEW_CHARS);
  const tailPreview =
    text.length > TAIL_PREVIEW_THRESHOLD
      ? text.slice(-TAIL_PREVIEW_CHARS)
      : undefined;

  const lineSpans = computeLineSpans(text);
  const totalLines = lineSpans.length;
  const boundedMax = Math.max(0, Math.floor(maxEntries));

  let sections: SpillSectionEntry[] = [];
  const jsonSections = parseJsonStructureSections(text, boundedMax);
  if (jsonSections !== null) {
    sections = jsonSections;
  } else if (boundedMax > 0 && lineSpans.length > 0) {
    const headingIndices: number[] = [];
    const logIndices: number[] = [];

    for (let i = 0; i < lineSpans.length; i++) {
      const lineText = lineSpans[i]!.cleanText;
      if (MARKDOWN_HEADING_REGEX.test(lineText)) {
        headingIndices.push(i);
      }
      if (LOG_HEADER_REGEX.test(lineText)) {
        logIndices.push(i);
      }
    }

    const useHeadings =
      headingIndices.length > 0 &&
      (logIndices.length === 0 ||
        headingIndices.length >= 2 ||
        logIndices.length < 3);

    const chosenIndices = useHeadings ? headingIndices : logIndices;
    const chosenKind: SpillSectionEntry["kind"] = useHeadings
      ? "heading"
      : "log-block";

    for (let k = 0; k < chosenIndices.length && sections.length < boundedMax; k++) {
      const startSpanIdx = chosenIndices[k]!;
      const nextMatchIdx = chosenIndices[k + 1];
      const endSpanIdx =
        nextMatchIdx !== undefined ? nextMatchIdx - 1 : lineSpans.length - 1;
      const startSpan = lineSpans[startSpanIdx]!;
      const endSpan = lineSpans[Math.max(startSpanIdx, endSpanIdx)]!;

      sections.push({
        label: truncateDeterministic(startSpan.cleanText, 80),
        kind: chosenKind,
        startByte: startSpan.startByte,
        endByte: endSpan.endByte,
        startLine: startSpan.lineNum,
        endLine: endSpan.lineNum,
      });
    }
  }

  return {
    totalBytes,
    totalLines,
    sha256,
    sections,
    headPreview,
    ...(tailPreview !== undefined ? { tailPreview } : {}),
  };
}

function escapeJsonPointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function resolveJsonPointer(
  root: unknown,
  pointer: string,
): { found: true; value: unknown } | { found: false; reason: string } {
  if (pointer === "") {
    return { found: true, value: root };
  }
  if (!pointer.startsWith("/")) {
    return {
      found: false,
      reason: "Invalid JSON Pointer: must be empty or start with '/'.",
    };
  }

  const tokens = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
        return {
          found: false,
          reason: `Invalid array index "${token}" in JSON Pointer "${pointer}".`,
        };
      }
      const index = Number(token);
      if (index < 0 || index >= current.length) {
        return {
          found: false,
          reason: `JSON Pointer "${pointer}" out of bounds at index ${index}.`,
        };
      }
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) {
        return {
          found: false,
          reason: `JSON Pointer "${pointer}" key "${token}" not found.`,
        };
      }
      current = obj[token];
    } else {
      return {
        found: false,
        reason: `JSON Pointer "${pointer}" cannot traverse primitive value.`,
      };
    }
  }

  return { found: true, value: current };
}

function sliceUtf8ByBytes(
  text: string,
  offsetBytes: number,
  maxBytes: number,
): { text: string; totalBytes: number; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  const totalBytes = buf.length;
  if (offsetBytes >= totalBytes || maxBytes <= 0) {
    return { text: "", totalBytes, truncated: false };
  }

  let start = Math.max(0, offsetBytes);
  if (start > 0 && start < totalBytes) {
    while (start < totalBytes && (buf[start]! & 0xc0) === 0x80) {
      start++;
    }
  }

  let end = Math.min(totalBytes, start + maxBytes);
  if (end < totalBytes) {
    let charStart = end;
    while (charStart > start && (buf[charStart]! & 0xc0) === 0x80) {
      charStart--;
    }
    if (charStart < end) {
      const lead = buf[charStart]!;
      const expectedLen =
        (lead & 0x80) === 0
          ? 1
          : (lead & 0xe0) === 0xc0
            ? 2
            : (lead & 0xf0) === 0xe0
              ? 3
              : 4;
      if (charStart + expectedLen > end) {
        end = charStart;
      }
    }
  }

  return {
    text: buf.subarray(start, end).toString("utf8"),
    totalBytes,
    truncated: end < totalBytes,
  };
}

function accessDeniedSpillResult(reason: string): ReadSpillToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `Access denied: ${reason}` }],
  };
}

export function executeReadSpillTool(
  args: ReadSpillArgs | Record<string, unknown>,
  options: McpDietOptions = {},
): ReadSpillToolResult {
  if (options.disableSpillReader) {
    return accessDeniedSpillResult(
      "mcp_diet_read_spill is disabled by --no-spill-reader.",
    );
  }

  const rawPath =
    args && typeof args === "object" && typeof args.path === "string"
      ? args.path
      : "";
  if (!rawPath.trim()) {
    return accessDeniedSpillResult("missing spill file path.");
  }

  const configuredSpillDir =
    options.spillDir ?? join(tmpdir(), "mcp-diet-spills");
  let realSpillDir: string;
  try {
    realSpillDir = realpathSync(configuredSpillDir);
  } catch {
    return accessDeniedSpillResult(
      "spill directory does not exist or cannot be resolved.",
    );
  }

  let realTarget: string;
  try {
    realTarget = realpathSync(rawPath);
  } catch {
    return accessDeniedSpillResult(
      "spill file not found or outside allowed spill directory.",
    );
  }

  if (
    dirname(realTarget) !== realSpillDir ||
    !SPILL_FILENAME_REGEX.test(basename(realTarget))
  ) {
    return accessDeniedSpillResult(
      "path resolves outside the allowed spill directory or has an invalid spill filename.",
    );
  }

  try {
    if (!statSync(realTarget).isFile()) {
      return accessDeniedSpillResult("target is not a regular file.");
    }
  } catch {
    return accessDeniedSpillResult("unable to stat spill file.");
  }

  const startLine =
    args.startLine !== undefined ? Number(args.startLine) : undefined;
  const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;
  const offsetBytes =
    args.offsetBytes !== undefined ? Number(args.offsetBytes) : undefined;
  const maxBytesArg =
    args.maxBytes !== undefined ? Number(args.maxBytes) : undefined;
  const jsonPointer =
    typeof args.jsonPointer === "string" ? args.jsonPointer : undefined;

  if (
    startLine !== undefined &&
    (!Number.isInteger(startLine) || startLine < 1)
  ) {
    return {
      isError: true,
      content: [
        { type: "text", text: "Invalid startLine: must be an integer >= 1." },
      ],
    };
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
    return {
      isError: true,
      content: [
        { type: "text", text: "Invalid endLine: must be an integer >= 1." },
      ],
    };
  }
  if (
    startLine !== undefined &&
    endLine !== undefined &&
    endLine < startLine
  ) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Invalid line range: endLine must be >= startLine.",
        },
      ],
    };
  }
  if (
    offsetBytes !== undefined &&
    (!Number.isInteger(offsetBytes) || offsetBytes < 0)
  ) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Invalid offsetBytes: must be an integer >= 0.",
        },
      ],
    };
  }
  if (
    maxBytesArg !== undefined &&
    (!Number.isFinite(maxBytesArg) || maxBytesArg <= 0)
  ) {
    return {
      isError: true,
      content: [
        { type: "text", text: "Invalid maxBytes: must be a positive number." },
      ],
    };
  }

  const configuredMaxBytes =
    options.maxResultKb !== undefined && options.maxResultKb > 0
      ? Math.floor(options.maxResultKb * 1024)
      : DEFAULT_READ_SPILL_LIMIT_BYTES;
  const limitBytes = Math.min(
    configuredMaxBytes,
    DEFAULT_READ_SPILL_LIMIT_BYTES,
  );
  const byteCap = Math.min(
    maxBytesArg !== undefined ? Math.floor(maxBytesArg) : limitBytes,
    limitBytes,
  );

  let rawFileText: string;
  try {
    rawFileText = readFileSync(realTarget, "utf8");
  } catch {
    return accessDeniedSpillResult("unable to read spill file.");
  }

  let parsedJson: unknown = undefined;
  let hasParsedJson = false;
  let unwrappedEnvelopeText: string | null = null;
  try {
    parsedJson = JSON.parse(rawFileText);
    hasParsedJson = true;
    unwrappedEnvelopeText = extractMcpContentText(parsedJson);
  } catch {
    hasParsedJson = false;
  }

  const shouldRedact = options.redactSecrets !== false;

  if (jsonPointer !== undefined) {
    if (!hasParsedJson) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "JSON Pointer error: spill file does not contain valid JSON.",
          },
        ],
      };
    }

    let resolved = resolveJsonPointer(parsedJson, jsonPointer);
    if (!resolved.found && unwrappedEnvelopeText !== null) {
      try {
        const innerJson = JSON.parse(unwrappedEnvelopeText);
        const innerResolved = resolveJsonPointer(innerJson, jsonPointer);
        if (innerResolved.found) {
          resolved = innerResolved;
        }
      } catch {
        // Inner payload is not JSON; keep original not-found error
      }
    }

    if (!resolved.found) {
      return {
        isError: true,
        content: [{ type: "text", text: resolved.reason }],
      };
    }

    let formatted =
      typeof resolved.value === "string"
        ? resolved.value
        : JSON.stringify(resolved.value, null, 2);
    if (shouldRedact) {
      formatted = redactSecretsInText(formatted);
    }
    const sliced = sliceUtf8ByBytes(formatted, 0, byteCap);
    return {
      content: [{ type: "text", text: sliced.text }],
      _mcpDietRead: {
        path: realTarget,
        totalBytes: Buffer.byteLength(rawFileText, "utf8"),
        totalLines: splitLinesForSlicing(unwrappedEnvelopeText ?? rawFileText)
          .length,
        returnedBytes: Buffer.byteLength(sliced.text, "utf8"),
        truncated: sliced.truncated,
      },
    };
  }

  const targetText = unwrappedEnvelopeText ?? rawFileText;
  const lines = splitLinesForSlicing(targetText);
  const targetTotalBytes = Buffer.byteLength(targetText, "utf8");

  let outputText: string;
  let truncated = false;

  if (startLine !== undefined || endLine !== undefined) {
    const startIdx = (startLine ?? 1) - 1;
    const endIdx = Math.min(endLine ?? lines.length, lines.length);
    const joined =
      startIdx >= lines.length ? "" : lines.slice(startIdx, endIdx).join("\n");
    const redacted = shouldRedact ? redactSecretsInText(joined) : joined;
    const capped = sliceUtf8ByBytes(redacted, 0, byteCap);
    outputText = capped.text;
    truncated = capped.truncated || endIdx < lines.length;
  } else {
    const slice = sliceUtf8ByBytes(targetText, offsetBytes ?? 0, byteCap);
    const redacted = shouldRedact
      ? redactSecretsInText(slice.text)
      : slice.text;
    const reCapped = sliceUtf8ByBytes(redacted, 0, byteCap);
    outputText = reCapped.text;
    truncated = slice.truncated || reCapped.truncated;
  }

  return {
    content: [{ type: "text", text: outputText }],
    _mcpDietRead: {
      path: realTarget,
      totalBytes: targetTotalBytes,
      totalLines: lines.length,
      returnedBytes: Buffer.byteLength(outputText, "utf8"),
      truncated,
    },
  };
}

function formatSpillNotificationText(params: {
  originalBytes: number;
  maxKb: number;
  maxBytes: number;
  spilledPath: string;
  structureMap: SpillStructureMap;
  disableSpillReader?: boolean;
}): string {
  const {
    originalBytes,
    maxKb,
    maxBytes,
    spilledPath,
    structureMap,
    disableSpillReader,
  } = params;
  const shaPrefix = structureMap.sha256.slice(0, 12);

  const buildText = (
    maxSectionsToShow: number,
    headLimit: number,
    tailLimit: number,
  ): string => {
    const visibleSections = structureMap.sections.slice(0, maxSectionsToShow);
    const sectionLines =
      visibleSections.length > 0
        ? visibleSections.map(
            (s) =>
              `  [L${s.startLine}-L${s.endLine} | bytes ${s.startByte}..${s.endByte}] ${truncateDeterministic(s.label, 64)}`,
          )
        : [
            `  [L1-L${Math.max(1, structureMap.totalLines)} | bytes 0..${structureMap.totalBytes}] (unstructured payload)`,
          ];

    const headSlice = structureMap.headPreview.slice(0, headLimit);
    const tailSlice =
      structureMap.tailPreview !== undefined && tailLimit > 0
        ? structureMap.tailPreview.slice(-tailLimit)
        : undefined;

    const lines: string[] = [
      `[mcp-diet] Oversized tool output intercepted (${(originalBytes / 1024).toFixed(1)} KiB > ${maxKb} KiB limit).`,
      `Full output saved to local file: ${spilledPath}`,
      `totalBytes=${structureMap.totalBytes} | totalLines=${structureMap.totalLines} | sha256=${shaPrefix}`,
      `Structural Section & Offset Index:`,
      ...sectionLines,
      `Head Preview (first ${headSlice.length} chars):`,
      headSlice,
    ];

    if (tailSlice !== undefined) {
      lines.push(`Tail Preview (last ${tailSlice.length} chars):`);
      lines.push(tailSlice);
    }

    if (!disableSpillReader) {
      const s0 = structureMap.sections[0];
      lines.push(`Concrete mcp_diet_read_spill examples:`);
      if (s0?.kind === "json-key") {
        const keyOnly = s0.label.replace(/\s+\([^)]+\)$/, "");
        lines.push(
          `  mcp_diet_read_spill({ path: ${JSON.stringify(spilledPath)}, jsonPointer: ${JSON.stringify(`/${escapeJsonPointerToken(keyOnly)}`)} })`,
        );
        lines.push(
          `  mcp_diet_read_spill({ path: ${JSON.stringify(spilledPath)}, offsetBytes: ${s0.startByte}, maxBytes: ${Math.min(16384, Math.max(1024, s0.endByte - s0.startByte))} })`,
        );
      } else if (s0) {
        lines.push(
          `  mcp_diet_read_spill({ path: ${JSON.stringify(spilledPath)}, startLine: ${s0.startLine}, endLine: ${Math.min(s0.endLine, s0.startLine + 100)} })`,
        );
        lines.push(
          `  mcp_diet_read_spill({ path: ${JSON.stringify(spilledPath)}, offsetBytes: ${s0.startByte}, maxBytes: 16384 })`,
        );
      } else {
        lines.push(
          `  mcp_diet_read_spill({ path: ${JSON.stringify(spilledPath)}, startLine: 1, endLine: ${Math.min(100, Math.max(1, structureMap.totalLines))} })`,
        );
        lines.push(
          `  mcp_diet_read_spill({ path: ${JSON.stringify(spilledPath)}, offsetBytes: 0, maxBytes: 16384 })`,
        );
      }
    }

    return lines.join("\n");
  };

  let formatted = buildText(
    structureMap.sections.length,
    HEAD_PREVIEW_CHARS,
    TAIL_PREVIEW_CHARS,
  );
  // Keep spill summary strictly under tiny test thresholds (e.g. maxResultKb: 4)
  if (maxBytes <= 8192 && formatted.length >= maxBytes) {
    formatted = buildText(Math.min(10, structureMap.sections.length), 600, 200);
    if (formatted.length >= maxBytes) {
      formatted = buildText(Math.min(5, structureMap.sections.length), 300, 100);
    }
  }
  return formatted;
}

export async function guardToolCallResult(
  result: unknown,
  options: McpDietOptions = {},
): Promise<{
  result: unknown;
  spilledPath: string | null;
  originalBytes: number;
  spilledImages: SpilledImageMetadata[];
}> {
  const processed = options.redactSecrets
    ? redactSecretsInValue(result)
    : result;
  const originalSerialized = JSON.stringify(processed ?? null);
  const originalBytes = Buffer.byteLength(originalSerialized, "utf8");
  const maxKb = options.maxResultKb ?? 512;
  const maxBytes = maxKb * 1024;
  const maxImageDim =
    options.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION_PX;
  const spillDir = options.spillDir ?? join(tmpdir(), "mcp-diet-spills");

  let updatedProcessed = processed;
  const spilledImages: SpilledImageMetadata[] = [];
  let spillDirCreated = false;

  const processedRecord =
    processed && typeof processed === "object" && !Array.isArray(processed)
      ? (processed as Record<string, unknown>)
      : null;

  if (
    maxImageDim > 0 &&
    processedRecord &&
    Array.isArray(processedRecord.content)
  ) {
    const contentItems = processedRecord.content;
    let nextContent: unknown[] | null = null;

    for (let idx = 0; idx < contentItems.length; idx++) {
      const item = contentItems[idx];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const recordItem = item as Record<string, unknown>;
      if (recordItem.type !== "image" || typeof recordItem.data !== "string") {
        continue;
      }

      const dims = inspectImageDimensions(recordItem.data);
      if (!dims || (dims.width <= maxImageDim && dims.height <= maxImageDim)) {
        continue;
      }

      if (!spillDirCreated) {
        await mkdir(spillDir, { recursive: true });
        spillDirCreated = true;
      }
      if (nextContent === null) {
        nextContent = [...contentItems];
      }

      const imgBuf = decodeBase64Payload(recordItem.data);
      const sha256 = createHash("sha256").update(imgBuf).digest("hex");
      const ext = dims.format === "jpeg" ? "jpg" : dims.format;
      const mimeType =
        typeof recordItem.mimeType === "string"
          ? recordItem.mimeType
          : `image/${dims.format}`;
      const imgPath = join(
        spillDir,
        `mcp-tool-image-${Date.now()}-${sha256.slice(0, 12)}-${idx}.${ext}`,
      );
      await writeFile(imgPath, imgBuf);

      spilledImages.push({
        index: idx,
        path: imgPath,
        mimeType,
        format: dims.format,
        width: dims.width,
        height: dims.height,
        byteLength: dims.byteLength,
        maxDimensionPx: maxImageDim,
        sha256,
      });

      nextContent[idx] = {
        type: "text",
        text: [
          `[mcp-diet] Oversized image block intercepted (${dims.width}x${dims.height}px > ${maxImageDim}px max dimension; ${mimeType}, ${(dims.byteLength / 1024).toFixed(1)} KiB).`,
          `Prevents Claude Code many-image >2000px session lockup.`,
          `Binary image saved to local file: ${imgPath} (sha256=${sha256.slice(0, 12)})`,
        ].join("\n"),
      };
    }

    if (nextContent !== null && spilledImages.length > 0) {
      updatedProcessed = {
        ...processedRecord,
        content: nextContent,
        _mcpDietSpilledImages: spilledImages,
      };
    }
  }

  const currentSerialized =
    updatedProcessed === processed
      ? originalSerialized
      : JSON.stringify(updatedProcessed ?? null);
  const currentBytes = Buffer.byteLength(currentSerialized, "utf8");

  if (maxKb <= 0 || currentBytes <= maxBytes) {
    return {
      result: updatedProcessed,
      spilledPath: null,
      originalBytes,
      spilledImages,
    };
  }

  if (!spillDirCreated) {
    await mkdir(spillDir, { recursive: true });
    spillDirCreated = true;
  }

  const digest = createHash("sha256")
    .update(currentSerialized)
    .digest("hex")
    .slice(0, 12);
  const spilledPath = join(
    spillDir,
    `mcp-tool-output-${Date.now()}-${digest}.json`,
  );
  await writeFile(spilledPath, currentSerialized, "utf8");

  let previewText = currentSerialized;
  const updatedRecord =
    updatedProcessed &&
    typeof updatedProcessed === "object" &&
    !Array.isArray(updatedProcessed)
      ? (updatedProcessed as Record<string, unknown>)
      : null;

  if (updatedRecord && Array.isArray(updatedRecord.content)) {
    const contentItems = updatedRecord.content as Array<
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

  const structureMap = buildSpillStructureMap(previewText);
  const formattedText = formatSpillNotificationText({
    originalBytes: currentBytes,
    maxKb,
    maxBytes,
    spilledPath,
    structureMap,
    disableSpillReader: options.disableSpillReader,
  });

  return {
    spilledPath,
    originalBytes,
    spilledImages,
    result: {
      ...(updatedRecord?.isError === true ? { isError: true } : {}),
      content: [
        {
          type: "text",
          text: formattedText,
        },
      ],
      _mcpDietSpilled: {
        path: spilledPath,
        originalBytes: currentBytes,
        maxBytes,
        totalBytes: structureMap.totalBytes,
        totalLines: structureMap.totalLines,
        sha256: structureMap.sha256,
        sections: structureMap.sections,
        ...(spilledImages.length > 0 ? { spilledImages } : {}),
      },
    },
  };
}

export async function transformJsonRpcMessage(
  rawLine: string,
  options: McpDietOptions = {},
  pendingRequests?: Map<string | number, string>,
  knownTools?: Map<string, McpToolDefinition>,
  telemetry?: SpillTelemetryTracker,
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
    let nextTools = filtered.tools;

    const denyList = normalizePatternList(options.deny);
    const spillReaderDenied =
      denyList.length > 0 &&
      denyList.some((p) => matchesPattern(MCP_DIET_READ_SPILL_TOOL.name, p));

    if (!options.disableSpillReader && !spillReaderDenied) {
      const compactedVirtual = filterToolsList([MCP_DIET_READ_SPILL_TOOL], {
        maxDescChars: options.maxDescChars,
      }).tools;
      const withoutDuplicate = nextTools.filter(
        (t) => t.name !== MCP_DIET_READ_SPILL_TOOL.name,
      );
      nextTools = [...withoutDuplicate, ...compactedVirtual].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (knownTools) {
        for (const vt of compactedVirtual) {
          knownTools.set(vt.name, vt);
        }
      }
    }

    return JSON.stringify({
      ...parsed,
      result: {
        ...resultObj,
        tools: nextTools,
      },
    });
  }

  if (
    resultObj &&
    (method === "tools/call" || Array.isArray(resultObj.content))
  ) {
    const guarded = await guardToolCallResult(resultObj, options);
    telemetry?.recordToolCall({
      spilledPath: guarded.spilledPath,
      imageSpillCount: guarded.spilledImages.length,
    });
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
  getTelemetry: () => SpillTelemetryStats;
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
  const telemetry = createSpillTelemetryTracker();

  const resolved = resolveWindowsSpawn(params.command, params.args, env);
  const child = spawn(resolved.command, resolved.args, {
    shell: resolved.shell,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const pendingRequests = new Map<string | number, string>();
  const knownTools = new Map<string, McpToolDefinition>();
  if (!params.options.disableSpillReader) {
    knownTools.set(MCP_DIET_READ_SPILL_TOOL.name, MCP_DIET_READ_SPILL_TOOL);
  }

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
            toolName === MCP_DIET_READ_SPILL_TOOL.name &&
            !params.options.disableSpillReader
          ) {
            const denyList = normalizePatternList(params.options.deny);
            const spillReaderDenied =
              denyList.length > 0 &&
              denyList.some((p) => matchesPattern(toolName, p));
            if (spillReaderDenied) {
              clientOut.write(
                `${JSON.stringify({
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
                })}\n`,
              );
              return;
            }

            const toolArgs =
              msgParams &&
              msgParams.arguments &&
              typeof msgParams.arguments === "object"
                ? (msgParams.arguments as Record<string, unknown>)
                : {};
            const readResult = executeReadSpillTool(toolArgs, params.options);
            if (!readResult.isError) {
              telemetry.recordSpillRead(readResult._mcpDietRead?.path);
            }
            clientOut.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: msgId,
                result: readResult,
              })}\n`,
            );
            return;
          }

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
              telemetry,
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
            telemetry,
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

  return { child, close, getTelemetry: () => telemetry.getStats() };
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
  MCP_DIET_READ_SPILL_TOOL,
];

export interface StandaloneServerHandle {
  close: () => void;
  getTelemetry: () => SpillTelemetryStats;
}

export function startStandaloneMcpServer(params?: {
  options?: McpDietOptions;
  version?: string;
  clientIn?: Readable;
  clientOut?: Writable;
}): StandaloneServerHandle {
  const options = params?.options ?? {};
  const version = params?.version ?? "0.3.0";
  const clientIn = params?.clientIn ?? process.stdin;
  const clientOut = params?.clientOut ?? process.stdout;
  const telemetry = createSpillTelemetryTracker();

  const activeStandaloneTools = options.disableSpillReader
    ? STANDALONE_MCP_TOOLS.filter(
        (t) => t.name !== MCP_DIET_READ_SPILL_TOOL.name,
      )
    : STANDALONE_MCP_TOOLS;

  const knownTools = new Map<string, McpToolDefinition>(
    activeStandaloneTools.map((t) => [t.name, t]),
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
          const filtered = filterToolsList(activeStandaloneTools, options);
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

        if (method === "logging/setLevel") {
          clientOut.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`,
          );
          return;
        }

        if (method === "completion/complete") {
          clientOut.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { completion: { values: [] } },
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

          if (toolName === MCP_DIET_READ_SPILL_TOOL.name) {
            const readResult = executeReadSpillTool(toolArgs, options);
            if (!readResult.isError) {
              telemetry.recordSpillRead(readResult._mcpDietRead?.path);
            }
            clientOut.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: readResult,
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
                      telemetry: telemetry.getStats(),
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
          telemetry.recordToolCall({
            spilledPath: guarded.spilledPath,
            imageSpillCount: guarded.spilledImages.length,
          });
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

  return { close, getTelemetry: () => telemetry.getStats() };
}
