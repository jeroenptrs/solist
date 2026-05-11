import { spawn } from "node:child_process";
import { basename } from "node:path";
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
	AssistantMessageEvent,
	OAuthLoginCallbacks,
	OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import {
	Container,
	Editor,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	TruncatedText,
	TUI,
	CombinedAutocompleteProvider,
	type Component,
	type Terminal,
} from "@earendil-works/pi-tui";
import { SOLIST_MODEL_PROVIDER } from "../solistPrompt.js";
import { getSolistAuthPath } from "../solistPaths.js";
import {
	listSolistSessions,
	readSolistSession,
	stripSessionRoleOverrideContext,
	updateSolistSession,
	writeSolistSession,
	type SolistSession,
} from "../solistSessions.js";
import {
	bindingsForAgentTools,
	formatRoleBindingSet,
	getConfiguredSolistMode,
	readSolistConfig,
	resolveAgentToolSelections,
	resolveRoleBinding,
	setSolistActiveMode,
	setSolistRoleBindings,
	unsetSolistRoleBinding,
	writeSolistConfig,
	type SolistRoleBindings,
} from "../solistConfig.js";
import {
	formatAgentToolChoices,
	getCurrentSoloProjectId,
	listSoloAgentTools,
} from "../soloAgentTools.js";
import {
	SOLIST_MODE_IDS,
	formatSolistMode,
	getSolistMode,
	isSolistModeId,
	type SolistModeId,
} from "../solistModes.js";
import {
	SOLIST_ROLE_IDS,
	SOLIST_ROLES,
	resolveSolistRoleId,
	type SolistRoleId,
} from "../solistRoles.js";
import {
	createSolistAnsiTheme,
	type SolistAnsiTheme,
} from "./SolistTuiTheme.js";
import { showMultiPicker, showSinglePicker, type SolistPickerItem } from "./SolistPicker.js";
import {
	isExactSolistInteractiveCommand,
	routeSolistInteractiveInput,
	SOLIST_INTERACTIVE_COMMANDS,
	type SolistInteractiveCommandContext,
} from "./SolistCommandRouter.js";

export interface SolistInteractiveHarness {
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentTool[];
	readonly modelRef: { provider: string; model: string };
	readonly thinkingLevel: ThinkingLevel;
	readonly modeId?: SolistModeId;
	readonly projectId?: number | string;
	readonly isStreaming: boolean;
	readonly authPath?: string;
	run(prompt: string): Promise<unknown>;
	abort(): void;
	login?(provider: string, callbacks: OAuthLoginCallbacks): Promise<void>;
	logout?(provider: string): Promise<void>;
	getProviderName?(provider: string): Promise<string>;
	close?(): void | Promise<void>;
	subscribe(
		listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
	): () => void;
}

export interface SolistInteractiveModeOptions {
	terminal?: Terminal;
	cwd?: string;
	soloMcpAvailable?: boolean;
	showWelcome?: boolean;
	createHarnessForMode?: (
		modeId: SolistModeId,
		context: { messages: readonly AgentMessage[]; projectId?: number | string },
	) => Promise<SolistInteractiveHarness>;
	resolveProjectId?: (selector: string) => Promise<number | string | undefined>;
	session?: SolistSession;
	listSessions?: () => readonly SolistSession[];
	readSession?: (id: string) => SolistSession | undefined;
	writeSession?: (session: SolistSession) => void;
}

export class SolistInteractiveMode {
	private readonly terminal: Terminal;
	private readonly cwd: string;
	private readonly soloMcpAvailable: boolean;
	private readonly showWelcome: boolean;
	private readonly createHarnessForMode?: SolistInteractiveModeOptions["createHarnessForMode"];
	private readonly resolveProjectId: (selector: string) => Promise<number | string | undefined>;
	private readonly listSessions: () => readonly SolistSession[];
	private readonly readSession: (id: string) => SolistSession | undefined;
	private readonly writeSession: (session: SolistSession) => void;
	private readonly ui: TUI;
	private readonly chat = new Container();
	private readonly status = new Container();
	private readonly editor: Editor;
	private activeTheme: SolistAnsiTheme;
	private unsubscribe?: () => void;
	private resolveRun?: () => void;
	private statusState = "Ready";
	private agentState: AgentActivityState = "idle";
	private activeTurn = false;
	private interruptRequested = false;
	private stopped = false;
	private activeAuth = false;
	private activeAuthAbort?: AbortController;
	private activeAuthInput?: AuthInputWaiter;
	private session?: SolistSession;
	private sessionRoleOverrides: SolistRoleBindings = {};
	private currentAssistant?: {
		text: string;
		component: Markdown;
		placeholder?: Loader;
	};

	constructor(
		private harness: SolistInteractiveHarness,
		options: SolistInteractiveModeOptions = {},
	) {
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.cwd = options.cwd ?? process.cwd();
		this.soloMcpAvailable = options.soloMcpAvailable ?? true;
		this.showWelcome = options.showWelcome ?? true;
		this.createHarnessForMode = options.createHarnessForMode;
		this.resolveProjectId = options.resolveProjectId ?? resolveDefaultProjectId;
		this.session = options.session;
		this.listSessions = options.listSessions ?? (() => listSolistSessions());
		this.readSession = options.readSession ?? ((id) => readSolistSession(id));
		this.writeSession = options.writeSession ?? ((session) => writeSolistSession(session));
		this.ui = new TUI(this.terminal);
		this.activeTheme = createSolistAnsiTheme(getSolistMode(this.harness.modeId));
		this.editor = new Editor(this.ui, this.createEditorTheme(), { paddingX: 1 });
	}

	async run(initialPrompt = ""): Promise<void> {
		const done = new Promise<void>((resolve) => {
			this.resolveRun = resolve;
		});
		this.setupLayout();
		this.unsubscribe = this.harness.subscribe((event) => this.renderEvent(event));
		this.ui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c") && this.activeAuth) {
				this.cancelActiveAuth();
				return { consume: true };
			}
			if (matchesKey(data, "escape") && this.activeAuth) {
				this.cancelActiveAuth();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+c")) {
				this.handleInterruptOrExit();
				return { consume: true };
			}
			if (matchesKey(data, "escape") && this.activeTurn) {
				this.handleInterruptOrExit();
				return { consume: true };
			}
			if (matchesKey(data, "enter") && this.submitExactInteractiveCommand()) {
				return { consume: true };
			}
			return undefined;
		});
		this.ui.start();

		if (initialPrompt.trim()) {
			void this.submitPrompt(initialPrompt.trim());
		}

		return done;
	}

	private setupLayout(): void {
		if (this.showWelcome) {
			this.chat.addChild(new Spacer(1));
			this.chat.addChild(new SolistWelcomeBanner(() => this.activeTheme));
			this.chat.addChild(new Spacer(1));
		}

		if (this.session && this.session.messages.length > 0) {
			this.renderStoredMessages(this.session.messages);
		}

		this.editor.onSubmit = (input) => {
			void this.handleSubmit(input);
		};
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[...SOLIST_INTERACTIVE_COMMANDS],
				this.cwd,
			),
		);

		this.ui.addChild(this.chat);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.status);
		this.ui.setFocus(this.editor);
		this.setStatusState("Ready");
	}

	private createEditorTheme() {
		return {
			borderColor: (text: string) => this.activeTheme.border(text),
			selectList: {
				selectedPrefix: (text: string) => this.activeTheme.selectList.selectedPrefix(text),
				selectedText: (text: string) => this.activeTheme.selectList.selectedText(text),
				description: (text: string) => this.activeTheme.selectList.description(text),
				scrollInfo: (text: string) => this.activeTheme.selectList.scrollInfo(text),
				noMatch: (text: string) => this.activeTheme.selectList.noMatch(text),
			},
		};
	}

	private async handleSubmit(input: string): Promise<void> {
		if (this.activeAuthInput) {
			this.resolveActiveAuthInput(input);
			return;
		}

		const route = routeSolistInteractiveInput(input, this.getCommandContext());
		if (route.kind === "empty") return;
		if (route.kind === "exit") {
			await this.stop();
			return;
		}
		if (route.kind === "clear") {
			this.chat.clear();
			this.clearCurrentAssistant();
			this.chat.addChild(new Text(route.message, 1, 0));
			this.setStatusState("Ready");
			this.setAgentState("idle");
			this.ui.requestRender(true);
			return;
		}
		if (route.kind === "render") {
			this.addSystemMessage(route.message);
			return;
		}
		if (route.kind === "mode") {
			await this.handleModeCommand(route.mode, route.project);
			return;
		}
		if (route.kind === "roles") {
			await this.handleRolesCommand(route.action, route.project);
			return;
		}
		if (route.kind === "role-menu") {
			await this.handleRoleMenuCommand(route.project);
			return;
		}
		if (route.kind === "role") {
			await this.handleRoleCommand(route.action, route.role, route.agent, route.project);
			return;
		}
		if (route.kind === "resume") {
			await this.handleResumeCommand(route.session);
			return;
		}
		if (route.kind === "login") {
			await this.handleLoginCommand(route.provider);
			return;
		}
		if (route.kind === "logout") {
			await this.handleLogoutCommand(route.provider);
			return;
		}
		await this.submitPrompt(route.prompt);
	}

	private submitExactInteractiveCommand(): boolean {
		const input = this.editor.getExpandedText();
		if (!isExactSolistInteractiveCommand(input)) return false;

		const trimmed = input.trim();
		this.editor.addToHistory(trimmed);
		this.editor.setText("");
		void this.handleSubmit(trimmed);
		return true;
	}

	private async submitPrompt(prompt: string): Promise<void> {
		if (this.activeTurn) {
			this.addSystemMessage("Solist is still working. Wait, or press Esc/Ctrl+C to interrupt.");
			return;
		}

		this.activeTurn = true;
		this.interruptRequested = false;
		this.editor.disableSubmit = true;
		this.setStatusState("Working");
		this.setAgentState("thinking");

		try {
			await this.harness.run(this.withSessionRoleOverrides(prompt));
		} catch (error) {
			if (this.interruptRequested) {
				this.addSystemMessage("Active turn stopped.");
				return;
			}
			this.addSystemMessage(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.activeTurn = false;
			this.interruptRequested = false;
			this.editor.disableSubmit = false;
			this.saveSessionSnapshot();
			this.setStatusState("Ready");
			this.setAgentState("idle");
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	private async handleModeCommand(modeArg?: string, projectSelector?: string): Promise<void> {
		if (this.activeTurn || this.activeAuth) {
			this.addSystemMessage("Wait for the current turn or authentication flow to finish before changing mode.");
			return;
		}
		let projectId: number | string | undefined;
		try {
			projectId = await this.resolveProjectSelector(projectSelector);
		} catch (error) {
			this.addSystemMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		const config = readSolistConfig();
		if (!modeArg) {
			const mode = getSolistMode(getConfiguredSolistMode(config, projectId));
			const selected = await showSinglePicker(this.ui, this.activeTheme, {
				title: `Select ${formatScopeLabel(projectId)} mode`,
				subtitle: `Current: ${formatSolistMode(mode)}`,
				selectedValue: mode.id,
				items: SOLIST_MODE_IDS.map((modeId) => {
					const candidate = getSolistMode(modeId);
					const rolePolicy = candidate.canSpawnRoles ? "roles enabled" : "roles disabled";
					return {
						value: candidate.id,
						label: candidate.label,
						description: `${candidate.provider}/${candidate.model} reasoning=${candidate.thinkingLevel} ${rolePolicy}`,
					};
				}),
			});
			if (!selected) {
				this.addSystemMessage(`Kept ${formatScopeLabel(projectId)} mode ${formatSolistMode(mode)}.`);
				return;
			}
			await this.applyModeSelection(selected.value, projectId);
			return;
		}
		if (!isSolistModeId(modeArg)) {
			this.addSystemMessage(`Expected mode: ${SOLIST_MODE_IDS.join(", ")}.`);
			return;
		}
		await this.applyModeSelection(modeArg, projectId);
	}

	private async applyModeSelection(
		modeArg: string,
		projectId?: number | string,
	): Promise<void> {
		if (!isSolistModeId(modeArg)) {
			this.addSystemMessage(`Expected mode: ${SOLIST_MODE_IDS.join(", ")}.`);
			return;
		}
		const config = readSolistConfig();
		writeSolistConfig(setSolistActiveMode(config, modeArg, projectId));
		if (!this.createHarnessForMode) {
			this.addSystemMessage(
				`Persisted ${formatScopeLabel(projectId)} mode ${formatSolistMode(getSolistMode(modeArg))}. Restart Solist for this running session to use the new model, reasoning, prompt, and tool profile.`,
			);
			return;
		}
		try {
			await this.switchHarnessMode(modeArg, projectId);
			this.addSystemMessage(`Switched running session and persisted ${formatScopeLabel(projectId)} mode ${formatSolistMode(getSolistMode(modeArg))}.`);
		} catch (error) {
			this.addSystemMessage(
				`Mode switch failed after persisting config: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async handleRolesCommand(
		action: "list" | "doctor" = "list",
		projectSelector?: string,
	): Promise<void> {
		let projectId: number | string | undefined;
		try {
			projectId = await this.resolveProjectSelector(projectSelector);
		} catch (error) {
			this.addSystemMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		const config = readSolistConfig();
		if (action === "doctor") {
			try {
				const agentTools = await listSoloAgentTools();
				const lines = [
					`Solist role binding doctor (${formatScopeLabel(projectId)}):`,
					`Available Solo agent tools: ${formatAgentToolChoices(agentTools) || "none"}`,
				];
				for (const roleId of SOLIST_ROLE_IDS) {
					const resolution = resolveRoleBinding({
						roleId,
						config,
						availableAgentTools: agentTools,
						projectId,
						sessionOverrides: this.sessionRoleOverrides,
					});
					if (resolution.status === "selected") {
						lines.push(`  ${roleId}: ok -> ${resolution.agentTools.map((agentTool) => `${agentTool.id} (${agentTool.name})`).join(", ")} [${resolution.source}]`);
					} else {
						lines.push(`  ${roleId}: missing -> ${resolution.reason}`);
					}
				}
				this.addSystemMessage(lines.join("\n"));
			} catch (error) {
				this.addSystemMessage(
					`Roles doctor failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		await this.showRoleManager(projectId);
	}

	private async handleRoleMenuCommand(projectSelector?: string): Promise<void> {
		let projectId: number | string | undefined;
		try {
			projectId = await this.resolveProjectSelector(projectSelector);
		} catch (error) {
			this.addSystemMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		await this.showRoleActionFlow(projectId);
	}

	private async handleRoleCommand(
		action: "set" | "unset" | "override" | "switch",
		roleSelection?: string,
		agentSelection?: string,
		projectSelector?: string,
	): Promise<void> {
		if (this.activeTurn || this.activeAuth) {
			this.addSystemMessage("Wait for the current turn or authentication flow to finish before changing role bindings.");
			return;
		}
		let projectId: number | string | undefined;
		try {
			projectId = await this.resolveProjectSelector(projectSelector);
		} catch (error) {
			this.addSystemMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		let roleId = roleSelection ? resolveSolistRoleId(roleSelection) : undefined;
		if (!roleId) {
			roleId = await this.pickRole(projectId, `Select role for /role ${action}`);
			if (!roleId) {
				this.addSystemMessage("Role command cancelled.");
				return;
			}
		}

		if (action === "unset") {
			const config = readSolistConfig();
			writeSolistConfig(unsetSolistRoleBinding(config, roleId, projectId));
			const { [roleId]: _removed, ...rest } = this.sessionRoleOverrides;
			this.sessionRoleOverrides = rest;
			this.addSystemMessage(`${formatScopeLabel(projectId)} role ${roleId} binding removed.`);
			return;
		}

		if (!agentSelection) {
			const agentTools = await this.pickAgentTools(roleId, action, projectId);
			if (!agentTools) {
				this.addSystemMessage("Role command cancelled.");
				return;
			}
			if (agentTools.length === 0) {
				this.addSystemMessage("No Solo agents selected. Use /role unset to clear a role mapping.");
				return;
			}
			await this.applyRoleAgentSelection(action, roleId, agentTools, projectId);
			return;
		}

		try {
			const agentTools = await listSoloAgentTools();
			const selectedAgentTools = resolveAgentToolSelections(agentSelection, agentTools);
			if (selectedAgentTools.length === 0) {
				this.addSystemMessage(
					`No enabled Solo agent tool matched "${agentSelection}". Available: ${formatAgentToolChoices(agentTools)}.`,
				);
				return;
			}
			await this.applyRoleAgentSelection(action, roleId, selectedAgentTools, projectId);
		} catch (error) {
			this.addSystemMessage(
				`Role command failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async showRoleManager(projectId?: number | string): Promise<void> {
		const roleId = await this.pickRole(projectId, `Solist roles (${formatScopeLabel(projectId)})`);
		if (!roleId) {
			this.addSystemMessage("Role manager closed.");
			return;
		}
		await this.showRoleActionFlow(projectId, roleId);
	}

	private async showRoleActionFlow(
		projectId?: number | string,
		roleId?: SolistRoleId,
	): Promise<void> {
		const selectedRoleId = roleId ?? await this.pickRole(projectId, "Select a Solist role");
		if (!selectedRoleId) {
			this.addSystemMessage("Role command cancelled.");
			return;
		}
		const actionItem = await showSinglePicker(this.ui, this.activeTheme, {
			title: `Manage ${selectedRoleId}`,
			subtitle: SOLIST_ROLES[selectedRoleId].description,
			selectedValue: "set",
			items: [
				{ value: "set", label: "Persist mapping", description: `Save ${formatScopeLabel(projectId)} role agents` },
				{ value: "switch", label: "Session switch", description: "Use selected agents for this Solist process only" },
				{ value: "override", label: "Session override", description: "Alias for a session-only role switch" },
				{ value: "unset", label: "Clear mapping", description: `Remove ${formatScopeLabel(projectId)} mapping and session override` },
			],
		});
		if (!actionItem) {
			this.addSystemMessage("Role command cancelled.");
			return;
		}
		const action = actionItem.value as "set" | "unset" | "override" | "switch";
		if (action === "unset") {
			const config = readSolistConfig();
			writeSolistConfig(unsetSolistRoleBinding(config, selectedRoleId, projectId));
			const { [selectedRoleId]: _removed, ...rest } = this.sessionRoleOverrides;
			this.sessionRoleOverrides = rest;
			this.addSystemMessage(`${formatScopeLabel(projectId)} role ${selectedRoleId} binding removed.`);
			return;
		}
		const agentTools = await this.pickAgentTools(selectedRoleId, action, projectId);
		if (!agentTools) {
			this.addSystemMessage("Role command cancelled.");
			return;
		}
		if (agentTools.length === 0) {
			this.addSystemMessage("No Solo agents selected. Use clear mapping to remove a role mapping.");
			return;
		}
		await this.applyRoleAgentSelection(action, selectedRoleId, agentTools, projectId);
	}

	private async pickRole(
		projectId: number | string | undefined,
		title: string,
	): Promise<SolistRoleId | undefined> {
		const config = readSolistConfig();
		const selected = await showSinglePicker(this.ui, this.activeTheme, {
			title,
			subtitle: "Arrow keys select a role.",
			items: SOLIST_ROLE_IDS.map((roleId) => {
				const projectBinding = projectId === undefined
					? undefined
					: config.projectOverrides[String(projectId)]?.roleBindings?.[roleId];
				const globalBinding = config.roleBindings[roleId];
				const override = this.sessionRoleOverrides[roleId];
				const binding = override ?? projectBinding ?? globalBinding;
				const source = override
					? "session"
					: projectBinding
						? "project"
						: globalBinding
							? "global"
							: "unconfigured";
				return {
					value: roleId,
					label: SOLIST_ROLES[roleId].label,
					description: `${source}: ${formatRoleBindingSet(binding)}`,
				};
			}),
		});
		return selected ? resolveSolistRoleId(selected.value) : undefined;
	}

	private async pickAgentTools(
		roleId: SolistRoleId,
		action: "set" | "override" | "switch",
		projectId?: number | string,
	): Promise<Array<{ id: number; name: string; enabled?: boolean }> | undefined> {
		try {
			const agentTools = await listSoloAgentTools();
			const selectedValues = this.getSelectedAgentToolValues(roleId, agentTools, projectId, action);
			const selected = await showMultiPicker(this.ui, this.activeTheme, {
				title: `Select Solo agents for ${roleId}`,
				subtitle: `${action === "set" ? "Persisted" : "Session-only"} mapping. Multiple agents can be selected.`,
				selectedValues,
				items: agentTools.map((agentTool): SolistPickerItem => ({
					value: String(agentTool.id),
					label: `${agentTool.id} ${agentTool.name}`,
					description: agentTool.enabled === false ? "disabled" : "enabled",
					disabled: agentTool.enabled === false,
				})),
				emptyText: "No Solo agent tools are configured.",
			});
			if (!selected) {
				return undefined;
			}
			return selected.flatMap((item) => {
				const id = Number(item.value);
				const tool = agentTools.find((agentTool) => agentTool.id === id);
				return tool ? [tool] : [];
			});
		} catch (error) {
			this.addSystemMessage(
				`Role picker failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	private getSelectedAgentToolValues(
		roleId: SolistRoleId,
		agentTools: ReadonlyArray<{ id: number; name: string; enabled?: boolean }>,
		projectId: number | string | undefined,
		action: "set" | "override" | "switch",
	): string[] {
		const config = readSolistConfig();
		const resolution = resolveRoleBinding({
			roleId,
			config,
			availableAgentTools: agentTools,
			projectId,
			sessionOverrides: action === "set" ? undefined : this.sessionRoleOverrides,
		});
		return resolution.status === "selected"
			? resolution.agentTools.map((agentTool) => String(agentTool.id))
			: [];
	}

	private async applyRoleAgentSelection(
		action: "set" | "override" | "switch",
		roleId: SolistRoleId,
		agentTools: ReadonlyArray<{ id: number; name: string; enabled?: boolean }>,
		projectId?: number | string,
	): Promise<void> {
		const enabledAgentTools = agentTools.filter((agentTool) => agentTool.enabled !== false);
		const bindings = bindingsForAgentTools(enabledAgentTools);
		const bindingSet = { agents: bindings };
		if (action === "override" || action === "switch") {
			this.sessionRoleOverrides = { ...this.sessionRoleOverrides, [roleId]: bindingSet };
			this.addSystemMessage(`Session role switch: role ${roleId} maps to Solo agents ${formatAgentTools(enabledAgentTools)}.`);
			return;
		}
		const config = readSolistConfig();
		writeSolistConfig(setSolistRoleBindings(config, roleId, bindings, projectId));
		this.addSystemMessage(`${formatScopeLabel(projectId)} role ${roleId} now maps to Solo agents ${formatAgentTools(enabledAgentTools)}.`);
	}

	private async handleResumeCommand(sessionSelection?: string): Promise<void> {
		if (this.activeTurn || this.activeAuth) {
			this.addSystemMessage("Wait for the current turn or authentication flow to finish before resuming another conversation.");
			return;
		}
		if (!this.createHarnessForMode) {
			this.addSystemMessage("This Solist harness cannot rebuild itself for resumed conversations.");
			return;
		}

		let session: SolistSession | undefined;
		try {
			session = sessionSelection && sessionSelection !== "latest"
				? this.readSession(sessionSelection)
				: undefined;
			if (sessionSelection === "latest") {
				session = this.listResumeSessions()[0];
			}
			if (!sessionSelection) {
				session = await this.pickSession();
			}
		} catch (error) {
			this.addSystemMessage(`Session read failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (!session) {
			this.addSystemMessage(sessionSelection
				? `No Solist session found for "${sessionSelection}".`
				: "Resume cancelled.");
			return;
		}
		if (this.session?.id !== session.id && this.harness.messages.length > 0) {
			const confirmed = await this.confirmResumeReplace(session);
			if (!confirmed) {
				this.addSystemMessage("Resume cancelled.");
				return;
			}
		}
		await this.resumeSession(session);
	}

	private async pickSession(): Promise<SolistSession | undefined> {
		const sessions = this.listResumeSessions();
		if (sessions.length === 0) {
			return undefined;
		}
		const selected = await showSinglePicker(this.ui, this.activeTheme, {
			title: "Resume Solist conversation",
			subtitle: "Recent sessions from ~/.solist/sessions.",
			selectedValue: this.session?.id,
			items: sessions.map((session) => ({
				value: session.id,
				label: session.title,
				description: `${session.updatedAt} mode=${session.modeId} messages=${session.messages.length}`,
			})),
		});
		if (!selected) {
			return undefined;
		}
		return this.readSession(selected.value);
	}

	private listResumeSessions(): readonly SolistSession[] {
		const currentId = this.session?.id;
		return this.listSessions().filter((session) => session.id !== currentId);
	}

	private async confirmResumeReplace(session: SolistSession): Promise<boolean> {
		const selected = await showSinglePicker(this.ui, this.activeTheme, {
			title: "Replace current conversation?",
			subtitle: `Resume "${session.title}" with ${session.messages.length} stored messages.`,
			selectedValue: "resume",
			items: [
				{ value: "resume", label: "Resume selected", description: "Replace the visible and model conversation context" },
				{ value: "cancel", label: "Cancel", description: "Keep the current conversation" },
			],
			maxVisible: 2,
		});
		return selected?.value === "resume";
	}

	private async resumeSession(session: SolistSession): Promise<void> {
		const previousHarness = this.harness;
		const previousUnsubscribe = this.unsubscribe;
		const nextHarness = await this.createHarnessForMode!(session.modeId, {
			messages: [...session.messages],
			projectId: session.projectId,
		});
		previousUnsubscribe?.();
		this.harness = nextHarness;
		this.activeTheme = createSolistAnsiTheme(getSolistMode(nextHarness.modeId ?? session.modeId));
		this.editor.borderColor = this.activeTheme.border;
		this.unsubscribe = nextHarness.subscribe((event) => this.renderEvent(event));
		await previousHarness.close?.();
		this.session = session;
		this.chat.clear();
		this.renderStoredMessages(session.messages);
		this.addSystemMessage(`Resumed Solist session ${session.id}: ${session.title}`);
		this.setStatusState("Ready");
		this.setAgentState("idle");
		this.ui.requestRender(true);
	}

	private async switchHarnessMode(modeId: SolistModeId, projectId?: number | string): Promise<void> {
		if (!this.createHarnessForMode) return;
		const previousHarness = this.harness;
		const previousUnsubscribe = this.unsubscribe;
		const nextHarness = await this.createHarnessForMode(modeId, {
			messages: previousHarness.messages,
			projectId,
		});
		previousUnsubscribe?.();
		this.harness = nextHarness;
		this.activeTheme = createSolistAnsiTheme(getSolistMode(nextHarness.modeId ?? modeId));
		this.editor.borderColor = this.activeTheme.border;
		this.unsubscribe = nextHarness.subscribe((event) => this.renderEvent(event));
		await previousHarness.close?.();
		this.saveSessionSnapshot();
		this.setStatusState("Ready");
		this.setAgentState("idle");
		this.ui.requestRender();
	}

	private async resolveProjectSelector(selector?: string): Promise<number | string | undefined> {
		if (!selector) {
			return undefined;
		}
		const projectId = await this.resolveProjectId(selector);
		if (projectId === undefined) {
			throw new Error("Could not detect the current Solo project. Use --project=<id> explicitly.");
		}
		return projectId;
	}

	private withSessionRoleOverrides(prompt: string): string {
		const lines = Object.entries(this.sessionRoleOverrides).map(([roleId, binding]) =>
			`- ${roleId} -> ${formatRoleBindingSet(binding)}`);
		if (lines.length === 0) {
			return prompt;
		}
		return [
			"Session role overrides for this Solist process:",
			...lines,
			"",
			prompt,
		].join("\n");
	}

	private getCommandContext(): SolistInteractiveCommandContext {
		return {
			status: {
				provider: this.harness.modelRef.provider,
				model: this.harness.modelRef.model,
				thinkingLevel: this.harness.thinkingLevel,
				cwd: this.cwd,
				soloMcpAvailable: this.soloMcpAvailable,
				messageCount: this.harness.messages.length,
				toolCount: this.harness.tools.length,
			},
			tools: this.harness.tools,
		};
	}

	private async handleLoginCommand(providerArg?: string): Promise<void> {
		const provider = this.resolvePinnedAuthProvider(providerArg, "/login");
		if (!provider) return;
		if (this.activeTurn) {
			this.addSystemMessage("Wait for the current turn to finish before logging in.");
			return;
		}
		if (this.activeAuth) {
			this.addSystemMessage("Authentication is already in progress.");
			return;
		}
		if (!this.harness.login) {
			this.addSystemMessage("This Solist harness does not expose login support.");
			return;
		}

		const authPath = this.getAuthPath();
		let providerName = provider;
		try {
			providerName = await this.getProviderName(provider);
		} catch (error) {
			this.addSystemMessage(
				`Login failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		this.activeAuth = true;
		this.activeAuthAbort = new AbortController();
		this.setStatusState("Authenticating");
		this.addSystemMessage(
			`Starting ${providerName} login. Credentials will be saved to ${authPath}.`,
		);

		try {
			await this.harness.login(provider, this.createLoginCallbacks());
			this.resolveActiveAuthInput("", { silent: true });
			this.addSystemMessage(`Logged in to ${providerName}. Credentials saved to ${authPath}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== "Login cancelled") {
				this.addSystemMessage(`Login failed: ${message}`);
			}
		} finally {
			this.activeAuth = false;
			this.activeAuthAbort = undefined;
			this.activeAuthInput = undefined;
			this.setStatusState("Ready");
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	private async handleLogoutCommand(providerArg?: string): Promise<void> {
		const provider = this.resolvePinnedAuthProvider(providerArg, "/logout");
		if (!provider) return;
		if (this.activeTurn || this.activeAuth) {
			this.addSystemMessage("Wait for the current turn or authentication flow to finish before logging out.");
			return;
		}
		if (!this.harness.logout) {
			this.addSystemMessage("This Solist harness does not expose logout support.");
			return;
		}

		try {
			const providerName = await this.getProviderName(provider);
			await this.harness.logout(provider);
			this.addSystemMessage(
				`Logged out of ${providerName}. Removed stored credentials from ${this.getAuthPath()}.`,
			);
		} catch (error) {
			this.addSystemMessage(
				`Logout failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private createLoginCallbacks(): OAuthLoginCallbacks {
		return {
			onAuth: (info) => {
				openBrowser(info.url);
				this.addSystemMessage(
					[
						"Open this authentication URL:",
						info.url,
						info.instructions ?? "Complete login in the browser to finish.",
					].join("\n"),
				);
			},
			onPrompt: (prompt) =>
				this.promptForAuthInput(
					prompt.placeholder
						? `${prompt.message}\n${prompt.placeholder}`
						: prompt.message,
				),
			onProgress: (message) => {
				this.addSystemMessage(message);
			},
			onManualCodeInput: () =>
				this.promptForAuthInput(
					"Paste the redirect URL or authorization code below, or complete login in the browser:",
				),
			onSelect: (prompt) => this.promptForAuthSelection(prompt),
			signal: this.activeAuthAbort?.signal,
		};
	}

	private promptForAuthInput(message: string): Promise<string> {
		this.addSystemMessage(message);
		this.editor.disableSubmit = false;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();

		return new Promise((resolve, reject) => {
			this.activeAuthInput = {
				resolve: (value) => {
					this.activeAuthInput = undefined;
					resolve(value.trim());
				},
				reject: (error) => {
					this.activeAuthInput = undefined;
					reject(error);
				},
			};
		});
	}

	private async promptForAuthSelection(prompt: OAuthSelectPrompt): Promise<string | undefined> {
		const optionsText = prompt.options
			.map((option) => `${option.id}: ${option.label}`)
			.join("\n");
		const input = await this.promptForAuthInput(`${prompt.message}\n${optionsText}`);
		const normalized = input.trim().toLowerCase();
		return prompt.options.find((option) =>
			option.id.toLowerCase() === normalized
			|| option.label.toLowerCase() === normalized
		)?.id;
	}

	private resolveActiveAuthInput(
		input: string,
		options: { silent?: boolean } = {},
	): void {
		const waiter = this.activeAuthInput;
		if (!waiter) return;
		waiter.resolve(input);
		if (!options.silent) {
			this.addSystemMessage("Authentication input received.");
		}
	}

	private cancelActiveAuth(): void {
		this.activeAuthAbort?.abort();
		this.activeAuthInput?.reject(new Error("Login cancelled"));
		this.activeAuthInput = undefined;
		this.activeAuth = false;
		this.activeAuthAbort = undefined;
		this.setStatusState("Ready");
		this.addSystemMessage("Authentication cancelled.");
	}

	private resolvePinnedAuthProvider(
		providerArg: string | undefined,
		command: "/login" | "/logout",
	): string | undefined {
		const provider = providerArg?.trim().toLowerCase() || SOLIST_MODEL_PROVIDER;
		if (provider !== SOLIST_MODEL_PROVIDER) {
			this.addSystemMessage(
				`Solist is pinned to ${SOLIST_MODEL_PROVIDER}; ${command} only supports that provider.`,
			);
			return undefined;
		}
		return provider;
	}

	private async getProviderName(provider: string): Promise<string> {
		return this.harness.getProviderName?.(provider) ?? provider;
	}

	private getAuthPath(): string {
		return this.harness.authPath ?? getSolistAuthPath();
	}

	private renderEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.setAgentState("thinking");
				break;
			case "agent_end":
				this.setAgentState("idle");
				break;
			case "turn_start":
				this.setAgentState("thinking");
				break;
			case "turn_end":
				if (this.activeTurn) this.setAgentState("thinking");
				break;
			case "message_start":
				this.renderMessageStart(event.message);
				break;
			case "message_update":
				this.renderAssistantUpdate(event.assistantMessageEvent);
				break;
			case "message_end":
				this.renderMessageEnd(event.message);
				break;
			case "tool_execution_start":
				this.setAgentState("running tool");
				this.setStatusState(`Running ${event.toolName}`);
				this.addToolMessage(
					`${event.toolName} started ${summarizeValue(event.args)}`,
				);
				break;
			case "tool_execution_update":
				this.addToolMessage(
					`${event.toolName} update ${summarizeValue(event.partialResult)}`,
				);
				break;
			case "tool_execution_end":
				this.setAgentState(this.activeTurn ? "thinking" : "idle");
				this.setStatusState(this.activeTurn ? "Working" : "Ready");
				this.addToolMessage(
					`${event.toolName} ${event.isError ? "failed" : "completed"} ${summarizeValue(event.result)}`,
				);
				break;
		}
		this.ui.requestRender();
	}

	private renderMessageStart(message: AgentMessage): void {
		if (message.role === "user") {
			this.chat.addChild(new Spacer(1));
			this.chat.addChild(createUserMessage(stripSessionRoleOverrideContext(extractMessageText(message)), this.activeTheme));
			return;
		}

		if (message.role === "assistant") {
			this.chat.addChild(new Spacer(1));
			const placeholder = createThinkingPlaceholder(this.ui, this.activeTheme);
			const component = new Markdown("", 1, 0, this.activeTheme.markdown);
			this.chat.addChild(placeholder);
			this.chat.addChild(component);
			this.currentAssistant = { text: "", component, placeholder };
			this.setAgentState("thinking");
		}
	}

	private renderMessageEnd(message: AgentMessage): void {
		if (message.role !== "assistant") return;

		const errorMessage = "errorMessage" in message
			&& typeof message.errorMessage === "string"
			? message.errorMessage
			: "";
		if (errorMessage) {
			this.addSystemMessage(`Error: ${errorMessage}`);
		}
		this.clearCurrentAssistant();
	}

	private renderAssistantUpdate(event: AssistantMessageEvent): void {
		if (event.type === "thinking_start" || event.type === "thinking_delta") {
			this.setAgentState("thinking");
			this.ensureAssistantPlaceholder();
			return;
		}

		if (event.type === "text_delta") {
			if (!this.currentAssistant) {
				this.chat.addChild(new Spacer(1));
				const component = new Markdown("", 1, 0, this.activeTheme.markdown);
				this.chat.addChild(component);
				this.currentAssistant = { text: "", component };
			}
			this.removeAssistantPlaceholder();
			this.setAgentState("streaming");
			this.currentAssistant.text += event.delta;
			this.currentAssistant.component.setText(this.currentAssistant.text);
			return;
		}

		if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
			this.setAgentState("thinking");
			this.ensureAssistantPlaceholder();
			return;
		}

		if (event.type === "toolcall_end") {
			this.removeAssistantPlaceholder();
			this.setAgentState("running tool");
			this.addToolMessage(
				`call ${event.toolCall.name} ${summarizeValue(event.toolCall.arguments)}`,
			);
		}
	}

	private addSystemMessage(message: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Markdown(message, 1, 0, this.activeTheme.markdown));
		this.updateStatusLine();
		this.ui.requestRender();
	}

	private addToolMessage(message: string): void {
		this.chat.addChild(new Text(this.activeTheme.muted(`[tool] ${message}`), 1, 0));
		this.updateStatusLine();
		this.ui.requestRender();
	}

	private renderStoredMessages(messages: readonly AgentMessage[]): void {
		for (const message of messages) {
			const text = message.role === "user"
				? stripSessionRoleOverrideContext(extractMessageText(message))
				: extractMessageText(message);
			if (!text) {
				continue;
			}
			this.chat.addChild(new Spacer(1));
			if (message.role === "user") {
				this.chat.addChild(createUserMessage(text, this.activeTheme));
			} else if (message.role === "assistant") {
				this.chat.addChild(new Markdown(text, 1, 0, this.activeTheme.markdown));
			} else {
				this.chat.addChild(new Text(this.activeTheme.muted(`[${message.role}] ${text}`), 1, 0));
			}
		}
	}

	private saveSessionSnapshot(): void {
		if (!this.session) {
			return;
		}
		this.session = updateSolistSession(this.session, {
			messages: [...this.harness.messages],
			modeId: getSolistMode(this.harness.modeId).id,
			projectId: this.harness.projectId ?? this.session.projectId,
		});
		try {
			this.writeSession(this.session);
		} catch (error) {
			this.addSystemMessage(
				`Session save failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private setStatusState(state: string): void {
		this.statusState = state;
		this.updateStatusLine();
	}

	private setAgentState(state: AgentActivityState): void {
		this.agentState = state;
		this.updateStatusLine();
	}

	private ensureAssistantPlaceholder(): void {
		if (!this.currentAssistant) {
			const placeholder = createThinkingPlaceholder(this.ui, this.activeTheme);
			const component = new Markdown("", 1, 0, this.activeTheme.markdown);
			this.chat.addChild(new Spacer(1));
			this.chat.addChild(placeholder);
			this.chat.addChild(component);
			this.currentAssistant = { text: "", component, placeholder };
			return;
		}
		if (!this.currentAssistant.placeholder && !this.currentAssistant.text) {
			const placeholder = createThinkingPlaceholder(this.ui, this.activeTheme);
			this.chat.removeChild(this.currentAssistant.component);
			this.chat.addChild(placeholder);
			this.chat.addChild(this.currentAssistant.component);
			this.currentAssistant.placeholder = placeholder;
		}
	}

	private removeAssistantPlaceholder(): void {
		const currentAssistant = this.currentAssistant;
		const placeholder = currentAssistant?.placeholder;
		if (!placeholder) return;
		placeholder.stop();
		this.chat.removeChild(placeholder);
		currentAssistant.placeholder = undefined;
	}

	private clearCurrentAssistant(): void {
		this.removeAssistantPlaceholder();
		this.currentAssistant = undefined;
	}

	private updateStatusLine(): void {
		const model = `${this.harness.modelRef.provider}/${this.harness.modelRef.model}`;
		const solo = this.soloMcpAvailable
			? this.activeTheme.success("solo:ok")
			: this.activeTheme.error("solo:down");
		const cwdName = basename(this.cwd) || this.cwd;
		const line = [
			colorStatusState(this.statusState, this.activeTheme),
			colorAgentState(this.agentState, this.activeTheme),
			this.activeTheme.accent(model),
			this.activeTheme.reasoning(`reasoning:${this.harness.thinkingLevel}`),
			this.activeTheme.dim(`messages:${this.harness.messages.length}`),
			this.activeTheme.dim(`tools:${this.harness.tools.length}`),
			solo,
			this.activeTheme.dim(`cwd:${cwdName}`),
		].join(" | ");
		this.status.clear();
		this.status.addChild(new TruncatedText(line, 1, 0));
		this.ui.requestRender();
	}

	private handleInterruptOrExit(): void {
		if (this.activeTurn || this.harness.isStreaming) {
			if (!this.interruptRequested) {
				this.interruptRequested = true;
				this.addSystemMessage("Aborting active turn...");
				this.harness.abort();
			}
			return;
		}

		void this.stop();
	}

	private async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.clearCurrentAssistant();
		this.saveSessionSnapshot();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.editor.disableSubmit = true;
		const resolve = this.resolveRun;
		this.resolveRun = undefined;
		try {
			this.ui.stop();
			await this.terminal.drainInput(100, 25);
			await this.harness.close?.();
		} finally {
			resolve?.();
		}
	}
}

function extractMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";

	const contentValue = message.content;
	if (typeof contentValue === "string") return contentValue;
	if (Array.isArray(contentValue)) {
		return contentValue
			.flatMap((content) =>
				content.type === "text" && typeof content.text === "string"
					? [content.text]
					: []
			)
			.join("");
	}
	return "";
}

function createUserMessage(text: string, theme: SolistAnsiTheme): Component {
	return new Text(text, 1, 1, theme.userBackground);
}

function createThinkingPlaceholder(ui: TUI, theme: SolistAnsiTheme): Loader {
	const placeholder = new Loader(ui, theme.accent, theme.dim, "Thinking...");
	placeholder.start();
	return placeholder;
}

function summarizeValue(value: unknown): string {
	const json = safeJson(value);
	if (json.length <= 360) return json;
	return `${json.slice(0, 357)}...`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

type AgentActivityState =
	| "idle"
	| "thinking"
	| "streaming"
	| "running tool";

interface AuthInputWaiter {
	resolve(value: string): void;
	reject(error: Error): void;
}

class SolistWelcomeBanner implements Component {
	constructor(private readonly getTheme: () => SolistAnsiTheme) {}

	invalidate(): void {}

	render(_width: number): string[] {
		const theme = this.getTheme();
		return [
			...getSolistAsciiArt(theme),
			theme.dim("   Solo orchestration agent"),
			theme.dim("   Type /help for commands, /exit to quit."),
		];
	}
}

function colorStatusState(state: string, theme: SolistAnsiTheme): string {
	if (state === "Ready") return theme.success("Solist Ready");
	if (state === "Working") return theme.accent("Solist Working");
	if (state.startsWith("Running ")) return theme.warning(`Solist ${state}`);
	return theme.dim(`Solist ${state}`);
}

function colorAgentState(state: AgentActivityState, theme: SolistAnsiTheme): string {
	const text = `agent:${state}`;
	if (state === "idle") return theme.dim(text);
	if (state === "thinking") return theme.warning(text);
	if (state === "streaming") return theme.accent(text);
	return theme.warning(text);
}

function formatScopeLabel(projectId?: number | string): string {
	return projectId === undefined ? "global" : `project ${projectId}`;
}

function formatAgentTools(
	agentTools: ReadonlyArray<{ id: number; name: string }>,
): string {
	return agentTools.map((agentTool) => `${agentTool.id} (${agentTool.name})`).join(", ");
}

async function resolveDefaultProjectId(selector: string): Promise<number | string | undefined> {
	if (selector === "current") {
		return getCurrentSoloProjectId();
	}
	const numeric = Number(selector);
	return Number.isInteger(numeric) && numeric > 0 ? numeric : selector;
}

function getSolistAsciiArt(theme: SolistAnsiTheme): readonly string[] {
	return [
		theme.accent("  ____        _ _     _"),
		theme.accent(" / ___|  ___ | (_)___| |_"),
		theme.accent(" \\___ \\ / _ \\| | / __| __|"),
		theme.accent("  ___) | (_) | | \\__ \\ |_"),
		theme.accent(" |____/ \\___/|_|_|___/\\__|"),
	];
}

function openBrowser(url: string): void {
	const command = process.platform === "darwin"
		? "open"
		: process.platform === "win32"
		? "cmd"
		: "xdg-open";
	const args = process.platform === "win32"
		? ["/c", "start", "", url]
		: [url];

	try {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// The URL is rendered in the terminal, so failing to auto-open is non-fatal.
	}
}
