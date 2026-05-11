import { describe, expect, it } from "vitest";
import {
	isExactSolistInteractiveCommand,
	routeSolistInteractiveInput,
	SOLIST_INTERACTIVE_COMMANDS,
} from "./SolistCommandRouter.js";

const context = {
	status: {
		provider: "openai-codex",
		model: "gpt-5.5",
		thinkingLevel: "off",
		cwd: "/tmp/project",
		soloMcpAvailable: true,
		messageCount: 4,
		toolCount: 2,
	},
	tools: [
		{
			name: "read",
			label: "Read",
			description: "Read files",
			parameters: {} as any,
			async execute() {
				return { content: [], details: {} };
			},
		},
	],
};

describe("SolistCommandRouter", () => {
	it("routes supported commands before model submission", () => {
		expect(routeSolistInteractiveInput("  ", context)).toEqual({ kind: "empty" });
		expect(routeSolistInteractiveInput("/exit", context)).toEqual({ kind: "exit" });
		expect(routeSolistInteractiveInput("/clear", context)).toMatchObject({ kind: "clear" });
		expect(routeSolistInteractiveInput("/tools", context)).toMatchObject({
			kind: "render",
			message: expect.stringContaining("read"),
		});
		expect(routeSolistInteractiveInput("/status", context)).toMatchObject({
			kind: "render",
			message: expect.stringContaining("openai-codex/gpt-5.5"),
		});
	});

	it("exposes Pi-style slash command metadata", () => {
		expect(SOLIST_INTERACTIVE_COMMANDS).toEqual([
			expect.objectContaining({ name: "help", description: expect.any(String) }),
			expect.objectContaining({ name: "exit", description: expect.any(String) }),
			expect.objectContaining({ name: "clear", description: expect.any(String) }),
			expect.objectContaining({ name: "tools", description: expect.any(String) }),
			expect.objectContaining({ name: "status", description: expect.any(String) }),
			expect.objectContaining({ name: "mode", description: expect.any(String) }),
			expect.objectContaining({ name: "roles", description: expect.any(String) }),
			expect.objectContaining({ name: "role", description: expect.any(String) }),
			expect.objectContaining({ name: "role-switch", description: expect.any(String) }),
			expect.objectContaining({ name: "login", description: expect.any(String) }),
			expect.objectContaining({ name: "logout", description: expect.any(String) }),
		]);
		expect(SOLIST_INTERACTIVE_COMMANDS.map((command) => command.name)).not.toContain("quit");
		for (const command of SOLIST_INTERACTIVE_COMMANDS) {
			expect(command.name.startsWith("/")).toBe(false);
		}
	});

	it("detects exact interactive commands without stealing partial completions", () => {
		expect(isExactSolistInteractiveCommand("/exit")).toBe(true);
		expect(isExactSolistInteractiveCommand("/quit")).toBe(true);
		expect(isExactSolistInteractiveCommand("quit")).toBe(true);
		expect(isExactSolistInteractiveCommand("/status")).toBe(true);
		expect(isExactSolistInteractiveCommand("/mode")).toBe(true);
		expect(isExactSolistInteractiveCommand("/roles")).toBe(true);
		expect(isExactSolistInteractiveCommand("/role-switch")).toBe(true);
		expect(isExactSolistInteractiveCommand("/login")).toBe(true);
		expect(isExactSolistInteractiveCommand("/logout")).toBe(true);
		expect(isExactSolistInteractiveCommand("/sta")).toBe(false);
		expect(isExactSolistInteractiveCommand("/status now")).toBe(false);
		expect(isExactSolistInteractiveCommand("/role set reviewer Gemini")).toBe(false);
		expect(isExactSolistInteractiveCommand("/role-switch reviewer Gemini")).toBe(false);
		expect(isExactSolistInteractiveCommand("/login openai-codex")).toBe(false);
		expect(isExactSolistInteractiveCommand("/model")).toBe(false);
	});

	it("routes mode and role commands", () => {
		expect(routeSolistInteractiveInput("/mode", context)).toEqual({
			kind: "mode",
			mode: undefined,
			project: undefined,
		});
		expect(routeSolistInteractiveInput("/mode analysis", context)).toEqual({
			kind: "mode",
			mode: "analysis",
			project: undefined,
		});
		expect(routeSolistInteractiveInput("/mode analysis --project", context)).toEqual({
			kind: "mode",
			mode: "analysis",
			project: "current",
		});
		expect(routeSolistInteractiveInput("/roles", context)).toEqual({
			kind: "roles",
			action: "list",
			project: undefined,
		});
		expect(routeSolistInteractiveInput("/roles doctor --project=11", context)).toEqual({
			kind: "roles",
			action: "doctor",
			project: "11",
		});
		expect(routeSolistInteractiveInput("/role set reviewer Gemini", context)).toEqual({
			kind: "role",
			action: "set",
			role: "reviewer",
			agent: "Gemini",
			project: undefined,
		});
		expect(routeSolistInteractiveInput("/role unset reviewer", context)).toEqual({
			kind: "role",
			action: "unset",
			role: "reviewer",
			project: undefined,
		});
		expect(routeSolistInteractiveInput("/role switch reviewer Gemini", context)).toEqual({
			kind: "role",
			action: "switch",
			role: "reviewer",
			agent: "Gemini",
			project: undefined,
		});
		expect(routeSolistInteractiveInput("/role-switch reviewer Gemini", context)).toEqual({
			kind: "role",
			action: "switch",
			role: "reviewer",
			agent: "Gemini",
			project: undefined,
		});
		expect(routeSolistInteractiveInput("/role set --project reviewer Gemini", context)).toEqual({
			kind: "role",
			action: "set",
			role: "reviewer",
			agent: "Gemini",
			project: "current",
		});
	});

	it("routes Solist-owned auth commands", () => {
		expect(routeSolistInteractiveInput("/login", context)).toEqual({
			kind: "login",
			provider: undefined,
		});
		expect(routeSolistInteractiveInput("/logout openai-codex", context)).toEqual({
			kind: "logout",
			provider: "openai-codex",
		});
	});

	it("rejects Pi commands and shell mode at the Solist boundary", () => {
		expect(routeSolistInteractiveInput("/model", context)).toMatchObject({
			kind: "render",
			message: expect.stringContaining("outside Solist's interactive boundary"),
		});
		expect(routeSolistInteractiveInput("!git status", context)).toMatchObject({
			kind: "render",
			message: expect.stringContaining("Shell commands are not exposed"),
		});
	});

	it("passes normal input through as a prompt", () => {
		expect(routeSolistInteractiveInput("inspect todo 207", context)).toEqual({
			kind: "prompt",
			prompt: "inspect todo 207",
		});
	});
});
