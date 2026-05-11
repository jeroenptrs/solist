import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import type { SolistMcpServerConfig, SolistResolvedSoloMcp } from "./soloMcp.js";
import type { SolistToolProfile } from "./solistModes.js";

export interface SoloMcpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface SoloMcpToolCallResult {
  readonly content?: readonly { readonly type: string; readonly text?: string; readonly [key: string]: unknown }[];
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export interface SoloMcpClient {
  listTools(): Promise<readonly SoloMcpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<SoloMcpToolCallResult>;
  close?(): Promise<void>;
}

export type SoloMcpClientFactory = (server: SolistMcpServerConfig) => SoloMcpClient;

export interface SoloMcpToolSet {
  readonly tools: AgentTool[];
  close(): Promise<void>;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly [key: string]: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class StdioSoloMcpClient implements SoloMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private nextId = 1;
  private initialized?: Promise<void>;
  private closing = false;
  private stderr = "";
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  constructor(server: SolistMcpServerConfig) {
    if (typeof server.command !== "string" || server.command.length === 0) {
      throw new Error("Direct Solo MCP stdio client requires the solo server to declare a command.");
    }

    const args = Array.isArray(server.args) ? server.args.map(String) : [];
    const env = isRecord(server.env)
      ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, String(value)]))
      : {};

    this.child = spawn(server.command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.closing) {
        return;
      }
      const stderr = this.stderr.trim();
      const detail = stderr.length > 0 ? ` stderr=${stderr}` : "";
      this.rejectAll(new Error(`Solo MCP process exited before responding: code=${code ?? "null"} signal=${signal ?? "null"}${detail}`));
    });
  }

  async listTools(): Promise<readonly SoloMcpToolDefinition[]> {
    await this.ensureInitialized();
    const result = await this.request("tools/list");
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error("Solo MCP tools/list returned an invalid response.");
    }
    return result.tools.filter(isRecord).map((tool) => ({
      name: String(tool.name),
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<SoloMcpToolCallResult> {
    await this.ensureInitialized();
    const result = await this.request("tools/call", { name, arguments: args });
    if (!isRecord(result)) {
      throw new Error(`Solo MCP tool ${name} returned an invalid response.`);
    }
    return result as SoloMcpToolCallResult;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.lines.close();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize();
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "solist", version: "0.0.0" },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Solo MCP request failed."));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const SOLO_MCP_ORCHESTRATION_OPERATIONS = [
  "bind_session_process",
  "clear_output",
  "close_process",
  "flush_terminal_perf",
  "help",
  "scratchpad_list",
  "scratchpad_read",
  "scratchpad_write",
  "scratchpad_append",
  "scratchpad_archive",
  "scratchpad_clear",
  "scratchpad_add_tags",
  "scratchpad_delete",
  "scratchpad_load_from_file",
  "scratchpad_remove_tags",
  "scratchpad_rename",
  "scratchpad_save_to_file",
  "scratchpad_tags_list",
  "scratchpad_transfer",
  "todo_list",
  "todo_get",
  "todo_create",
  "todo_update",
  "todo_complete",
  "todo_add_tag",
  "todo_remove_tag",
  "todo_delete",
  "todo_set_blockers",
  "todo_add_blocker",
  "todo_remove_blocker",
  "todo_comment_delete",
  "todo_comment_create",
  "todo_comment_list",
  "todo_comment_update",
  "todo_lock",
  "todo_tags_list",
  "todo_transfer",
  "todo_unlock",
  "kv_delete",
  "kv_get",
  "kv_list",
  "kv_set",
  "list_agent_tools",
  "list_projects",
  "spawn_process",
  "submit_solo_feedback",
  "send_input",
  "start_process",
  "stop_process",
  "restart_process",
  "start_all_commands",
  "stop_all_commands",
  "restart_all_commands",
  "list_processes",
  "get_process_status",
  "get_process_output",
  "get_process_raw_output",
  "get_process_ports",
  "get_project_stats",
  "get_project_status",
  "search_output",
  "search_raw_output",
  "select_process",
  "select_project",
  "services_list",
  "setup_agent_integration",
  "wait_for_bound_port",
  "lock_acquire",
  "lock_release",
  "lock_status",
  "register_agent",
  "rename_process",
  "timer_set",
  "timer_cancel",
  "timer_list",
  "timer_pause",
  "timer_resume",
  "timer_fire_when_idle_any",
  "timer_fire_when_idle_all",
  "whoami",
] as const;

export const SOLO_MCP_EXPOSED_OPERATIONS = SOLO_MCP_ORCHESTRATION_OPERATIONS;

export type SoloMcpExposedOperation = typeof SOLO_MCP_ORCHESTRATION_OPERATIONS[number];

export function getSoloMcpOperationsForProfile(
  _profile: SolistToolProfile,
): readonly SoloMcpExposedOperation[] {
  return SOLO_MCP_ORCHESTRATION_OPERATIONS;
}

const OPERATION_DESCRIPTIONS: Partial<Record<SoloMcpExposedOperation, string>> = {
  close_process: "Solo MCP close_process: close a Solo terminal or agent process entry.",
  scratchpad_list: "Solo MCP scratchpad_list: list Solo scratchpads in the selected project.",
  scratchpad_read: "Solo MCP scratchpad_read: read a Solo scratchpad by id.",
  scratchpad_write: "Solo MCP scratchpad_write: create or replace a Solo scratchpad.",
  scratchpad_append: "Solo MCP scratchpad_append: append content to a Solo scratchpad.",
  scratchpad_add_tags: "Solo MCP scratchpad_add_tags: add tags to a Solo scratchpad.",
  scratchpad_remove_tags: "Solo MCP scratchpad_remove_tags: remove tags from a Solo scratchpad.",
  todo_list: "Solo MCP todo_list: list Solo todos.",
  todo_get: "Solo MCP todo_get: read a Solo todo and optionally comments.",
  todo_create: "Solo MCP todo_create: create a Solo todo.",
  todo_update: "Solo MCP todo_update: update selected Solo todo fields.",
  todo_complete: "Solo MCP todo_complete: mark a Solo todo complete or incomplete.",
  todo_add_tag: "Solo MCP todo_add_tag: add one tag to a Solo todo.",
  todo_remove_tag: "Solo MCP todo_remove_tag: remove one tag from a Solo todo.",
  todo_set_blockers: "Solo MCP todo_set_blockers: replace a Solo todo blocker list.",
  todo_add_blocker: "Solo MCP todo_add_blocker: add one blocker to a Solo todo.",
  todo_remove_blocker: "Solo MCP todo_remove_blocker: remove one blocker from a Solo todo.",
  todo_comment_create: "Solo MCP todo_comment_create: add a comment to a Solo todo.",
  todo_comment_list: "Solo MCP todo_comment_list: list comments for a Solo todo.",
  todo_comment_update: "Solo MCP todo_comment_update: update a Solo todo comment.",
  list_agent_tools: "Solo MCP list_agent_tools: list Solo worker agent runtimes.",
  spawn_process: "Solo MCP spawn_process: spawn a Solo terminal or worker agent process.",
  send_input: "Solo MCP send_input: send an assignment or follow-up input to a Solo process.",
  stop_process: "Solo MCP stop_process: gracefully stop one running Solo process.",
  restart_process: "Solo MCP restart_process: restart one Solo process entry.",
  list_processes: "Solo MCP list_processes: list Solo processes.",
  get_process_status: "Solo MCP get_process_status: inspect one Solo process status.",
  get_process_output: "Solo MCP get_process_output: read rendered output for one Solo process.",
  get_process_raw_output: "Solo MCP get_process_raw_output: read raw output for one Solo process.",
  search_output: "Solo MCP search_output: search rendered output for one Solo process.",
  search_raw_output: "Solo MCP search_raw_output: search raw output for one Solo process.",
  timer_set: "Solo MCP timer_set: schedule a Solo timer.",
  timer_cancel: "Solo MCP timer_cancel: cancel a Solo timer.",
  timer_list: "Solo MCP timer_list: list pending Solo timers.",
  timer_fire_when_idle_any: "Solo MCP timer_fire_when_idle_any: fire when any watched Solo process is idle.",
  timer_fire_when_idle_all: "Solo MCP timer_fire_when_idle_all: fire when all watched Solo processes are idle.",
};

export function createDirectSoloMcpClient(server: SolistMcpServerConfig): SoloMcpClient {
  if (typeof server.command === "string" && server.command.length > 0) {
    return new StdioSoloMcpClient(server);
  }
  throw new Error("Direct Solo MCP currently supports configured local stdio command servers only.");
}

export function createSoloMcpTools(
  resolved: SolistResolvedSoloMcp,
  options: { readonly clientFactory?: SoloMcpClientFactory; readonly operations?: readonly SoloMcpExposedOperation[] } = {},
): AgentTool[] {
  return createSoloMcpToolSet(resolved, options).tools;
}

export function createSoloMcpToolSet(
  resolved: SolistResolvedSoloMcp,
  options: { readonly clientFactory?: SoloMcpClientFactory; readonly operations?: readonly SoloMcpExposedOperation[] } = {},
): SoloMcpToolSet {
  const serverNames = Object.keys(resolved.config.mcpServers);
  const nonSoloServers = serverNames.filter((name) => name !== "solo");
  if (nonSoloServers.length > 0) {
    throw new Error(`Solist direct Solo MCP exposes only the solo server. Remove: ${nonSoloServers.join(", ")}`);
  }

  const soloServer = resolved.config.mcpServers.solo;
  if (!soloServer) {
    throw new Error("Solist direct Solo MCP requires a configured solo server.");
  }

  const client = options.clientFactory?.(soloServer) ?? createDirectSoloMcpClient(soloServer);
  return {
    tools: (options.operations ?? SOLO_MCP_EXPOSED_OPERATIONS)
      .map((operation) => createSoloMcpTool(operation, client)),
    async close() {
      await client.close?.();
    },
  };
}

export async function checkSoloMcpReachability(
  resolved: SolistResolvedSoloMcp,
  options: { readonly clientFactory?: SoloMcpClientFactory; readonly operations?: readonly SoloMcpExposedOperation[] } = {},
): Promise<{ readonly ok: boolean; readonly exposedOperations: readonly string[]; readonly serverTools: readonly string[] }> {
  const client = options.clientFactory?.(resolved.config.mcpServers.solo)
    ?? createDirectSoloMcpClient(resolved.config.mcpServers.solo);
  try {
    const tools = await client.listTools();
    const serverTools = tools.map((tool) => tool.name);
    const exposedOperations = (options.operations ?? SOLO_MCP_EXPOSED_OPERATIONS)
      .filter((operation) => serverTools.includes(operation));
    return { ok: true, exposedOperations, serverTools };
  } finally {
    await client.close?.();
  }
}

function createSoloMcpTool(operation: SoloMcpExposedOperation, client: SoloMcpClient): AgentTool<TSchema> {
  const description = OPERATION_DESCRIPTIONS[operation]
    ?? `Solo MCP ${operation}: generic Solo MCP wrapper.`;
  return {
    name: `solo_mcp_${operation}`,
    label: `Solo MCP ${operation}`,
    description: `${description} Maps directly to Solo MCP tool "${operation}".`,
    parameters: Type.Object({
      args: Type.Record(Type.String(), Type.Unknown(), {
        description: `Arguments passed to Solo MCP ${operation}. Use the Solo MCP tool schema for field names.`,
      }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      assertAllowedSoloMcpOperation(operation);
      const result = await client.callTool(operation, normalizeArgs(params));
      const text = renderSoloMcpResult(result);
      return {
        content: [{ type: "text", text }],
        details: { operation, result },
      };
    },
  };
}

function normalizeArgs(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) {
    return {};
  }
  return isRecord(params.args) ? params.args : {};
}

function assertAllowedSoloMcpOperation(operation: string): void {
  if (!SOLO_MCP_EXPOSED_OPERATIONS.includes(operation as SoloMcpExposedOperation)) {
    throw new Error(`Solo MCP operation ${operation} is not exposed by Solist.`);
  }
}

function renderSoloMcpResult(result: SoloMcpToolCallResult): string {
  const text = result.content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (text && text.length > 0) {
    return text;
  }
  return JSON.stringify(result, null, 2);
}
