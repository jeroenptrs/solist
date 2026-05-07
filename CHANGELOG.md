# Changelog

## 0.0.0 (Unreleased)

### Initial Scaffold
- Established `solist` npm/TypeScript CLI package.
- Integrated Pi SDK for constrained interactive orchestration sessions.
- Added `solist` bin entry for global or local execution.

### Features
- Implemented `--check` flag for non-interactive environment and model feasibility validation.
- Defined orchestrator policy: `openai-codex/gpt-5.5` using provider `openai-codex`, model `gpt-5.5`, and `off` reasoning.
- Restricted orchestrator startup to read-only local filesystem tools plus the Solo MCP proxy.
- Added Solo-only MCP enforcement, including default `solo` allowlist, non-Solo rejection, and runtime override blocking.
- Added eager Solo MCP boot wiring by generating a temporary solo-only Pi MCP config and passing it via `--mcp-config`.
- Extended `--check` diagnostics to report Pi auth/model status, MCP config sources, configured servers, and MCP proxy availability.
- Added global install support for `npm install -g .`, including package build preparation and symlink-safe CLI entrypoint detection.

### Fixes
- Fixed globally installed `solist` binaries importing and exiting without starting the CLI.
- Fixed Solist recognizing Solo MCP configuration without exposing the Pi `mcp` proxy tool or attempting an eager Solo connection.
- Fixed default MCP allowlist handling so `SOLIST_MCP_ALLOWLIST=solo` is no longer required for the normal Solo-only path.

### Documentation
- Added comprehensive README with purpose, installation, and v1 target boundaries.
- Linked Solo scratchpad `solo://proj/11/scratchpad/solo-orchestration-a--50` for living design specs.
- Documented global installation, Pi auth requirements, Pi MCP adapter setup, and Solo MCP startup behavior.
