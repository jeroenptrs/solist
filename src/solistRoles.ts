export const SOLIST_ROLE_IDS = [
	"code-searcher",
	"patch-worker",
	"feature-worker",
	"refactor-worker",
	"test-worker",
	"reviewer",
	"verifier",
	"docs-writer",
] as const;

export type SolistRoleId = typeof SOLIST_ROLE_IDS[number];
export type SolistRolePosture = "read-only" | "implementation" | "verification" | "documentation";
export type SolistImplementationComplexity = "patch" | "feature" | "refactor";

export interface SolistRole {
	readonly id: SolistRoleId;
	readonly label: string;
	readonly description: string;
	readonly aliases: readonly string[];
	readonly posture: SolistRolePosture;
	readonly implementationComplexity?: SolistImplementationComplexity;
	readonly promptFrame: readonly string[];
	readonly expectedHandoff: readonly string[];
}

export interface ImplementationRoleRecommendationInput {
	readonly ownedPathCount?: number;
	readonly touchesSharedContracts?: boolean;
	readonly changesStructure?: boolean;
	readonly behaviorMostlyStable?: boolean;
}

export const SOLIST_ROLES: Record<SolistRoleId, SolistRole> = {
	"code-searcher": {
		id: "code-searcher",
		label: "Code Searcher",
		description: "Read-only codebase retrieval and impact mapping.",
		aliases: ["search", "explorer", "investigator"],
		posture: "read-only",
		promptFrame: [
			"Act as a read-only codebase investigator.",
			"Find relevant files, call paths, tests, existing patterns, ownership boundaries, and risks.",
			"Do not edit files.",
		],
		expectedHandoff: [
			"Relevant paths and symbols.",
			"Concise findings and suggested lane boundaries.",
			"Open questions, risks, and confidence level.",
		],
	},
	"patch-worker": {
		id: "patch-worker",
		label: "Patch Worker",
		description: "Small localized implementation changes with an obvious acceptance check.",
		aliases: ["patch", "small-implementation", "small-worker"],
		posture: "implementation",
		implementationComplexity: "patch",
		promptFrame: [
			"Act as a focused editor for one small patch lane.",
			"Own only the listed files or tightly bounded surface.",
			"Prefer minimal edits and existing local patterns.",
			"Run the smallest relevant check when feasible.",
		],
		expectedHandoff: [
			"Files changed.",
			"Behavior changed.",
			"Focused check result and skipped checks with reasons.",
			"Blockers and residual risks.",
		],
	},
	"feature-worker": {
		id: "feature-worker",
		label: "Feature Worker",
		description: "Medium coherent feature slices across a few related files.",
		aliases: ["feature", "implementation", "implementation-worker"],
		posture: "implementation",
		implementationComplexity: "feature",
		promptFrame: [
			"Act as the implementation owner for one coherent feature slice.",
			"Own listed modules, directories, and associated focused tests.",
			"Preserve architecture and established project patterns.",
			"Coordinate with nearby changes and do not revert unrelated work.",
		],
		expectedHandoff: [
			"Files changed.",
			"User-visible behavior and design decisions made.",
			"Tests/checks run and skipped checks with reasons.",
			"Blockers and residual risks.",
		],
	},
	"refactor-worker": {
		id: "refactor-worker",
		label: "Refactor Worker",
		description: "Controlled refactors or migrations that affect shared structure or compatibility.",
		aliases: ["refactor", "migration", "large-implementation"],
		posture: "implementation",
		implementationComplexity: "refactor",
		promptFrame: [
			"Act as a controlled refactor and migration worker.",
			"State invariants before editing.",
			"Move in small reviewable steps and avoid unrelated cleanup.",
			"Keep compatibility shims where needed and run broader verification than a patch lane.",
		],
		expectedHandoff: [
			"Invariants preserved.",
			"Files changed and migration/compatibility notes.",
			"Tests/checks run and skipped checks with reasons.",
			"Regressions found and residual risks.",
		],
	},
	"test-worker": {
		id: "test-worker",
		label: "Test Worker",
		description: "Test creation, repair, reproduction coverage, and focused verification commands.",
		aliases: ["test", "tests", "qa"],
		posture: "verification",
		promptFrame: [
			"Act as a test and reproduction specialist.",
			"Own specified test files, fixtures, reproduction scripts, or verification commands.",
			"Only change production code when explicitly assigned; otherwise report failures to the orchestrator.",
		],
		expectedHandoff: [
			"Coverage added or repaired.",
			"Commands run with passing/failing summary.",
			"Remaining untested risks.",
		],
	},
	reviewer: {
		id: "reviewer",
		label: "Reviewer",
		description: "Review-only bug, regression, security, performance, and missing-test inspection.",
		aliases: ["review", "code-review"],
		posture: "read-only",
		promptFrame: [
			"Act as a review-only code reviewer by default.",
			"Inspect actual diffs and worker evidence, not just summaries.",
			"Prioritize bugs, regressions, missing tests, unsafe assumptions, and unclear ownership.",
			"Do not edit files unless explicitly converted into an implementation lane.",
		],
		expectedHandoff: [
			"Findings ordered by severity.",
			"File and line references where possible.",
			"Missing verification and pass/fail recommendation.",
		],
	},
	verifier: {
		id: "verifier",
		label: "Verifier",
		description: "Independent post-implementation validation before completion.",
		aliases: ["verify", "validation"],
		posture: "verification",
		promptFrame: [
			"Act as an independent validation worker.",
			"Re-run focused checks, smoke tests, screenshots, or process checks as assigned.",
			"If issues are found, mark them as blockers rather than silently fixing broad areas.",
		],
		expectedHandoff: [
			"Commands run and results.",
			"Artifacts or URLs, if any.",
			"Blockers and skipped checks with reasons.",
		],
	},
	"docs-writer": {
		id: "docs-writer",
		label: "Docs Writer",
		description: "README, changelog, user docs, migration notes, and durable handoff documentation.",
		aliases: ["docs", "documentation", "writer"],
		posture: "documentation",
		promptFrame: [
			"Act as a documentation-focused worker.",
			"Use scratchpad and todo context plus accepted implementation facts.",
			"Avoid speculative claims and broad rewrites.",
		],
		expectedHandoff: [
			"Files changed.",
			"Source of truth used.",
			"Docs gaps and checks run.",
		],
	},
};

export function isSolistRoleId(value: string): value is SolistRoleId {
	return (SOLIST_ROLE_IDS as readonly string[]).includes(value);
}

export function resolveSolistRoleId(value: string): SolistRoleId | undefined {
	const normalized = value.trim().toLowerCase();
	if (isSolistRoleId(normalized)) {
		return normalized;
	}
	return SOLIST_ROLE_IDS.find((roleId) =>
		SOLIST_ROLES[roleId].aliases.includes(normalized)
	);
}

export function getSolistRole(id: SolistRoleId): SolistRole {
	return SOLIST_ROLES[id];
}

export function formatRoleForPrompt(role: SolistRole): string {
	return [
		`${role.id}: ${role.description}`,
		"Prompt frame:",
		...role.promptFrame.map((line) => `- ${line}`),
		"Expected handoff:",
		...role.expectedHandoff.map((line) => `- ${line}`),
	].join("\n");
}

export function recommendImplementationRole(
	input: ImplementationRoleRecommendationInput,
): Extract<SolistRoleId, "patch-worker" | "feature-worker" | "refactor-worker"> {
	if (input.touchesSharedContracts || input.changesStructure || input.behaviorMostlyStable) {
		return "refactor-worker";
	}
	if ((input.ownedPathCount ?? 0) > 2) {
		return "feature-worker";
	}
	return "patch-worker";
}
