import { describe, expect, it } from "vitest";
import { defaultSolistConfig, setSolistRoleBinding, setSolistRoleBindings } from "../solistConfig.js";
import type { SoloMcpClient, SoloMcpToolCallResult } from "../soloMcpDirect.js";
import { createSolistRoleDispatchTool } from "./roleDispatchTool.js";

class FakeSoloMcpClient implements SoloMcpClient {
	readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	private spawnCount = 0;

	constructor(
		private readonly agentTools = [{ id: 7, name: "Codex High", enabled: true }],
		private readonly failSpawnAt?: number,
	) {}

	async listTools() {
		return [];
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<SoloMcpToolCallResult> {
		this.calls.push({ name, args });
		if (name === "list_agent_tools") {
			return json(this.agentTools);
		}
		if (name === "spawn_process") {
			this.spawnCount += 1;
			if (this.failSpawnAt === this.spawnCount) {
				throw new Error(`spawn failed at ${this.spawnCount}`);
			}
			return json({ process_id: 43 + this.spawnCount, name: `review-worker-${this.spawnCount}` });
		}
		if (name === "send_input" || name === "todo_comment_create" || name === "close_process") {
			return json({ ok: true, todo_id: args.todo_id });
		}
		throw new Error(`Unexpected tool ${name}`);
	}
}

describe("createSolistRoleDispatchTool", () => {
	it("spawns a configured Solo role and records the assignment on the todo", async () => {
		const client = new FakeSoloMcpClient();
		const config = setSolistRoleBinding(defaultSolistConfig(), "reviewer", {
			agentToolId: 7,
			lastKnownName: "Codex High",
		});
		const tool = createSolistRoleDispatchTool(client, {
			configReader: () => config,
			projectId: 11,
		});

		const result = await tool.execute("call-1", {
			role_id: "reviewer",
			objective: "Review the patch for regressions",
			scratchpad_uri: "solo://proj/11/scratchpad/plan--1",
			todo_id: 123,
			todo_uri: "solo://proj/11/todo/123",
			todo_title: "Review patch",
			ownership_boundaries: ["src/review.ts"],
			expected_handoff: ["Findings with file references"],
		});

		expect(firstText(result)).toContain("Solist role dispatch spawned");
		expect(client.calls.map((call) => call.name)).toEqual([
			"list_agent_tools",
			"spawn_process",
			"send_input",
			"todo_comment_create",
		]);
		expect(client.calls[1]?.args).toMatchObject({
			kind: "agent",
			agent_tool_id: 7,
			include_agent_instructions: false,
		});
		expect(client.calls[2]?.args).toMatchObject({
			process_id: 44,
		});
		expect(String(client.calls[2]?.args.input)).toContain("Role: reviewer");
		expect(client.calls[3]?.args).toMatchObject({
			todo_id: 123,
			body: expect.stringContaining("role=reviewer"),
		});
	});

	it("spawns one Solo agent by default when multiple agents are mapped to a role", async () => {
		const client = new FakeSoloMcpClient([
			{ id: 7, name: "Codex High", enabled: true },
			{ id: 9, name: "Gemini", enabled: true },
		]);
		const config = setSolistRoleBindings(defaultSolistConfig(), "reviewer", [
			{ agentToolId: 7, lastKnownName: "Codex High" },
			{ agentToolId: 9, lastKnownName: "Gemini" },
		]);
		const tool = createSolistRoleDispatchTool(client, {
			configReader: () => config,
			projectId: 11,
		});

		const result = await tool.execute("call-1", {
			role_id: "reviewer",
			objective: "Review the patch for regressions",
			scratchpad_uri: "solo://proj/11/scratchpad/plan--1",
			todo_id: 123,
			todo_title: "Review patch",
			worker_name: "reviewer",
		});

		expect(firstText(result)).toContain("Agent tools: 7 (Codex High)");
		expect(firstText(result)).not.toContain("9 (Gemini)");
		expect(client.calls.filter((call) => call.name === "spawn_process").map((call) => call.args.agent_tool_id)).toEqual([7]);
		expect(client.calls.filter((call) => call.name === "send_input")).toHaveLength(1);
		expect(client.calls.at(-1)?.args.body).not.toEqual(expect.stringContaining("runtime=9 (Gemini)"));
	});

	it("spawns every Solo agent mapped to a role when explicitly requested", async () => {
		const client = new FakeSoloMcpClient([
			{ id: 7, name: "Codex High", enabled: true },
			{ id: 9, name: "Gemini", enabled: true },
		]);
		const config = setSolistRoleBindings(defaultSolistConfig(), "reviewer", [
			{ agentToolId: 7, lastKnownName: "Codex High" },
			{ agentToolId: 9, lastKnownName: "Gemini" },
		]);
		const tool = createSolistRoleDispatchTool(client, {
			configReader: () => config,
			projectId: 11,
		});

		const result = await tool.execute("call-1", {
			role_id: "reviewer",
			objective: "Review the patch for regressions with all reviewers",
			scratchpad_uri: "solo://proj/11/scratchpad/plan--1",
			todo_id: 123,
			todo_title: "Review patch",
			worker_name: "reviewer",
			use_all_configured_agents: true,
		});

		expect(firstText(result)).toContain("Agent tools: 7 (Codex High), 9 (Gemini)");
		expect(client.calls.filter((call) => call.name === "spawn_process").map((call) => call.args.agent_tool_id)).toEqual([7, 9]);
		expect(client.calls.filter((call) => call.name === "send_input")).toHaveLength(2);
		expect(client.calls.at(-1)?.args.body).toEqual(expect.stringContaining("runtime=9 (Gemini)"));
	});

	it("closes already spawned role processes when a later runtime spawn fails", async () => {
		const client = new FakeSoloMcpClient([
			{ id: 7, name: "Codex High", enabled: true },
			{ id: 9, name: "Gemini", enabled: true },
		], 2);
		const config = setSolistRoleBindings(defaultSolistConfig(), "reviewer", [
			{ agentToolId: 7, lastKnownName: "Codex High" },
			{ agentToolId: 9, lastKnownName: "Gemini" },
		]);
		const tool = createSolistRoleDispatchTool(client, {
			configReader: () => config,
			projectId: 11,
		});

		await expect(tool.execute("call-1", {
			role_id: "reviewer",
			objective: "Review the patch for regressions",
			scratchpad_uri: "solo://proj/11/scratchpad/plan--1",
			todo_id: 123,
			todo_title: "Review patch",
			worker_name: "reviewer",
			use_all_configured_agents: true,
		})).rejects.toThrow("spawn failed at 2");

		expect(client.calls.filter((call) => call.name === "close_process").map((call) => call.args.process_id)).toEqual([44]);
		expect(client.calls.some((call) => call.name === "todo_comment_create")).toBe(false);
	});

	it("returns decision-needed when the role has no configured Solo agent", async () => {
		const client = new FakeSoloMcpClient();
		const tool = createSolistRoleDispatchTool(client, {
			configReader: () => defaultSolistConfig(),
		});

		const result = await tool.execute("call-1", {
			role_id: "verifier",
			objective: "Verify tests",
			scratchpad_uri: "solo://proj/11/scratchpad/plan--1",
			todo_id: 123,
			todo_title: "Verify",
		});

		expect(firstText(result)).toContain("needs a Solo agent selection");
		expect(client.calls.map((call) => call.name)).toEqual(["list_agent_tools"]);
	});
});

function json(value: unknown): SoloMcpToolCallResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
	};
}

function firstText(result: { content: readonly unknown[] }): string {
	const first = result.content[0];
	return typeof first === "object" && first !== null && "text" in first
		? String(first.text)
		: "";
}
