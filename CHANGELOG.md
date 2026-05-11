# Changelog

## 0.0.0 (Unreleased)

### Solist Rewrite Wave (WP1-WP4)
- **Harness Spike**: Introduced the `SolistHarness` as a lightweight alternative to the legacy Pi wrapper.
- **Interactive Chat**: Added a persistent terminal chat for the default harness path so Solo can keep the orchestrator process alive and send follow-up commands to the same agent context.
- **TUI Chat Source Path**: Moved the interactive chat implementation into source, backed by `@earendil-works/pi-tui`, with visible assistant streaming, tool-call lifecycle rendering, interrupts, and a small Solist-owned command router.
- **Interactive TUI Controls**: Added Pi-style `/` command overview autocomplete, deterministic `/exit` / `/quit` shutdown, and a status line with model, reasoning, message/tool counts, Solo MCP availability, cwd, and active state.
- **Codex Auth Resolution**: The harness now resolves stored Solist Codex credentials from `~/.solist/auth.json` through Pi's auth storage primitives, including OAuth refresh, instead of relying on environment-variable lookup only.
- **Solist Auth Commands**: Added Solist-owned `/login` and `/logout` commands for the pinned `openai-codex` provider.
- **Read-Only Tools**: Implemented native read-only filesystem tools (`read`, `ls`, `find`, `grep`) within the harness to eliminate full SDK dependencies and enforce strict access boundaries.
- **Direct Solo MCP Integration**: Added `SoloMcpDirect` for low-level, high-performance communication with Solo MCP, bypassing the generic MCP proxy for core operations.
- **Modes and Role Bindings**: Added persisted Solist mode configuration, high-reasoning analysis modes, orchestration role registry, implementation complexity roles, role-to-Solo-agent binding commands, and conversation-scoped role switching.
- **Hardening Stopgap**: Implemented orchestrator policy enforcement, including blocked runtime flags and Solo-only MCP allowlisting, to ensure session integrity during the transition.
- **Review Follow-ups**: Hardened tool resolution, improved feasibility diagnostics, and synchronized internal reasoning-level settings.

### Initial Scaffold
- Established `solist` npm/TypeScript CLI package.
- Integrated Pi SDK for constrained interactive orchestration sessions.
- Added `solist` bin entry for global or local execution.

### Features
- Implemented `--check` flag for non-interactive environment and model feasibility validation.
- Defined orchestrator policy: `openai-codex/gpt-5.5` using provider `openai-codex`, model `gpt-5.5`, and default orchestration `off` reasoning.
- Restricted orchestrator startup to read-only local filesystem tools plus the Solo MCP proxy.
- Added Solo-only MCP enforcement, including default `solo` allowlist, non-Solo rejection, and runtime override blocking.
- Added eager Solo MCP boot wiring by generating a temporary solo-only Pi MCP config and passing it via `--mcp-config`.
- Extended `--check` diagnostics to report Pi auth/model status, MCP config sources, configured servers, and MCP proxy availability.
- Added global install support for `pnpm add -g .`, including package build preparation and symlink-safe CLI entrypoint detection.
- Added the phase-1 `--harness` / `SOLIST_HARNESS=1` path for the Solist harness runtime, including `--harness --check` boundary validation.
- Made the Solist harness the default CLI runtime, moved the Pi wrapper behind explicit `--legacy-wrapper` / `SOLIST_LEGACY_WRAPPER=1`, and made default `--check` validate harness auth, Solo MCP reachability, and tool boundaries.

### Fixes
- Fixed globally installed `solist` binaries importing and exiting without starting the CLI.
- Fixed Solist recognizing Solo MCP configuration without exposing the Pi `mcp` proxy tool or attempting an eager Solo connection.
- Fixed default MCP allowlist handling so `SOLIST_MCP_ALLOWLIST=solo` is no longer required for the normal Solo-only path.

### Documentation
- Added comprehensive README with purpose, installation, and v1 target boundaries.
- Linked Solo scratchpad `solo://proj/11/scratchpad/solo-orchestration-a--50` for living design specs.
- Documented global installation, Solist auth requirements, Pi MCP adapter setup, and Solo MCP startup behavior.
