export const SOLIST_LOCAL_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const SOLIST_MCP_TOOL = "mcp" as const;
export const SOLIST_ALLOWED_TOOLS = [...SOLIST_LOCAL_READ_ONLY_TOOLS, SOLIST_MCP_TOOL] as const;
export const SOLIST_DEFAULT_MCP_ALLOWLIST = ["solo"] as const;
export const SOLIST_MCP_ALLOWLIST_ENV = "SOLIST_MCP_ALLOWLIST";

const ORCHESTRATOR_BLOCKED_FLAGS = [
  "--tools",
  "--no-tools",
  "--no-builtin-tools",
  "--extensions",
  "--no-extensions",
  "--mcp-config",
  "-t",
  "-nt",
  "-nbt"
] as const;

export function splitCommaList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function resolveSoloMcpAllowlist(rawAllowlist = process.env[SOLIST_MCP_ALLOWLIST_ENV]): readonly string[] {
  const allowlist = splitCommaList(rawAllowlist ?? "");

  if (allowlist.length === 0) {
    return SOLIST_DEFAULT_MCP_ALLOWLIST;
  }

  const normalized = [...new Set(allowlist)];
  const nonSoloServers = normalized.filter((server) => server !== SOLIST_DEFAULT_MCP_ALLOWLIST[0]);

  if (nonSoloServers.length > 0) {
    throw new Error(
      `Orchestrator must expose Solo MCP only. Remove non-solo MCP servers: ${nonSoloServers.join(", ")}`
    );
  }

  return normalized;
}

export function assertNoPolicyToolOverrides(rawArgs: readonly string[]): void {
  const blocked: string[] = [];
  const flagsWithValues = new Set(["--tools", "-t", "--extensions", "--mcp-config"]);

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--tools" || arg === "-t") {
      blocked.push(arg);
      if (rawArgs[index + 1] && !rawArgs[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--tools=") || arg.startsWith("-t=")) {
      blocked.push(arg);
      continue;
    }

    if (arg.startsWith("--extensions=") || arg.startsWith("--mcp-config=")) {
      blocked.push(arg);
      continue;
    }

    if (ORCHESTRATOR_BLOCKED_FLAGS.includes(arg as (typeof ORCHESTRATOR_BLOCKED_FLAGS)[number])) {
      blocked.push(arg);
      if (flagsWithValues.has(arg) && rawArgs[index + 1] && !rawArgs[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }
  }

  if (blocked.length > 0) {
    throw new Error(
      `Disallowed orchestrator runtime flags: ${blocked.join(", ")}.`
      + " Solist enforces tool policy and MCP boundaries and rejects runtime override flags."
    );
  }
}
