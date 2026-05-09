import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildPiArgs,
	getHelpText,
	isInteractiveExitCommand,
	isCliEntrypoint,
	shouldUseLegacyWrapper,
	shouldUseHarness,
	stripRuntimeSelectorArgs,
} from "./cli.js";
import {
	buildSolistSystemPrompt,
	SOLIST_MODEL_ID,
	SOLIST_MODEL_PATTERN,
	SOLIST_MODEL_PROVIDER,
	SOLIST_ALLOWED_TOOLS,
	SOLIST_THINKING_LEVEL,
} from "./solistPrompt.js";
import { SOLIST_HARDENING_FLAGS } from "./orchestratorPolicy.js";

describe("Solist scaffold constants", () => {
	it("pins the requested model and reasoning level", () => {
		expect(SOLIST_MODEL_PATTERN).toBe("openai-codex/gpt-5.5");
		expect(SOLIST_THINKING_LEVEL).toBe("off");
	});

	it("keeps the initial orchestrator tool surface constrained", () => {
		expect(SOLIST_ALLOWED_TOOLS).toEqual(["read", "grep", "find", "ls", "mcp"]);
	});

	it("tells the orchestrator not to implement directly", () => {
		expect(buildSolistSystemPrompt()).toContain(
			"Do not edit repository files directly.",
		);
		expect(buildSolistSystemPrompt()).toContain(
			"Do not implement code yourself.",
		);
		expect(buildSolistSystemPrompt()).toContain(
			"Do not satisfy direct implementation requests by writing code, patches, or file changes yourself.",
		);
		expect(buildSolistSystemPrompt()).toContain(
			"refuse the direct implementation path briefly",
		);
	});

	it("states Solo-only MCP exposure", () => {
		const prompt = buildSolistSystemPrompt(["solo"]);
		expect(prompt).toContain("Tool boundary:");
		expect(prompt).toContain("Solo MCP is an explicit orchestration surface");
		expect(prompt).toContain("solo_mcp_<operation>");
		expect(prompt).toContain("Solist limits MCP exposure to the solo MCP server only; it does not hide Solo MCP from you.");
		expect(prompt).toContain("Do not use or request non-Solo MCP servers");
		expect(prompt).toContain("solo");
	});

	it("matches the feature-flagged harness tool boundary", () => {
		const prompt = buildSolistSystemPrompt(["solo"]);
		expect(prompt).toContain("Local inspection tools are read, ls, find, and grep. They are read-only.");
		expect(prompt).toContain("Use explicit Solo MCP wrapper tools for scratchpads, todos, comments, blockers, timers, worker processes, and process output.");
		expect(prompt).toContain("Do not use or request non-Solo MCP servers, shell commands, write tools, patch tools, browser tools, or generic MCP proxies.");
		expect(prompt).not.toMatch(/\bPi\b/);
	});

	it("requires verification, blocker tracking, and worker handoff evidence", () => {
		const prompt = buildSolistSystemPrompt(["solo"]);
		expect(prompt).toContain("Worker handoffs must include the objective, relevant Solo todo or scratchpad links, owned files or scope, constraints, expected evidence, and verification commands.");
		expect(prompt).toContain("Do not mark work complete until worker evidence and verification evidence are recorded in Solo state.");
		expect(prompt).toContain("Verification evidence must include commands run, results, and any skipped checks with reasons.");
		expect(prompt).toContain("If blocked, record the blocker in Solo state");
	});

	it("keeps the help text on the combined provider/model slug", () => {
		expect(getHelpText()).toContain("openai-codex/gpt-5.5");
	});

	it("documents the harness default and explicit legacy fallback in help", () => {
		expect(getHelpText()).toContain("solist              Start an interactive Solist orchestration chat");
		expect(getHelpText()).toContain("solist <prompt>     Send an initial prompt, then continue interactive chat");
		expect(getHelpText()).toContain("Validate model auth, Solo MCP reachability, and harness tool boundary");
		expect(getHelpText()).toContain("solist --legacy-wrapper");
		expect(getHelpText()).toContain("The default path does not call the Pi coding-agent main() wrapper");
	});

	it("recognizes interactive chat exit commands", () => {
		expect(isInteractiveExitCommand("/exit")).toBe(true);
		expect(isInteractiveExitCommand(" /QUIT ")).toBe(true);
		expect(isInteractiveExitCommand("exit")).toBe(true);
		expect(isInteractiveExitCommand("quit")).toBe(true);
		expect(isInteractiveExitCommand("continue")).toBe(false);
		expect(isInteractiveExitCommand("/help")).toBe(false);
	});

	it("uses the harness by default and keeps legacy wrapper explicit", () => {
		expect(shouldUseHarness([], {})).toBe(true);
		expect(shouldUseHarness(["--harness"], {})).toBe(true);
		expect(shouldUseHarness([], { SOLIST_HARNESS: "1" })).toBe(true);
		expect(shouldUseHarness(["--legacy-wrapper"], {})).toBe(false);
		expect(shouldUseLegacyWrapper(["--legacy-wrapper"], {})).toBe(true);
		expect(shouldUseLegacyWrapper([], { SOLIST_LEGACY_WRAPPER: "1" })).toBe(true);
		expect(shouldUseLegacyWrapper([], {})).toBe(false);
		expect(stripRuntimeSelectorArgs(["--harness", "--legacy-wrapper", "inspect", "todo"])).toEqual(["inspect", "todo"]);
	});

	it("keeps Pi coding-agent main behind the explicit legacy dynamic import", () => {
		const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
		expect(source).not.toContain('import { main as piMain } from "@earendil-works/pi-coding-agent"');
		expect(source).toContain('await import("@earendil-works/pi-coding-agent")');
		expect(source).toContain("shouldUseLegacyWrapper(args)");
	});

	it("passes Pi provider/model/tools args and hardening controls", () => {
		expect(buildPiArgs(["--foo", "bar"], ["solo"], "/tmp/solist-mcp.json")).toEqual([
			"--provider",
			SOLIST_MODEL_PROVIDER,
			"--model",
			SOLIST_MODEL_ID,
			"--thinking",
			SOLIST_THINKING_LEVEL,
			"--tools",
			SOLIST_ALLOWED_TOOLS.join(","),
			"--system-prompt",
			buildSolistSystemPrompt(["solo"]),
			...SOLIST_HARDENING_FLAGS,
			"--mcp-config",
			"/tmp/solist-mcp.json",
			"--foo",
			"bar",
		]);
	});

	it("recognizes npm-linked bin symlinks as the CLI entrypoint", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "solist-cli-test-"));
		const target = join(tempDir, "cli.js");
		const link = join(tempDir, "solist");

		writeFileSync(target, "#!/usr/bin/env node\n");
		symlinkSync(target, link);

		expect(isCliEntrypoint(pathToFileURL(target).href, link)).toBe(true);
	});

	it("does not treat a different file as the CLI entrypoint", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "solist-cli-test-"));
		const modulePath = join(tempDir, "cli.js");
		const otherPath = join(tempDir, "other.js");

		writeFileSync(modulePath, "#!/usr/bin/env node\n");
		writeFileSync(otherPath, "#!/usr/bin/env node\n");

		expect(
			isCliEntrypoint(pathToFileURL(modulePath).href, resolve(otherPath)),
		).toBe(false);
	});
});
