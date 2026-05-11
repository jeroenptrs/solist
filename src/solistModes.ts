import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const SOLIST_MODE_IDS = [
	"orchestration",
	"analysis",
	"deep-analysis",
] as const;

export type SolistModeId = typeof SOLIST_MODE_IDS[number];
export type SolistToolProfile = "orchestration";

export interface SolistMode {
	readonly id: SolistModeId;
	readonly label: string;
	readonly description: string;
	readonly provider: string;
	readonly model: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly toolProfile: SolistToolProfile;
	readonly canSpawnRoles: boolean;
	readonly theme: SolistModeTheme;
}

export interface SolistModeTheme {
	readonly accent: number;
	readonly secondary: number;
	readonly muted: number;
	readonly warning: number;
	readonly success: number;
	readonly error: number;
	readonly userBackground: number;
	readonly panelBackground: number;
	readonly selectedBackground: number;
	readonly reasoning: number;
}

export const SOLIST_ORCHESTRATION_MODE_ID: SolistModeId = "orchestration";

export const SOLIST_MODES: Record<SolistModeId, SolistMode> = {
	orchestration: {
		id: "orchestration",
		label: "Orchestration",
		description: "Lead-agent planning, Solo scratchpads/todos, worker dispatch, monitoring, and integration.",
		provider: "openai-codex",
		model: "gpt-5.5",
		thinkingLevel: "off",
		toolProfile: "orchestration",
		canSpawnRoles: true,
		theme: {
			accent: 36,
			secondary: 32,
			muted: 244,
			warning: 33,
			success: 32,
			error: 31,
			userBackground: 238,
			panelBackground: 236,
			selectedBackground: 24,
			reasoning: 36,
		},
	},
	analysis: {
		id: "analysis",
		label: "Analysis",
		description: "Higher-reasoning analysis without role-bound Solo worker dispatch.",
		provider: "openai-codex",
		model: "gpt-5.5",
		thinkingLevel: "high",
		toolProfile: "orchestration",
		canSpawnRoles: false,
		theme: {
			accent: 35,
			secondary: 99,
			muted: 244,
			warning: 33,
			success: 32,
			error: 31,
			userBackground: 235,
			panelBackground: 236,
			selectedBackground: 53,
			reasoning: 99,
		},
	},
	"deep-analysis": {
		id: "deep-analysis",
		label: "Deep Analysis",
		description: "Expensive design, risk, and tradeoff analysis without role-bound Solo worker dispatch.",
		provider: "openai-codex",
		model: "gpt-5.5",
		thinkingLevel: "xhigh",
		toolProfile: "orchestration",
		canSpawnRoles: false,
		theme: {
			accent: 214,
			secondary: 208,
			muted: 244,
			warning: 214,
			success: 32,
			error: 31,
			userBackground: 237,
			panelBackground: 236,
			selectedBackground: 94,
			reasoning: 214,
		},
	},
};

export const SOLIST_DEFAULT_MODE = SOLIST_MODES[SOLIST_ORCHESTRATION_MODE_ID];

export function isSolistModeId(value: string): value is SolistModeId {
	return (SOLIST_MODE_IDS as readonly string[]).includes(value);
}

export function getSolistMode(id: string | undefined): SolistMode {
	if (id && isSolistModeId(id)) {
		return SOLIST_MODES[id];
	}
	return SOLIST_DEFAULT_MODE;
}

export function formatSolistMode(mode: SolistMode): string {
	return `${mode.id}: ${mode.provider}/${mode.model} reasoning=${mode.thinkingLevel} tools=${mode.toolProfile}`;
}
