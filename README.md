# solist

`solist` is an orchestration CLI designed to manage software engineering tasks by coordinating multiple specialized agents through [Solo](https://soloterm.com). Powered by the [Pi SDK](https://pi.dev), it acts as a lead orchestrator that plans, delegates, and monitors progress without directly modifying your codebase.

## Purpose

The primary goal of `solist` is to provide a safe and efficient way to leverage AI agents for large-scale codebase modifications. By separating the **Orchestrator** (which handles high-level planning and Solo management) from **Workers** (which execute specific implementation tasks), `solist` ensures that all changes are tracked, verified, and constrained within defined boundaries.

## Prerequisites

- **Node.js**: Version 22 or newer.
- **Solo**: A running instance of Solo with the Solo MCP server enabled.
- **Pi MCP Adapter**: `npm:pi-mcp-adapter` must be installed and enabled in Pi so the `mcp` tool is available.
- **Pi/Codex/OpenAI Credentials**: Discoverable by Pi, normally through `~/.pi/agent/auth.json` (after `pi /login`) or through provider environment variables supported by Pi.
- **Model Access**: Access to `openai-codex/gpt-5.5` with `off` reasoning is required.

## Installation

```bash
# Clone the repository and enter the directory
cd solist

# Install dependencies
npm install

# Build the project
npm run build
```

To install the CLI from this checkout and run it as `solist`:

```bash
npm install -g .
solist --help
```

## Usage

Start the interactive orchestrator session using the local build:

```bash
npm run solist
```

### Safety Check

Verify your environment and SDK feasibility without launching the full TUI:

```bash
npm run solist -- --check
```

## Configuration

### MCP Allowlist

`solist` defaults to allowing only the `solo` MCP server. This ensures the orchestrator operates within the intended safety boundaries. The `SOLIST_MCP_ALLOWLIST` environment variable can be used as an override or validation guard if needed:

```bash
# Optional override (defaults to "solo" if unset)
SOLIST_MCP_ALLOWLIST=solo npm run solist
```

At launch, `solist` validates the merged Pi MCP config, rejects any non-`solo` server, writes a temporary solo-only `--mcp-config`, disables direct tools, and forces `solo` to `lifecycle: "eager"` so Pi attempts the Solo MCP connection during startup instead of waiting for a first tool call.

If `solist --check` reports that the MCP adapter tool is missing, install or re-enable it in Pi:

```bash
pi install npm:pi-mcp-adapter
```

## V1 Boundaries & Constraints

`solist` v1 is focused on establishing the core orchestration loop. It operates within the following boundaries:

- **Interactive-Only**: V1 is designed for interactive sessions. It does not support headless or non-interactive automation.
- **Solo-Centric**: All durable state—plans, todos, blockers, and worker handoffs—lives exclusively in Solo. `solist` does not maintain its own database.
- **Fixed Model**: The orchestrator is locked to `openai-codex/gpt-5.5` with `low` reasoning.
- **Read-Only Target**: The orchestrator session is restricted to read-only local file inspection plus the Solo MCP proxy.
- **Solo-Only MCP Target**: The orchestrator validates Pi MCP config at startup and refuses to run if any non-`solo` server would be exposed.

## Safety Model

`solist` employs a multi-layered safety model:

1. **Role Separation**: The orchestrator plans; workers execute. This prevents "context drift" where a single agent tries to do too much.
2. **Tool Guardrails**: The orchestrator is provided with a restricted toolset (read-only filesystem tools and the Solo MCP proxy only). Startup rejects runtime flags that would override tool policy, extension loading, or MCP config.
3. **Implicit Verification**: Workers are expected to verify their own work, and the orchestrator is designed to delegate a separate "reviewer" worker before marking a task as complete.
4. **Durable Handoffs**: All agent interactions are recorded in Solo, providing a complete audit trail of decisions and changes.

## Living Design & Specs

For detailed architecture, implementation plans, and ongoing design discussions, refer to the Solo scratchpads:
- **Design Interview**: `solo://proj/11/scratchpad/solo-orchestration-a--50`

---
*Note: This project is currently in early development. See [CHANGELOG.md](./CHANGELOG.md) for recent updates.*
