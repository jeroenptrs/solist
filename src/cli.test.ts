import { describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPiArgs, getHelpText, isCliEntrypoint } from "./cli.js";
import {
	buildSolistSystemPrompt,
	SOLIST_MODEL_ID,
	SOLIST_MODEL_PATTERN,
	SOLIST_MODEL_PROVIDER,
	SOLIST_ALLOWED_TOOLS,
	SOLIST_THINKING_LEVEL,
} from "./solistPrompt.js";

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
	});

	it("states Solo-only MCP exposure", () => {
		const prompt = buildSolistSystemPrompt(["solo"]);
		expect(prompt).toContain("Solo MCP boundary:");
		expect(prompt).toContain("solo");
	});

	it("keeps the help text on the combined provider/model slug", () => {
		expect(getHelpText()).toContain("openai-codex/gpt-5.5");
	});

	it("passes Pi separate provider and model args", () => {
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
