# solist

`solist` is an orchestration CLI designed to manage software engineering tasks by coordinating multiple specialized agents through [Solo](https://soloterm.com). It acts as a lead orchestrator that plans, delegates, and monitors progress without directly modifying your codebase.

## Purpose

The primary goal of `solist` is to provide a safe and efficient way to leverage AI agents for large-scale codebase modifications. By separating the **Orchestrator** (which handles high-level planning and Solo management) from **Workers** (which execute specific implementation tasks), `solist` ensures that all changes are tracked, verified, and constrained within defined boundaries.

## Prerequisites

- **Node.js**: Version 22 or newer.
- **Solo**: A running instance of Solo with the Solo MCP server enabled.
- **Solo MCP configuration**: a configured `solo` MCP server, preferably in `~/.solist/mcp.json`. The stripped Solist harness connects to Solo MCP directly; the legacy wrapper path still validates a Solo-only Pi MCP config.
- **Codex credentials**: `openai-codex` credentials in Solist's auth store, normally `~/.solist/auth.json` after running `/login` inside Solist.
- **Model Access**: Access to `openai-codex/gpt-5.5` is required. Orchestration uses `off` reasoning; analysis modes use `high` and `xhigh`.

## Installation

```bash
# Clone the repository and enter the directory
cd solist

# Install dependencies
pnpm install

# Build the project
pnpm run build
```

To install the CLI from this checkout and run it as `solist`:

```bash
pnpm add -g .
solist --help
```

## Usage Guide

`solist` defaults to the stripped `SolistHarness`. In a terminal or Solo process, it starts a persistent interactive orchestration chat built on `@earendil-works/pi-tui`: the same harness stays alive across follow-up prompts, preserving in-memory conversation context while durable plans, todos, blockers, and worker handoffs live in Solo.

Start an interactive chat:

```bash
pnpm run solist
```

With a global install:

```bash
solist
```

You can pass an initial prompt as command arguments. Solist sends that first turn, then keeps the chat open for follow-up commands:

```bash
pnpm run solist -- "Inspect todo 207 and propose the next Solo worker handoff"
```

With a global install, the equivalent command is:

```bash
solist "Inspect todo 207 and propose the next Solo worker handoff"
```

Inside the chat, press `/` at the start of the prompt to open the command overview, type `/help` for the Solist command set, use `/login` / `/logout` to manage Solist's Codex credentials, `/mode` to choose the active mode with arrow keys, `/roles` and `/role` to manage role-to-Solo-agent bindings in the TUI, `/resume` to reopen persisted conversations, or `/exit` / `/quit` to stop the process. Assistant responses, tool calls, and tool completion events render in the same chat surface above the editor. While Solist is working, submitted prompts are queued and sent to the same conversation when the active turn finishes. The status line shows the current state, model, reasoning level, message count, tool count, approximate context size, queued input count, Solo MCP availability, and cwd.

You can also provide a prompt on stdin when no prompt arguments are present. Piped stdin is non-interactive, so Solist treats it as a batch prompt and exits after the response:

```bash
printf 'Inspect todo 207 and summarize the current blockers\n' | solist
```

If prompt arguments are provided, they are joined with spaces and used as the initial prompt; stdin is only read when no prompt argument remains after runtime selector flags are removed.

The default harness wires Solist-owned read-only local tools (`read`, `ls`, `find`, `grep`) and explicit Solo MCP wrapper tools named `solo_mcp_<operation>`. It does not call the Pi coding-agent `main()` wrapper.

`--harness` and `SOLIST_HARNESS=1` are accepted as compatibility selectors, but they are no longer required:

```bash
pnpm run solist -- --harness "Inspect todo 207 and propose the next Solo worker handoff"
```

The temporary legacy wrapper fallback remains explicit:

```bash
pnpm run solist -- --legacy-wrapper
```

### Safety Check

Verify the default harness boundary without launching a run:

```bash
pnpm run solist -- --check
```

`solist --check` validates that the active mode's required model is available, provider auth is configured, Solo MCP configuration resolves and is reachable, the local tool set is exactly the read-only inspection tools, and the explicit Solo MCP operation wrappers match the expected allowlist for that mode.

### Codex Authentication

Solist modes currently use the `openai-codex/gpt-5.5` provider/model pair. That provider uses Codex OAuth/subscription auth through Pi's exported auth primitives, not the regular OpenAI API-key provider.

Authenticate once through Solist:

```bash
solist
/login
```

Then verify Solist can see the stored credential:

```bash
pnpm run solist -- --check
```

The stored credential should appear as provider auth for `openai-codex`. The harness resolves keys through Solist's auth store at `~/.solist/auth.json` and uses Pi's auth storage implementation for OAuth refresh and file locking. For this pinned Codex provider, `OPENAI_API_KEY` alone is not a substitute; that belongs to the separate `openai` provider.

Use `/logout` inside Solist to remove the stored Codex credential from `~/.solist/auth.json`.

Validate the legacy wrapper fallback instead:

```bash
pnpm run solist -- --legacy-wrapper --check
```

The legacy check validates the temporary Pi wrapper path, including model availability, provider auth, Solo-only MCP configuration, Pi MCP adapter availability, and wrapper hardening flags.

### Tool and Security Boundary

In the default harness, local workspace access is read-only. The orchestrator can inspect files through `read`, `ls`, `find`, and `grep`, and can operate on Solo through explicit `solo_mcp_<operation>` tools. It does not expose direct file mutation, generic shell execution, or non-Solo MCP servers. Local code changes should be made by delegated worker processes under Solo coordination, not by the orchestrator harness itself.

### State Model

Durable orchestration state belongs in Solo: plans, todos, blockers, worker handoffs, process state, and comments should be recoverable from Solo scratchpads and todos. Conversation history for a `solist` chat is also snapshotted locally under `~/.solist/sessions` so the TUI can resume previous conversations.

## Configuration

### Solist Home

Solist-owned credentials and primary MCP configuration live under `~/.solist` by default. Override with:

```bash
SOLIST_HOME=/path/to/solist-home solist
SOLIST_AUTH_PATH=/path/to/auth.json solist
SOLIST_MCP_CONFIG=/path/to/mcp.json solist
SOLIST_CONFIG_PATH=/path/to/config.json solist
```

### Modes

Solist persists its active mode in `~/.solist/config.json` unless `SOLIST_CONFIG_PATH` is set.

| Mode | Model | Reasoning | Tool profile | Worker roles |
|------|-------|-----------|--------------|--------------|
| `orchestration` | `openai-codex/gpt-5.5` | `off` | Full Solo orchestration wrappers | Enabled |
| `analysis` | `openai-codex/gpt-5.5` | `high` | Full Solo orchestration wrappers | Disabled |
| `deep-analysis` | `openai-codex/gpt-5.5` | `xhigh` | Full Solo orchestration wrappers | Disabled |

Manage modes interactively:

```text
/mode
/mode analysis
/mode deep-analysis --project
```

Calling `/mode` without an argument opens an arrow-key selector that shows the current mode, provider/model, reasoning effort, and role-spawning policy. Each mode uses a distinct TUI accent color; the status line reasoning segment follows the selected mode color.

Or headlessly:

```bash
solist mode get
solist mode set deep-analysis
solist mode get --project current
solist mode set orchestration --project 11
```

Changing mode in a running interactive session persists the setting and switches the active harness immediately when Solist is running in the default interactive path. Use `--project current` or `--project <id>` to store a project override instead of changing the global default.

### Role Bindings

Subagent roles are available only in `orchestration` mode. They are prompt frames for Solo-spawned child agents; the concrete Solo agent tool is configured separately.

Initial orchestration roles:

- `code-searcher`: read-only codebase retrieval and impact mapping.
- `patch-worker`: small localized implementation changes.
- `feature-worker`: coherent multi-file feature slices.
- `refactor-worker`: structural or compatibility-sensitive implementation work.
- `test-worker`: test and reproduction coverage.
- `reviewer`: review-only bug, regression, and missing-test inspection.
- `verifier`: independent validation before completion.
- `docs-writer`: README, changelog, migration notes, and human-facing docs.

Manage role mappings interactively:

```text
/roles
/roles doctor
/roles --project
/role
/role set reviewer Gemini
/role set reviewer "Codex High, Gemini"
/role set patch-worker Codex
/role set feature-worker "Codex High"
/role set refactor-worker "Codex XHigh"
/role set reviewer Gemini --project
/role override verifier "Codex High"
/role switch reviewer Gemini
/role-switch verifier "Codex High"
```

Or headlessly:

```bash
solist roles list
solist roles set reviewer Gemini
solist roles set reviewer "Codex High, Gemini"
solist roles unset reviewer
solist roles doctor
solist roles list --project current
solist roles set verifier "Codex High" --project 11
```

Role bindings are validated against Solo's configured agent tools via `list_agent_tools`. A role can map to one or more Solo agent tools. When a mapped role has multiple agents, singular dispatches use one configured agent by default; all mapped agents are spawned only when the dispatch explicitly asks for multiple agents. `/role-switch` and `/role override` affect prompts submitted later in the same Solist process; persisted bindings live in Solist config.

When roles are enabled, the orchestrator gets a Solist-owned `solist_dispatch_role` tool. It resolves the configured global, project, or session-provided Solo agent choices, spawns the selected Solo agent or agents, sends the role-framed assignment with `send_input`, and records the assignment comment on the Solo todo. The raw `solo_mcp_spawn_process` and `solo_mcp_send_input` tools remain available for handoff shapes that need lower-level control.

### Sessions and Resume

Interactive conversations are saved as JSON snapshots in `~/.solist/sessions`. These files contain conversation text and model/tool context, so treat them as local private data. Use the TUI picker or CLI commands to resume:

```text
/resume
/resume latest
/resume <session-id>
```

```bash
solist sessions list
solist resume latest
solist resume <session-id>
```

### MCP Allowlist

`solist` defaults to allowing only the `solo` MCP server. This ensures the orchestrator operates within the intended safety boundaries. The `SOLIST_MCP_ALLOWLIST` environment variable can be used as an override or validation guard if needed:

```bash
# Optional override (defaults to "solo" if unset)
SOLIST_MCP_ALLOWLIST=solo pnpm run solist
```

At launch, `solist` validates the merged MCP config and rejects any non-`solo` server. The stripped harness looks for MCP config in `~/.solist/mcp.json`, `~/.config/mcp/mcp.json`, project `.mcp.json`, and project `.solist/mcp.json` by default. Set `SOLIST_MCP_CONFIG=/path/to/mcp.json` to override the primary config path. The stripped harness exposes typed tools named `solo_mcp_<operation>` that map directly to Solo MCP operations such as `todo_get`, `scratchpad_read`, `spawn_process`, `send_input`, and timer/process output tools. Broad or destructive Solo MCP operations are not exposed through the orchestrator surface.

The default harness path resolves the Solo-only MCP config and exposes only Solist-owned read-only local tools plus explicit Solo MCP operation wrappers. It does not use a persistent local session store; durable orchestration state belongs in Solo and conversation history remains in memory for the current run.

The temporary legacy wrapper path writes a solo-only `--mcp-config`, disables direct tools, and forces `solo` to `lifecycle: "eager"` so Pi attempts the Solo MCP connection during startup instead of waiting for a first tool call.

If the legacy wrapper `solist --check` reports that the MCP adapter tool is missing, install or re-enable it in Pi:

```bash
pi install npm:pi-mcp-adapter
```

## V1 Boundaries & Constraints

`solist` v1 is focused on establishing the core orchestration loop. It operates within the following boundaries:

- **Human-Initiated Interactive Sessions**: V1 runs as a persistent terminal chat when attached to a TTY, including Solo agent processes. Piped stdin remains a non-interactive batch prompt path. Solist is not a daemon or unattended automation service.
- **Solo-Centric**: All durable state—plans, todos, blockers, and worker handoffs—lives exclusively in Solo. `solist` does not maintain its own database.
- **Mode Profiles**: The default orchestrator mode uses `openai-codex/gpt-5.5` with `off` reasoning. Analysis modes use the same model with `high` or `xhigh` reasoning and the same Solo MCP tool surface, but role-bound worker spawning is disabled by mode policy.
- **Read-Only Target**: The orchestrator session is restricted to read-only local file inspection plus explicit Solo MCP operations.
- **Solo-Only MCP Target**: The orchestrator validates Pi MCP config at startup and refuses to run if any non-`solo` server would be exposed.

## Safety Model

`solist` employs a multi-layered safety model:

1. **Role Separation**: The orchestrator plans; workers execute. This prevents "context drift" where a single agent tries to do too much.
2. **Tool Guardrails**: The orchestrator is provided with a restricted toolset (read-only filesystem tools and explicit Solo MCP operations only). Startup rejects runtime flags that would override tool policy, extension loading, or MCP config.
3. **Implicit Verification**: Workers are expected to verify their own work, and the orchestrator is designed to delegate a separate "reviewer" worker before marking a task as complete.
4. **Durable Handoffs**: All agent interactions are recorded in Solo, providing a complete audit trail of decisions and changes.

### Harness Read-Only Tools

The stripped `SolistHarness` uses Solist-owned read-only local tool implementations in `src/harness/readOnlyTools.ts`.
Pi's `@earendil-works/pi-coding-agent` package exports read-only factories, but importing from its root export also exposes the full coding-agent SDK surface, including session runtime, extension APIs, settings/session managers, TUI components, and write/edit/bash tool factories. To keep the harness boundary narrow, Solist implements only `read`, `ls`, `find`, and `grep` directly against Node filesystem APIs.

These tools do not expose generic shell execution, do not write files, resolve paths through the workspace root with `realpath`, reject symlink traversal outside the workspace, and apply line, byte, and result limits.

## Living Design & Specs

For detailed architecture, implementation plans, and ongoing design discussions, refer to the Solo scratchpads:
- **Design Interview**: `solo://proj/11/scratchpad/solo-orchestration-a--50`

---
*Note: This project is currently in early development. See [CHANGELOG.md](./CHANGELOG.md) for recent updates.*
