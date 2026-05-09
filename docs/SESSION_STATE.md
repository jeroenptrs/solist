# Session and State Strategy

This document outlines how `solist` manages orchestration state and conversation history.

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
| Conversation History | Solist | In-Memory (Transient) |
| Active Processes | Solo | Solo Processes |
