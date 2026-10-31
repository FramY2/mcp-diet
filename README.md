# mcp-diet (`@framy2/mcp-diet`)

<p align="center">
  <a href="https://github.com/FramY2/mcp-diet/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/FramY2/mcp-diet?style=flat&logo=github&color=F59E0B" /></a>
  <a href="https://github.com/FramY2/mcp-diet/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/FramY2/mcp-diet/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Zero Dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2DE2E6" />
</p>

**Zero-dependency stdio MCP proxy & runtime context firewall** for **Claude Code**, **OpenAI Codex CLI**, and **Cursor**.

Wrap any stdio MCP server in `.mcp.json`, `~/.claude.json`, or `.codex/config.toml` to tree-shake bloated `tools/list` schemas, prevent oversized `tools/call` stdio crashes (`anthropics/claude-code#105703`), and redact leaked secrets before they enter the model's context window.

Companion runtime proxy to **[`FramY2/ctxwise`](https://github.com/FramY2/ctxwise)** (`@framy2/ctxwise`).

---

## ⚡ Why `mcp-diet`?

1. **Deterministic `tools/list` Tree-Shaking (`--allow`, `--deny`, `--read-only`, `--max-desc`)**:
   - Filters `tools/list` responses before the agent sees them and deterministically sorts tools by name so **prompt prefix caching never invalidates**.
   - `--read-only` keeps only tools with `annotations.readOnlyHint === true` or safe read-only names (`get_*`, `list_*`, `read_*`, `search_*`).
   - `--max-desc <chars>` compacts verbose tool and parameter descriptions without mutating JSON schema types.
2. **Oversized `tools/call` Crash & Context-Blowout Guard (`--max-result-kb 512`)**:
   - Prevents Claude Code's `>= 8 MiB` stdio buffer disconnect crash (`anthropics/claude-code#105703`) and 100k-token single-turn blowouts by spilling oversized `tools/call` outputs to a local file and returning a structured preview + file path.
3. **Live `tools/call` Secret Redaction (`--redact-secrets`)**:
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
        "@framy2/mcp-diet",
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

---

## 🛠️ CLI Options

```text
Usage:
  mcp-diet [options] -- <server-command> [server-args...]

Options:
  --allow <t1,t2>         Allow only matching tool names or wildcard patterns (e.g. get_*,list_*)
  --deny <t1,t2>          Remove matching tool names or wildcard patterns (e.g. delete_*,drop_*)
  --read-only             Keep only read-only tools (annotations.readOnlyHint or read-only heuristic)
  --max-desc <chars>      Deterministically truncate tool and property descriptions
  --max-result-kb <kb>    Spill oversized tools/call results to a temp file (default: 512)
  --redact-secrets        Redact leaked API keys, PATs, and credentials in tools/call output
  --spill-dir <dir>       Custom directory for spilled oversized tool outputs
  -v, --version           Print version
  -h, --help              Print help
```

---

## 📦 Programmatic API

```ts
import {
  filterToolsList,
  guardToolCallResult,
  redactSecretsInText,
  startStdioMcpProxy,
} from "@framy2/mcp-diet";
```

## 🧩 Companion Tools / Ecosystem

- **[`FramY2/ctxwise`](https://github.com/FramY2/ctxwise) (`@framy2/ctxwise`)**: Local-first AI Context Firewall, MCP Schema Tree-Shaker (`mcp-xray`, `mcp-prune`), multi-agent rule sync (`CLAUDE.md` ↔ `AGENTS.md` ↔ Cursor), Codex `32 KiB` doctor, and SARIF 2.1.0 Secret Shield.
- **[`FramY2/agent-wire-tap`](https://github.com/FramY2/agent-wire-tap) (`@framy2/agent-wire-tap`)**: Zero-cost local loopback HTTP interceptor & CI context contract tester for `codex` and `claude` — verifies outbound system prompt markers, tool counts, and byte budgets with **$0.00 API cost**.
- **[Interactive Context & MCP Token Tax Calculator](https://framy2.github.io/ctxwise/)**: 100% client-side web calculator for MCP schema token tax, 50-turn session costs, and secret scanning.

---

## License

MIT © [Christian Frascogna (@FramY2)](https://github.com/FramY2)
