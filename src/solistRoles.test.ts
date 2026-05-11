import { describe, expect, it } from "vitest";
import {
	SOLIST_ROLE_IDS,
	SOLIST_ROLES,
	formatRoleForPrompt,
	recommendImplementationRole,
	resolveSolistRoleId,
} from "./solistRoles.js";

describe("Solist roles", () => {
	it("keeps orchestration roles focused on concrete Solo work lanes", () => {
		expect(SOLIST_ROLE_IDS).toEqual([
			"code-searcher",
			"patch-worker",
			"feature-worker",
			"refactor-worker",
			"test-worker",
			"reviewer",
			"verifier",
			"docs-writer",
		]);
		expect(SOLIST_ROLE_IDS).not.toContain("external-researcher");
		expect(SOLIST_ROLE_IDS).not.toContain("design-oracle");
	});

	it("splits implementation work by complexity", () => {
		expect(SOLIST_ROLES["patch-worker"]).toMatchObject({
			posture: "implementation",
			implementationComplexity: "patch",
		});
		expect(SOLIST_ROLES["feature-worker"]).toMatchObject({
			posture: "implementation",
			implementationComplexity: "feature",
		});
		expect(SOLIST_ROLES["refactor-worker"]).toMatchObject({
			posture: "implementation",
			implementationComplexity: "refactor",
		});
	});

	it("resolves aliases and formats prompt frames", () => {
		expect(resolveSolistRoleId("implementation-worker")).toBe("feature-worker");
		expect(resolveSolistRoleId("docs")).toBe("docs-writer");
		const prompt = formatRoleForPrompt(SOLIST_ROLES["refactor-worker"]);
		expect(prompt).toContain("State invariants before editing");
		expect(prompt).toContain("Expected handoff:");
	});

	it("recommends implementation roles from blast radius signals", () => {
		expect(recommendImplementationRole({ ownedPathCount: 1 })).toBe("patch-worker");
		expect(recommendImplementationRole({ ownedPathCount: 4 })).toBe("feature-worker");
		expect(recommendImplementationRole({ touchesSharedContracts: true })).toBe("refactor-worker");
		expect(recommendImplementationRole({ changesStructure: true })).toBe("refactor-worker");
	});
});
