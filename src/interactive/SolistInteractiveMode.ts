import { spawn } from "node:child_process";
import { basename } from "node:path";
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
	AssistantMessageEvent,
	OAuthLoginCallbacks,
	OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import {
	Container,
	Editor,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	TruncatedText,
	TUI,
	CombinedAutocompleteProvider,
	type Component,
	type EditorTheme,
	type MarkdownTheme,
	type Terminal,
} from "@earendil-works/pi-tui";
import { SOLIST_MODEL_PROVIDER } from "../solistPrompt.js";
import { getSolistAuthPath } from "../solistPaths.js";
import {
	isExactSolistInteractiveCommand,
	routeSolistInteractiveInput,
	SOLIST_INTERACTIVE_COMMANDS,
	type SolistInteractiveCommandContext,
} from "./SolistCommandRouter.js";

export interface SolistInteractiveHarness {
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentTool[];
	readonly modelRef: { provider: string; model: string };
	readonly thinkingLevel: ThinkingLevel;
	readonly isStreaming: boolean;
	readonly authPath?: string;
	run(prompt: string): Promise<unknown>;
	abort(): void;
	login?(provider: string, callbacks: OAuthLoginCallbacks): Promise<void>;
	logout?(provider: string): Promise<void>;
	getProviderName?(provider: string): Promise<string>;
	close?(): void | Promise<void>;
	subscribe(
		listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
	): () => void;
}

export interface SolistInteractiveModeOptions {
	terminal?: Terminal;
	cwd?: string;
	soloMcpAvailable?: boolean;
	showWelcome?: boolean;
}

export class SolistInteractiveMode {
	private readonly terminal: Terminal;
	private readonly cwd: string;
	private readonly soloMcpAvailable: boolean;
	private readonly showWelcome: boolean;
	private readonly ui: TUI;
	private readonly chat = new Container();
	private readonly status = new Container();
	private readonly editor: Editor;
	private unsubscribe?: () => void;
	private resolveRun?: () => void;
	private statusState = "Ready";
	private agentState: AgentActivityState = "idle";
	private activeTurn = false;
	private interruptRequested = false;
	private stopped = false;
	private activeAuth = false;
	private activeAuthAbort?: AbortController;
	private activeAuthInput?: AuthInputWaiter;
	private currentAssistant?: {
		text: string;
		component: Markdown;
		placeholder?: Loader;
	};

	constructor(
		private readonly harness: SolistInteractiveHarness,
		options: SolistInteractiveModeOptions = {},
	) {
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.cwd = options.cwd ?? process.cwd();
		this.soloMcpAvailable = options.soloMcpAvailable ?? true;
		this.showWelcome = options.showWelcome ?? true;
		this.ui = new TUI(this.terminal);
		this.editor = new Editor(this.ui, defaultEditorTheme, { paddingX: 1 });
	}

	async run(initialPrompt = ""): Promise<void> {
		const done = new Promise<void>((resolve) => {
			this.resolveRun = resolve;
		});
		this.setupLayout();
		this.unsubscribe = this.harness.subscribe((event) => this.renderEvent(event));
		this.ui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c") && this.activeAuth) {
				this.cancelActiveAuth();
				return { consume: true };
			}
			if (matchesKey(data, "escape") && this.activeAuth) {
				this.cancelActiveAuth();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+c")) {
				this.handleInterruptOrExit();
				return { consume: true };
			}
			if (matchesKey(data, "escape") && this.activeTurn) {
				this.handleInterruptOrExit();
				return { consume: true };
			}
			if (matchesKey(data, "enter") && this.submitExactInteractiveCommand()) {
				return { consume: true };
			}
			return undefined;
		});
		this.ui.start();

		if (initialPrompt.trim()) {
			void this.submitPrompt(initialPrompt.trim());
		}

		return done;
	}

	private setupLayout(): void {
		if (this.showWelcome) {
			this.chat.addChild(new Spacer(1));
			for (const line of getSolistAsciiArt()) {
				this.chat.addChild(new Text(line, 1, 0));
			}
			this.chat.addChild(new Text(color.dim("   Solo orchestration agent"), 1, 0));
			this.chat.addChild(
				new Text(color.dim("   Type /help for commands, /exit to quit."), 1, 0),
			);
			this.chat.addChild(new Spacer(1));
		}

		this.editor.onSubmit = (input) => {
			void this.handleSubmit(input);
		};
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[...SOLIST_INTERACTIVE_COMMANDS],
				this.cwd,
			),
		);

		this.ui.addChild(this.chat);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.status);
		this.ui.setFocus(this.editor);
		this.setStatusState("Ready");
	}

	private async handleSubmit(input: string): Promise<void> {
		if (this.activeAuthInput) {
			this.resolveActiveAuthInput(input);
			return;
		}

		const route = routeSolistInteractiveInput(input, this.getCommandContext());
		if (route.kind === "empty") return;
		if (route.kind === "exit") {
			await this.stop();
			return;
		}
		if (route.kind === "clear") {
			this.chat.clear();
			this.clearCurrentAssistant();
			this.chat.addChild(new Text(route.message, 1, 0));
			this.setStatusState("Ready");
			this.setAgentState("idle");
			this.ui.requestRender(true);
			return;
		}
		if (route.kind === "render") {
			this.addSystemMessage(route.message);
			return;
		}
		if (route.kind === "login") {
			await this.handleLoginCommand(route.provider);
			return;
		}
		if (route.kind === "logout") {
			await this.handleLogoutCommand(route.provider);
			return;
		}
		await this.submitPrompt(route.prompt);
	}

	private submitExactInteractiveCommand(): boolean {
		const input = this.editor.getExpandedText();
		if (!isExactSolistInteractiveCommand(input)) return false;

		const trimmed = input.trim();
		this.editor.addToHistory(trimmed);
		this.editor.setText("");
		void this.handleSubmit(trimmed);
		return true;
	}

	private async submitPrompt(prompt: string): Promise<void> {
		if (this.activeTurn) {
			this.addSystemMessage("Solist is still working. Wait, or press Esc/Ctrl+C to interrupt.");
			return;
		}

		this.activeTurn = true;
		this.interruptRequested = false;
		this.editor.disableSubmit = true;
		this.setStatusState("Working");
		this.setAgentState("thinking");

		try {
			await this.harness.run(prompt);
		} catch (error) {
			if (this.interruptRequested) {
				this.addSystemMessage("Active turn stopped.");
				return;
			}
			this.addSystemMessage(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.activeTurn = false;
			this.interruptRequested = false;
			this.editor.disableSubmit = false;
			this.setStatusState("Ready");
			this.setAgentState("idle");
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	private getCommandContext(): SolistInteractiveCommandContext {
		return {
			status: {
				provider: this.harness.modelRef.provider,
				model: this.harness.modelRef.model,
				thinkingLevel: this.harness.thinkingLevel,
				cwd: this.cwd,
				soloMcpAvailable: this.soloMcpAvailable,
				messageCount: this.harness.messages.length,
				toolCount: this.harness.tools.length,
			},
			tools: this.harness.tools,
		};
	}

	private async handleLoginCommand(providerArg?: string): Promise<void> {
		const provider = this.resolvePinnedAuthProvider(providerArg, "/login");
		if (!provider) return;
		if (this.activeTurn) {
			this.addSystemMessage("Wait for the current turn to finish before logging in.");
			return;
		}
		if (this.activeAuth) {
			this.addSystemMessage("Authentication is already in progress.");
			return;
		}
		if (!this.harness.login) {
			this.addSystemMessage("This Solist harness does not expose login support.");
			return;
		}

		const authPath = this.getAuthPath();
		let providerName = provider;
		try {
			providerName = await this.getProviderName(provider);
		} catch (error) {
			this.addSystemMessage(
				`Login failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		this.activeAuth = true;
		this.activeAuthAbort = new AbortController();
		this.setStatusState("Authenticating");
		this.addSystemMessage(
			`Starting ${providerName} login. Credentials will be saved to ${authPath}.`,
		);

		try {
			await this.harness.login(provider, this.createLoginCallbacks());
			this.resolveActiveAuthInput("", { silent: true });
			this.addSystemMessage(`Logged in to ${providerName}. Credentials saved to ${authPath}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== "Login cancelled") {
				this.addSystemMessage(`Login failed: ${message}`);
			}
		} finally {
			this.activeAuth = false;
			this.activeAuthAbort = undefined;
			this.activeAuthInput = undefined;
			this.setStatusState("Ready");
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	private async handleLogoutCommand(providerArg?: string): Promise<void> {
		const provider = this.resolvePinnedAuthProvider(providerArg, "/logout");
		if (!provider) return;
		if (this.activeTurn || this.activeAuth) {
			this.addSystemMessage("Wait for the current turn or authentication flow to finish before logging out.");
			return;
		}
		if (!this.harness.logout) {
			this.addSystemMessage("This Solist harness does not expose logout support.");
			return;
		}

		try {
			const providerName = await this.getProviderName(provider);
			await this.harness.logout(provider);
			this.addSystemMessage(
				`Logged out of ${providerName}. Removed stored credentials from ${this.getAuthPath()}.`,
			);
		} catch (error) {
			this.addSystemMessage(
				`Logout failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private createLoginCallbacks(): OAuthLoginCallbacks {
		return {
			onAuth: (info) => {
				openBrowser(info.url);
				this.addSystemMessage(
					[
						"Open this authentication URL:",
						info.url,
						info.instructions ?? "Complete login in the browser to finish.",
					].join("\n"),
				);
			},
			onPrompt: (prompt) =>
				this.promptForAuthInput(
					prompt.placeholder
						? `${prompt.message}\n${prompt.placeholder}`
						: prompt.message,
				),
			onProgress: (message) => {
				this.addSystemMessage(message);
			},
			onManualCodeInput: () =>
				this.promptForAuthInput(
					"Paste the redirect URL or authorization code below, or complete login in the browser:",
				),
			onSelect: (prompt) => this.promptForAuthSelection(prompt),
			signal: this.activeAuthAbort?.signal,
		};
	}

	private promptForAuthInput(message: string): Promise<string> {
		this.addSystemMessage(message);
		this.editor.disableSubmit = false;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();

		return new Promise((resolve, reject) => {
			this.activeAuthInput = {
				resolve: (value) => {
					this.activeAuthInput = undefined;
					resolve(value.trim());
				},
				reject: (error) => {
					this.activeAuthInput = undefined;
					reject(error);
				},
			};
		});
	}

	private async promptForAuthSelection(prompt: OAuthSelectPrompt): Promise<string | undefined> {
		const optionsText = prompt.options
			.map((option) => `${option.id}: ${option.label}`)
			.join("\n");
		const input = await this.promptForAuthInput(`${prompt.message}\n${optionsText}`);
		const normalized = input.trim().toLowerCase();
		return prompt.options.find((option) =>
			option.id.toLowerCase() === normalized
			|| option.label.toLowerCase() === normalized
		)?.id;
	}

	private resolveActiveAuthInput(
		input: string,
		options: { silent?: boolean } = {},
	): void {
		const waiter = this.activeAuthInput;
		if (!waiter) return;
		waiter.resolve(input);
		if (!options.silent) {
			this.addSystemMessage("Authentication input received.");
		}
	}

	private cancelActiveAuth(): void {
		this.activeAuthAbort?.abort();
		this.activeAuthInput?.reject(new Error("Login cancelled"));
		this.activeAuthInput = undefined;
		this.activeAuth = false;
		this.activeAuthAbort = undefined;
		this.setStatusState("Ready");
		this.addSystemMessage("Authentication cancelled.");
	}

	private resolvePinnedAuthProvider(
		providerArg: string | undefined,
		command: "/login" | "/logout",
	): string | undefined {
		const provider = providerArg?.trim().toLowerCase() || SOLIST_MODEL_PROVIDER;
		if (provider !== SOLIST_MODEL_PROVIDER) {
			this.addSystemMessage(
				`Solist is pinned to ${SOLIST_MODEL_PROVIDER}; ${command} only supports that provider.`,
			);
			return undefined;
		}
		return provider;
	}

	private async getProviderName(provider: string): Promise<string> {
		return this.harness.getProviderName?.(provider) ?? provider;
	}

	private getAuthPath(): string {
		return this.harness.authPath ?? getSolistAuthPath();
	}

	private renderEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.setAgentState("thinking");
				break;
			case "agent_end":
				this.setAgentState("idle");
				break;
			case "turn_start":
				this.setAgentState("thinking");
				break;
			case "turn_end":
				if (this.activeTurn) this.setAgentState("thinking");
				break;
			case "message_start":
				this.renderMessageStart(event.message);
				break;
			case "message_update":
				this.renderAssistantUpdate(event.assistantMessageEvent);
				break;
			case "message_end":
				this.renderMessageEnd(event.message);
				break;
			case "tool_execution_start":
				this.setAgentState("running tool");
				this.setStatusState(`Running ${event.toolName}`);
				this.addToolMessage(
					`${event.toolName} started ${summarizeValue(event.args)}`,
				);
				break;
			case "tool_execution_update":
				this.addToolMessage(
					`${event.toolName} update ${summarizeValue(event.partialResult)}`,
				);
				break;
			case "tool_execution_end":
				this.setAgentState(this.activeTurn ? "thinking" : "idle");
				this.setStatusState(this.activeTurn ? "Working" : "Ready");
				this.addToolMessage(
					`${event.toolName} ${event.isError ? "failed" : "completed"} ${summarizeValue(event.result)}`,
				);
				break;
		}
		this.ui.requestRender();
	}

	private renderMessageStart(message: AgentMessage): void {
		if (message.role === "user") {
			this.chat.addChild(new Spacer(1));
			this.chat.addChild(createUserMessage(extractMessageText(message)));
			return;
		}

		if (message.role === "assistant") {
			this.chat.addChild(new Spacer(1));
			const placeholder = createThinkingPlaceholder(this.ui);
			const component = new Markdown("", 1, 0, defaultMarkdownTheme);
			this.chat.addChild(placeholder);
			this.chat.addChild(component);
			this.currentAssistant = { text: "", component, placeholder };
			this.setAgentState("thinking");
		}
	}

	private renderMessageEnd(message: AgentMessage): void {
		if (message.role !== "assistant") return;

		const errorMessage = "errorMessage" in message
			&& typeof message.errorMessage === "string"
			? message.errorMessage
			: "";
		if (errorMessage) {
			this.addSystemMessage(`Error: ${errorMessage}`);
		}
		this.clearCurrentAssistant();
	}

	private renderAssistantUpdate(event: AssistantMessageEvent): void {
		if (event.type === "thinking_start" || event.type === "thinking_delta") {
			this.setAgentState("thinking");
			this.ensureAssistantPlaceholder();
			return;
		}

		if (event.type === "text_delta") {
			if (!this.currentAssistant) {
				this.chat.addChild(new Spacer(1));
				const component = new Markdown("", 1, 0, defaultMarkdownTheme);
				this.chat.addChild(component);
				this.currentAssistant = { text: "", component };
			}
			this.removeAssistantPlaceholder();
			this.setAgentState("streaming");
			this.currentAssistant.text += event.delta;
			this.currentAssistant.component.setText(this.currentAssistant.text);
			return;
		}

		if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
			this.setAgentState("thinking");
			this.ensureAssistantPlaceholder();
			return;
		}

		if (event.type === "toolcall_end") {
			this.removeAssistantPlaceholder();
			this.setAgentState("running tool");
			this.addToolMessage(
				`call ${event.toolCall.name} ${summarizeValue(event.toolCall.arguments)}`,
			);
		}
	}

	private addSystemMessage(message: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Markdown(message, 1, 0, defaultMarkdownTheme));
		this.updateStatusLine();
		this.ui.requestRender();
	}

	private addToolMessage(message: string): void {
		this.chat.addChild(new Text(`[tool] ${message}`, 1, 0));
		this.updateStatusLine();
		this.ui.requestRender();
	}

	private setStatusState(state: string): void {
		this.statusState = state;
		this.updateStatusLine();
	}

	private setAgentState(state: AgentActivityState): void {
		this.agentState = state;
		this.updateStatusLine();
	}

	private ensureAssistantPlaceholder(): void {
		if (!this.currentAssistant) {
			const placeholder = createThinkingPlaceholder(this.ui);
			const component = new Markdown("", 1, 0, defaultMarkdownTheme);
			this.chat.addChild(new Spacer(1));
			this.chat.addChild(placeholder);
			this.chat.addChild(component);
			this.currentAssistant = { text: "", component, placeholder };
			return;
		}
		if (!this.currentAssistant.placeholder && !this.currentAssistant.text) {
			const placeholder = createThinkingPlaceholder(this.ui);
			this.chat.removeChild(this.currentAssistant.component);
			this.chat.addChild(placeholder);
			this.chat.addChild(this.currentAssistant.component);
			this.currentAssistant.placeholder = placeholder;
		}
	}

	private removeAssistantPlaceholder(): void {
		const currentAssistant = this.currentAssistant;
		const placeholder = currentAssistant?.placeholder;
		if (!placeholder) return;
		placeholder.stop();
		this.chat.removeChild(placeholder);
		currentAssistant.placeholder = undefined;
	}

	private clearCurrentAssistant(): void {
		this.removeAssistantPlaceholder();
		this.currentAssistant = undefined;
	}

	private updateStatusLine(): void {
		const model = `${this.harness.modelRef.provider}/${this.harness.modelRef.model}`;
		const solo = this.soloMcpAvailable
			? color.success("solo:ok")
			: color.error("solo:down");
		const cwdName = basename(this.cwd) || this.cwd;
		const line = [
			colorStatusState(this.statusState),
			colorAgentState(this.agentState),
			color.accent(model),
			color.dim(`reasoning:${this.harness.thinkingLevel}`),
			color.dim(`messages:${this.harness.messages.length}`),
			color.dim(`tools:${this.harness.tools.length}`),
			solo,
			color.dim(`cwd:${cwdName}`),
		].join(" | ");
		this.status.clear();
		this.status.addChild(new TruncatedText(line, 1, 0));
		this.ui.requestRender();
	}

	private handleInterruptOrExit(): void {
		if (this.activeTurn || this.harness.isStreaming) {
			if (!this.interruptRequested) {
				this.interruptRequested = true;
				this.addSystemMessage("Aborting active turn...");
				this.harness.abort();
			}
			return;
		}

		void this.stop();
	}

	private async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.clearCurrentAssistant();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.editor.disableSubmit = true;
		const resolve = this.resolveRun;
		this.resolveRun = undefined;
		try {
			this.ui.stop();
			await this.terminal.drainInput(100, 25);
			await this.harness.close?.();
		} finally {
			resolve?.();
		}
	}
}

function extractMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";

	const contentValue = message.content;
	if (typeof contentValue === "string") return contentValue;
	if (Array.isArray(contentValue)) {
		return contentValue
			.flatMap((content) =>
				content.type === "text" && typeof content.text === "string"
					? [content.text]
					: []
			)
			.join("");
	}
	return "";
}

function createUserMessage(text: string): Component {
	return new Text(text, 1, 1, color.userBackground);
}

function createThinkingPlaceholder(ui: TUI): Loader {
	const placeholder = new Loader(ui, color.accent, color.dim, "Thinking...");
	placeholder.start();
	return placeholder;
}

function summarizeValue(value: unknown): string {
	const json = safeJson(value);
	if (json.length <= 360) return json;
	return `${json.slice(0, 357)}...`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

const identity = (text: string) => text;

const ANSI_RESET = "\x1b[0m";

type AgentActivityState =
	| "idle"
	| "thinking"
	| "streaming"
	| "running tool";

interface AuthInputWaiter {
	resolve(value: string): void;
	reject(error: Error): void;
}

const color = {
	accent: (text: string) => `\x1b[36m${text}${ANSI_RESET}`,
	dim: (text: string) => `\x1b[2m${text}${ANSI_RESET}`,
	error: (text: string) => `\x1b[31m${text}${ANSI_RESET}`,
	success: (text: string) => `\x1b[32m${text}${ANSI_RESET}`,
	userBackground: (text: string) => `\x1b[48;5;238m${text}${ANSI_RESET}`,
	warning: (text: string) => `\x1b[33m${text}${ANSI_RESET}`,
};

function colorStatusState(state: string): string {
	if (state === "Ready") return color.success("Solist Ready");
	if (state === "Working") return color.accent("Solist Working");
	if (state.startsWith("Running ")) return color.warning(`Solist ${state}`);
	return color.dim(`Solist ${state}`);
}

function colorAgentState(state: AgentActivityState): string {
	const text = `agent:${state}`;
	if (state === "idle") return color.dim(text);
	if (state === "thinking") return color.warning(text);
	if (state === "streaming") return color.accent(text);
	return color.warning(text);
}

function getSolistAsciiArt(): readonly string[] {
	return [
		color.accent("  ____        _ _     _"),
		color.accent(" / ___|  ___ | (_)___| |_"),
		color.accent(" \\___ \\ / _ \\| | / __| __|"),
		color.accent("  ___) | (_) | | \\__ \\ |_"),
		color.accent(" |____/ \\___/|_|_|___/\\__|"),
	];
}

const defaultEditorTheme: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: (text: string) => text,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

const defaultMarkdownTheme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

function openBrowser(url: string): void {
	const command = process.platform === "darwin"
		? "open"
		: process.platform === "win32"
		? "cmd"
		: "xdg-open";
	const args = process.platform === "win32"
		? ["/c", "start", "", url]
		: [url];

	try {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// The URL is rendered in the terminal, so failing to auto-open is non-fatal.
	}
}
