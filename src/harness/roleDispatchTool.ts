import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
	readSolistConfig,
	type SolistConfig,
	type SolistRoleBindings,
} from "../solistConfig.js";
import { type SoloMcpClient, type SoloMcpToolCallResult } from "../soloMcpDirect.js";
import { parseSoloAgentTools, parseSoloToolJson } from "../soloAgentTools.js";
import { resolveSolistRoleId, type SolistRoleId } from "../solistRoles.js";
import type { SoloTodo } from "../soloPlanning.js";
import {
	assignmentCommentForProcesses,
	buildWorkerPrompt,
	selectWorkerRuntimeForDispatch,
	type SoloWorkerProcess,
	type SoloWorkerRuntime,
} from "../soloWorkers.js";

export interface RoleDispatchToolOptions {
	readonly configReader?: () => SolistConfig;
	readonly projectId?: number | string;
	readonly sessionRoleOverrides?: () => SolistRoleBindings;
}

export interface RoleDispatchToolParams {
	readonly role_id: string;
	readonly objective: string;
	readonly scratchpad_uri: string;
	readonly todo_id: number;
	readonly todo_uri?: string;
	readonly todo_title: string;
	readonly todo_body?: string;
	readonly lane?: string;
	readonly ownership_boundaries?: string[];
	readonly what_not_to_change?: string[];
	readonly expected_handoff?: string[];
	readonly worker_name?: string;
	readonly agent_tool?: string;
	readonly project_id?: number | string;
}

export function createSolistRoleDispatchTool(
	client: SoloMcpClient,
	options: RoleDispatchToolOptions = {},
): AgentTool {
	return {
		name: "solist_dispatch_role",
		label: "Solist dispatch role",
		description:
			"Spawn a configured Solo subagent role, send the role-framed assignment, and record the assignment on the Solo todo.",
		parameters: Type.Object({
			role_id: Type.String({ description: "Solist role id, such as code-searcher, patch-worker, feature-worker, test-worker, reviewer, verifier, docs-writer, or refactor-worker." }),
			objective: Type.String({ description: "Concrete outcome the subagent should produce." }),
			scratchpad_uri: Type.String({ description: "Solo scratchpad URI containing the plan or findings context." }),
			todo_id: Type.Number({ description: "Numeric Solo todo id to comment on." }),
			todo_uri: Type.Optional(Type.String({ description: "Solo todo URI. If omitted, Solist derives a display URI from todo_id." })),
			todo_title: Type.String({ description: "Solo todo title." }),
			todo_body: Type.Optional(Type.String({ description: "Relevant Solo todo body or context." })),
			lane: Type.Optional(Type.String({ description: "Workflow lane for this assignment." })),
			ownership_boundaries: Type.Optional(Type.Array(Type.String(), { description: "Files, modules, or responsibility boundaries owned by this subagent." })),
			what_not_to_change: Type.Optional(Type.Array(Type.String(), { description: "Explicit exclusions or nearby work the subagent must leave alone." })),
			expected_handoff: Type.Optional(Type.Array(Type.String(), { description: "Evidence and deliverables expected in the subagent handoff." })),
			worker_name: Type.Optional(Type.String({ description: "Optional Solo process name." })),
			agent_tool: Type.Optional(Type.String({ description: "Optional Solo agent tool id or exact name. Use for conversation-scoped /role-switch overrides." })),
			project_id: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Optional Solo project id override for role binding resolution." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return dispatchRole(client, normalizeParams(params), options);
		},
	};
}

async function dispatchRole(
	client: SoloMcpClient,
	input: RoleDispatchToolParams,
	options: RoleDispatchToolOptions,
): Promise<AgentToolResult<Record<string, unknown>>> {
	const roleId = resolveSolistRoleId(input.role_id);
	if (!roleId) {
		throw new Error(`Unknown Solist role "${input.role_id}".`);
	}

	const runtimes = await listWorkerRuntimes(client);
	const config = options.configReader?.() ?? readSolistConfig();
	const projectId = input.project_id ?? options.projectId;
	const selection = await selectWorkerRuntimeForDispatch({
		async listWorkerRuntimes() {
			return runtimes;
		},
	}, {
		role: roleId,
		roleId,
		runtimeSelection: input.agent_tool,
		config,
		projectId,
		sessionRoleOverrides: options.sessionRoleOverrides?.(),
	});

	if (selection.status === "decision-needed") {
		return text([
			"Solist role dispatch needs a Solo agent selection.",
			`Role: ${roleId}`,
			`Reason: ${selection.reason}`,
			`Available: ${selection.runtimes.map((runtime) => `${runtime.id} (${runtime.name})`).join(", ") || "none"}`,
		].join("\n"), {
			status: "decision-needed",
			roleId,
			reason: selection.reason,
			availableRuntimes: selection.runtimes,
		});
	}

	const todo = normalizeTodo(input, projectId);
	const prompt = buildWorkerPrompt({
		objective: input.objective,
		scratchpadUri: input.scratchpad_uri,
		todo,
		role: roleId,
		roleId,
		lane: input.lane ?? roleId,
		ownershipBoundaries: input.ownership_boundaries ?? [],
		whatNotToChange: input.what_not_to_change ?? [],
		expectedHandoff: input.expected_handoff ?? [],
		runtimeSelection: input.agent_tool,
		workerName: input.worker_name,
		config,
		projectId,
		sessionRoleOverrides: options.sessionRoleOverrides?.(),
	});
	const processes: SoloWorkerProcess[] = [];
	try {
		for (const runtime of selection.selectedRuntimes) {
			processes.push(await spawnRoleProcess(
				client,
				runtime,
				prompt,
				workerNameForRuntime(input.worker_name, runtime, selection.selectedRuntimes.length),
			));
		}
		await client.callTool("todo_comment_create", {
			todo_id: input.todo_id,
			body: assignmentCommentForProcesses(selection.selectedRuntimes, processes, roleId),
			response_mode: "slim",
		});
	} catch (error) {
		await cleanupRoleProcesses(client, processes);
		throw error;
	}

	return text([
		"Solist role dispatch spawned a Solo subagent.",
		`Role: ${roleId}`,
		`Agent tools: ${selection.selectedRuntimes.map((runtime) => `${runtime.id} (${runtime.name})`).join(", ")}`,
		`Processes: ${processes.map((process) => `${process.id} (${process.name})`).join(", ")}`,
		`Todo comment: ${input.todo_id}`,
	].join("\n"), {
		status: "spawned",
		roleId,
		agentTool: selection.runtime,
		agentTools: selection.selectedRuntimes,
		process: processes[0],
		processes,
		todo,
		prompt,
	});
}

async function listWorkerRuntimes(client: SoloMcpClient): Promise<SoloWorkerRuntime[]> {
	const result = await client.callTool("list_agent_tools", {});
	return parseSoloAgentTools(result).map((tool) => ({
		id: String(tool.id),
		name: tool.name,
		description: tool.enabled === false ? "disabled" : undefined,
	}));
}

async function spawnRoleProcess(
	client: SoloMcpClient,
	runtime: SoloWorkerRuntime,
	prompt: string,
	name?: string,
): Promise<SoloWorkerProcess> {
	const agentToolId = Number(runtime.id);
	if (!Number.isInteger(agentToolId)) {
		throw new Error(`Solo agent tool id must be numeric, got "${runtime.id}".`);
	}
	const spawnResult = parseSoloProcess(await client.callTool("spawn_process", {
		kind: "agent",
		agent_tool_id: agentToolId,
		include_agent_instructions: false,
		...(name ? { name } : {}),
	}));
	try {
		await client.callTool("send_input", {
			process_id: spawnResult.processId,
			input: prompt,
		});
	} catch (error) {
		await cleanupRoleProcesses(client, [{ id: String(spawnResult.processId), name: spawnResult.name }]);
		throw error;
	}
	return {
		id: String(spawnResult.processId),
		name: spawnResult.name,
	};
}

async function cleanupRoleProcesses(
	client: SoloMcpClient,
	processes: readonly SoloWorkerProcess[],
): Promise<void> {
	await Promise.allSettled(processes.map((process) => client.callTool("close_process", {
		process_id: Number(process.id),
	})));
}

function parseSoloProcess(result: SoloMcpToolCallResult): { processId: number; name: string } {
	const parsed = parseSoloToolJson(result);
	if (!isRecord(parsed)) {
		throw new Error("Solo spawn_process returned an invalid response.");
	}
	const processId = Number(parsed.process_id ?? parsed.id);
	if (!Number.isInteger(processId)) {
		throw new Error("Solo spawn_process response did not include a process_id.");
	}
	return {
		processId,
		name: typeof parsed.name === "string" && parsed.name.trim()
			? parsed.name
			: String(processId),
	};
}

function workerNameForRuntime(
	baseName: string | undefined,
	runtime: SoloWorkerRuntime,
	count: number,
): string | undefined {
	if (count <= 1) {
		return baseName;
	}
	const suffix = runtime.id.replace(/[^a-zA-Z0-9_-]+/g, "-");
	return `${baseName ?? "role-worker"}-${suffix}`;
}

function normalizeParams(value: unknown): RoleDispatchToolParams {
	if (!isRecord(value)) {
		throw new Error("solist_dispatch_role expects an object.");
	}
	const roleId = requiredString(value, "role_id");
	const objective = requiredString(value, "objective");
	const scratchpadUri = requiredString(value, "scratchpad_uri");
	const todoId = Number(value.todo_id);
	if (!Number.isInteger(todoId) || todoId <= 0) {
		throw new Error("todo_id must be a positive integer.");
	}
	return {
		role_id: roleId,
		objective,
		scratchpad_uri: scratchpadUri,
		todo_id: todoId,
		todo_uri: optionalString(value.todo_uri),
		todo_title: requiredString(value, "todo_title"),
		todo_body: optionalString(value.todo_body),
		lane: optionalString(value.lane),
		ownership_boundaries: optionalStringArray(value.ownership_boundaries),
		what_not_to_change: optionalStringArray(value.what_not_to_change),
		expected_handoff: optionalStringArray(value.expected_handoff),
		worker_name: optionalString(value.worker_name),
		agent_tool: optionalString(value.agent_tool),
		project_id: optionalProjectId(value.project_id),
	};
}

function normalizeTodo(input: RoleDispatchToolParams, projectId?: number | string): SoloTodo {
	return {
		uri: input.todo_uri ?? `solo://todo/${input.todo_id}`,
		projectId: typeof projectId === "number" ? projectId : 0,
		title: input.todo_title,
		...(input.todo_body ? { body: input.todo_body } : {}),
		tags: [],
		comments: [],
		blockedBy: [],
	};
}

function requiredString(value: Record<string, unknown>, key: string): string {
	const text = optionalString(value[key]);
	if (!text) {
		throw new Error(`${key} is required.`);
	}
	return text;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.flatMap((item) =>
		typeof item === "string" && item.trim() ? [item.trim()] : []
	);
}

function optionalProjectId(value: unknown): number | string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		return Number.isInteger(numeric) && numeric > 0 ? numeric : value.trim();
	}
	return undefined;
}

function text(output: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: output }],
		details,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
