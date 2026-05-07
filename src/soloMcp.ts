import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface SolistMcpServerConfig {
  readonly [key: string]: unknown;
}

export interface SolistMcpConfig {
  readonly settings?: Record<string, unknown>;
  readonly mcpServers: Record<string, SolistMcpServerConfig>;
}

export interface SolistMcpSource {
  readonly path: string;
  readonly config: SolistMcpConfig;
}

export interface SolistResolvedSoloMcp {
  readonly mergedServerNames: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly config: SolistMcpConfig;
}

function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

export function getSolistMcpConfigPaths(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  return [
    join(homedir(), ".config", "mcp", "mcp.json"),
    join(resolvePiAgentDir(env), "mcp.json"),
    resolve(cwd, ".mcp.json"),
    resolve(cwd, ".pi", "mcp.json")
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMcpConfig(path: string): SolistMcpConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;

  if (!isRecord(raw)) {
    throw new Error(`Invalid MCP config in ${path}: expected a JSON object.`);
  }

  const mcpServers = raw.mcpServers;
  if (!isRecord(mcpServers)) {
    throw new Error(`Invalid MCP config in ${path}: missing "mcpServers" object.`);
  }

  const settings = raw.settings;
  return {
    settings: isRecord(settings) ? settings : undefined,
    mcpServers: mcpServers as Record<string, SolistMcpServerConfig>
  };
}

export function loadSolistMcpSources(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): readonly SolistMcpSource[] {
  return getSolistMcpConfigPaths(cwd, env)
    .filter((path) => existsSync(path))
    .map((path) => ({
      path,
      config: parseMcpConfig(path)
    }));
}

export function resolveSoloMcpRuntimeConfig(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): SolistResolvedSoloMcp {
  const sources = loadSolistMcpSources(cwd, env);
  const sourcePaths = sources.map((source) => source.path);

  if (sources.length === 0) {
    throw new Error(
      "Solist could not find any Pi MCP config. Configure the solo server in one of: "
      + getSolistMcpConfigPaths(cwd, env).join(", ")
    );
  }

  const merged = sources.reduce<SolistMcpConfig>(
    (current, source) => ({
      settings: source.config.settings ? { ...(current.settings ?? {}), ...source.config.settings } : current.settings,
      mcpServers: { ...current.mcpServers, ...source.config.mcpServers }
    }),
    { mcpServers: {} }
  );

  const mergedServerNames = Object.keys(merged.mcpServers);
  if (mergedServerNames.length === 0) {
    throw new Error(
      `Solist found MCP config files but no configured servers. Checked: ${sourcePaths.join(", ")}`
    );
  }

  if (!("solo" in merged.mcpServers)) {
    throw new Error(
      `Solist requires a configured "solo" MCP server. Found: ${mergedServerNames.join(", ")}`
    );
  }

  const nonSoloServers = mergedServerNames.filter((name) => name !== "solo");
  if (nonSoloServers.length > 0) {
    throw new Error(
      `Solist exposes Solo MCP only. Remove non-solo MCP servers from Pi MCP config: ${nonSoloServers.join(", ")}`
    );
  }

  const soloServer = merged.mcpServers.solo;
  const hasCommand = typeof soloServer.command === "string" && soloServer.command.length > 0;
  const hasUrl = typeof soloServer.url === "string" && soloServer.url.length > 0;
  if (!hasCommand && !hasUrl) {
    throw new Error(
      `Solist requires the "solo" MCP server to declare either "command" or "url". Checked: ${sourcePaths.join(", ")}`
    );
  }

  return {
    mergedServerNames,
    sourcePaths,
    config: {
      settings: {
        ...(merged.settings ?? {}),
        directTools: false,
        disableProxyTool: false
      },
      mcpServers: {
        solo: {
          ...soloServer,
          directTools: false,
          lifecycle: "eager"
        }
      }
    }
  };
}

export function writeSoloMcpRuntimeConfig(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): SolistResolvedSoloMcp & { readonly path: string } {
  const resolvedMcp = resolveSoloMcpRuntimeConfig(cwd, env);
  const directory = mkdtempSync(join(tmpdir(), "solist-mcp-"));
  const path = join(directory, "mcp.json");

  writeFileSync(path, `${JSON.stringify(resolvedMcp.config, null, 2)}\n`, "utf8");

  return { ...resolvedMcp, path };
}
