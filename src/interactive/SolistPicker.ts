import {
	Key,
	matchesKey,
	SelectList,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import type { SolistAnsiTheme } from "./SolistTuiTheme.js";

const ANSI_RESET = "\x1b[0m";

export interface SolistPickerItem extends SelectItem {
	readonly disabled?: boolean;
}

export interface ShowSinglePickerOptions {
	readonly title: string;
	readonly subtitle?: string;
	readonly items: readonly SolistPickerItem[];
	readonly selectedValue?: string;
	readonly maxVisible?: number;
	readonly emptyText?: string;
}

export interface ShowMultiPickerOptions {
	readonly title: string;
	readonly subtitle?: string;
	readonly items: readonly SolistPickerItem[];
	readonly selectedValues?: readonly string[];
	readonly maxVisible?: number;
	readonly emptyText?: string;
}

export async function showSinglePicker(
	ui: TUI,
	theme: SolistAnsiTheme,
	options: ShowSinglePickerOptions,
): Promise<SolistPickerItem | undefined> {
	if (options.items.length === 0) {
		return undefined;
	}

	return new Promise((resolve) => {
		let handle: OverlayHandle | undefined;
		const enabledItems = options.items.map((item) => ({
			...item,
			description: item.disabled
				? `${item.description ? `${item.description} ` : ""}(disabled)`
				: item.description,
		}));
		const list = new SelectList(
			enabledItems.map(({ disabled: _disabled, ...item }) => item),
			options.maxVisible ?? 8,
			theme.selectList,
			{ maxPrimaryColumnWidth: 30 },
		);
		const selectedIndex = Math.max(0, enabledItems.findIndex((item) => item.value === options.selectedValue));
		list.setSelectedIndex(selectedIndex);
		list.onSelect = (item) => {
			const selected = enabledItems.find((candidate) => candidate.value === item.value);
			if (selected?.disabled) return;
			handle?.hide();
			resolve(selected);
		};
		list.onCancel = () => {
			handle?.hide();
			resolve(undefined);
		};
		const panel = new PickerPanel(theme, {
			title: options.title,
			subtitle: options.subtitle,
			body: list,
			footer: "Enter selects, Esc cancels.",
			emptyText: options.emptyText,
		});
		handle = ui.showOverlay(panel, {
			anchor: "center",
			width: "76%",
			minWidth: 48,
			maxHeight: "70%",
			margin: 2,
		});
	});
}

export async function showMultiPicker(
	ui: TUI,
	theme: SolistAnsiTheme,
	options: ShowMultiPickerOptions,
): Promise<SolistPickerItem[] | undefined> {
	if (options.items.length === 0) {
		return undefined;
	}

	return new Promise((resolve) => {
		let handle: OverlayHandle | undefined;
		const list = new MultiSelectList(
			theme,
			options.items,
			options.selectedValues ?? [],
			options.maxVisible ?? 8,
		);
		list.onSubmit = (items) => {
			handle?.hide();
			resolve(items);
		};
		list.onCancel = () => {
			handle?.hide();
			resolve(undefined);
		};
		const panel = new PickerPanel(theme, {
			title: options.title,
			subtitle: options.subtitle,
			body: list,
			footer: "Space toggles, Enter saves, Esc cancels.",
			emptyText: options.emptyText,
		});
		handle = ui.showOverlay(panel, {
			anchor: "center",
			width: "80%",
			minWidth: 54,
			maxHeight: "74%",
			margin: 2,
		});
	});
}

class PickerPanel implements Component {
	constructor(
		private readonly theme: SolistAnsiTheme,
		private readonly options: {
			readonly title: string;
			readonly subtitle?: string;
			readonly body: Component;
			readonly footer?: string;
			readonly emptyText?: string;
		},
	) {}

	invalidate(): void {
		this.options.body.invalidate();
	}

	handleInput(data: string): void {
		this.options.body.handleInput?.(data);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines = [
			this.panelBackground(" ".repeat(width)),
			this.pad(this.theme.accent(this.options.title), innerWidth),
		];
		if (this.options.subtitle) {
			lines.push(this.pad(this.theme.muted(this.options.subtitle), innerWidth));
		}
		lines.push(this.pad("", innerWidth));
		const bodyLines = this.options.body.render(innerWidth);
		if (bodyLines.length === 0 && this.options.emptyText) {
			lines.push(this.pad(this.theme.muted(this.options.emptyText), innerWidth));
		} else {
			for (const line of bodyLines) {
				lines.push(this.pad(line, innerWidth));
			}
		}
		if (this.options.footer) {
			lines.push(this.pad("", innerWidth));
			lines.push(this.pad(this.theme.muted(this.options.footer), innerWidth));
		}
		lines.push(this.panelBackground(" ".repeat(width)));
		return lines;
	}

	private pad(text: string, innerWidth: number): string {
		const truncated = truncateToWidth(text, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		return this.panelBackground(`  ${truncated}${padding}  `);
	}

	private panelBackground(text: string): string {
		const start = `\x1b[48;5;${this.theme.mode.theme.panelBackground}m`;
		return `${start}${text.replaceAll(ANSI_RESET, `${ANSI_RESET}${start}`)}${ANSI_RESET}`;
	}
}

class MultiSelectList implements Component {
	private selectedIndex = 0;
	private readonly selected = new Set<string>();
	onSubmit?: (items: SolistPickerItem[]) => void;
	onCancel?: () => void;

	constructor(
		private readonly theme: SolistAnsiTheme,
		private readonly items: readonly SolistPickerItem[],
		selectedValues: readonly string[],
		private readonly maxVisible: number,
	) {
		for (const value of selectedValues) {
			this.selected.add(value);
		}
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = this.selectedIndex === 0
				? this.items.length - 1
				: this.selectedIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1
				? 0
				: this.selectedIndex + 1;
			return;
		}
		if (matchesKey(data, Key.space)) {
			const item = this.items[this.selectedIndex];
			if (!item || item.disabled) return;
			if (this.selected.has(item.value)) {
				this.selected.delete(item.value);
			} else {
				this.selected.add(item.value);
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.onSubmit?.(this.items.filter((item) =>
				!item.disabled && this.selected.has(item.value)
			));
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel?.();
		}
	}

	render(width: number): string[] {
		if (this.items.length === 0) {
			return [this.theme.muted("  No options")];
		}
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.items.length - this.maxVisible,
			),
		);
		const end = Math.min(start + this.maxVisible, this.items.length);
		const lines: string[] = [];
		for (let index = start; index < end; index += 1) {
			const item = this.items[index];
			if (!item) continue;
			const selected = this.selected.has(item.value);
			const highlighted = index === this.selectedIndex;
			const checkbox = selected ? "[x]" : "[ ]";
			const disabled = item.disabled ? " (disabled)" : "";
			const primary = `${highlighted ? "> " : "  "}${checkbox} ${item.label}${disabled}`;
			const description = item.description ? `  ${item.description}` : "";
			const truncated = truncateToWidth(`${primary}${description}`, width, "");
			const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
			const line = `${truncated}${padding}`;
			lines.push(highlighted ? this.theme.selectedBackground(this.theme.accent(line)) : line);
		}
		if (start > 0 || end < this.items.length) {
			lines.push(this.theme.muted(truncateToWidth(`  (${this.selectedIndex + 1}/${this.items.length})`, width, "")));
		}
		return lines;
	}
}
