import type {
	EditorTheme,
	MarkdownTheme,
	SelectListTheme,
	SettingsListTheme,
} from "@earendil-works/pi-tui";
import { SOLIST_DEFAULT_MODE, type SolistMode, type SolistModeTheme } from "../solistModes.js";

const ANSI_RESET = "\x1b[0m";

export interface SolistAnsiTheme {
	readonly mode: SolistMode;
	readonly accent: (text: string) => string;
	readonly secondary: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly muted: (text: string) => string;
	readonly error: (text: string) => string;
	readonly success: (text: string) => string;
	readonly warning: (text: string) => string;
	readonly reasoning: (text: string) => string;
	readonly userBackground: (text: string) => string;
	readonly panelBackground: (text: string) => string;
	readonly selectedBackground: (text: string) => string;
	readonly border: (text: string) => string;
	readonly editor: EditorTheme;
	readonly markdown: MarkdownTheme;
	readonly selectList: SelectListTheme;
	readonly settingsList: SettingsListTheme;
}

export const identity = (text: string): string => text;

export function createSolistAnsiTheme(
	mode: SolistMode = SOLIST_DEFAULT_MODE,
): SolistAnsiTheme {
	const palette = mode.theme;
	const theme: Omit<
		SolistAnsiTheme,
		"mode" | "editor" | "markdown" | "selectList" | "settingsList"
	> = {
		accent: fg(palette.accent),
		secondary: fg(palette.secondary),
		dim: (text) => `\x1b[2m${text}${ANSI_RESET}`,
		muted: fg(palette.muted),
		error: fg(palette.error),
		success: fg(palette.success),
		warning: fg(palette.warning),
		reasoning: fg(palette.reasoning),
		userBackground: bg(palette.userBackground),
		panelBackground: bg(palette.panelBackground),
		selectedBackground: bg(palette.selectedBackground),
		border: fg(palette.accent),
	};
	const selectList = createSelectListTheme(theme, palette);
	return {
		mode,
		...theme,
		editor: {
			borderColor: theme.border,
			selectList,
		},
		markdown: createMarkdownTheme(theme),
		selectList,
		settingsList: createSettingsListTheme(theme),
	};
}

function createSelectListTheme(
	theme: Omit<
		SolistAnsiTheme,
		"mode" | "editor" | "markdown" | "selectList" | "settingsList"
	>,
	palette: SolistModeTheme,
): SelectListTheme {
	return {
		selectedPrefix: theme.accent,
		selectedText: (text) => fgOnBg(palette.accent, palette.selectedBackground)(text),
		description: theme.muted,
		scrollInfo: theme.muted,
		noMatch: theme.muted,
	};
}

function createSettingsListTheme(
	theme: Omit<
		SolistAnsiTheme,
		"mode" | "editor" | "markdown" | "selectList" | "settingsList"
	>,
): SettingsListTheme {
	return {
		label: (text, selected) => selected ? theme.accent(text) : text,
		value: (text, selected) => selected ? theme.reasoning(text) : theme.muted(text),
		description: theme.muted,
		cursor: theme.accent(">"),
		hint: theme.muted,
	};
}

function createMarkdownTheme(
	theme: Omit<
		SolistAnsiTheme,
		"mode" | "editor" | "markdown" | "selectList" | "settingsList"
	>,
): MarkdownTheme {
	return {
		heading: theme.accent,
		link: theme.secondary,
		linkUrl: theme.muted,
		code: theme.reasoning,
		codeBlock: identity,
		codeBlockBorder: theme.border,
		quote: theme.muted,
		quoteBorder: theme.border,
		hr: theme.border,
		listBullet: theme.accent,
		bold: (text) => `\x1b[1m${text}${ANSI_RESET}`,
		italic: (text) => `\x1b[3m${text}${ANSI_RESET}`,
		strikethrough: (text) => `\x1b[9m${text}${ANSI_RESET}`,
		underline: (text) => `\x1b[4m${text}${ANSI_RESET}`,
	};
}

function fg(code: number): (text: string) => string {
	if (code >= 0 && code <= 7) {
		return (text) => `\x1b[3${code}m${text}${ANSI_RESET}`;
	}
	if (code >= 30 && code <= 37) {
		return (text) => `\x1b[${code}m${text}${ANSI_RESET}`;
	}
	return (text) => `\x1b[38;5;${code}m${text}${ANSI_RESET}`;
}

function bg(code: number): (text: string) => string {
	return (text) => `\x1b[48;5;${code}m${text}${ANSI_RESET}`;
}

function fgOnBg(fgCode: number, bgCode: number): (text: string) => string {
	const foreground = fgCode >= 30 && fgCode <= 37
		? `\x1b[${fgCode}m`
		: `\x1b[38;5;${fgCode}m`;
	return (text) => `${foreground}\x1b[48;5;${bgCode}m${text}${ANSI_RESET}`;
}
