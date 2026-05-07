#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { main as piMain } from "@mariozechner/pi-coding-agent";
import { checkPiSessionFeasibility } from "./feasibility.js";
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
  assertNoPolicyToolOverrides,
  resolveSoloMcpAllowlist
} from "./orchestratorPolicy.js";
import { writeSoloMcpRuntimeConfig } from "./soloMcp.js";
import { solistStatusExtension } from "./statusExtension.js";

export function getHelpText(): string {
  return `solist

Usage:
  solist              Start the constrained Pi interactive session
  solist --check      Validate Pi SDK auth/model/session feasibility
  solist --help       Show this help

The interactive session forces ${SOLIST_MODEL_PATTERN} with ${SOLIST_THINKING_LEVEL} reasoning, read-only local tools, and the Solo MCP proxy.`;
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
  ];

  if (mcpConfigPath) {
    runtimeArgs.push("--mcp-config", mcpConfigPath);
  }

  return [...runtimeArgs, ...args];
}

export async function run(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--check")) {
    assertNoPolicyToolOverrides(args);
    const result = await checkPiSessionFeasibility();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  assertNoPolicyToolOverrides(args);
  const mcpRuntimeConfig = writeSoloMcpRuntimeConfig();

  await piMain(buildPiArgs(args, undefined, mcpRuntimeConfig.path), {
    extensionFactories: [solistStatusExtension]
  });
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
