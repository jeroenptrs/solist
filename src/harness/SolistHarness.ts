import { Agent } from "@earendil-works/pi-agent-core";
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
	StreamFn,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	getModel,
	streamSimple,
	type Api,
	type Model,
	type OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { buildSolistSystemPrompt } from "../solistPrompt.js";
import { getSolistAuthPath } from "../solistPaths.js";
import type { SolistModeId } from "../solistModes.js";
import {
	createSolistApiKeyResolver,
	getSolistOAuthProviderName,
	loginSolistProvider,
	logoutSolistProvider,
	type SolistApiKeyResolver,
} from "./auth.js";

export interface SolistModelRef {
	provider: string;
	model: string;
}

export interface SolistHarnessOutput {
	write(chunk: string): void;
}

export interface SolistHarnessOptions {
	model?: Model<Api>;
	modelRef?: SolistModelRef;
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: AgentTool[];
	disposables?: Array<() => void | Promise<void>>;
	streamFn?: StreamFn;
	getApiKey?: SolistApiKeyResolver;
	output?: SolistHarnessOutput;
	messages?: AgentMessage[];
	modeId?: SolistModeId;
	projectId?: number | string;
}

export interface SolistHarnessRunResult {
	messages: AgentMessage[];
}

export class SolistHarness {
	private readonly agent: Agent;
	private readonly output: SolistHarnessOutput;
	private readonly disposables: Array<() => void | Promise<void>>;
	private readonly configuredModeId?: SolistModeId;
	private readonly configuredProjectId?: number | string;
	private finalMessages: AgentMessage[] = [];
	private closePromise?: Promise<void>;

	constructor(options: SolistHarnessOptions = {}) {
		this.output = options.output ?? process.stdout;
		this.disposables = options.disposables ?? [];
		this.configuredModeId = options.modeId;
		this.configuredProjectId = options.projectId;

		this.agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt ?? buildSolistSystemPrompt(),
				model: options.model ?? resolveSolistModel(options.modelRef),
				thinkingLevel: options.thinkingLevel ?? "off",
				tools: options.tools ?? [],
				messages: options.messages ?? [],
			},
			streamFn: options.streamFn ?? streamSimple,
			getApiKey: options.getApiKey ?? createSolistApiKeyResolver(),
		});

		this.agent.subscribe((event) => this.handleEvent(event));
	}

	get messages(): readonly AgentMessage[] {
		return this.agent.state.messages;
	}

	get tools(): readonly AgentTool[] {
		return this.agent.state.tools;
	}

	get modelRef(): SolistModelRef {
		const model = this.agent.state.model;
		return {
			provider: model.provider,
			model: model.id,
		};
	}

	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get modeId(): SolistModeId | undefined {
		return this.configuredModeId;
	}

	get projectId(): number | string | undefined {
		return this.configuredProjectId;
	}

	get authPath(): string {
		return getSolistAuthPath();
	}

	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	subscribe(
		listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
	): () => void {
		return this.agent.subscribe(listener);
	}

	abort(): void {
		this.agent.abort();
	}

	async run(prompt: string): Promise<SolistHarnessRunResult> {
		this.finalMessages = [];
		await this.agent.prompt(prompt);
		return {
			messages: this.finalMessages.length > 0
				? this.finalMessages
				: this.agent.state.messages,
		};
	}

	async close(): Promise<void> {
		this.closePromise ??= this.closeOnce();
		await this.closePromise;
	}

	async login(provider: string, callbacks: OAuthLoginCallbacks): Promise<void> {
		await loginSolistProvider(provider, callbacks);
	}

	async logout(provider: string): Promise<void> {
		await logoutSolistProvider(provider);
	}

	async getProviderName(provider: string): Promise<string> {
		return getSolistOAuthProviderName(provider);
	}

	private async closeOnce(): Promise<void> {
		this.abort();
		await Promise.allSettled(this.disposables.map(async (dispose) => dispose()));
	}

	private handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_update":
				this.writeAssistantDelta(event.assistantMessageEvent);
				break;
			case "tool_execution_start":
				this.output.write(
					`\n[tool:start ${event.toolName} ${JSON.stringify(event.args)}]\n`,
				);
				break;
			case "tool_execution_update":
				this.output.write(
					`\n[tool:update ${event.toolName} ${JSON.stringify(event.partialResult)}]\n`,
				);
				break;
			case "tool_execution_end":
				this.output.write(
					`\n[tool:end ${event.toolName} ${event.isError ? "error" : "ok"}]\n`,
				);
				break;
			case "agent_end":
				this.finalMessages = event.messages;
				break;
		}
	}

	private writeAssistantDelta(event: AgentEventForAssistantUpdate): void {
		if (event.type === "text_delta") {
			this.output.write(event.delta);
		}
		if (event.type === "toolcall_end") {
			this.output.write(
				`\n[tool:call ${event.toolCall.name} ${JSON.stringify(event.toolCall.arguments)}]\n`,
			);
		}
	}
}

type AgentEventForAssistantUpdate = Extract<
	AgentEvent,
	{ type: "message_update" }
>["assistantMessageEvent"];

function resolveSolistModel(modelRef: SolistModelRef = {
	provider: "openai-codex",
	model: "gpt-5.5",
}): Model<Api> {
	return getModel(
		modelRef.provider as Parameters<typeof getModel>[0],
		modelRef.model as Parameters<typeof getModel>[1],
	) as Model<Api>;
}
