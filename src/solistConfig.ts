import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSolistConfigPath } from "./solistPaths.js";
import { getSolistMode, isSolistModeId, type SolistModeId } from "./solistModes.js";
import { isSolistRoleId, type SolistRoleId } from "./solistRoles.js";

export const SOLIST_CONFIG_SCHEMA = "solist.config.v1";

export interface SolistRoleBinding {
	readonly agentToolId?: number;
	readonly agentToolName?: string;
	readonly lastKnownName?: string;
}

export interface SolistRoleBindingSet {
	readonly agents: readonly SolistRoleBinding[];
}

export type SolistRoleBindings = Partial<Record<SolistRoleId, SolistRoleBindingSet>>;

export interface SolistProjectConfig {
	readonly activeMode?: SolistModeId;
	readonly roleBindings?: SolistRoleBindings;
}

export interface SolistConfig {
	readonly schema: typeof SOLIST_CONFIG_SCHEMA;
	readonly activeMode: SolistModeId;
	readonly roleBindings: SolistRoleBindings;
	readonly projectOverrides: Record<string, SolistProjectConfig>;
}

export interface SoloAgentToolReference {
	readonly id: number;
	readonly name: string;
	readonly enabled?: boolean;
}

export type RoleBindingResolution =
	| {
		readonly status: "selected";
		readonly roleId: SolistRoleId;
		readonly source: "session" | "project" | "global";
		readonly binding: SolistRoleBindingSet;
		readonly bindingSet: SolistRoleBindingSet;
		readonly agentTools: readonly SoloAgentToolReference[];
		/** First selected agent, retained for single-agent call sites during migration. */
		readonly agentTool: SoloAgentToolReference;
	}
	| {
		readonly status: "decision-needed";
		readonly roleId: SolistRoleId;
		readonly reason: string;
		readonly availableAgentTools: readonly SoloAgentToolReference[];
	};

export function defaultSolistConfig(): SolistConfig {
	return {
		schema: SOLIST_CONFIG_SCHEMA,
		activeMode: "orchestration",
		roleBindings: {},
		projectOverrides: {},
	};
}

export function getConfiguredSolistMode(
	config: SolistConfig,
	projectId?: number | string,
): SolistModeId {
	const projectMode = projectId === undefined
		? undefined
		: config.projectOverrides[String(projectId)]?.activeMode;
	return getSolistMode(projectMode ?? config.activeMode).id;
}

export function readSolistConfig(
	path = getSolistConfigPath(),
): SolistConfig {
	if (!existsSync(path)) {
		return defaultSolistConfig();
	}

	const raw = readFileSync(path, "utf8");
	if (raw.trim().length === 0) {
		return defaultSolistConfig();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid Solist config in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return normalizeSolistConfig(parsed);
}

export function writeSolistConfig(
	config: SolistConfig,
	path = getSolistConfigPath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp-${process.pid}`;
	writeFileSync(tmpPath, `${JSON.stringify(normalizeSolistConfig(config), null, 2)}\n`, "utf8");
	renameSync(tmpPath, path);
}

export function setSolistActiveMode(
	config: SolistConfig,
	modeId: SolistModeId,
	projectId?: number | string,
): SolistConfig {
	if (projectId === undefined) {
		return { ...config, activeMode: modeId };
	}
	const key = String(projectId);
	const project = config.projectOverrides[key] ?? {};
	return {
		...config,
		projectOverrides: {
			...config.projectOverrides,
			[key]: { ...project, activeMode: modeId },
		},
	};
}

export function setSolistRoleBinding(
	config: SolistConfig,
	roleId: SolistRoleId,
	binding: SolistRoleBinding,
	projectId?: number | string,
): SolistConfig {
	return setSolistRoleBindings(config, roleId, [binding], projectId);
}

export function setSolistRoleBindings(
	config: SolistConfig,
	roleId: SolistRoleId,
	bindings: readonly SolistRoleBinding[],
	projectId?: number | string,
): SolistConfig {
	if (projectId === undefined) {
		return {
			...config,
			roleBindings: { ...config.roleBindings, [roleId]: normalizeRoleBindingSet({ agents: bindings }) },
		};
	}
	const key = String(projectId);
	const project = config.projectOverrides[key] ?? {};
	return {
		...config,
		projectOverrides: {
			...config.projectOverrides,
			[key]: {
				...project,
				roleBindings: {
					...(project.roleBindings ?? {}),
					[roleId]: normalizeRoleBindingSet({ agents: bindings }),
				},
			},
		},
	};
}

export function unsetSolistRoleBinding(
	config: SolistConfig,
	roleId: SolistRoleId,
	projectId?: number | string,
): SolistConfig {
	if (projectId === undefined) {
		const { [roleId]: _removed, ...roleBindings } = config.roleBindings;
		return { ...config, roleBindings };
	}
	const key = String(projectId);
	const project = config.projectOverrides[key] ?? {};
	const { [roleId]: _removed, ...roleBindings } = project.roleBindings ?? {};
	return {
		...config,
		projectOverrides: {
			...config.projectOverrides,
			[key]: { ...project, roleBindings },
		},
	};
}

export function resolveRoleBinding(input: {
	readonly roleId: SolistRoleId;
	readonly config: SolistConfig;
	readonly availableAgentTools: readonly SoloAgentToolReference[];
	readonly projectId?: number | string;
	readonly sessionOverrides?: SolistRoleBindings;
}): RoleBindingResolution {
	const candidates: Array<{
		readonly source: "session" | "project" | "global";
		readonly binding: SolistRoleBindingSet | undefined;
	}> = [
		{ source: "session", binding: input.sessionOverrides?.[input.roleId] },
		{
			source: "project",
			binding: input.projectId === undefined
				? undefined
				: input.config.projectOverrides[String(input.projectId)]?.roleBindings?.[input.roleId],
		},
		{ source: "global", binding: input.config.roleBindings[input.roleId] },
	];

	for (const candidate of candidates) {
		if (!candidate.binding) {
			continue;
		}
		const agentTools = resolveAgentTools(candidate.binding, input.availableAgentTools);
		if (agentTools.length === candidate.binding.agents.length && agentTools.length > 0) {
			return {
				status: "selected",
				roleId: input.roleId,
				source: candidate.source,
				binding: candidate.binding,
				bindingSet: candidate.binding,
				agentTools,
				agentTool: agentTools[0]!,
			};
		}
		return {
			status: "decision-needed",
			roleId: input.roleId,
			reason: `Configured ${candidate.source} binding for role "${input.roleId}" does not match an enabled Solo agent tool.`,
			availableAgentTools: enabledAgentTools(input.availableAgentTools),
		};
	}

	return {
		status: "decision-needed",
		roleId: input.roleId,
		reason: `No Solo agent tool is configured for role "${input.roleId}".`,
		availableAgentTools: enabledAgentTools(input.availableAgentTools),
	};
}

export function resolveAgentToolSelection(
	selection: string,
	availableAgentTools: readonly SoloAgentToolReference[],
): SoloAgentToolReference | undefined {
	const normalized = stripWrappingQuotes(selection.trim()).toLowerCase();
	if (!normalized) {
		return undefined;
	}
	const numeric = Number(normalized);
	if (Number.isInteger(numeric)) {
		return enabledAgentTools(availableAgentTools).find((tool) => tool.id === numeric);
	}
	return enabledAgentTools(availableAgentTools).find((tool) =>
		tool.name.toLowerCase() === normalized
	);
}

export function resolveAgentToolSelections(
	selection: string,
	availableAgentTools: readonly SoloAgentToolReference[],
): SoloAgentToolReference[] {
	const unwrappedSelection = stripWrappingQuotes(selection.trim());
	const parts = unwrappedSelection.split(",").map((part) => part.trim()).filter(Boolean);
	const selections = parts.length > 0 ? parts : [unwrappedSelection];
	const selected: SoloAgentToolReference[] = [];
	for (const part of selections) {
		const tool = resolveAgentToolSelection(part, availableAgentTools);
		if (!tool) {
			return [];
		}
		if (!selected.some((candidate) => candidate.id === tool.id)) {
			selected.push(tool);
		}
	}
	return selected;
}

function stripWrappingQuotes(value: string): string {
	if (
		(value.startsWith("\"") && value.endsWith("\""))
		|| (value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1).trim();
	}
	return value;
}

export function bindingForAgentTool(agentTool: SoloAgentToolReference): SolistRoleBinding {
	return {
		agentToolId: agentTool.id,
		lastKnownName: agentTool.name,
	};
}

export function bindingsForAgentTools(
	agentTools: readonly SoloAgentToolReference[],
): SolistRoleBinding[] {
	return agentTools.map((agentTool) => bindingForAgentTool(agentTool));
}

export function formatRoleBindingSet(bindingSet: SolistRoleBindingSet | undefined): string {
	if (!bindingSet || bindingSet.agents.length === 0) {
		return "unconfigured";
	}
	return bindingSet.agents.map((binding) => formatRoleBinding(binding)).join(", ");
}

function normalizeSolistConfig(value: unknown): SolistConfig {
	if (!isRecord(value)) {
		return defaultSolistConfig();
	}
	return {
		schema: SOLIST_CONFIG_SCHEMA,
		activeMode: typeof value.activeMode === "string" && isSolistModeId(value.activeMode)
			? value.activeMode
			: "orchestration",
		roleBindings: normalizeRoleBindings(value.roleBindings),
		projectOverrides: normalizeProjectOverrides(value.projectOverrides),
	};
}

function normalizeProjectOverrides(value: unknown): Record<string, SolistProjectConfig> {
	if (!isRecord(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([projectId, project]) => {
			if (!isRecord(project)) {
				return [];
			}
			return [[
				projectId,
				{
					...(typeof project.activeMode === "string" && isSolistModeId(project.activeMode)
						? { activeMode: project.activeMode }
						: {}),
					roleBindings: normalizeRoleBindings(project.roleBindings),
				},
			]];
		}),
	);
}

function normalizeRoleBindings(value: unknown): SolistRoleBindings {
	if (!isRecord(value)) {
		return {};
	}
	const entries = Object.entries(value).flatMap(([roleId, binding]) => {
		if (!isSolistRoleId(roleId)) {
			return [];
		}
		const normalized = normalizeRoleBindingSet(binding);
		if (normalized.agents.length === 0) {
			return [];
		}
		return [[roleId, normalized] as const];
	});
	return Object.fromEntries(entries) as SolistRoleBindings;
}

function normalizeRoleBindingSet(value: unknown): SolistRoleBindingSet {
	if (Array.isArray(value)) {
		return { agents: dedupeBindings(value.flatMap((item) =>
			isRecord(item) ? [normalizeRoleBinding(item)] : []
		)) };
	}
	if (!isRecord(value)) {
		return { agents: [] };
	}
	if (Array.isArray(value.agents)) {
		return {
			agents: dedupeBindings(value.agents.flatMap((item) =>
				isRecord(item) ? [normalizeRoleBinding(item)] : []
			)),
		};
	}
	return { agents: dedupeBindings([normalizeRoleBinding(value)]) };
}

function normalizeRoleBinding(value: unknown): SolistRoleBinding {
	if (!isRecord(value)) {
		return {};
	}
	return {
		...(typeof value.agentToolId === "number" && Number.isInteger(value.agentToolId)
			? { agentToolId: value.agentToolId }
			: {}),
		...(typeof value.agentToolName === "string" && value.agentToolName.trim()
			? { agentToolName: value.agentToolName.trim() }
			: {}),
		...(typeof value.lastKnownName === "string" && value.lastKnownName.trim()
			? { lastKnownName: value.lastKnownName.trim() }
			: {}),
	};
}

function dedupeBindings(bindings: readonly SolistRoleBinding[]): SolistRoleBinding[] {
	const seen = new Set<string>();
	return bindings.filter((binding) => {
		if (!binding.agentToolId && !binding.agentToolName && !binding.lastKnownName) {
			return false;
		}
		const key = binding.agentToolId !== undefined
			? `id:${binding.agentToolId}`
			: `name:${(binding.agentToolName ?? binding.lastKnownName ?? "").toLowerCase()}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function resolveAgentTools(
	bindingSet: SolistRoleBindingSet,
	availableAgentTools: readonly SoloAgentToolReference[],
): SoloAgentToolReference[] {
	const selected: SoloAgentToolReference[] = [];
	for (const binding of bindingSet.agents) {
		const agentTool = resolveAgentTool(binding, availableAgentTools);
		if (!agentTool || selected.some((tool) => tool.id === agentTool.id)) {
			continue;
		}
		selected.push(agentTool);
	}
	return selected;
}

function resolveAgentTool(
	binding: SolistRoleBinding,
	availableAgentTools: readonly SoloAgentToolReference[],
): SoloAgentToolReference | undefined {
	const enabled = enabledAgentTools(availableAgentTools);
	if (typeof binding.agentToolId === "number") {
		const byId = enabled.find((tool) => tool.id === binding.agentToolId);
		if (byId) return byId;
	}
	const name = binding.agentToolName ?? binding.lastKnownName;
	if (name) {
		const normalized = name.toLowerCase();
		return enabled.find((tool) => tool.name.toLowerCase() === normalized);
	}
	return undefined;
}

function formatRoleBinding(binding: SolistRoleBinding): string {
	if (binding.agentToolId !== undefined && binding.lastKnownName) {
		return `${binding.agentToolId} (${binding.lastKnownName})`;
	}
	if (binding.agentToolId !== undefined) {
		return String(binding.agentToolId);
	}
	return binding.agentToolName ?? binding.lastKnownName ?? "unconfigured";
}

function enabledAgentTools(
	availableAgentTools: readonly SoloAgentToolReference[],
): SoloAgentToolReference[] {
	return availableAgentTools.filter((tool) => tool.enabled !== false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
