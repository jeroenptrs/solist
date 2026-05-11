import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SlashCommand } from "@earendil-works/pi-tui";

export const SOLIST_INTERACTIVE_COMMANDS: readonly SlashCommand[] = [
	{
		name: "help",
		description: "Show the supported Solist command set and boundaries",
	},
	{
		name: "exit",
		description: "Stop the interactive Solist process",
	},
	{
		name: "clear",
		description: "Clear visible chat output without clearing conversation context",
	},
	{
		name: "tools",
		description: "List the read-only local tools and explicit Solo MCP tools",
	},
	{
		name: "status",
		description: "Show model, reasoning, cwd, message count, and tool count",
	},
	{
		name: "mode",
		description: "Show or persist the Solist mode",
	},
	{
		name: "roles",
		description: "List orchestration roles and persisted bindings",
	},
	{
		name: "role",
		description: "Set, unset, or override a role-to-Solo-agent binding",
	},
	{
		name: "role-switch",
		description: "Switch a role to a Solo agent for this conversation",
	},
	{
		name: "resume",
		description: "Resume a persisted Solist conversation",
	},
	{
		name: "login",
		description: "Authenticate Solist with the pinned Codex provider",
	},
	{
		name: "logout",
		description: "Remove Solist's stored Codex credentials",
	},
];

const SOLIST_INTERACTIVE_COMMAND_NAMES = new Set(
	SOLIST_INTERACTIVE_COMMANDS.map((command) => command.name),
);

const UNSUPPORTED_PI_COMMANDS = new Set([
	"/model",
	"/settings",
	"/scoped-models",
	"/export",
	"/import",
	"/share",
	"/fork",
	"/clone",
	"/tree",
	"/reload",
	"/compact",
]);

export interface SolistInteractiveStatus {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel | string;
	cwd: string;
	soloMcpAvailable: boolean;
	messageCount: number;
	toolCount: number;
	contextUsage?: SolistContextUsage;
	queuedInputCount?: number;
}

export interface SolistContextUsage {
	used: number;
	limit?: number;
	approximate?: boolean;
}

export interface SolistInteractiveCommandContext {
	status: SolistInteractiveStatus;
	tools: readonly AgentTool[];
}

export type SolistInteractiveRoute =
	| { kind: "empty" }
	| { kind: "exit" }
	| { kind: "clear"; message: string }
	| { kind: "render"; message: string }
	| { kind: "mode"; mode?: string; project?: string }
	| { kind: "roles"; action?: "list" | "doctor"; project?: string }
	| { kind: "role-menu"; project?: string }
	| { kind: "role"; action: "set" | "unset" | "override" | "switch"; role?: string; agent?: string; project?: string }
	| { kind: "resume"; session?: string }
	| { kind: "login"; provider?: string }
	| { kind: "logout"; provider?: string }
	| { kind: "prompt"; prompt: string };

export function routeSolistInteractiveInput(
	input: string,
	context: SolistInteractiveCommandContext,
): SolistInteractiveRoute {
	const trimmed = input.trim();
	if (!trimmed) {
		return { kind: "empty" };
	}

	if (trimmed.startsWith("!")) {
		return {
			kind: "render",
			message:
				"Shell commands are not exposed in Solist interactive mode. Use Solo worker handoffs for implementation work.",
		};
	}

	const normalized = trimmed.toLowerCase();
	if (
		normalized === "exit"
		|| normalized === "quit"
		|| normalized === "/exit"
		|| normalized === "/quit"
	) {
		return { kind: "exit" };
	}

	if (normalized === "/help") {
		return { kind: "render", message: getInteractiveHelpText() };
	}

	if (normalized === "/clear") {
		return {
			kind: "clear",
			message:
				"Cleared visible chat display. Conversation context remains in this process.",
		};
	}

	if (normalized === "/tools") {
		return { kind: "render", message: getToolsText(context.tools) };
	}

	if (normalized === "/status") {
		return { kind: "render", message: getStatusText(context.status) };
	}

	if (normalized === "/mode" || normalized.startsWith("/mode ")) {
		const options = getCommandOptions(trimmed);
		return {
			kind: "mode",
			mode: options.args.join(" ").trim() || undefined,
			project: options.project,
		};
	}

	if (normalized === "/roles" || normalized.startsWith("/roles ")) {
		const options = getCommandOptions(trimmed);
		const [action] = options.args;
		if (!action || action === "list") {
			return { kind: "roles", action: "list", project: options.project };
		}
		if (action === "doctor") {
			return { kind: "roles", action: "doctor", project: options.project };
		}
		return {
			kind: "render",
			message: "Usage: /roles [list|doctor] [--project[=id|current]]",
		};
	}

	if (normalized === "/role" || normalized.startsWith("/role ")) {
		return getRoleRoute(trimmed);
	}

	if (normalized === "/role-switch" || normalized.startsWith("/role-switch ")) {
		return getRoleSwitchRoute(trimmed);
	}

	if (normalized === "/resume" || normalized.startsWith("/resume ")) {
		return { kind: "resume", session: getCommandArgument(trimmed) };
	}

	if (normalized === "/login" || normalized.startsWith("/login ")) {
		return { kind: "login", provider: getCommandArgument(trimmed) };
	}

	if (normalized === "/logout" || normalized.startsWith("/logout ")) {
		return { kind: "logout", provider: getCommandArgument(trimmed) };
	}

	if (trimmed.startsWith("/")) {
		return {
			kind: "render",
			message: getUnsupportedCommandText(normalized),
		};
	}

	return { kind: "prompt", prompt: trimmed };
}

export function isSolistInteractiveExitCommand(input: string): boolean {
	return routeSolistInteractiveInput(input, {
		status: {
			provider: "",
			model: "",
			thinkingLevel: "",
			cwd: "",
			soloMcpAvailable: false,
			messageCount: 0,
			toolCount: 0,
		},
		tools: [],
	}).kind === "exit";
}

export function isExactSolistInteractiveCommand(input: string): boolean {
	const normalized = input.trim().toLowerCase();
	if (
		normalized === "exit"
		|| normalized === "quit"
		|| normalized === "/exit"
		|| normalized === "/quit"
	) {
		return true;
	}
	if (!normalized.startsWith("/")) return false;

	return SOLIST_INTERACTIVE_COMMAND_NAMES.has(normalized.slice(1));
}

function getInteractiveHelpText(): string {
	return [
		"Solist interactive commands:",
		`  ${SOLIST_INTERACTIVE_COMMANDS.map((command) => `/${command.name}`).join(", ")}`,
		"",
		"Solist keeps this process' conversation context in memory and uses Solo for durable plans, todos, blockers, and worker handoffs.",
		"Use the editor for multi-line prompts: Shift+Enter, Ctrl+Enter, or Alt+Enter inserts a newline when your terminal supports it.",
		"Use /mode for persisted mode selection, /roles or /role set for role bindings, /role-switch for conversation-scoped role switching, and /resume for local conversation history.",
		"Pi session commands, model switching, import/export/share, fork/tree, reload, compact, and ! shell mode are not available.",
	].join("\n");
}

function getRoleRoute(input: string): SolistInteractiveRoute {
	const options = getCommandOptions(input);
	const [action, role, ...agentParts] = options.args;
	if (!action) {
		return { kind: "role-menu", project: options.project };
	}
	if (action === "set" || action === "override" || action === "switch") {
		return {
			kind: "role",
			action,
			role,
			agent: agentParts.join(" ").trim() || undefined,
			project: options.project,
		};
	}
	if (action === "unset") {
		return { kind: "role", action, role, project: options.project };
	}
	return {
		kind: "render",
		message: "Usage: /role set <role> <agent id or exact name> [--project[=id|current]] | /role unset <role> [--project[=id|current]] | /role override <role> <agent id or exact name> | /role switch <role> <agent id or exact name>",
	};
}

function getRoleSwitchRoute(input: string): SolistInteractiveRoute {
	const options = getCommandOptions(input);
	const [role, ...agentParts] = options.args;
	return {
		kind: "role",
		action: "switch",
		role,
		agent: agentParts.join(" ").trim() || undefined,
		project: options.project,
	};
}

function getCommandArgument(input: string): string | undefined {
	const [, ...parts] = input.trim().split(/\s+/);
	const arg = parts.join(" ").trim();
	return arg || undefined;
}

function getCommandOptions(input: string): { args: string[]; project?: string } {
	const [, ...parts] = input.trim().split(/\s+/);
	const args: string[] = [];
	let project: string | undefined;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (part === "--project") {
			const next = parts[index + 1];
			if (next === "current" || (next !== undefined && /^\d+$/.test(next))) {
				project = next;
				index += 1;
			} else {
				project = "current";
			}
			continue;
		}
		if (part.startsWith("--project=")) {
			project = part.slice("--project=".length) || "current";
			continue;
		}
		args.push(part);
	}
	return { args, project };
}

function getToolsText(tools: readonly AgentTool[]): string {
	if (tools.length === 0) {
		return "No tools are exposed to this Solist harness.";
	}

	const lines = ["Exposed Solist harness tools:"];
	for (const tool of tools) {
		const label = tool.label && tool.label !== tool.name
			? ` (${tool.label})`
			: "";
		lines.push(`  ${tool.name}${label}: ${tool.description}`);
	}
	return lines.join("\n");
}

function getStatusText(status: SolistInteractiveStatus): string {
	return [
		"Solist status:",
		`  model: ${status.provider}/${status.model}`,
		`  reasoning: ${status.thinkingLevel}`,
		`  cwd: ${status.cwd}`,
		`  solo mcp: ${status.soloMcpAvailable ? "available" : "unavailable"}`,
		`  messages: ${status.messageCount}`,
		`  tools: ${status.toolCount}`,
		`  context: ${formatContextUsage(status.contextUsage)}`,
		`  queued inputs: ${status.queuedInputCount ?? 0}`,
	].join("\n");
}

function formatContextUsage(contextUsage: SolistContextUsage | undefined): string {
	if (!contextUsage) {
		return "unknown";
	}
	const used = formatTokenCount(contextUsage.used);
	const limit = contextUsage.limit ? `/${formatTokenCount(contextUsage.limit)}` : "";
	const approximate = contextUsage.approximate ? " approx" : "";
	return `${used}${limit}${approximate}`;
}

function formatTokenCount(value: number): string {
	if (value >= 1000) {
		return `${Math.round(value / 100) / 10}k`;
	}
	return String(value);
}

function getUnsupportedCommandText(command: string): string {
	const commandName = command.split(/\s+/, 1)[0] ?? command;
	const prefix = UNSUPPORTED_PI_COMMANDS.has(commandName)
		? `${commandName} is a Pi session command and is outside Solist's interactive boundary.`
		: `${commandName} is not a supported Solist command.`;
	return `${prefix} Type /help for the supported command set.`;
}
