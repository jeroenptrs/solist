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
	"/resume",
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
		"Pi session commands, model switching, import/export/share, resume/fork/tree, reload, compact, and ! shell mode are not available.",
	].join("\n");
}

function getCommandArgument(input: string): string | undefined {
	const [, ...parts] = input.trim().split(/\s+/);
	const arg = parts.join(" ").trim();
	return arg || undefined;
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
	].join("\n");
}

function getUnsupportedCommandText(command: string): string {
	const commandName = command.split(/\s+/, 1)[0] ?? command;
	const prefix = UNSUPPORTED_PI_COMMANDS.has(commandName)
		? `${commandName} is a Pi session command and is outside Solist's interactive boundary.`
		: `${commandName} is not a supported Solist command.`;
	return `${prefix} Type /help for the supported command set.`;
}
