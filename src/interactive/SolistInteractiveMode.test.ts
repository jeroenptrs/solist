import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SolistInteractiveMode, type SolistInteractiveHarness } from "./SolistInteractiveMode.js";
import type { SolistSession } from "../solistSessions.js";

class FakeTerminal implements Terminal {
	private onInput?: (data: string) => void;
	output = "";
	stopped = false;

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
		this.stopped = false;
	}

	stop(): void {
		this.stopped = true;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.output += data;
	}

	get columns(): number {
		return 120;
	}

	get rows(): number {
		return 32;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	send(text: string): void {
		for (const char of text) {
			this.onInput?.(char);
		}
	}
}

function createHarness(options: {
	authPath?: string;
	close?: () => void | Promise<void>;
	logout?: (provider: string) => Promise<void> | void;
	getProviderName?: (provider: string) => Promise<string> | string;
	modeId?: SolistInteractiveHarness["modeId"];
	thinkingLevel?: ThinkingLevel;
} = {}): SolistInteractiveHarness {
	return {
		messages: [] satisfies AgentMessage[],
		tools: [],
		modelRef: { provider: "openai-codex", model: "gpt-5.5" },
		thinkingLevel: options.thinkingLevel ?? "off" as ThinkingLevel,
		modeId: options.modeId,
		isStreaming: false,
		authPath: options.authPath,
		async run() {},
		abort() {},
		async logout(provider: string) {
			await options.logout?.(provider);
		},
		async getProviderName(provider: string) {
			return options.getProviderName?.(provider) ?? provider;
		},
		close: options.close,
		subscribe(_listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
			return () => {};
		},
	};
}

function waitForRender(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 35));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function testSession(input: {
	id: string;
	updatedAt: string;
	messages: readonly AgentMessage[];
}): SolistSession {
	return {
		schema: "solist.session.v1",
		id: input.id,
		title: input.id,
		cwd: "/tmp/project",
		modeId: "orchestration",
		createdAt: "2026-05-11T09:00:00.000Z",
		updatedAt: input.updatedAt,
		messages: input.messages,
	};
}

describe("SolistInteractiveMode", () => {
	it("renders a colored Solist ascii banner in the welcome area", async () => {
		const terminal = new FakeTerminal();
		const mode = new SolistInteractiveMode(createHarness(), {
			terminal,
			cwd: "/tmp/project",
		});

		const done = mode.run();
		await waitForRender();

		expect(terminal.output).toContain("____        _ _     _");
		expect(terminal.output).toContain("Solo orchestration agent");
		expect(terminal.output).toContain("\x1b[36m  ____");

		terminal.send("/exit\r");
		await done;
	});

	it("renders the Solist ascii banner with the active mode color", async () => {
		const terminal = new FakeTerminal();
		const mode = new SolistInteractiveMode(createHarness({
			modeId: "analysis",
			thinkingLevel: "high",
		}), {
			terminal,
			cwd: "/tmp/project",
		});

		const done = mode.run();
		await waitForRender();

		expect(terminal.output).toContain("____        _ _     _");
		expect(terminal.output).toContain("\x1b[35m  ____");
		expect(terminal.output).toContain("reasoning:high");

		terminal.send("/exit\r");
		await done;
	});

	it("renders slash command overview and statusline", async () => {
		const terminal = new FakeTerminal();
		const mode = new SolistInteractiveMode(createHarness(), {
			terminal,
			cwd: "/tmp/project",
			showWelcome: false,
		});

		const done = mode.run();
		terminal.send("/");
		await waitForRender();

		expect(terminal.output).toContain("help");
		expect(terminal.output).toContain("Show the supported Solist command set");
		expect(terminal.output).toContain("exit");
		expect(terminal.output).not.toContain("quit");
		expect(terminal.output).toContain("openai-codex/gpt-5.5");
		expect(terminal.output).toContain("agent:idle");
		expect(terminal.output).toContain("reasoning:off");
		expect(terminal.output).toContain("\x1b[32mSolist Ready");

		terminal.send("exit\r");
		await done;
		expect(terminal.stopped).toBe(true);
	});

	it("submits exact /exit without requiring autocomplete confirmation", async () => {
		const terminal = new FakeTerminal();
		let closed = false;
		const mode = new SolistInteractiveMode(createHarness(), {
			terminal,
			showWelcome: false,
		});

		const done = mode.run();
		terminal.send("/exit\r");

		await done;
		expect(terminal.stopped).toBe(true);
		expect(closed).toBe(false);
	});

	it("closes harness resources when /quit exits", async () => {
		const terminal = new FakeTerminal();
		let closed = false;
		const mode = new SolistInteractiveMode(createHarness({
			close: () => {
				closed = true;
			},
		}), {
			terminal,
			showWelcome: false,
		});

		const done = mode.run();
		terminal.send("/quit\r");

		await done;
		expect(terminal.stopped).toBe(true);
		expect(closed).toBe(true);
	});

	it("handles Solist-owned /logout without sending it to the model", async () => {
		const terminal = new FakeTerminal();
		const loggedOut: string[] = [];
		const mode = new SolistInteractiveMode(createHarness({
			authPath: "/tmp/solist-auth.json",
			logout: (provider) => {
				loggedOut.push(provider);
			},
			getProviderName: () => "ChatGPT Plus/Pro (Codex Subscription)",
		}), {
			terminal,
			showWelcome: false,
		});

		const done = mode.run();
		terminal.send("/logout\r");
		await waitForRender();

		expect(loggedOut).toEqual(["openai-codex"]);
		expect(terminal.output).toContain("Logged out of ChatGPT Plus/Pro");
		expect(terminal.output).toContain("/tmp/solist-auth.json");

		terminal.send("/exit\r");
		await done;
	});

	it("renders user turns as unlabeled full-width background blocks", async () => {
		const terminal = new FakeTerminal();
		const releaseRun = createDeferred();
		let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | undefined;
		const signal = new AbortController().signal;
		const harness = {
			...createHarness(),
			async run(prompt: string) {
				listener?.({
					type: "message_start",
					message: {
						role: "user",
						content: [{ type: "text", text: prompt }],
					} as AgentMessage,
				} as AgentEvent, signal);
				await releaseRun.promise;
			},
			subscribe(nextListener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listener = nextListener;
				return () => {
					listener = undefined;
				};
			},
		} satisfies SolistInteractiveHarness;
		const mode = new SolistInteractiveMode(harness, {
			terminal,
			showWelcome: false,
		});

		const done = mode.run("Please plan this");
		await waitForRender();

		expect(terminal.output).toContain("Please plan this");
		expect(terminal.output).toContain("\x1b[48;5;238m");
		expect(terminal.output).not.toContain("You:");
		expect(terminal.output).not.toContain("Assistant:");

		releaseRun.resolve();
		await waitForRender();
		terminal.send("/exit\r");
		await done;
	});

	it("does not render internal role override context from user messages", async () => {
		const terminal = new FakeTerminal();
		let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | undefined;
		const signal = new AbortController().signal;
		const harness = {
			...createHarness(),
			async run() {
				listener?.({
					type: "message_start",
					message: {
						role: "user",
						content: [{
							type: "text",
							text: [
								"Session role overrides for this Solist process:",
								"- reviewer -> 7 (Codex High)",
								"",
								"Please review this patch",
							].join("\n"),
						}],
					} as AgentMessage,
				} as AgentEvent, signal);
			},
			subscribe(nextListener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listener = nextListener;
				return () => {
					listener = undefined;
				};
			},
		} satisfies SolistInteractiveHarness;
		const mode = new SolistInteractiveMode(harness, {
			terminal,
			showWelcome: false,
		});

		const done = mode.run("start");
		await waitForRender();

		expect(terminal.output).toContain("Please review this patch");
		expect(terminal.output).not.toContain("Session role overrides");
		expect(terminal.output).not.toContain("reviewer ->");

		terminal.send("/exit\r");
		await done;
	});

	it("resumes the previous session for /resume latest instead of the active empty session", async () => {
		const terminal = new FakeTerminal();
		const activeSession = testSession({
			id: "current-empty",
			updatedAt: "2026-05-11T09:40:00.000Z",
			messages: [],
		});
		const previousSession = testSession({
			id: "previous-chat",
			updatedAt: "2026-05-11T09:30:00.000Z",
			messages: [
				{ role: "user", content: [{ type: "text", text: "Previous prompt" }], timestamp: 1 },
			] satisfies AgentMessage[],
		});
		const createdHarnessMessages: Array<readonly AgentMessage[]> = [];
		const mode = new SolistInteractiveMode(createHarness({ modeId: "orchestration" }), {
			terminal,
			showWelcome: false,
			session: activeSession,
			listSessions: () => [activeSession, previousSession],
			readSession: (id) => id === previousSession.id ? previousSession : activeSession,
			createHarnessForMode: async (_modeId, context) => {
				createdHarnessMessages.push(context.messages);
				return createHarness({ modeId: "analysis" });
			},
		});

		const done = mode.run();
		terminal.send("/resume latest\r");
		await waitForRender();

		expect(createdHarnessMessages).toEqual([[previousSession.messages[0]!]]);
		expect(terminal.output).toContain("Previous prompt");
		expect(terminal.output).toContain("Resumed Solist session previous-chat");

		terminal.send("/exit\r");
		await done;
	});

	it("streams assistant deltas into the current response before the turn ends", async () => {
		const terminal = new FakeTerminal();
		const releaseRun = createDeferred();
		let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | undefined;
		const signal = new AbortController().signal;
		const harness = {
			...createHarness(),
			get isStreaming() {
				return true;
			},
			async run() {
				listener?.({
					type: "message_start",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "" }],
					} as AgentMessage,
				} as AgentEvent, signal);
				listener?.({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: "Partial response",
					},
				} as AgentEvent, signal);
				await releaseRun.promise;
				listener?.({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: " completed",
					},
				} as AgentEvent, signal);
				listener?.({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Partial response completed" }],
					} as AgentMessage,
				} as AgentEvent, signal);
			},
			subscribe(nextListener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listener = nextListener;
				return () => {
					listener = undefined;
				};
			},
		} satisfies SolistInteractiveHarness;
		const mode = new SolistInteractiveMode(harness, {
			terminal,
			showWelcome: false,
		});

		const done = mode.run("start");
		await waitForRender();

		expect(terminal.output).toContain("Partial response");
		expect(terminal.output).not.toContain("completed");
		expect(terminal.output).not.toContain("Assistant:");

		releaseRun.resolve();
		await waitForRender();
		expect(terminal.output).toContain("Partial response completed");

		terminal.send("/exit\r");
		await done;
	});

	it("shows a thinking spinner placeholder before assistant text streams", async () => {
		const terminal = new FakeTerminal();
		const releaseDelta = createDeferred();
		const releaseRun = createDeferred();
		let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | undefined;
		const signal = new AbortController().signal;
		const harness = {
			...createHarness(),
			get isStreaming() {
				return true;
			},
			async run() {
				listener?.({ type: "agent_start" } as AgentEvent, signal);
				listener?.({ type: "turn_start" } as AgentEvent, signal);
				listener?.({
					type: "message_start",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "" }],
					} as AgentMessage,
				} as AgentEvent, signal);
				await releaseDelta.promise;
				listener?.({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: "Started",
					},
				} as AgentEvent, signal);
				await releaseRun.promise;
				listener?.({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Started" }],
					} as AgentMessage,
				} as AgentEvent, signal);
				listener?.({
					type: "agent_end",
					messages: [],
				} as AgentEvent, signal);
			},
			subscribe(nextListener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listener = nextListener;
				return () => {
					listener = undefined;
				};
			},
		} satisfies SolistInteractiveHarness;
		const mode = new SolistInteractiveMode(harness, {
			terminal,
			showWelcome: false,
		});

		const done = mode.run("start");
		await waitForRender();

		expect(terminal.output).toContain("Thinking...");
		expect(terminal.output).toContain("agent:thinking");
		expect(terminal.output).not.toContain("Started");

		releaseDelta.resolve();
		await waitForRender();
		expect(terminal.output).toContain("Started");
		expect(terminal.output).toContain("agent:streaming");

		releaseRun.resolve();
		await waitForRender();
		terminal.send("/exit\r");
		await done;
	});
});
