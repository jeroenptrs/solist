#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// Temporary fallback note: keep the Pi wrapper import dynamic and isolated to
// --legacy-wrapper until the fallback is removed after the harness has soaked.
import type { main as piMainType } from "@earendil-works/pi-coding-agent";
import { checkHarnessRuntimeBoundary, checkPiSessionFeasibility } from "./feasibility.js";
import {
  buildSolistSystemPrompt,
  SOLIST_MODEL_ID,
  SOLIST_THINKING_LEVEL,
  SOLIST_MODEL_PATTERN,
  SOLIST_MODEL_PROVIDER
} from "./solistPrompt.js";
import {
  SOLIST_MCP_ALLOWLIST_ENV,
  SOLIST_ALLOWED_TOOLS,
  SOLIST_HARDENING_FLAGS,
  assertNoPolicyToolOverrides,
  resolveSoloMcpAllowlist
} from "./orchestratorPolicy.js";
import { writeSoloMcpRuntimeConfig } from "./soloMcp.js";
import { solistStatusExtension } from "./statusExtension.js";
import { createSolistReadOnlyTools } from "./harness/readOnlyTools.js";
import { SolistHarness } from "./harness/SolistHarness.js";
import {
  createDirectSoloMcpClient,
  createSoloMcpToolSet,
  getSoloMcpOperationsForProfile,
} from "./soloMcpDirect.js";
import { createSolistRoleDispatchTool } from "./harness/roleDispatchTool.js";
import { SolistInteractiveMode } from "./interactive/SolistInteractiveMode.js";
import { isSolistInteractiveExitCommand } from "./interactive/SolistCommandRouter.js";
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
  type SoloAgentToolReference,
  type SolistConfig,
} from "./solistConfig.js";
import {
  formatAgentToolChoices,
  getCurrentSoloProjectId,
  listSoloAgentTools,
} from "./soloAgentTools.js";
import {
  SOLIST_MODE_IDS,
  SOLIST_MODES,
  getSolistMode,
  isSolistModeId,
  formatSolistMode,
  type SolistModeId,
} from "./solistModes.js";
import {
  SOLIST_ROLE_IDS,
  SOLIST_ROLES,
  resolveSolistRoleId,
} from "./solistRoles.js";
import {
  createSolistSession,
  getLatestSolistSession,
  listSolistSessions,
  readSolistSession,
  writeSolistSession,
  type SolistSession,
} from "./solistSessions.js";

export const SOLIST_HARNESS_FLAG = "--harness";
export const SOLIST_HARNESS_ENV = "SOLIST_HARNESS";
export const SOLIST_LEGACY_WRAPPER_FLAG = "--legacy-wrapper";
export const SOLIST_LEGACY_WRAPPER_ENV = "SOLIST_LEGACY_WRAPPER";
export const SOLIST_VERSION = "0.1.0";

export function getHelpText(): string {
  return `solist

Usage:
  solist              Start an interactive Solist orchestration chat
  solist <prompt>     Send an initial prompt, then continue interactive chat
  solist --check      Validate model auth, Solo MCP reachability, and harness tool boundary
  solist --legacy-wrapper
                      Temporarily run the legacy Pi wrapper fallback
  solist --legacy-wrapper --check
                      Validate legacy Pi wrapper feasibility
  solist mode get [--project <id|current>]
                      Show the persisted Solist mode
  solist mode set <mode> [--project <id|current>]
                      Persist orchestration, analysis, or deep-analysis mode
  solist roles list [--project <id|current>]
                      Show orchestration subagent roles and configured Solo agent bindings
  solist roles set <role> <agent id or exact name> [--project <id|current>]
                      Persist a role-to-Solo-agent binding
  solist roles unset <role> [--project <id|current>]
                      Remove a persisted role binding
  solist roles doctor [--project <id|current>]
                      Validate persisted role bindings against Solo agent tools
  solist sessions list
                      List persisted local conversation sessions
  solist resume [latest|session-id]
                      Resume a persisted local conversation session
  solist --version    Show the Solist version
  solist --help       Show this help

Compatibility:
  ${SOLIST_HARNESS_FLAG} and ${SOLIST_HARNESS_ENV}=1 are accepted as no-op compatibility selectors for the default harness path.
  ${SOLIST_LEGACY_WRAPPER_FLAG} or ${SOLIST_LEGACY_WRAPPER_ENV}=1 selects the temporary legacy wrapper fallback.

The default orchestration mode uses ${SOLIST_MODEL_PATTERN} with ${SOLIST_THINKING_LEVEL} reasoning, Solist-owned read-only local tools, and explicit Solo MCP tools.
Interactive mode supports /login and /logout for Solist-owned Codex credentials in ~/.solist/auth.json, and stores resumable conversations in ~/.solist/sessions.
The default path does not call the Pi coding-agent main() wrapper.`;
}

function printHelp(): void {
  console.log(getHelpText());
}

export function buildPiArgs(
  args: readonly string[],
  mcpAllowlist = resolveSoloMcpAllowlist(process.env[SOLIST_MCP_ALLOWLIST_ENV]),
  mcpConfigPath?: string
): string[] {
  const runtimeArgs = [
    "--provider",
    SOLIST_MODEL_PROVIDER,
    "--model",
    SOLIST_MODEL_ID,
    "--thinking",
    SOLIST_THINKING_LEVEL,
    "--tools",
    SOLIST_ALLOWED_TOOLS.join(","),
    "--system-prompt",
    buildSolistSystemPrompt(mcpAllowlist),
    ...SOLIST_HARDENING_FLAGS
  ];

  if (mcpConfigPath) {
    runtimeArgs.push("--mcp-config", mcpConfigPath);
  }

  return [...runtimeArgs, ...args];
}

export async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const useLegacyWrapper = shouldUseLegacyWrapper(args);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(SOLIST_VERSION);
    return;
  }

  if (args.includes("--check")) {
    assertNoPolicyToolOverrides(args);
    const result = useLegacyWrapper
      ? await checkPiSessionFeasibility()
      : await checkHarnessRuntimeBoundary();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  assertNoPolicyToolOverrides(args);
  if (await maybeRunConfigCommand(stripRuntimeSelectorArgs(args))) {
    return;
  }
  if (useLegacyWrapper) await runLegacyWrapperPath(args);
  else await runHarnessPath(args);
}

export function shouldUseHarness(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !shouldUseLegacyWrapper(args, env);
}

export function shouldUseLegacyWrapper(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return args.includes(SOLIST_LEGACY_WRAPPER_FLAG) || env[SOLIST_LEGACY_WRAPPER_ENV] === "1";
}

export function stripRuntimeSelectorArgs(args: readonly string[]): string[] {
  return args.filter((arg) =>
    arg !== SOLIST_HARNESS_FLAG
    && arg !== SOLIST_LEGACY_WRAPPER_FLAG
  );
}

export async function maybeRunConfigCommand(args: readonly string[]): Promise<boolean> {
  const [scope, action, ...rest] = args;
  if (scope === "mode") {
    await runModeCommand(action, rest);
    return true;
  }
  if (scope === "roles") {
    await runRolesCommand(action, rest);
    return true;
  }
  if (scope === "sessions") {
    await runSessionsCommand(action);
    return true;
  }
  if (scope === "resume") {
    await runResumeCommand(action ?? "latest");
    return true;
  }
  return false;
}

async function runModeCommand(action = "get", args: readonly string[]): Promise<void> {
  const config = readSolistConfig();
  const scoped = await extractProjectOption(args);
  if (action === "get") {
    const mode = getSolistMode(getConfiguredSolistMode(config, scoped.projectId));
    console.log(`${formatScopeLabel(scoped.projectId)} mode: ${formatSolistMode(mode)}`);
    return;
  }

  if (action === "set") {
    const [modeId] = scoped.args;
    if (!modeId || !isSolistModeId(modeId)) {
      throw new Error(`Expected mode: ${SOLIST_MODE_IDS.join(", ")}.`);
    }
    writeSolistConfig(setSolistActiveMode(config, modeId, scoped.projectId));
    console.log(`Solist ${formatScopeLabel(scoped.projectId)} mode set to ${formatSolistMode(SOLIST_MODES[modeId])}.`);
    return;
  }

  throw new Error("Usage: solist mode get [--project <id|current>] | solist mode set <orchestration|analysis|deep-analysis> [--project <id|current>]");
}

async function runRolesCommand(action = "list", args: readonly string[]): Promise<void> {
  const config = readSolistConfig();
  const scoped = await extractProjectOption(args);
  if (action === "list") {
    console.log(formatRolesList(config, scoped.projectId));
    return;
  }

  if (action === "set") {
    const [roleSelection, ...agentParts] = scoped.args;
    const roleId = roleSelection ? resolveSolistRoleId(roleSelection) : undefined;
    const agentSelection = agentParts.join(" ").trim();
    if (!roleId || !agentSelection) {
      throw new Error("Usage: solist roles set <role> <agent id or exact name> [--project <id|current>]");
    }
    const agentTools = await listSoloAgentTools();
    const selectedAgentTools = resolveAgentToolSelections(agentSelection, agentTools);
    if (selectedAgentTools.length === 0) {
      throw new Error(
        `No enabled Solo agent tool matched "${agentSelection}". Available: ${formatAgentToolChoices(agentTools)}.`,
      );
    }
    writeSolistConfig(setSolistRoleBindings(config, roleId, bindingsForAgentTools(selectedAgentTools), scoped.projectId));
    console.log(`${formatScopeLabel(scoped.projectId)} role ${roleId} now maps to Solo agents ${selectedAgentTools.map((agentTool) => `${agentTool.id} (${agentTool.name})`).join(", ")}.`);
    return;
  }

  if (action === "unset") {
    const [roleSelection] = scoped.args;
    const roleId = roleSelection ? resolveSolistRoleId(roleSelection) : undefined;
    if (!roleId) {
      throw new Error("Usage: solist roles unset <role> [--project <id|current>]");
    }
    writeSolistConfig(unsetSolistRoleBinding(config, roleId, scoped.projectId));
    console.log(`${formatScopeLabel(scoped.projectId)} role ${roleId} binding removed.`);
    return;
  }

  if (action === "doctor") {
    const agentTools = await listSoloAgentTools();
    console.log(formatRolesDoctor(config, agentTools, scoped.projectId));
    return;
  }

  throw new Error("Usage: solist roles list | set <role> <agent> | unset <role> | doctor [--project <id|current>]");
}

async function runHarnessPath(args: readonly string[]): Promise<void> {
  const prompt = stripRuntimeSelectorArgs(args).join(" ").trim()
    || (!stdin.isTTY ? await readPromptFromStdin() : "");
  if (!prompt && !stdin.isTTY) {
    throw new Error(`The Solist harness path requires a prompt argument or stdin input.`);
  }

  if (stdin.isTTY) {
    const interactiveOutput = { write: () => undefined };
    const harness = await createDefaultHarness(interactiveOutput);
    const session = createSolistSession({
      cwd: process.cwd(),
      modeId: harness.modeId,
      projectId: harness.projectId,
      messages: [...harness.messages],
    });
    writeSolistSession(session);
    try {
      await runInteractiveChat(harness, prompt, {
        session,
        createHarnessForMode: (modeId, context) =>
          createDefaultHarness(interactiveOutput, {
            modeOverride: modeId,
            messages: [...context.messages],
            projectId: context.projectId,
          }),
      });
    } finally {
      await harness.close();
    }
    return;
  }

  const harness = await createDefaultHarness();
  try {
    if (prompt) {
      await harness.run(prompt);
      stdout.write("\n");
    }
  } finally {
    await harness.close();
  }
}

async function runResumeCommand(selector: string): Promise<void> {
  if (!stdin.isTTY) {
    throw new Error("solist resume requires an interactive terminal.");
  }
  const session = selector === "latest"
    ? getLatestSolistSession()
    : readSolistSession(selector);
  if (!session) {
    throw new Error(`No Solist session found for ${selector}.`);
  }
  const interactiveOutput = { write: () => undefined };
  const harness = await createDefaultHarness(interactiveOutput, {
    modeOverride: session.modeId,
    messages: [...session.messages],
    projectId: session.projectId,
  });
  try {
    await runInteractiveChat(harness, "", {
      session,
      createHarnessForMode: (modeId, context) =>
        createDefaultHarness(interactiveOutput, {
          modeOverride: modeId,
          messages: [...context.messages],
          projectId: context.projectId,
        }),
    });
  } finally {
    await harness.close();
  }
}

async function runSessionsCommand(action = "list"): Promise<void> {
  if (action !== "list") {
    throw new Error("Usage: solist sessions list");
  }
  const sessions = listSolistSessions();
  if (sessions.length === 0) {
    console.log("No Solist sessions found.");
    return;
  }
  console.log(formatSessionsList(sessions));
}

function formatRolesList(config: SolistConfig, projectId?: number | string): string {
  const lines = [
    `Solist orchestration roles (${formatScopeLabel(projectId)} effective bindings):`,
    ...SOLIST_ROLE_IDS.map((roleId) => {
      const projectBinding = projectId === undefined
        ? undefined
        : config.projectOverrides[String(projectId)]?.roleBindings?.[roleId];
      const globalBinding = config.roleBindings[roleId];
      const binding = projectBinding ?? globalBinding;
      const bindingText = binding
        ? ` -> ${formatRoleBindingSet(binding)} [${projectBinding ? "project" : "global"}]`
        : "";
      return `  ${roleId}: ${SOLIST_ROLES[roleId].description}${bindingText}`;
    }),
  ];
  return lines.join("\n");
}

function formatSessionsList(sessions: readonly SolistSession[]): string {
  return [
    "Solist sessions:",
    ...sessions.map((session) =>
      `  ${session.id}: ${session.title} [mode=${session.modeId}, messages=${session.messages.length}, updated=${session.updatedAt}]`
    ),
  ].join("\n");
}

function formatRolesDoctor(
  config: SolistConfig,
  agentTools: readonly SoloAgentToolReference[],
  projectId?: number | string,
): string {
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
    });
    if (resolution.status === "selected") {
      lines.push(`  ${roleId}: ok -> ${resolution.agentTools.map((agentTool) => `${agentTool.id} (${agentTool.name})`).join(", ")} [${resolution.source}]`);
    } else {
      lines.push(`  ${roleId}: missing -> ${resolution.reason}`);
    }
  }
  return lines.join("\n");
}

function formatRoleBindingLines(config: SolistConfig, projectId?: number | string): string[] {
  return SOLIST_ROLE_IDS.flatMap((roleId) => {
    const binding = projectId === undefined
      ? config.roleBindings[roleId]
      : config.projectOverrides[String(projectId)]?.roleBindings?.[roleId]
        ?? config.roleBindings[roleId];
    return binding ? [`${roleId} -> ${formatRoleBindingSet(binding)}`] : [];
  });
}

interface ProjectScopedArgs {
  readonly args: readonly string[];
  readonly projectId?: number | string;
}

async function extractProjectOption(args: readonly string[]): Promise<ProjectScopedArgs> {
  const remaining: string[] = [];
  let selector: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      const next = args[index + 1];
      if (next === "current" || (next !== undefined && /^\d+$/.test(next))) {
        selector = next;
        index += 1;
      } else {
        selector = "current";
      }
      continue;
    }
    if (arg.startsWith("--project=")) {
      selector = arg.slice("--project=".length) || "current";
      continue;
    }
    remaining.push(arg);
  }
  return {
    args: remaining,
    projectId: selector === undefined ? undefined : await resolveProjectSelector(selector),
  };
}

async function resolveProjectSelector(selector: string): Promise<number | string> {
  if (selector === "current") {
    const projectId = await getCurrentSoloProjectId();
    if (projectId === undefined) {
      throw new Error("Could not detect the current Solo project. Pass --project <id> explicitly.");
    }
    return projectId;
  }
  const numeric = Number(selector);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : selector;
}

function formatScopeLabel(projectId?: number | string): string {
  return projectId === undefined ? "global" : `project ${projectId}`;
}

interface CreateDefaultHarnessOptions {
  readonly modeOverride?: SolistModeId;
  readonly messages?: AgentMessage[];
  readonly projectId?: number | string;
}

async function createDefaultHarness(
  output?: { write(chunk: string): void },
  options: CreateDefaultHarnessOptions = {},
): Promise<SolistHarness> {
  const config = readSolistConfig();
  const projectId = await resolveDefaultHarnessProjectId(options.projectId);
  const mode = getSolistMode(options.modeOverride ?? getConfiguredSolistMode(config, projectId));
  const soloMcp = writeSoloMcpRuntimeConfig();
  const readOnlyTools = await createSolistReadOnlyTools(process.cwd());
  const soloMcpToolSet = createSoloMcpToolSet(soloMcp, {
    operations: getSoloMcpOperationsForProfile(mode.toolProfile),
  });
  const roleDispatchClient = mode.canSpawnRoles
    ? createDirectSoloMcpClient(soloMcp.config.mcpServers.solo)
    : undefined;
  const tools = [
    ...readOnlyTools,
    ...(roleDispatchClient
      ? [createSolistRoleDispatchTool(roleDispatchClient, { projectId })]
      : []),
    ...soloMcpToolSet.tools,
  ];
  return new SolistHarness({
    modelRef: { provider: mode.provider, model: mode.model },
    thinkingLevel: mode.thinkingLevel,
    modeId: mode.id,
    projectId,
    systemPrompt: buildSolistSystemPrompt({
      mcpAllowlist: ["solo"],
      mode,
      roleBindingLines: formatRoleBindingLines(config, projectId),
    }),
    tools,
    disposables: [
      () => soloMcpToolSet.close(),
      ...(roleDispatchClient ? [() => roleDispatchClient.close?.()] : []),
    ],
    output,
    messages: options.messages,
  });
}

export function isInteractiveExitCommand(input: string): boolean {
  return isSolistInteractiveExitCommand(input);
}

export async function runInteractiveChat(
  harness: SolistHarness,
  initialPrompt = "",
  options: ConstructorParameters<typeof SolistInteractiveMode>[1] = {},
): Promise<void> {
  await new SolistInteractiveMode(harness, options).run(initialPrompt);
}

async function resolveDefaultHarnessProjectId(
  projectId?: number | string,
): Promise<number | string | undefined> {
  if (projectId !== undefined) {
    return projectId;
  }
  try {
    return await getCurrentSoloProjectId();
  } catch {
    return undefined;
  }
}

async function runLegacyWrapperPath(args: readonly string[]): Promise<void> {
  const mcpRuntimeConfig = writeSoloMcpRuntimeConfig();
  const { main: piMain } = await import("@earendil-works/pi-coding-agent") as {
    main: typeof piMainType;
  };

  await piMain(buildPiArgs(stripRuntimeSelectorArgs(args), undefined, mcpRuntimeConfig.path), {
    extensionFactories: [solistStatusExtension]
  });
}

async function readPromptFromStdin(): Promise<string> {
  if (stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function isCliEntrypoint(
  moduleUrl: string,
  argvPath = process.argv[1]
): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href;
  }
}

if (isCliEntrypoint(import.meta.url)) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`solist: ${message}`);
    process.exitCode = 1;
  });
}
