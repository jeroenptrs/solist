import { describe, expect, it } from "vitest";
import {
	SOLIST_DEFAULT_MODE,
	SOLIST_MODES,
	formatSolistMode,
	getSolistMode,
	isSolistModeId,
} from "./solistModes.js";

describe("Solist modes", () => {
	it("keeps orchestration as the gpt-5.5/off default", () => {
		expect(SOLIST_DEFAULT_MODE).toMatchObject({
			id: "orchestration",
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "off",
			toolProfile: "orchestration",
			canSpawnRoles: true,
		});
	});

	it("defines analysis modes with high and xhigh reasoning, full tools, and no role spawning", () => {
		expect(SOLIST_MODES.analysis).toMatchObject({
			thinkingLevel: "high",
			toolProfile: "orchestration",
			canSpawnRoles: false,
		});
		expect(SOLIST_MODES["deep-analysis"]).toMatchObject({
			thinkingLevel: "xhigh",
			toolProfile: "orchestration",
			canSpawnRoles: false,
		});
	});

	it("validates and formats mode ids", () => {
		expect(isSolistModeId("analysis")).toBe(true);
		expect(isSolistModeId("oracle")).toBe(false);
		expect(getSolistMode("bad")).toBe(SOLIST_DEFAULT_MODE);
		expect(formatSolistMode(SOLIST_MODES["deep-analysis"])).toContain("reasoning=xhigh");
	});
});
