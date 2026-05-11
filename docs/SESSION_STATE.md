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

### Local Session Snapshots

The `SolistHarness` maintains conversation history in memory while a chat is running. Interactive `solist` sessions are also snapshotted to local JSON files so they can be resumed later.

- **Storage**: `~/.solist/sessions/*.json`, or the equivalent directory under `SOLIST_HOME`.
- **Schema**: `solist.session.v1`.
- **Contents**: session id, title, cwd, Solo project id when known, mode id, timestamps, and `AgentMessage[]`.
- **Privacy**: session files contain prompts, responses, and tool context. They are local Solist state and should be treated as private.

The harness supports manual message injection, and `/resume` uses that path to rebuild the active harness from a stored transcript without rerunning old prompts.

### Recovery Strategy

`solist` is designed to be "stateless" across restarts by relying on Solo:

1. On startup, the orchestrator can be instructed to inspect the current project state.
2. By listing scratchpads and todos, it can identify active plans and their current status.
3. Key decisions and the "intent" of the plan are preserved in the scratchpad, allowing a new session to pick up where the previous one left off.

## Session Store

The local session store is intentionally separate from durable Solo orchestration state:

- `/resume` opens a TUI picker for recent sessions.
- `/resume latest` resumes the most recently updated local session.
- `solist sessions list` prints stored session ids.
- `solist resume latest` or `solist resume <session-id>` starts directly from a stored session.
- Sessions are independent of Solo scratchpads/todos; restarting from a session restores conversation context, not worker process lifecycle state.

## Summary of State Ownership

| State Type | Primary Owner | Storage Format |
|------------|---------------|----------------|
| Plan Structure | Solo | Scratchpad (HTML comments) |
| Task Status | Solo | Todo (Status/Completion) |
| Worker Evidence | Solo | Todo Comments |
| Blockers/Deps | Solo | Todo Blockers |
| Active Mode | Solist | `~/.solist/config.json` or `SOLIST_CONFIG_PATH` |
| Role Bindings | Solist | `~/.solist/config.json` or `SOLIST_CONFIG_PATH` |
| Conversation History | Solist | `~/.solist/sessions/*.json` plus in-memory active harness state |
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

Role bindings map orchestration roles such as `patch-worker`, `feature-worker`, `refactor-worker`, `reviewer`, and `verifier` to one or more Solo agent tools returned by `list_agent_tools`.

Resolution order during orchestration is:

1. Session override.
2. Project override.
3. Global default binding.

The role vocabulary and binding configuration are local Solist state. Worker assignments, handoffs, blocker updates, and verification evidence still belong in Solo todos and scratchpads.

Interactive `/role-switch` and `/role override` commands create session-only role bindings. They affect later prompts in the same running Solist process, but they are not written to the config file unless the user uses `/role set` or the headless `solist roles set` command. `/role` and `/roles` open TUI selectors for choosing roles and one or more Solo agents.

In orchestration mode, `solist_dispatch_role` is the preferred worker handoff path. It resolves the role binding, spawns every configured Solo agent for the role unless an explicit single `agent_tool` override is supplied, sends the role-framed assignment, and records the assignment comment on the Solo todo. Verification dispatch uses the same role-binding resolution path for the `verifier` role.
