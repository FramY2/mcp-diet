import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { parseCliArgs } from "../src/cli.js";
import {
  buildSpillStructureMap,
  executeReadSpillTool,
  filterToolsList,
  guardToolCallResult,
  isReadOnlyTool,
  redactSecretsInText,
  startStandaloneMcpServer,
  startStdioMcpProxy,
  transformJsonRpcMessage,
  type McpToolDefinition,
} from "../src/proxy.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

const SAMPLE_TOOLS: McpToolDefinition[] = [
  {
    name: "delete_repository",
    description:
      "Permanently deletes an entire GitHub repository and all associated issues, pull requests, and releases.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner username" },
        repo: { type: "string", description: "Repository name to delete" },
      },
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "get_pull_request",
    description:
      "Fetches details of a specific pull request including title, body, state, and mergeability status.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository name" },
        number: { type: "number", description: "Pull request number" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_issues",
    description:
      "Lists issues in a repository with filtering by state, labels, and assignee.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description:
            "Filter issues by open, closed, or all states across the repository.",
        },
      },
    },
  },
];

describe("mcp-diet — tools/list tree-shaking and prefix-cache determinism", () => {
  it("filters tools by --allow, --deny, and --read-only and sorts deterministically by name", () => {
    const readOnlyRes = filterToolsList(SAMPLE_TOOLS, { readOnly: true });
    expect(readOnlyRes.tools.map((t) => t.name)).toEqual([
      "get_pull_request",
      "list_issues",
    ]);
    expect(readOnlyRes.stats.removedTools).toEqual(["delete_repository"]);
    expect(readOnlyRes.stats.savedBytes).toBeGreaterThan(100);

    const allowWildcard = filterToolsList(SAMPLE_TOOLS, {
      allow: ["get_*"],
    });
    expect(allowWildcard.tools.map((t) => t.name)).toEqual([
      "get_pull_request",
    ]);

    const denyWildcard = filterToolsList(SAMPLE_TOOLS, {
      deny: ["delete_*", "list_*"],
    });
    expect(denyWildcard.tools.map((t) => t.name)).toEqual([
      "get_pull_request",
    ]);
  });

  it("truncates tool and property descriptions deterministically with --max-desc", () => {
    const res = filterToolsList(SAMPLE_TOOLS, { maxDescChars: 40 });
    for (const tool of res.tools) {
      expect((tool.description ?? "").length).toBeLessThanOrEqual(40);
      expect(tool.description?.endsWith("...")).toBe(true);
    }
    const firstRun = JSON.stringify(res.tools);
    const secondRun = JSON.stringify(
      filterToolsList([...SAMPLE_TOOLS].reverse(), { maxDescChars: 40 }).tools,
    );
    expect(firstRun).toBe(secondRun);
  });

  it("identifies read-only tools via annotations.readOnlyHint or name heuristics", () => {
    expect(
      isReadOnlyTool({
        name: "custom_mutation",
        annotations: { readOnlyHint: true },
      }),
    ).toBe(true);
    expect(
      isReadOnlyTool({
        name: "get_secret_but_destructive",
        annotations: { destructiveHint: true },
      }),
    ).toBe(false);
    expect(isReadOnlyTool({ name: "search_code" })).toBe(true);
    expect(isReadOnlyTool({ name: "drop_table" })).toBe(false);
  });
});

describe("mcp-diet — oversized tools/call crash guard & secret redaction", () => {
  it("redacts Anthropic, OpenAI, GitHub, AWS, URI userinfo, AccountKey, and Bearer secrets", () => {
    const raw = [
      "ANTHROPIC=sk-ant-api03-1234567890abcdefghijklmnop",
      "OPENAI=sk-proj-1234567890abcdefghijklmnop",
      "GITHUB=ghp_1234567890abcdefghijklmnopqrstuvwx",
      "AWS=AKIA1234567890ABCDEF",
      "DSN=postgres://admin:super_secret_pw@db.internal:5432/prod",
      "AZURE=AccountKey=wJalrXUtnFEMI/K7MDENG/bPxRfiCYzSecretKey==",
      "AUTH=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload",
    ].join("\n");

    const redacted = redactSecretsInText(raw);
    expect(redacted).toContain("***REDACTED***");
    expect(redacted).not.toContain("1234567890abcdefghijklmnop");
    expect(redacted).not.toContain("super_secret_pw");
    expect(redacted).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYzSecretKey");
    expect(redacted).not.toContain("secretpayload");
  });

  it("spills oversized tools/call results to a temp file and returns a bounded preview", async () => {
    const spillDir = await mkdtemp(join(tmpdir(), "mcp-diet-test-"));
    tempDirs.push(spillDir);

    const hugeText = `sk-ant-api03-1234567890abcdefghijklmnop\n${"x".repeat(20_000)}`;
    const guarded = await guardToolCallResult(
      {
        content: [{ type: "text", text: hugeText }],
      },
      {
        maxResultKb: 4,
        redactSecrets: true,
        spillDir,
      },
    );

    expect(guarded.spilledPath).toBeTruthy();
    const spilledContent = await readFile(guarded.spilledPath!, "utf8");
    expect(spilledContent).toContain("***REDACTED***");
    expect(spilledContent).not.toContain("1234567890abcdefghijklmnop");

    const resultRecord = guarded.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(resultRecord.content[0]?.text).toContain(
      "[mcp-diet] Oversized tool output intercepted",
    );
    expect(resultRecord.content[0]?.text).toContain(guarded.spilledPath!);
    expect(resultRecord.content[0]?.text.length).toBeLessThan(4096);
  });

  it("transforms JSON-RPC tools/list and tools/call messages end-to-end", async () => {
    const pending = new Map<string | number, string>([[2, "tools/call"]]);
    const listLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: SAMPLE_TOOLS },
    });
    const filteredLine = await transformJsonRpcMessage(
      listLine,
      { readOnly: true, maxDescChars: 50 },
      pending,
    );
    const parsedList = JSON.parse(filteredLine) as {
      result: { tools: McpToolDefinition[] };
    };
    expect(parsedList.result.tools.map((t) => t.name)).toEqual([
      "get_pull_request",
      "list_issues",
      "mcp_diet_read_spill",
    ]);

    const callLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [
          {
            type: "text",
            text: "Leaked token: ghp_1234567890abcdefghijklmnopqrstuvwx",
          },
        ],
      },
    });
    const redactedCall = await transformJsonRpcMessage(
      callLine,
      { redactSecrets: true },
      pending,
    );
    expect(redactedCall).toContain("***REDACTED***");
    expect(redactedCall).not.toContain("1234567890abcdefghijklmnopqrstuvwx");
  });

  it("proxies a live child stdio MCP server process end-to-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-diet-stdio-"));
    tempDirs.push(dir);
    const fakeServerPath = join(dir, "fake-mcp-server.mjs");
    await writeFile(
      fakeServerPath,
      [
        'import { createInterface } from "node:readline";',
        "const rl = createInterface({ input: process.stdin });",
        'rl.on("line", (line) => {',
        "  const msg = JSON.parse(line);",
        '  if (msg.method === "tools/list") {',
        "    process.stdout.write(JSON.stringify({",
        '      jsonrpc: "2.0",',
        "      id: msg.id,",
        "      result: {",
        "        tools: [",
        '          { name: "read_file", description: "Read file contents from workspace", annotations: { readOnlyHint: true } },',
        '          { name: "delete_file", description: "Delete file permanently", annotations: { destructiveHint: true } }',
        "        ]",
        "      }",
        '    }) + "\\n");',
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const proxy = startStdioMcpProxy({
      command: process.execPath,
      args: [fakeServerPath],
      options: { readOnly: true },
      clientIn,
      clientOut,
    });

    const responsePromise = new Promise<string>((resolve) => {
      let buf = "";
      clientOut.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes("\n")) {
          resolve(buf.trim());
        }
      });
    });

    clientIn.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} })}\n`,
    );

    const responseLine = await responsePromise;
    proxy.close();

    const parsed = JSON.parse(responseLine) as {
      id: number;
      result: { tools: McpToolDefinition[] };
    };
    expect(parsed.id).toBe(10);
    expect(parsed.result.tools.map((t) => t.name)).toEqual([
      "mcp_diet_read_spill",
      "read_file",
    ]);
  });

  it("blocks forbidden tools/call requests at the firewall and handles multi-line JSON + stdout banners", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-diet-firewall-"));
    tempDirs.push(dir);
    const fakeServerPath = join(dir, "fake-multiline-mcp.mjs");
    await writeFile(
      fakeServerPath,
      [
        'import { createInterface } from "node:readline";',
        'process.stdout.write("MCP server diagnostic startup banner\\n");',
        "const rl = createInterface({ input: process.stdin });",
        'rl.on("line", (line) => {',
        "  const msg = JSON.parse(line);",
        '  if (msg.method === "tools/list") {',
        "    process.stdout.write(JSON.stringify({",
        '      jsonrpc: "2.0",',
        "      id: msg.id,",
        "      result: {",
        "        tools: [",
        '          { name: "read_file", description: "Read file", annotations: { readOnlyHint: true } },',
        '          { name: "delete_file", description: "Delete file", annotations: { destructiveHint: true } }',
        "        ]",
        "      }",
        '    }, null, 2) + "\\n");',
        "  }",
        '  if (msg.method === "tools/call") {',
        "    process.stdout.write(JSON.stringify({",
        '      jsonrpc: "2.0",',
        "      id: msg.id,",
        '      result: { content: [{ type: "text", text: "executed:" + msg.params.name }] }',
        '    }) + "\\n");',
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const proxy = startStdioMcpProxy({
      command: process.execPath,
      args: [fakeServerPath],
      options: { readOnly: true },
      clientIn,
      clientOut,
    });

    const lines: string[] = [];
    const pendingWaiters: Array<{ count: number; resolve: () => void }> = [];
    clientOut.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString().split(/\r?\n/)) {
        if (l.trim()) lines.push(l.trim());
      }
      for (let i = pendingWaiters.length - 1; i >= 0; i--) {
        if (lines.length >= pendingWaiters[i]!.count) {
          pendingWaiters[i]!.resolve();
          pendingWaiters.splice(i, 1);
        }
      }
    });
    const waitForLines = (count: number) =>
      new Promise<void>((resolve) => {
        if (lines.length >= count) {
          resolve();
          return;
        }
        pendingWaiters.push({ count, resolve });
      });

    clientIn.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
    );
    await waitForLines(2);

    expect(lines[0]).toBe("MCP server diagnostic startup banner");
    const listResp = JSON.parse(lines[1]!) as {
      result: { tools: McpToolDefinition[] };
    };
    expect(listResp.result.tools.map((t) => t.name)).toEqual([
      "mcp_diet_read_spill",
      "read_file",
    ]);

    // Attempt a forbidden tools/call to delete_file -> blocked by firewall without hitting server
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "delete_file", arguments: { path: "/etc/passwd" } },
      })}\n`,
    );
    await waitForLines(3);

    const blockedResp = JSON.parse(lines[2]!) as {
      id: number;
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(blockedResp.id).toBe(2);
    expect(blockedResp.result.isError).toBe(true);
    expect(blockedResp.result.content[0]?.text).toContain(
      'Tool call "delete_file" blocked by runtime firewall policy',
    );
    proxy.close();
  });

  it("summarizes oversized image and resource content blocks without dumping raw base64", async () => {
    const spillDir = await mkdtemp(join(tmpdir(), "mcp-diet-media-"));
    tempDirs.push(spillDir);

    const guardedImage = await guardToolCallResult(
      {
        isError: true,
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "A".repeat(12_000),
          },
          {
            type: "resource",
            resource: {
              uri: "file:///logs/app.log",
              text: "Resource log line summary",
            },
          },
        ],
      },
      { maxResultKb: 2, spillDir },
    );

    const res = guardedImage.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain(
      "[image block (image/png, 12000 base64 chars)]",
    );
    expect(res.content[0]?.text).toContain("Resource log line summary");
    expect(res.content[0]?.text).not.toContain("AAAAAAAAAA");
  });

  it("parses CLI flags cleanly", () => {
    const parsed = parseCliArgs([
      "--read-only",
      "--allow",
      "get_*,list_*",
      "--deny=delete_*",
      "--max-desc",
      "120",
      "--max-result-kb=256",
      "--redact-secrets",
      "--",
      "npx",
      "-y",
      "@modelcontextprotocol/server-github",
    ]);
    expect(parsed.options.readOnly).toBe(true);
    expect(parsed.options.allow).toEqual(["get_*,list_*"]);
    expect(parsed.options.deny).toEqual(["delete_*"]);
    expect(parsed.options.maxDescChars).toBe(120);
    expect(parsed.options.maxResultKb).toBe(256);
    expect(parsed.options.redactSecrets).toBe(true);
    expect(parsed.command).toBe("npx");
    expect(parsed.commandArgs).toEqual([
      "-y",
      "@modelcontextprotocol/server-github",
    ]);

    const standaloneParsed = parseCliArgs(["--self-test-server", "--read-only"]);
    expect(standaloneParsed.selfTestServer).toBe(true);
    expect(standaloneParsed.options.readOnly).toBe(true);
    expect(standaloneParsed.command).toBeNull();
  });

  it("serves standalone MCP introspection requests (initialize, tools/list, resources/list, prompts/list, tools/call)", async () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const server = startStandaloneMcpServer({
      options: { redactSecrets: true },
      version: "0.2.0",
      clientIn,
      clientOut,
    });

    const lines: string[] = [];
    const pendingWaiters: Array<{ count: number; resolve: () => void }> = [];
    clientOut.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString().split(/\r?\n/)) {
        if (l.trim()) lines.push(l.trim());
      }
      for (let i = pendingWaiters.length - 1; i >= 0; i--) {
        if (lines.length >= pendingWaiters[i]!.count) {
          pendingWaiters[i]!.resolve();
          pendingWaiters.splice(i, 1);
        }
      }
    });
    const waitForLines = (count: number) =>
      new Promise<void>((resolve) => {
        if (lines.length >= count) {
          resolve();
          return;
        }
        pendingWaiters.push({ count, resolve });
      });

    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "glama-scanner", version: "1.0.0" },
        },
      })}\n`,
    );
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`,
    );
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })}\n`,
    );
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/list",
        params: {},
      })}\n`,
    );
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "prompts/list",
        params: {},
      })}\n`,
    );
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "mcp_diet_analyze_tools",
          arguments: {
            tools: SAMPLE_TOOLS,
            readOnly: true,
          },
        },
      })}\n`,
    );
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "mcp_diet_redact_text",
          arguments: {
            text: "Leaked key: sk-ant-api03-1234567890abcdefghijklmnop",
          },
        },
      })}\n`,
    );

    await waitForLines(6);
    server.close();

    const initResp = JSON.parse(lines[0]!) as {
      id: number;
      result: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
      };
    };
    expect(initResp.id).toBe(1);
    expect(initResp.result.protocolVersion).toBe("2025-03-26");
    expect(initResp.result.serverInfo.name).toBe("@framy2/mcp-diet");
    expect(initResp.result.serverInfo.version).toBe("0.2.0");

    const toolsResp = JSON.parse(lines[1]!) as {
      id: number;
      result: { tools: McpToolDefinition[] };
    };
    expect(toolsResp.id).toBe(2);
    expect(toolsResp.result.tools.map((t) => t.name)).toEqual([
      "mcp_diet_analyze_tools",
      "mcp_diet_read_spill",
      "mcp_diet_redact_text",
      "mcp_diet_status",
    ]);

    const resResp = JSON.parse(lines[2]!) as {
      id: number;
      result: { resources: unknown[] };
    };
    expect(resResp.id).toBe(3);
    expect(resResp.result.resources).toEqual([]);

    const promptsResp = JSON.parse(lines[3]!) as {
      id: number;
      result: { prompts: unknown[] };
    };
    expect(promptsResp.id).toBe(4);
    expect(promptsResp.result.prompts).toEqual([]);

    const analyzeResp = JSON.parse(lines[4]!) as {
      id: number;
      result: { content: Array<{ text: string }> };
    };
    expect(analyzeResp.id).toBe(5);
    const stats = JSON.parse(analyzeResp.result.content[0]!.text) as {
      originalCount: number;
      keptCount: number;
      removedTools: string[];
    };
    expect(stats.originalCount).toBe(3);
    expect(stats.keptCount).toBe(2);
    expect(stats.removedTools).toEqual(["delete_repository"]);

    const redactResp = JSON.parse(lines[5]!) as {
      id: number;
      result: { content: Array<{ text: string }> };
    };
    expect(redactResp.id).toBe(6);
    expect(redactResp.result.content[0]!.text).toContain("***REDACTED***");
    expect(redactResp.result.content[0]!.text).not.toContain(
      "1234567890abcdefghijklmnop",
    );
  });

  it("responds to MCP initialize + tools/list when CLI is invoked without a downstream command over non-TTY stdio", async () => {
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const tsxCliPath = fileURLToPath(
      new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [tsxCliPath, cliPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines: string[] = [];
    const waitForLines = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (lines.length >= count) resolve();
        };
        check();
        child.stdout.on("data", (chunk: Buffer) => {
          for (const l of chunk.toString().split(/\r?\n/)) {
            if (l.trim()) lines.push(l.trim());
          }
          check();
        });
      });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {} },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })}\n`,
    );

    await waitForLines(2);
    child.stdin.end();
    child.kill();

    const init = JSON.parse(lines[0]!) as {
      id: number;
      result: { serverInfo: { name: string } };
    };
    expect(init.id).toBe(1);
    expect(init.result.serverInfo.name).toBe("@framy2/mcp-diet");

    const tools = JSON.parse(lines[1]!) as {
      id: number;
      result: { tools: McpToolDefinition[] };
    };
    expect(tools.id).toBe(2);
    expect(tools.result.tools.length).toBe(4);
  });

  it("executes CLI main() when invoked via a symlinked binary path (like node_modules/.bin/mcp-diet)", async () => {
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const tsxCliPath = fileURLToPath(
      new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const dir = await mkdtemp(join(tmpdir(), "mcp-diet-symlink-"));
    tempDirs.push(dir);
    const linkPath = join(dir, "mcp-diet-bin.ts");
    await symlink(cliPath, linkPath);

    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCliPath, linkPath, "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(`Exited with code ${code}`));
        else resolve(stdout.trim());
      });
    });

    expect(out).toBe("0.2.0");
  });
});

describe("mcp-diet v0.2.0 — structured spill offset maps and sandboxed mcp_diet_read_spill", () => {
  it("builds JSON object and array spill structure maps with 1-based lines, UTF-8 byte spans, and tail preview", () => {
    const payload = {
      metadata: { source: "github 🚀", ok: true },
      results: Array.from({ length: 420 }, (_, i) => ({
        id: i,
        title: `Issue #${i} — details`,
      })),
      total: 420,
    };
    const prettyJson = JSON.stringify(payload, null, 2);
    const map = buildSpillStructureMap(prettyJson);

    expect(map.totalBytes).toBe(Buffer.byteLength(prettyJson, "utf8"));
    expect(map.totalLines).toBeGreaterThan(1000);
    expect(map.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(map.headPreview.length).toBe(1200);
    expect(map.tailPreview?.length).toBe(400);
    expect(map.sections).toHaveLength(3);
    expect(map.sections[0]?.kind).toBe("json-key");
    expect(map.sections[0]?.label).toBe("metadata (object)");
    expect(map.sections[0]?.startLine).toBe(2);
    expect(map.sections[1]?.label).toBe("results (array[420])");
    expect(map.sections[2]?.label).toBe("total (number)");

    const rawBuf = Buffer.from(prettyJson, "utf8");
    const metaSlice = rawBuf
      .subarray(map.sections[0]!.startByte, map.sections[0]!.endByte)
      .toString("utf8");
    expect(metaSlice).toContain('"source": "github 🚀"');

    // Large JSON array chunks capped at maxEntries
    const arrayJson = JSON.stringify(
      Array.from({ length: 65 }, (_, i) => ({ index: i })),
      null,
      2,
    );
    const arrayMap = buildSpillStructureMap(arrayJson, 10);
    expect(arrayMap.sections.length).toBeLessThanOrEqual(10);
    expect(arrayMap.sections[0]?.kind).toBe("json-item");
    expect(arrayMap.sections[0]?.label).toContain("items[0..");

    // Small payload <= 1600 chars omits tailPreview
    const smallArrayJson = JSON.stringify([{ a: 1 }, "two"]);
    const smallMap = buildSpillStructureMap(smallArrayJson);
    expect(smallMap.tailPreview).toBeUndefined();
    expect(smallMap.sections.map((s) => s.label)).toEqual([
      "[0] (object)",
      "[1] (string)",
    ]);
  });

  it("builds Markdown heading and log-block spill structure maps up to 20 entries", () => {
    const mdLines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      mdLines.push(`## Section ${i}`);
      mdLines.push(`Line A of section ${i} with UTF-8 café`);
      mdLines.push(`Line B of section ${i}`);
    }
    const mdText = mdLines.join("\n");
    const mdMap = buildSpillStructureMap(mdText);

    expect(mdMap.sections).toHaveLength(20);
    expect(mdMap.sections[0]?.kind).toBe("heading");
    expect(mdMap.sections[0]?.label).toBe("## Section 1");
    expect(mdMap.sections[0]?.startLine).toBe(1);
    expect(mdMap.sections[0]?.endLine).toBe(3);
    expect(mdMap.sections[1]?.startLine).toBe(4);
    expect(mdMap.sections[1]?.endLine).toBe(6);

    const mdBuf = Buffer.from(mdText, "utf8");
    expect(
      mdBuf
        .subarray(mdMap.sections[0]!.startByte, mdMap.sections[0]!.endByte)
        .toString("utf8"),
    ).toContain("## Section 1");

    const logText = [
      "[2026-11-14T09:00:00Z] Boot sequence started",
      "service=api port=8080",
      "WARN Cache miss ratio above threshold",
      "cache=redis key=session:42",
      "ERROR Failed to connect to replica",
      "retry=3",
      "=== Summary ===",
      "FAIL 1 check failed",
    ].join("\n");
    const logMap = buildSpillStructureMap(logText);
    expect(logMap.sections).toHaveLength(5);
    expect(logMap.sections.every((s) => s.kind === "log-block")).toBe(true);
    expect(logMap.sections[1]?.label).toContain("WARN Cache miss");
    expect(logMap.sections[2]?.label).toContain("ERROR Failed");
    expect(logMap.sections[2]?.startLine).toBe(5);
    expect(logMap.sections[2]?.endLine).toBe(6);
  });

  it("enriches guardToolCallResult output and _mcpDietSpilled with offset index and previews", async () => {
    const spillDir = await mkdtemp(join(tmpdir(), "mcp-diet-map-"));
    tempDirs.push(spillDir);

    const mdPayload = [
      "# Report Overview",
      "Intro paragraph ".repeat(80),
      "## Findings",
      "Detail line ".repeat(120),
      "## Conclusion",
      "Final tail marker XYZ_END",
    ].join("\n");

    const guarded = await guardToolCallResult(
      { content: [{ type: "text", text: mdPayload }] },
      { maxResultKb: 2, spillDir },
    );

    const resultObj = guarded.result as {
      content: Array<{ type: string; text: string }>;
      _mcpDietSpilled: {
        path: string;
        originalBytes: number;
        maxBytes: number;
        totalLines: number;
        sha256: string;
        sections: Array<{ label: string; kind: string }>;
      };
    };

    const text = resultObj.content[0]!.text;
    expect(text).toContain("totalBytes=");
    expect(text).toContain("totalLines=6");
    expect(text).toContain("sha256=");
    expect(text).toContain("Structural Section & Offset Index:");
    expect(text).toContain("[L1-L2 | bytes ");
    expect(text).toContain("# Report Overview");
    expect(text).toContain("Head Preview");
    expect(text).toContain("Tail Preview");
    expect(text).toContain("Final tail marker XYZ_END");
    expect(text).toContain("mcp_diet_read_spill");

    expect(resultObj._mcpDietSpilled.path).toBe(guarded.spilledPath);
    expect(resultObj._mcpDietSpilled.originalBytes).toBeGreaterThan(2048);
    expect(resultObj._mcpDietSpilled.maxBytes).toBe(2048);
    expect(resultObj._mcpDietSpilled.totalLines).toBe(6);
    expect(resultObj._mcpDietSpilled.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(resultObj._mcpDietSpilled.sections.map((s) => s.label)).toEqual([
      "# Report Overview",
      "## Findings",
      "## Conclusion",
    ]);
  });

  it("supports line slicing, byte slicing, RFC 6901 jsonPointer, capping, and default secret redaction in executeReadSpillTool", async () => {
    const spillDir = await mkdtemp(join(tmpdir(), "mcp-diet-read-"));
    tempDirs.push(spillDir);

    const data = {
      meta: { secret: "sk-ant-api03-1234567890abcdefghijklmnop" },
      "a/b": { "c~d": "escaped-pointer-ok" },
      results: [
        { id: 10, title: "First item 🚀" },
        { id: 20, title: "Second item", body: "Z".repeat(5000) },
      ],
    };
    const spillFile = join(spillDir, "mcp-tool-output-1700000000000-abcdef012345.json");
    const pretty = JSON.stringify(data, null, 2);
    await writeFile(spillFile, pretty, "utf8");

    // 1. 1-based line slicing + default secret redaction
    const lineRes = executeReadSpillTool(
      { path: spillFile, startLine: 1, endLine: 4 },
      { spillDir },
    );
    expect(lineRes.isError).toBeUndefined();
    expect(lineRes.content[0]?.text).toContain("***REDACTED***");
    expect(lineRes.content[0]?.text).not.toContain("1234567890abcdefghijklmnop");

    // Opt-out redaction when redactSecrets: false
    const unredacted = executeReadSpillTool(
      { path: spillFile, startLine: 1, endLine: 4 },
      { spillDir, redactSecrets: false },
    );
    expect(unredacted.content[0]?.text).toContain("1234567890abcdefghijklmnop");

    // 2. offsetBytes + maxBytes slicing capped at limitBytes
    const byteRes = executeReadSpillTool(
      { path: spillFile, offsetBytes: 0, maxBytes: 10_000 },
      { spillDir, maxResultKb: 1 },
    );
    expect(byteRes.isError).toBeUndefined();
    expect(
      Buffer.byteLength(byteRes.content[0]!.text, "utf8"),
    ).toBeLessThanOrEqual(1024);

    // 3. RFC 6901 jsonPointer resolution including ~1 and ~0 escaping
    const ptrRes = executeReadSpillTool(
      { path: spillFile, jsonPointer: "/results/0/title" },
      { spillDir },
    );
    expect(ptrRes.isError).toBeUndefined();
    expect(ptrRes.content[0]?.text).toBe("First item 🚀");

    const escapedPtrRes = executeReadSpillTool(
      { path: spillFile, jsonPointer: "/a~1b/c~0d" },
      { spillDir },
    );
    expect(escapedPtrRes.isError).toBeUndefined();
    expect(escapedPtrRes.content[0]?.text).toBe("escaped-pointer-ok");

    // Missing JSON pointer returns isError
    const missingPtr = executeReadSpillTool(
      { path: spillFile, jsonPointer: "/results/999" },
      { spillDir },
    );
    expect(missingPtr.isError).toBe(true);

    // Prototype pollution guard
    const protoPtr = executeReadSpillTool(
      { path: spillFile, jsonPointer: "/__proto__/polluted" },
      { spillDir },
    );
    expect(protoPtr.isError).toBe(true);

    // 4. End-to-end compatibility with guardToolCallResult MCP envelope
    const mdGuarded = await guardToolCallResult(
      {
        content: [
          {
            type: "text",
            text: "# Alpha\nalpha-1\nalpha-2\n## Beta\nbeta-1\nbeta-2\n" + "x".repeat(4000),
          },
        ],
      },
      { maxResultKb: 2, spillDir },
    );
    const envelopeLineSlice = executeReadSpillTool(
      { path: mdGuarded.spilledPath!, startLine: 4, endLine: 6 },
      { spillDir },
    );
    expect(envelopeLineSlice.isError).toBeUndefined();
    expect(envelopeLineSlice.content[0]?.text).toBe("## Beta\nbeta-1\nbeta-2");
  });

  it("enforces strict realpathSync sandbox against traversal, arbitrary paths, invalid filenames, and escaping symlinks", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "mcp-diet-sandbox-"));
    tempDirs.push(baseDir);
    const spillDir = join(baseDir, "spills");
    const outsideDir = join(baseDir, "outside");
    const { mkdir: fsMkdir } = await import("node:fs/promises");
    await fsMkdir(spillDir, { recursive: true });
    await fsMkdir(outsideDir, { recursive: true });

    const outsideFile = join(outsideDir, "mcp-tool-output-123-abcdef012345.json");
    await writeFile(outsideFile, '{"secret":"outside"}', "utf8");

    const badNameInside = join(spillDir, "not-a-spill-file.json");
    await writeFile(badNameInside, '{"secret":"badname"}', "utf8");

    const escapingSymlink = join(
      spillDir,
      "mcp-tool-output-999-abcdef012345.json",
    );
    await symlink(outsideFile, escapingSymlink);

    const badTargetSymlink = join(
      spillDir,
      "mcp-tool-output-888-abcdef012345.json",
    );
    await symlink(badNameInside, badTargetSymlink);

    const traversalPath = join(
      spillDir,
      "..",
      "outside",
      "mcp-tool-output-123-abcdef012345.json",
    );
    const missingFile = join(
      spillDir,
      "mcp-tool-output-777-abcdef012345.json",
    );

    for (const badPath of [
      outsideFile,
      badNameInside,
      escapingSymlink,
      badTargetSymlink,
      traversalPath,
      missingFile,
      spillDir,
      "",
    ]) {
      const res = executeReadSpillTool({ path: badPath }, { spillDir });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/^Access denied:/);
    }
  });

  it("injects mcp_diet_read_spill under --read-only, intercepts tools/call locally without hitting child, and respects --no-spill-reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-diet-proxy-spill-"));
    tempDirs.push(dir);
    const spillDir = join(dir, "spills");
    const childReceivedPath = join(dir, "child-calls.jsonl");
    const fakeServerPath = join(dir, "fake-big-server.mjs");

    await writeFile(
      fakeServerPath,
      [
        'import { appendFileSync } from "node:fs";',
        'import { createInterface } from "node:readline";',
        `const logPath = ${JSON.stringify(childReceivedPath)};`,
        "const rl = createInterface({ input: process.stdin });",
        'rl.on("line", (line) => {',
        "  appendFileSync(logPath, line + '\\n', 'utf8');",
        "  const msg = JSON.parse(line);",
        '  if (msg.method === "tools/list") {',
        "    process.stdout.write(JSON.stringify({",
        '      jsonrpc: "2.0",',
        "      id: msg.id,",
        "      result: {",
        "        tools: [",
        '          { name: "get_logs", description: "Fetch build logs", annotations: { readOnlyHint: true } },',
        '          { name: "drop_db", description: "Drop database", annotations: { destructiveHint: true } }',
        "        ]",
        "      }",
        '    }) + "\\n");',
        "  }",
        '  if (msg.method === "tools/call") {',
        '    const bigText = "# Build Start\\nline-1\\n## Errors\\nERROR timeout on db\\n" + "z".repeat(6000);',
        "    process.stdout.write(JSON.stringify({",
        '      jsonrpc: "2.0",',
        "      id: msg.id,",
        '      result: { content: [{ type: "text", text: bigText }] }',
        '    }) + "\\n");',
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const proxy = startStdioMcpProxy({
      command: process.execPath,
      args: [fakeServerPath],
      options: { readOnly: true, maxResultKb: 2, spillDir },
      clientIn,
      clientOut,
    });

    const lines: string[] = [];
    const pendingWaiters: Array<{ count: number; resolve: () => void }> = [];
    clientOut.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString().split(/\r?\n/)) {
        if (l.trim()) lines.push(l.trim());
      }
      for (let i = pendingWaiters.length - 1; i >= 0; i--) {
        if (lines.length >= pendingWaiters[i]!.count) {
          pendingWaiters[i]!.resolve();
          pendingWaiters.splice(i, 1);
        }
      }
    });
    const waitForLines = (count: number) =>
      new Promise<void>((resolve) => {
        if (lines.length >= count) {
          resolve();
          return;
        }
        pendingWaiters.push({ count, resolve });
      });

    clientIn.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
    );
    await waitForLines(1);

    const listResp = JSON.parse(lines[0]!) as {
      result: { tools: McpToolDefinition[] };
    };
    expect(listResp.result.tools.map((t) => t.name)).toEqual([
      "get_logs",
      "mcp_diet_read_spill",
    ]);
    const spillTool = listResp.result.tools.find(
      (t) => t.name === "mcp_diet_read_spill",
    );
    expect(spillTool?.annotations?.readOnlyHint).toBe(true);

    // Call get_logs -> triggers spill with offset map
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_logs", arguments: {} },
      })}\n`,
    );
    await waitForLines(2);

    const callResp = JSON.parse(lines[1]!) as {
      result: {
        _mcpDietSpilled: { path: string };
        content: Array<{ text: string }>;
      };
    };
    const spilledPath = callResp.result._mcpDietSpilled.path;
    expect(callResp.result.content[0]?.text).toContain("## Errors");

    // Now invoke mcp_diet_read_spill locally through the proxy
    clientIn.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "mcp_diet_read_spill",
          arguments: { path: spilledPath, startLine: 3, endLine: 4 },
        },
      })}\n`,
    );
    await waitForLines(3);
    proxy.close();

    const readResp = JSON.parse(lines[2]!) as {
      id: number;
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(readResp.id).toBe(3);
    expect(readResp.result.isError).toBeUndefined();
    expect(readResp.result.content[0]?.text).toBe(
      "## Errors\nERROR timeout on db",
    );

    // Verify child stdin NEVER received mcp_diet_read_spill
    const childLog = await readFile(childReceivedPath, "utf8");
    expect(childLog).toContain("get_logs");
    expect(childLog).not.toContain("mcp_diet_read_spill");

    // Verify --no-spill-reader CLI parsing and proxy opt-out
    const noReaderParsed = parseCliArgs([
      "--no-spill-reader",
      "--",
      "node",
      "server.js",
    ]);
    expect(noReaderParsed.options.disableSpillReader).toBe(true);

    const noReaderIn = new PassThrough();
    const noReaderOut = new PassThrough();
    const noReaderProxy = startStdioMcpProxy({
      command: process.execPath,
      args: [fakeServerPath],
      options: { readOnly: true, disableSpillReader: true },
      clientIn: noReaderIn,
      clientOut: noReaderOut,
    });
    const noReaderPromise = new Promise<string>((resolve) => {
      let buf = "";
      noReaderOut.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes("\n")) resolve(buf.trim());
      });
    });
    noReaderIn.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} })}\n`,
    );
    const noReaderLine = await noReaderPromise;
    noReaderProxy.close();
    const noReaderList = JSON.parse(noReaderLine) as {
      result: { tools: McpToolDefinition[] };
    };
    expect(noReaderList.result.tools.map((t) => t.name)).toEqual(["get_logs"]);

    // Verify standalone server honors disableSpillReader and executes mcp_diet_read_spill when enabled
    const standaloneIn = new PassThrough();
    const standaloneOut = new PassThrough();
    const standaloneDisabled = startStandaloneMcpServer({
      options: { disableSpillReader: true },
      clientIn: standaloneIn,
      clientOut: standaloneOut,
    });
    const standaloneLines: string[] = [];
    standaloneOut.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString().split(/\r?\n/)) {
        if (l.trim()) standaloneLines.push(l.trim());
      }
    });
    standaloneIn.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
    );
    await new Promise((r) => setTimeout(r, 30));
    standaloneDisabled.close();
    const standaloneParsed = JSON.parse(standaloneLines[0]!) as {
      result: { tools: McpToolDefinition[] };
    };
    expect(standaloneParsed.result.tools.map((t) => t.name)).toEqual([
      "mcp_diet_analyze_tools",
      "mcp_diet_redact_text",
      "mcp_diet_status",
    ]);
  });
});
