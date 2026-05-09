import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SolistInteractiveMode, type SolistInteractiveHarness } from "./SolistInteractiveMode.js";

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

function createHarness(options: { close?: () => void | Promise<void> } = {}): SolistInteractiveHarness {
	return {
		messages: [] satisfies AgentMessage[],
		tools: [],
		modelRef: { provider: "openai-codex", model: "gpt-5.5" },
		thinkingLevel: "off" as ThinkingLevel,
		isStreaming: false,
		async run() {},
		abort() {},
		close: options.close,
		subscribe(_listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
			return () => {};
		},
	};
}

function waitForRender(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 35));
}

describe("SolistInteractiveMode", () => {
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
		expect(terminal.output).toContain("reasoning:off");

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
});
