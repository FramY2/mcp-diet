# mcp-diet (`@framy2/mcp-diet`)

<p align="center">
  <a href="https://www.npmjs.com/package/@framy2/mcp-diet"><img alt="npm version" src="https://img.shields.io/npm/v/@framy2/mcp-diet?style=flat&logo=npm&color=CB3837" /></a>
  <a href="https://glama.ai/mcp/servers/FramY2/mcp-diet"><img alt="Glama MCP Score" src="https://glama.ai/mcp/servers/FramY2/mcp-diet/badges/score.svg" /></a>
  <a href="https://github.com/FramY2/mcp-diet/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/FramY2/mcp-diet?style=flat&logo=github&color=F59E0B" /></a>
  <a href="https://github.com/FramY2/mcp-diet/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/FramY2/mcp-diet/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Zero Dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2DE2E6" />
</p>

**Zero-dependency stdio MCP proxy & runtime context firewall** for **Claude Code**, **OpenAI Codex CLI**, and **Cursor**.

Wrap any stdio MCP server in `.mcp.json`, `~/.claude.json`, or `.codex/config.toml` to tree-shake bloated `tools/list` schemas, prevent oversized `tools/call` stdio crashes (`anthropics/claude-code#105703`) and `>2000px` many-image session lockups, navigate `>=512 KiB` spilled responses via **Structured Spill Offset Maps** and sandboxed **`mcp_diet_read_spill`** paging, and redact leaked secrets before they enter the model's context window.

Companion runtime proxy to **[`FramY2/ctxwise`](https://github.com/FramY2/ctxwise)** (`@framy2/ctxwise`).

---

## ⚡ Why `mcp-diet`?

1. **Deterministic `tools/list` Tree-Shaking (`--allow`, `--deny`, `--read-only`, `--max-desc`)**:
   - Filters `tools/list` responses before the agent sees them and deterministically sorts tools by name so **prompt prefix caching never invalidates**.
   - `--read-only` keeps only tools with `annotations.readOnlyHint === true` or safe read-only names (`get_*`, `list_*`, `read_*`, `search_*`).
   - `--max-desc <chars>` compacts verbose tool and parameter descriptions without mutating JSON schema types.
2. **Oversized `tools/call` Crash Guard + Structured Spill Offset Maps (`--max-result-kb 512`, `--preview-chars 1200`)**:
   - Prevents Claude Code's `>= 8 MiB` stdio buffer disconnect crash (`anthropics/claude-code#105703`) and 100k-token single-turn blowouts by spilling oversized `tools/call` outputs to a local file.
   - Builds a deterministic **Structural Section & Offset Index** (`buildSpillStructureMap`) with `totalBytes`, `totalLines`, `sha256` digest, `headPreview` (default `1,200` chars, configurable per server wrapper via `--preview-chars <chars>`), `tailPreview` (default `400` chars or ~1/3 of `--preview-chars` when payloads exceed head + tail length), and `[L1-L42 | bytes 0..1820]` byte/line ranges across JSON top-level keys/array chunks, Markdown headings, and log blocks (`ERROR`, `WARN`, `FAIL`, timestamps).
3. **`>2000px` Image Dimension Firewall (`--max-image-dim 2000`)**:
   - Zero-dependency binary header inspection (`PNG`, `JPEG`, `GIF`, `WebP`) catches `image` content blocks exceeding `2000px` on either side **even when the raw file size is well below `--max-result-kb`** — preventing Claude Code's irreversible *"An image in the conversation exceeds the dimension limit for many-image requests (2000px)"* session rejection.
   - **Why `2000px` is the session-safe default**: Anthropic allows up to `8000px` only while a request carries `<=20` images, then rejects anything over `2000px` once image `#21` arrives; because earlier tool outputs remain immutable in `messages[]` (and a single stdio wrapper cannot see user-pasted screenshots or sibling MCP servers), keeping `2000px` prevents delayed turn-21 lockups. Short `<=20`-image sessions can explicitly pass `--max-image-dim 8000` (or `0` to disable).
   - Spills oversized images cleanly to native `.png` / `.jpg` / `.gif` / `.webp` files inside `spillDir`, leaving `<=2000px` images inline.
4. **Sandboxed Spill Paging (`mcp_diet_read_spill`) & Follow-Up Telemetry (`--report-stats`)**:
   - Automatically injected into `tools/list` (with `readOnlyHint: true`, compatible with `--read-only`; opt out with `--no-spill-reader`) and intercepted locally in the proxy without reaching the downstream child process.
   - Supports 1-based line slicing (`startLine`/`endLine`), UTF-8 byte paging (`offsetBytes`/`maxBytes`), and RFC 6901 `jsonPointer` extraction (`/results/0/title`).
   - Hard-sandboxed via `realpathSync` verification (`dirname(realTarget) === realSpillDir` and `^mcp-tool-output-\d+-[a-f0-9]{12}\.json$`), rejecting path traversal, symlinks escaping `spillDir`, or arbitrary filesystem paths, while capping returned bytes and redacting secrets by default.
   - Tracks `upstreamServer` (`{ name, version }` captured from `initialize`), global counters (`byteSpillsTriggered`, `imageDimensionSpillsTriggered`, `uniqueSpillsReadCount`, `previewOnlySpillsCount`, `spillReadFollowUpRate`), and a per-tool `byTool` breakdown via `getTelemetry()`, `mcp_diet_status`, or `--report-stats` on stderr at exit.
5. **Live `tools/call` Secret Redaction (`--redact-secrets`)**:
   - Masks leaked credentials (`sk-ant-*`, `sk-proj-*`, `ghp_*`, `AKIA*`, `://user:pass@`, `AccountKey=...`, `Bearer ...`, private keys) in tool call responses before they enter your LLM transcript.

---

## 🚀 Quickstart (Drop-In `.mcp.json` Wrapper)

Replace your MCP server command in `.mcp.json` or `~/.claude.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "@framy2/mcp-diet@0.3.1",
        "--read-only",
        "--max-desc",
        "160",
        "--max-result-kb",
        "512",
        "--redact-secrets",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-github"
      ]
    }
  }
}
```

### Paging Oversized Spills with `mcp_diet_read_spill`

When a tool response exceeds `--max-result-kb`, `mcp-diet` writes the full JSON payload to `spillDir` and returns an offset map plus concrete paging examples:

```text
[mcp-diet] Oversized tool output intercepted (742.4 KiB > 512 KiB limit).
Full output saved to local file: /tmp/mcp-diet-spills/mcp-tool-output-1763114400000-a1b2c3d4e5f6.json
totalBytes=760218 | totalLines=4820 | sha256=a1b2c3d4e5f6
Structural Section & Offset Index:
  [L1-L42 | bytes 0..1820] metadata (object)
  [L43-L4820 | bytes 1821..760218] results (array[420])
```

The agent can then inspect targeted slices without blowing its context budget:

- **By RFC 6901 JSON Pointer**: `mcp_diet_read_spill({ path: "...", jsonPointer: "/results/0" })`
- **By 1-based line range**: `mcp_diet_read_spill({ path: "...", startLine: 43, endLine: 120 })`
- **By UTF-8 byte offset**: `mcp_diet_read_spill({ path: "...", offsetBytes: 1821, maxBytes: 16384 })`

---

## 🛠️ CLI Options

```text
Usage:
  mcp-diet [options] -- <server-command> [server-args...]
  mcp-diet [options] --self-test-server

Options:
  --allow <t1,t2>         Allow only matching tool names or wildcard patterns (e.g. get_*,list_*)
  --deny <t1,t2>          Remove matching tool names or wildcard patterns (e.g. delete_*,drop_*)
  --read-only             Keep only read-only tools (annotations.readOnlyHint or read-only heuristic)
  --max-desc <chars>      Deterministically truncate tool and property descriptions
  --max-result-kb <kb>    Spill oversized tools/call results to a temp file (default: 512)
  --preview-chars <chars> Override spilled head preview length in chars (default: 1200)
  --max-image-dim <px>    Spill PNG/JPEG/GIF/WebP images wider/taller than <px> (default: 2000, 0 disables)
  --redact-secrets        Redact leaked API keys, PATs, and credentials in tools/call output
  --spill-dir <dir>       Custom directory for spilled oversized tool outputs
  --no-spill-reader       Disable the virtual mcp_diet_read_spill tool in tools/list and tools/call
  --report-stats          Emit session spill & follow-up telemetry JSON to stderr on exit
  --self-test-server      Run standalone diagnostic MCP server over stdio (for introspection/Glama)
  -v, --version           Print version
  -h, --help              Print help
```

---

## 📦 Programmatic API

```ts
import {
  buildSpillStructureMap,
  executeReadSpillTool,
  filterToolsList,
  guardToolCallResult,
  inspectImageDimensions,
  redactSecretsInText,
  startStandaloneMcpServer,
  startStdioMcpProxy,
  type ImageDimensions,
  type SpillSectionEntry,
  type SpillStructureMap,
  type SpillTelemetryStats,
  type ToolSpillTelemetryStats,
  type UpstreamServerInfo,
} from "@framy2/mcp-diet";
```

## 🧩 Companion Tools / Ecosystem

- **[`FramY2/ctxwise`](https://github.com/FramY2/ctxwise) (`@framy2/ctxwise`)**: Local-first AI Context Firewall, MCP Schema Tree-Shaker (`mcp-xray`, `mcp-prune`), multi-agent rule sync (`CLAUDE.md` ↔ `AGENTS.md` ↔ Cursor), Codex `32 KiB` doctor, and SARIF 2.1.0 Secret Shield.
- **[`FramY2/agent-wire-tap`](https://github.com/FramY2/agent-wire-tap) (`@framy2/agent-wire-tap`)**: Zero-cost local loopback HTTP interceptor & CI context contract tester for `codex` and `claude` — verifies outbound system prompt markers, tool counts, and byte budgets with **$0.00 API cost**.
- **[Interactive Context & MCP Token Tax Calculator](https://framy2.github.io/ctxwise/)**: 100% client-side web calculator for MCP schema token tax, 50-turn session costs, and secret scanning.

---

## License

MIT © [Christian Frascogna (@FramY2)](https://github.com/FramY2)
