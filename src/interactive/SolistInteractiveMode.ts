import { basename } from "node:path";
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	Container,
	Editor,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	TruncatedText,
	TUI,
	CombinedAutocompleteProvider,
	type EditorTheme,
	type MarkdownTheme,
	type Terminal,
} from "@earendil-works/pi-tui";
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
	run(prompt: string): Promise<unknown>;
	abort(): void;
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
	private activeTurn = false;
	private interruptRequested = false;
	private stopped = false;
	private currentAssistant?: {
		text: string;
		component: Markdown;
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
			this.chat.addChild(new Text("Solist interactive chat", 1, 0));
			this.chat.addChild(
				new Text("Type /help for commands, /exit to quit.", 1, 0),
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
		const route = routeSolistInteractiveInput(input, this.getCommandContext());
		if (route.kind === "empty") return;
		if (route.kind === "exit") {
			await this.stop();
			return;
		}
		if (route.kind === "clear") {
			this.chat.clear();
			this.currentAssistant = undefined;
			this.chat.addChild(new Text(route.message, 1, 0));
			this.setStatusState("Ready");
			this.ui.requestRender(true);
			return;
		}
		if (route.kind === "render") {
			this.addSystemMessage(route.message);
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

	private renderEvent(event: AgentEvent): void {
		switch (event.type) {
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
			this.chat.addChild(new Text(`You: ${extractMessageText(message)}`, 1, 0));
			return;
		}

		if (message.role === "assistant") {
			this.chat.addChild(new Spacer(1));
			this.chat.addChild(new Text("Assistant:", 1, 0));
			const component = new Markdown("", 1, 0, defaultMarkdownTheme);
			this.chat.addChild(component);
			this.currentAssistant = { text: "", component };
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
		this.currentAssistant = undefined;
	}

	private renderAssistantUpdate(event: AssistantMessageEvent): void {
		if (event.type === "text_delta") {
			if (!this.currentAssistant) {
				const component = new Markdown("", 1, 0, defaultMarkdownTheme);
				this.chat.addChild(new Spacer(1));
				this.chat.addChild(new Text("Assistant:", 1, 0));
				this.chat.addChild(component);
				this.currentAssistant = { text: "", component };
			}
			this.currentAssistant.text += event.delta;
			this.currentAssistant.component.setText(this.currentAssistant.text);
			return;
		}

		if (event.type === "toolcall_end") {
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

	private updateStatusLine(): void {
		const model = `${this.harness.modelRef.provider}/${this.harness.modelRef.model}`;
		const solo = this.soloMcpAvailable ? "solo:ok" : "solo:down";
		const cwdName = basename(this.cwd) || this.cwd;
		const line = [
			`Solist ${this.statusState}`,
			model,
			`reasoning:${this.harness.thinkingLevel}`,
			`messages:${this.harness.messages.length}`,
			`tools:${this.harness.tools.length}`,
			solo,
			`cwd:${cwdName}`,
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
