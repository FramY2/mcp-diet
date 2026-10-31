import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { parseCliArgs } from "../src/cli.js";
import {
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
    expect(parsedList.result.tools).toHaveLength(2);

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
    expect(parsed.result.tools.map((t) => t.name)).toEqual(["read_file"]);
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
    const waitForLines = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (lines.length >= count) resolve();
        };
        check();
        clientOut.on("data", (chunk: Buffer) => {
          for (const l of chunk.toString().split(/\r?\n/)) {
            if (l.trim()) lines.push(l.trim());
          }
          check();
        });
      });

    clientIn.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
    );
    await waitForLines(2);

    expect(lines[0]).toBe("MCP server diagnostic startup banner");
    const listResp = JSON.parse(lines[1]!) as {
      result: { tools: McpToolDefinition[] };
    };
    expect(listResp.result.tools.map((t) => t.name)).toEqual(["read_file"]);

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
      version: "0.1.1",
      clientIn,
      clientOut,
    });

    const lines: string[] = [];
    const waitForLines = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (lines.length >= count) resolve();
        };
        check();
        clientOut.on("data", (chunk: Buffer) => {
          for (const l of chunk.toString().split(/\r?\n/)) {
            if (l.trim()) lines.push(l.trim());
          }
          check();
        });
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
    expect(initResp.result.serverInfo.version).toBe("0.1.1");

    const toolsResp = JSON.parse(lines[1]!) as {
      id: number;
      result: { tools: McpToolDefinition[] };
    };
    expect(toolsResp.id).toBe(2);
    expect(toolsResp.result.tools.map((t) => t.name)).toEqual([
      "mcp_diet_analyze_tools",
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
    expect(tools.result.tools.length).toBe(3);
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

    expect(out).toBe("0.1.1");
  });
});
