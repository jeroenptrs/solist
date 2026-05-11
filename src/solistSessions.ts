import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSolistSessionsDir } from "./solistPaths.js";
import { getSolistMode, type SolistModeId } from "./solistModes.js";

export const SOLIST_SESSION_SCHEMA = "solist.session.v1";
const SESSION_ROLE_OVERRIDES_HEADER = "Session role overrides for this Solist process:";

export interface SolistSession {
	readonly schema: typeof SOLIST_SESSION_SCHEMA;
	readonly id: string;
	readonly title: string;
	readonly cwd: string;
	readonly projectId?: number | string;
	readonly modeId: SolistModeId;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messages: readonly AgentMessage[];
}

export interface CreateSolistSessionInput {
	readonly cwd: string;
	readonly projectId?: number | string;
	readonly modeId?: SolistModeId;
	readonly messages?: readonly AgentMessage[];
	readonly title?: string;
}

export function createSolistSession(input: CreateSolistSessionInput): SolistSession {
	const now = new Date().toISOString();
	const messages = sanitizeSessionMessages(input.messages ?? []);
	return {
		schema: SOLIST_SESSION_SCHEMA,
		id: createSessionId(now),
		title: input.title ?? deriveSessionTitle(messages),
		cwd: input.cwd,
		...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
		modeId: getSolistMode(input.modeId).id,
		createdAt: now,
		updatedAt: now,
		messages,
	};
}

export function updateSolistSession(
	session: SolistSession,
	input: {
		readonly messages?: readonly AgentMessage[];
		readonly modeId?: SolistModeId;
		readonly projectId?: number | string;
		readonly title?: string;
	},
): SolistSession {
	const messages = sanitizeSessionMessages(input.messages ?? session.messages);
	return {
		...session,
		...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
		modeId: getSolistMode(input.modeId ?? session.modeId).id,
		title: input.title ?? deriveSessionTitle(messages, session.title),
		updatedAt: new Date().toISOString(),
		messages,
	};
}

export function writeSolistSession(
	session: SolistSession,
	dir = getSolistSessionsDir(),
): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const normalized = normalizeSolistSession(session);
	const path = getSolistSessionPath(normalized.id, dir);
	const tmpPath = `${path}.tmp-${process.pid}`;
	writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tmpPath, path);
}

export function readSolistSession(
	id: string,
	dir = getSolistSessionsDir(),
): SolistSession | undefined {
	const safeId = sanitizeSessionId(id);
	if (!safeId) {
		return undefined;
	}
	const path = getSolistSessionPath(safeId, dir);
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		return normalizeSolistSession(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

export function listSolistSessions(
	dir = getSolistSessionsDir(),
	limit = 20,
): SolistSession[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.flatMap((name) => {
			try {
				return [normalizeSolistSession(JSON.parse(readFileSync(join(dir, name), "utf8")))];
			} catch {
				return [];
			}
		})
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
		.slice(0, limit);
}

export function getLatestSolistSession(
	dir = getSolistSessionsDir(),
): SolistSession | undefined {
	return listSolistSessions(dir, 1)[0];
}

export function getSolistSessionPath(id: string, dir = getSolistSessionsDir()): string {
	const safeId = sanitizeSessionId(id);
	if (!safeId) {
		throw new Error(`Invalid Solist session id "${id}".`);
	}
	return join(dir, `${safeId}.json`);
}

export function deriveSessionTitle(
	messages: readonly AgentMessage[],
	fallback = "Untitled Solist session",
): string {
	for (const message of messages) {
		if (message.role !== "user") {
			continue;
		}
		const text = stripSessionRoleOverrideContext(extractMessageText(message)).replace(/\s+/g, " ").trim();
		if (text) {
			return text.length > 80 ? `${text.slice(0, 77)}...` : text;
		}
	}
	return fallback;
}

export function stripSessionRoleOverrideContext(text: string): string {
	if (!text.startsWith(SESSION_ROLE_OVERRIDES_HEADER)) {
		return text;
	}
	const lines = text.split("\n");
	const separatorIndex = lines.findIndex((line, index) =>
		index > 0 && line.trim() === ""
	);
	if (separatorIndex < 0) {
		return "";
	}
	return lines.slice(separatorIndex + 1).join("\n");
}

function normalizeSolistSession(value: unknown): SolistSession {
	if (!isRecord(value)) {
		throw new Error("Invalid Solist session file.");
	}
	const id = typeof value.id === "string" && sanitizeSessionId(value.id)
		? value.id
		: createSessionId(new Date().toISOString());
	const messages = Array.isArray(value.messages)
		? sanitizeSessionMessages(value.messages.filter(isRecord) as unknown as AgentMessage[])
		: [];
	const modeId = typeof value.modeId === "string" ? getSolistMode(value.modeId).id : "orchestration";
	const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();
	const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
	const title = typeof value.title === "string" && value.title.trim()
		? value.title.trim()
		: deriveSessionTitle(messages);
	const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : process.cwd();
	const projectId = typeof value.projectId === "number" || typeof value.projectId === "string"
		? value.projectId
		: undefined;
	return {
		schema: SOLIST_SESSION_SCHEMA,
		id,
		title,
		cwd,
		...(projectId !== undefined ? { projectId } : {}),
		modeId,
		createdAt,
		updatedAt,
		messages,
	};
}

function sanitizeSessionMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => {
		if (message.role !== "user" || !("content" in message)) {
			return message;
		}
		const content = message.content;
		if (typeof content === "string") {
			return { ...message, content: stripSessionRoleOverrideContext(content) };
		}
		if (!Array.isArray(content)) {
			return message;
		}
		let stripped = false;
		const nextContent = content.map((item) => {
			if (!stripped && isRecord(item) && item.type === "text" && typeof item.text === "string") {
				stripped = true;
				return { ...item, text: stripSessionRoleOverrideContext(item.text) };
			}
			return item;
		});
		return { ...message, content: nextContent };
	});
}

function createSessionId(nowIso: string): string {
	const timestamp = nowIso.replace(/[-:.TZ]/g, "").slice(0, 14);
	return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function sanitizeSessionId(id: string): string | undefined {
	const trimmed = id.trim();
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed) ? trimmed : undefined;
}

function extractMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((item) =>
		isRecord(item) && item.type === "text" && typeof item.text === "string"
			? [item.text]
			: []
	).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
