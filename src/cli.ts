#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
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
import { createSoloMcpToolSet } from "./soloMcpDirect.js";
import { SolistInteractiveMode } from "./interactive/SolistInteractiveMode.js";
import { isSolistInteractiveExitCommand } from "./interactive/SolistCommandRouter.js";

export const SOLIST_HARNESS_FLAG = "--harness";
export const SOLIST_HARNESS_ENV = "SOLIST_HARNESS";
export const SOLIST_LEGACY_WRAPPER_FLAG = "--legacy-wrapper";
export const SOLIST_LEGACY_WRAPPER_ENV = "SOLIST_LEGACY_WRAPPER";

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
  solist --help       Show this help

Compatibility:
  ${SOLIST_HARNESS_FLAG} and ${SOLIST_HARNESS_ENV}=1 are accepted as no-op compatibility selectors for the default harness path.
  ${SOLIST_LEGACY_WRAPPER_FLAG} or ${SOLIST_LEGACY_WRAPPER_ENV}=1 selects the temporary legacy wrapper fallback.

The default harness forces ${SOLIST_MODEL_PATTERN} with ${SOLIST_THINKING_LEVEL} reasoning, Solist-owned read-only local tools, and explicit Solo MCP tools.
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

async function runHarnessPath(args: readonly string[]): Promise<void> {
  const prompt = stripRuntimeSelectorArgs(args).join(" ").trim()
    || (!stdin.isTTY ? await readPromptFromStdin() : "");
  if (!prompt && !stdin.isTTY) {
    throw new Error(`The Solist harness path requires a prompt argument or stdin input.`);
  }

  if (stdin.isTTY) {
    const harness = await createDefaultHarness({ write: () => undefined });
    try {
      await runInteractiveChat(harness, prompt);
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

async function createDefaultHarness(output?: { write(chunk: string): void }): Promise<SolistHarness> {
  const soloMcp = writeSoloMcpRuntimeConfig();
  const readOnlyTools = await createSolistReadOnlyTools(process.cwd());
  const soloMcpToolSet = createSoloMcpToolSet(soloMcp);
  const tools = [
    ...readOnlyTools,
    ...soloMcpToolSet.tools,
  ];
  return new SolistHarness({
    modelRef: { provider: SOLIST_MODEL_PROVIDER, model: SOLIST_MODEL_ID },
    thinkingLevel: SOLIST_THINKING_LEVEL,
    systemPrompt: buildSolistSystemPrompt(["solo"]),
    tools,
    disposables: [() => soloMcpToolSet.close()],
    output,
  });
}

export function isInteractiveExitCommand(input: string): boolean {
  return isSolistInteractiveExitCommand(input);
}

export async function runInteractiveChat(
  harness: SolistHarness,
  initialPrompt = "",
): Promise<void> {
  await new SolistInteractiveMode(harness).run(initialPrompt);
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
