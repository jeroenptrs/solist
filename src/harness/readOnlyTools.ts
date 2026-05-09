import { opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export const SOLIST_READ_ONLY_TOOL_NAMES = ["read", "ls", "find", "grep"] as const;

export interface SolistReadOnlyToolOptions {
	maxBytes?: number;
	maxLines?: number;
	maxEntries?: number;
}

export type SolistReadOnlyToolName = typeof SOLIST_READ_ONLY_TOOL_NAMES[number];

interface ToolContext {
	root: string;
	rootReal: string;
	limits: Required<SolistReadOnlyToolOptions>;
}

interface TextResultDetails {
	truncated: boolean;
}

const DEFAULT_LIMITS: Required<SolistReadOnlyToolOptions> = {
	maxBytes: 64 * 1024,
	maxLines: 500,
	maxEntries: 200,
};

const text = (
	output: string,
	details: TextResultDetails = { truncated: false },
): AgentToolResult<TextResultDetails> => ({
	content: [{ type: "text", text: output }],
	details,
});

export async function createSolistReadOnlyTools(
	workspaceRoot: string,
	options: SolistReadOnlyToolOptions = {},
): Promise<AgentTool[]> {
	const root = path.resolve(workspaceRoot);
	const rootReal = await realpath(root);
	const context: ToolContext = {
		root,
		rootReal,
		limits: { ...DEFAULT_LIMITS, ...options },
	};

	return [
		createReadTool(context),
		createLsTool(context),
		createFindTool(context),
		createGrepTool(context),
	];
}

function createReadTool(context: ToolContext): AgentTool {
	return {
		name: "read",
		label: "read",
		description: "Read a text file inside the workspace. Output is truncated by line and byte limits.",
		parameters: Type.Object({
			path: Type.String({ description: "Workspace-relative path to read." }),
			offset: Type.Optional(Type.Number({ description: "1-based line offset." })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return." })),
		}),
		async execute(_toolCallId, params) {
			const input = params as { path: string; offset?: number; limit?: number };
			const target = await resolveContainedPath(context, input.path);
			const fileStat = await stat(target);
			if (!fileStat.isFile()) throw new Error(`Not a file: ${input.path}`);

			const buffer = await readFile(target);
			if (isBinaryish(buffer)) {
				return text(`[Binary or non-UTF-8 file omitted: ${displayPath(context, target)}]`);
			}

			const allLines = buffer.toString("utf8").split("\n");
			const offset = Math.max(1, Math.floor(input.offset ?? 1));
			if (offset > allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines)`);
			}
			const requestedLimit = input.limit === undefined
				? undefined
				: Math.max(0, Math.floor(input.limit));
			const selected = allLines.slice(
				offset - 1,
				requestedLimit === undefined ? undefined : offset - 1 + requestedLimit,
			);
			return truncateLines(selected, context.limits, offset);
		},
	};
}

function createLsTool(context: ToolContext): AgentTool {
	return {
		name: "ls",
		label: "ls",
		description: "List directory entries inside the workspace.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Workspace-relative directory path." })),
		}),
		async execute(_toolCallId, params) {
			const input = params as { path?: string };
			const target = await resolveContainedPath(context, input.path ?? ".");
			const dirStat = await stat(target);
			if (!dirStat.isDirectory()) throw new Error(`Not a directory: ${input.path ?? "."}`);

			const entries = await readDirectoryEntries(target);
			const lines = entries
				.slice(0, context.limits.maxEntries)
				.map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
			if (entries.length > context.limits.maxEntries) {
				lines.push(`[truncated: ${entries.length - context.limits.maxEntries} more entries]`);
			}
			return text(lines.join("\n"), { truncated: entries.length > context.limits.maxEntries });
		},
	};
}

function createFindTool(context: ToolContext): AgentTool {
	return {
		name: "find",
		label: "find",
		description: "Find workspace paths whose relative path contains a query string.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Case-insensitive substring to match." })),
			path: Type.Optional(Type.String({ description: "Workspace-relative directory path." })),
		}),
		async execute(_toolCallId, params) {
			const input = params as { query?: string; path?: string };
			const start = await resolveContainedPath(context, input.path ?? ".");
			const matches: string[] = [];
			const query = (input.query ?? "").toLowerCase();
			const truncated = await walk(context, start, (entryPath) => {
				const relative = displayPath(context, entryPath);
				if (!query || relative.toLowerCase().includes(query)) {
					matches.push(relative);
				}
				return matches.length < context.limits.maxEntries;
			});
			if (truncated) matches.push("[truncated: result limit reached]");
			return text(matches.join("\n"), { truncated });
		},
	};
}

function createGrepTool(context: ToolContext): AgentTool {
	return {
		name: "grep",
		label: "grep",
		description: "Search text files inside the workspace. Does not execute a shell.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Case-sensitive plain-text pattern." }),
			path: Type.Optional(Type.String({ description: "Workspace-relative file or directory path." })),
		}),
		async execute(_toolCallId, params) {
			const input = params as { pattern: string; path?: string };
			if (!input.pattern) throw new Error("pattern is required");
			const start = await resolveContainedPath(context, input.path ?? ".");
			const matches: string[] = [];
			const truncated = await walk(context, start, async (entryPath, entry) => {
				if (entry && !entry.isFile()) return true;
				const fileStat = await stat(entryPath);
				if (!fileStat.isFile()) return true;
				const buffer = await readFile(entryPath);
				if (isBinaryish(buffer)) return true;
				const lines = buffer.toString("utf8").split("\n");
				for (let index = 0; index < lines.length; index += 1) {
					if (lines[index]?.includes(input.pattern)) {
						matches.push(`${displayPath(context, entryPath)}:${index + 1}:${lines[index]}`);
						if (matches.length >= context.limits.maxEntries) return false;
					}
				}
				return true;
			});
			if (truncated) matches.push("[truncated: result limit reached]");
			const result = truncateLines(matches, context.limits, 1);
			return {
				...result,
				details: { truncated: truncated || result.details.truncated },
			};
		},
	};
}

async function resolveContainedPath(context: ToolContext, inputPath: string): Promise<string> {
	if (inputPath.includes("\0")) throw new Error("Path contains a null byte");
	const absolute = path.resolve(context.root, inputPath);
	const resolved = await realpath(absolute);
	if (resolved !== context.rootReal && !resolved.startsWith(`${context.rootReal}${path.sep}`)) {
		throw new Error(`Path is outside workspace: ${inputPath}`);
	}
	return resolved;
}

async function readDirectoryEntries(directory: string): Promise<Dirent[]> {
	const entries: Dirent[] = [];
	const handle = await opendir(directory);
	for await (const entry of handle) entries.push(entry);
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function walk(
	context: ToolContext,
	start: string,
	visit: (entryPath: string, entry?: Dirent) => boolean | Promise<boolean>,
): Promise<boolean> {
	const startStat = await stat(start);
	if (startStat.isFile()) return !(await visit(start));
	if (!startStat.isDirectory()) throw new Error(`Not a file or directory: ${displayPath(context, start)}`);

	const entries = await readDirectoryEntries(start);
	for (const entry of entries) {
		const entryPath = path.join(start, entry.name);
		const resolved = await resolveContainedPath(context, path.relative(context.rootReal, entryPath));
		const shouldContinue = await visit(resolved, entry);
		if (!shouldContinue) return true;
		if (entry.isDirectory()) {
			const truncated = await walk(context, resolved, visit);
			if (truncated) return true;
		}
	}
	return false;
}

function displayPath(context: ToolContext, absolutePath: string): string {
	const relative = path.relative(context.rootReal, absolutePath);
	return relative === "" ? "." : relative;
}

function truncateLines(
	lines: string[],
	limits: Required<SolistReadOnlyToolOptions>,
	startLine: number,
): AgentToolResult<TextResultDetails> {
	const output: string[] = [];
	let bytes = 0;
	let truncated = false;
	for (let index = 0; index < lines.length && output.length < limits.maxLines; index += 1) {
		const line = lines[index] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + lineBytes > limits.maxBytes) {
			truncated = true;
			break;
		}
		bytes += lineBytes;
		output.push(line);
	}
	if (output.length < lines.length) truncated = true;
	if (truncated) {
		output.push(`[truncated after line ${startLine + Math.max(0, output.length - 1)}]`);
	}
	return {
		content: [{ type: "text", text: output.join("\n") }],
		details: { truncated },
	};
}

function isBinaryish(buffer: Buffer): boolean {
	if (buffer.length === 0) return false;
	const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
	if (sample.includes(0)) return true;
	return sample.toString("utf8").includes("\uFFFD");
}
