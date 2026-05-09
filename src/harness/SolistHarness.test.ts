import { describe, expect, it } from "vitest";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	Type,
	type Api,
	type AssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { SolistHarness } from "./SolistHarness.js";
import { buildSolistSystemPrompt } from "../solistPrompt.js";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const fakeModel: Model<Api> = {
	id: "fake-model",
	name: "Fake Model",
	api: "fake-api",
	provider: "fake-provider",
	baseUrl: "http://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 1000,
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: fakeModel.api,
		provider: fakeModel.provider,
		model: fakeModel.id,
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("SolistHarness", () => {
	it("runs a fake stream with the Solist system prompt and explicitly passed tools", async () => {
		const writes: string[] = [];
		const seenContexts: unknown[] = [];
		let calls = 0;
		let toolExecuted = false;
		const fakeTools: AgentTool[] = [
			{
				name: "fake_tool",
				label: "Fake Tool",
				description: "A fake test tool",
				parameters: Type.Object({}),
				async execute() {
					toolExecuted = true;
					return {
						content: [{ type: "text", text: "tool result" }],
						details: { ok: true },
					};
				},
			},
		];
		const streamFn: StreamFn = (_model, context) => {
			seenContexts.push(context);
			calls += 1;
			const stream = createAssistantMessageEventStream();
			const toolCall = {
				type: "toolCall" as const,
				id: "call-1",
				name: "fake_tool",
				arguments: {},
			};

			if (calls === 1) {
				const partial = assistant([toolCall]);

				queueMicrotask(() => {
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_end",
						contentIndex: 0,
						toolCall,
						partial,
					});
					stream.push({
						type: "done",
						reason: "toolUse",
						message: partial,
					});
				});

				return stream;
			}

			queueMicrotask(() => {
				const partial = assistant([{ type: "text", text: "" }]);
				stream.push({ type: "start", partial });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: "hello",
					partial: assistant([{ type: "text", text: "hello" }]),
				});
				stream.push({
					type: "text_end",
					contentIndex: 0,
					content: "hello",
					partial: assistant([{ type: "text", text: "hello" }]),
				});
				stream.push({
					type: "done",
					reason: "stop",
					message: assistant([{ type: "text", text: "hello" }]),
				});
			});

			return stream;
		};

		const harness = new SolistHarness({
			model: fakeModel,
			tools: fakeTools,
			streamFn,
			output: { write: (chunk) => writes.push(chunk) },
		});

		const result = await harness.run("Say hello");

		expect(writes.join("")).toContain("hello");
		expect(writes.join("")).toContain("[tool:call fake_tool {}]");
		expect(writes.join("")).toContain("[tool:start fake_tool {}]");
		expect(writes.join("")).toContain("[tool:end fake_tool ok]");
		expect(toolExecuted).toBe(true);
		expect(harness.tools.map((tool) => tool.name)).toEqual(["fake_tool"]);
		expect(result.messages.at(-1)?.role).toBe("assistant");
		expect(seenContexts).toHaveLength(2);
		expect(seenContexts[0]).toMatchObject({
			systemPrompt: buildSolistSystemPrompt(),
			tools: [{ name: "fake_tool" }],
		});
	});

	it("exposes no tools unless Solist passes them explicitly", async () => {
		const seenToolCounts: number[] = [];
		const streamFn: StreamFn = (_model, context) => {
			seenToolCounts.push(context.tools?.length ?? 0);
			const stream = createAssistantMessageEventStream();

			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: assistant([{ type: "text", text: "done" }]),
				});
			});

			return stream;
		};

		const harness = new SolistHarness({
			model: fakeModel,
			streamFn,
			output: { write: () => undefined },
		});

		await harness.run("No tools");

		expect(harness.tools).toEqual([]);
		expect(seenToolCounts).toEqual([0]);
	});

	it("supports resuming a session with injected messages", async () => {
		const seenMessages: any[] = [];
		const streamFn: StreamFn = (_model, context) => {
			seenMessages.push(...context.messages);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: assistant([{ type: "text", text: "done" }]),
				});
			});
			return stream;
		};

		const previousMessages = [
			{ role: "user" as const, content: "First prompt", timestamp: 1 },
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "First response" }],
				timestamp: 2,
				api: "fake-api",
				provider: "fake-provider",
				model: "fake-model",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop" as const,
			},
		];

		const harness = new SolistHarness({
			model: fakeModel,
			streamFn,
			output: { write: () => undefined },
			messages: previousMessages,
		});

		await harness.run("Second prompt");

		expect(seenMessages).toHaveLength(3);
		expect(seenMessages[0].content).toBe("First prompt");
		expect(seenMessages[1].content[0].text).toBe("First response");
		expect(seenMessages[2].role).toBe("user");
		expect(seenMessages[2].content[0].text).toBe("Second prompt");
	});

	it("closes owned resources idempotently", async () => {
		let closes = 0;
		const harness = new SolistHarness({
			model: fakeModel,
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistant([{ type: "text", text: "done" }]),
					});
				});
				return stream;
			},
			disposables: [() => {
				closes += 1;
			}],
			output: { write: () => undefined },
		});

		await harness.close();
		await harness.close();

		expect(closes).toBe(1);
	});
});
