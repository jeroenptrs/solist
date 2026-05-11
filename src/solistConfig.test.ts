import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bindingForAgentTool,
	defaultSolistConfig,
	getConfiguredSolistMode,
	readSolistConfig,
	resolveAgentToolSelection,
	resolveRoleBinding,
	setSolistActiveMode,
	setSolistRoleBinding,
	unsetSolistRoleBinding,
	writeSolistConfig,
} from "./solistConfig.js";

describe("Solist config", () => {
	it("defaults to orchestration mode with no role bindings", () => {
		const config = defaultSolistConfig();
		expect(config.activeMode).toBe("orchestration");
		expect(config.roleBindings).toEqual({});
		expect(getConfiguredSolistMode(config)).toBe("orchestration");
	});

	it("round-trips normalized config through disk", () => {
		const path = join(mkdtempSync(join(tmpdir(), "solist-config-test-")), "config.json");
		const config = setSolistRoleBinding(
			setSolistActiveMode(defaultSolistConfig(), "analysis"),
			"reviewer",
			{ agentToolId: 1, lastKnownName: "Gemini" },
		);

		writeSolistConfig(config, path);

		expect(readSolistConfig(path)).toMatchObject({
			schema: "solist.config.v1",
			activeMode: "analysis",
			roleBindings: {
				reviewer: { agentToolId: 1, lastKnownName: "Gemini" },
			},
		});
		expect(readFileSync(path, "utf8")).toContain("\"activeMode\": \"analysis\"");
	});

	it("treats an empty config file as default config", () => {
		const path = join(mkdtempSync(join(tmpdir(), "solist-config-test-")), "config.json");
		writeFileSync(path, "", "utf8");

		expect(readSolistConfig(path)).toEqual(defaultSolistConfig());
	});

	it("ignores unknown modes and roles while preserving valid project overrides", () => {
		const path = join(mkdtempSync(join(tmpdir(), "solist-config-test-")), "config.json");
		writeFileSync(path, JSON.stringify({
			activeMode: "oracle",
			roleBindings: {
				"design-oracle": { agentToolId: 5 },
				"patch-worker": { agentToolId: 4 },
			},
			projectOverrides: {
				"11": {
					activeMode: "deep-analysis",
					roleBindings: {
						"feature-worker": { agentToolName: "Codex High" },
					},
				},
			},
		}), "utf8");

		const config = readSolistConfig(path);

		expect(config.activeMode).toBe("orchestration");
		expect(config.roleBindings).toEqual({ "patch-worker": { agentToolId: 4 } });
		expect(getConfiguredSolistMode(config, 11)).toBe("deep-analysis");
		expect(config.projectOverrides["11"]?.roleBindings).toEqual({
			"feature-worker": { agentToolName: "Codex High" },
		});
	});

	it("resolves role bindings by session, project, then global scope", () => {
		const tools = [
			{ id: 4, name: "Codex", enabled: true },
			{ id: 27, name: "Codex High", enabled: true },
		];
		const config = setSolistRoleBinding(
			setSolistRoleBinding(defaultSolistConfig(), "patch-worker", { agentToolId: 4 }),
			"patch-worker",
			{ agentToolId: 27 },
			11,
		);

		expect(resolveRoleBinding({
			roleId: "patch-worker",
			config,
			projectId: 11,
			availableAgentTools: tools,
		})).toMatchObject({
			status: "selected",
			source: "project",
			agentTool: { id: 27 },
		});
		expect(resolveRoleBinding({
			roleId: "patch-worker",
			config,
			projectId: 11,
			availableAgentTools: tools,
			sessionOverrides: { "patch-worker": { agentToolId: 4 } },
		})).toMatchObject({
			status: "selected",
			source: "session",
			agentTool: { id: 4 },
		});
	});

	it("returns decision-needed for missing or stale bindings", () => {
		const config = setSolistRoleBinding(defaultSolistConfig(), "reviewer", { agentToolId: 99 });
		expect(resolveRoleBinding({
			roleId: "reviewer",
			config,
			availableAgentTools: [{ id: 1, name: "Gemini", enabled: true }],
		})).toMatchObject({
			status: "decision-needed",
			reason: expect.stringContaining("does not match"),
		});
		expect(resolveRoleBinding({
			roleId: "verifier",
			config,
			availableAgentTools: [{ id: 1, name: "Gemini", enabled: true }],
		})).toMatchObject({
			status: "decision-needed",
			reason: expect.stringContaining("No Solo agent tool is configured"),
		});
	});

	it("sets, unsets, and creates bindings from Solo agent tools", () => {
		const tool = { id: 27, name: "Codex High", enabled: true };
		const config = setSolistRoleBinding(defaultSolistConfig(), "verifier", bindingForAgentTool(tool));

		expect(config.roleBindings.verifier).toEqual({
			agentToolId: 27,
			lastKnownName: "Codex High",
		});
		expect(unsetSolistRoleBinding(config, "verifier").roleBindings.verifier).toBeUndefined();
		expect(resolveAgentToolSelection("27", [tool])).toEqual(tool);
		expect(resolveAgentToolSelection("codex high", [tool])).toEqual(tool);
		expect(resolveAgentToolSelection("\"Codex High\"", [tool])).toEqual(tool);
	});
});
