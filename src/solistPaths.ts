import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SOLIST_HOME_ENV = "SOLIST_HOME";
export const SOLIST_AUTH_PATH_ENV = "SOLIST_AUTH_PATH";
export const SOLIST_MCP_CONFIG_ENV = "SOLIST_MCP_CONFIG";
export const SOLIST_CONFIG_PATH_ENV = "SOLIST_CONFIG_PATH";

export function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function resolveSolistHome(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configured = env[SOLIST_HOME_ENV];
	return configured
		? resolve(expandHomePath(configured))
		: join(homedir(), ".solist");
}

export function getSolistAuthPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configured = env[SOLIST_AUTH_PATH_ENV];
	return configured
		? resolve(expandHomePath(configured))
		: join(resolveSolistHome(env), "auth.json");
}

export function getSolistConfigPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configured = env[SOLIST_CONFIG_PATH_ENV];
	return configured
		? resolve(expandHomePath(configured))
		: join(resolveSolistHome(env), "config.json");
}

export function getSolistMcpConfigPaths(
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
	const configured = env[SOLIST_MCP_CONFIG_ENV];
	const primary = configured
		? resolve(expandHomePath(configured))
		: join(resolveSolistHome(env), "mcp.json");

	return dedupePaths([
		primary,
		join(homedir(), ".config", "mcp", "mcp.json"),
		resolve(cwd, ".mcp.json"),
		resolve(cwd, ".solist", "mcp.json"),
	]);
}

function dedupePaths(paths: readonly string[]): string[] {
	return [...new Set(paths)];
}
