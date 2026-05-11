# Session and State Strategy

This document outlines how `solist` manages orchestration state, mode configuration, role bindings, and conversation history.

## Durable Planning State

All durable orchestration state is stored in **Solo**. `solist` does not maintain its own database or project-local state files (with the exception of transient runtime configuration).

### Solo Scratchpads

The primary source of truth for planning is a Solo scratchpad. `solist` uses HTML comments to embed machine-readable state within the scratchpad content.

- **Plan Metadata**: Includes plan ID, title, and schema version.
- **Todo Associations**: Maps internal planning keys to durable Solo todo URIs.
- **Decisions**: A list of key architectural or process decisions made during orchestration.

By storing this in a scratchpad, the plan remains human-readable and inspectable within the Solo UI while being recoverable by `solist`.

### Solo Todos and Comments

- **Tasks**: Every unit of work is mapped to a Solo todo.
- **Worker Handoffs**: Detailed worker instructions and handoff evidence are stored as comments on the respective todos.
- **Blockers**: Dependencies and blockers are modeled using Solo's native todo blocker support.

## Conversation History

### In-Memory History (Current)

The `SolistHarness` maintains conversation history in memory. 

- **Pros**: Simple, no local file management, avoids leaking conversation details into the repository.
- **Cons**: History is lost if the `solist` process restarts.

The harness supports manual message injection, allowing a caller to resume a conversation if it manages the transient history itself, but `solist` does not currently persist this history to disk.

### Recovery Strategy

`solist` is designed to be "stateless" across restarts by relying on Solo:

1. On startup, the orchestrator can be instructed to inspect the current project state.
2. By listing scratchpads and todos, it can identify active plans and their current status.
3. Key decisions and the "intent" of the plan are preserved in the scratchpad, allowing a new session to pick up where the previous one left off.

## Session Store (Future/Deferred)

A lightweight, local session store may be added in a future work package only if interactive usability (e.g., a persistent TUI) requires it. Currently, it is NOT implemented. If implemented in the future, it will follow these rules:

- **Opt-in**: Persistent history must be explicitly enabled or associated with a session ID.
- **Storage**: Sessions will be stored in a `.solist/sessions/` directory (git-ignored).
- **Format**: Simple JSON lines or similar lightweight format.
- **No Shared State**: Sessions are independent of the durable Solo orchestration state.

## Summary of State Ownership

| State Type | Primary Owner | Storage Format |
|------------|---------------|----------------|
| Plan Structure | Solo | Scratchpad (HTML comments) |
| Task Status | Solo | Todo (Status/Completion) |
| Worker Evidence | Solo | Todo Comments |
| Blockers/Deps | Solo | Todo Blockers |
| Active Mode | Solist | `~/.solist/config.json` or `SOLIST_CONFIG_PATH` |
| Role Bindings | Solist | `~/.solist/config.json` or `SOLIST_CONFIG_PATH` |
| Conversation History | Solist | In-Memory (Transient) |
| Active Processes | Solo | Solo Processes |

## Local Solist Configuration

Mode selection and role-to-Solo-agent bindings are Solist runtime configuration, not durable orchestration state. They live in `~/.solist/config.json` by default, or in `SOLIST_CONFIG_PATH` when that environment variable is set.

Both active mode and role bindings can be global or project-scoped. Use `--project current`, `--project <id>`, `/mode ... --project`, or `/role set ... --project` when a mapping should apply only to one Solo project.

### Active Mode

The active mode controls the main Solist harness profile:

- `orchestration`: `openai-codex/gpt-5.5`, `off` reasoning, full Solo orchestration tools, role spawning enabled.
- `analysis`: `openai-codex/gpt-5.5`, `high` reasoning, full Solo MCP tool surface, role spawning disabled by mode policy.
- `deep-analysis`: `openai-codex/gpt-5.5`, `xhigh` reasoning, full Solo MCP tool surface, role spawning disabled by mode policy.

Changing the persisted mode in the default interactive Solist path also rebuilds the running harness immediately with the selected model, reasoning level, prompt, and role-dispatch surface. Durable plan state remains in Solo regardless of mode.

### Role Bindings

Role bindings map orchestration roles such as `patch-worker`, `feature-worker`, `refactor-worker`, `reviewer`, and `verifier` to Solo agent tools returned by `list_agent_tools`.

Resolution order during orchestration is:

1. Session override.
2. Project override.
3. Global default binding.

The role vocabulary and binding configuration are local Solist state. Worker assignments, handoffs, blocker updates, and verification evidence still belong in Solo todos and scratchpads.

Interactive `/role-switch` and `/role override` commands create session-only role bindings. They affect later prompts in the same running Solist process, but they are not written to the config file unless the user uses `/role set` or the headless `solist roles set` command.

In orchestration mode, `solist_dispatch_role` is the preferred worker handoff path. It resolves the role binding, spawns the configured Solo agent, sends the role-framed assignment, and records the assignment comment on the Solo todo. Verification dispatch uses the same role-binding resolution path for the `verifier` role.
