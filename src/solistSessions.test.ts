import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createSolistSession,
	deriveSessionTitle,
	getLatestSolistSession,
	listSolistSessions,
	readSolistSession,
	stripSessionRoleOverrideContext,
	updateSolistSession,
	writeSolistSession,
} from "./solistSessions.js";

describe("Solist sessions", () => {
	it("creates, writes, lists, and reads session snapshots", () => {
		const dir = mkdtempSync(join(tmpdir(), "solist-sessions-test-"));
		const messages = [
			{ role: "user", content: [{ type: "text", text: "Plan the work" }], timestamp: 1 },
		] satisfies AgentMessage[];
		const session = createSolistSession({
			cwd: "/tmp/project",
			projectId: 11,
			modeId: "analysis",
			messages,
		});

		writeSolistSession(session, dir);

		expect(listSolistSessions(dir)).toHaveLength(1);
		expect(getLatestSolistSession(dir)?.id).toBe(session.id);
		expect(readSolistSession(session.id, dir)).toMatchObject({
			id: session.id,
			title: "Plan the work",
			cwd: "/tmp/project",
			projectId: 11,
			modeId: "analysis",
			messages,
		});
	});

	it("updates title, mode, and messages from the stored transcript", () => {
		const initial = createSolistSession({
			cwd: "/tmp/project",
			modeId: "orchestration",
			title: "Initial",
		});
		const messages = [
			{ role: "user", content: [{ type: "text", text: "Resume this plan" }], timestamp: 1 },
		] satisfies AgentMessage[];

		const updated = updateSolistSession(initial, {
			messages,
			modeId: "deep-analysis",
		});

		expect(updated.title).toBe("Resume this plan");
		expect(updated.modeId).toBe("deep-analysis");
		expect(updated.messages).toEqual(messages);
	});

	it("derives a stable fallback title when no user text exists", () => {
		expect(deriveSessionTitle([], "Fallback")).toBe("Fallback");
	});

	it("returns undefined for malformed direct session reads", () => {
		const dir = mkdtempSync(join(tmpdir(), "solist-sessions-test-"));
		writeFileSync(join(dir, "broken.json"), "{not json", "utf8");

		expect(readSolistSession("broken", dir)).toBeUndefined();
		expect(listSolistSessions(dir)).toEqual([]);
	});

	it("strips internal role override context before deriving or storing user text", () => {
		const pollutedText = [
			"Session role overrides for this Solist process:",
			"- reviewer -> 7 (Codex High)",
			"",
			"Review the current patch",
		].join("\n");
		const messages = [
			{ role: "user", content: [{ type: "text", text: pollutedText }], timestamp: 1 },
		] satisfies AgentMessage[];
		const session = createSolistSession({ cwd: "/tmp/project", messages });
		const dir = mkdtempSync(join(tmpdir(), "solist-sessions-test-"));

		writeSolistSession(session, dir);

		expect(stripSessionRoleOverrideContext(pollutedText)).toBe("Review the current patch");
		expect(readSolistSession(session.id, dir)?.title).toBe("Review the current patch");
		expect(readSolistSession(session.id, dir)?.messages[0]).toMatchObject({
			content: [{ text: "Review the current patch" }],
		});
	});
});
