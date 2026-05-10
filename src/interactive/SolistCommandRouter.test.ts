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
		expect(isExactSolistInteractiveCommand("/login")).toBe(true);
		expect(isExactSolistInteractiveCommand("/logout")).toBe(true);
		expect(isExactSolistInteractiveCommand("/sta")).toBe(false);
		expect(isExactSolistInteractiveCommand("/status now")).toBe(false);
		expect(isExactSolistInteractiveCommand("/login openai-codex")).toBe(false);
		expect(isExactSolistInteractiveCommand("/model")).toBe(false);
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
