import { describe, expect, it } from "vitest";
import { defaultSolistConfig, setSolistRoleBinding } from "../solistConfig.js";
import type { SoloMcpClient, SoloMcpToolCallResult } from "../soloMcpDirect.js";
import { createSolistRoleDispatchTool } from "./roleDispatchTool.js";

class FakeSoloMcpClient implements SoloMcpClient {
	readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

	async listTools() {
		return [];
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<SoloMcpToolCallResult> {
		this.calls.push({ name, args });
		if (name === "list_agent_tools") {
			return json([{ id: 7, name: "Codex High", enabled: true }]);
		}
		if (name === "spawn_process") {
			return json({ process_id: 44, name: "review-worker" });
		}
		if (name === "send_input" || name === "todo_comment_create") {
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
