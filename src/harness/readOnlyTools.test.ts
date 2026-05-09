import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createSolistReadOnlyTools,
	SOLIST_READ_ONLY_TOOL_NAMES,
} from "./readOnlyTools.js";

let tmp: string;
let tools: AgentTool[];

beforeEach(async () => {
	tmp = await mkdtemp(path.join(os.tmpdir(), "solist-readonly-"));
	await mkdir(path.join(tmp, "src"));
	await writeFile(path.join(tmp, "src", "app.ts"), "alpha\nbeta\nalpha beta\n");
	await writeFile(path.join(tmp, "notes.txt"), "short\n");
	tools = await createSolistReadOnlyTools(tmp, {
		maxBytes: 32,
		maxLines: 2,
		maxEntries: 2,
	});
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("createSolistReadOnlyTools", () => {
	it("exposes only read, ls, find, and grep", () => {
		expect(tools.map((tool) => tool.name)).toEqual([...SOLIST_READ_ONLY_TOOL_NAMES]);
		expect(tools.some((tool) => ["bash", "write", "edit"].includes(tool.name))).toBe(false);
	});

	it("reads workspace files and truncates output by configured limits", async () => {
		await writeFile(path.join(tmp, "long.txt"), "one\ntwo\nthree\n");
		const result = await getTool("read").execute("call-1", { path: "long.txt" });

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "one\ntwo\n[truncated after line 2]",
		});
		expect(result.details).toEqual({ truncated: true });
	});

	it("rejects missing files", async () => {
		await expect(
			getTool("read").execute("call-1", { path: "missing.txt" }),
		).rejects.toThrow();
	});

	it("rejects parent traversal outside the workspace", async () => {
		await expect(
			getTool("read").execute("call-1", { path: "../outside.txt" }),
		).rejects.toThrow(/outside workspace|ENOENT/);
	});

	it("rejects symlinks that resolve outside the workspace", async () => {
		const outside = await mkdtemp(path.join(os.tmpdir(), "solist-outside-"));
		try {
			await writeFile(path.join(outside, "secret.txt"), "secret\n");
			await symlink(path.join(outside, "secret.txt"), path.join(tmp, "secret-link"));

			await expect(
				getTool("read").execute("call-1", { path: "secret-link" }),
			).rejects.toThrow(/outside workspace/);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("omits binary-ish file contents", async () => {
		await writeFile(path.join(tmp, "data.bin"), Buffer.from([0, 1, 2, 3]));
		const result = await getTool("read").execute("call-1", { path: "data.bin" });

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "[Binary or non-UTF-8 file omitted: data.bin]",
		});
	});

	it("lists and truncates directory entries", async () => {
		await writeFile(path.join(tmp, "extra.txt"), "extra\n");
		const result = await getTool("ls").execute("call-1", { path: "." });
		const output = textContent(result);

		expect(output.split("\n")).toHaveLength(3);
		expect(output).toContain("[truncated:");
		expect(result.details.truncated).toBe(true);
	});

	it("finds paths without shell execution and truncates matches", async () => {
		await writeFile(path.join(tmp, "src", "another-app.ts"), "");
		const result = await getTool("find").execute("call-1", { query: "app" });
		const output = textContent(result);

		expect(output).toContain("src/another-app.ts");
		expect(output).toContain("[truncated: result limit reached]");
		expect(result.details.truncated).toBe(true);
	});

	it("greps text files, skips binary-ish files, and truncates matches", async () => {
		await writeFile(path.join(tmp, "binary.txt"), Buffer.from([0, 97, 108, 112, 104, 97]));
		const result = await getTool("grep").execute("call-1", { pattern: "alpha" });
		const output = textContent(result);

		expect(output).toContain("src/app.ts:1:alpha");
		expect(output).not.toContain("binary.txt");
		expect(output).toContain("[truncated");
		expect(result.details.truncated).toBe(true);
	});
});

function getTool(name: string): AgentTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool;
}

function textContent(result: Awaited<ReturnType<AgentTool["execute"]>>): string {
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("Expected text result");
	return content.text;
}

it("documents the Solist-owned implementation path", async () => {
	const source = await readFile(new URL("./readOnlyTools.ts", import.meta.url), "utf8");

	expect(source).toContain("createSolistReadOnlyTools");
	expect(source).not.toContain("@earendil-works/pi-coding-agent");
	expect(source).not.toContain("child_process");
});
