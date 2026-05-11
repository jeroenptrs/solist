import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getSolistAuthPath,
	getSolistConfigPath,
	getSolistMcpConfigPaths,
	resolveSolistHome,
} from "./solistPaths.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Solist paths", () => {
	it("defaults auth and primary MCP config to ~/.solist", () => {
		expect(resolveSolistHome({})).toBe(join(homedir(), ".solist"));
		expect(getSolistAuthPath({})).toBe(join(homedir(), ".solist", "auth.json"));
		expect(getSolistConfigPath({})).toBe(join(homedir(), ".solist", "config.json"));
		expect(getSolistMcpConfigPaths("/tmp/project", {})[0]).toBe(
			join(homedir(), ".solist", "mcp.json"),
		);
	});

	it("supports explicit Solist home and file overrides", () => {
		const env = {
			SOLIST_HOME: "~/custom-solist",
			SOLIST_AUTH_PATH: "/tmp/solist-auth.json",
			SOLIST_CONFIG_PATH: "/tmp/solist-config.json",
			SOLIST_MCP_CONFIG: "/tmp/solist-mcp.json",
		};

		expect(resolveSolistHome(env)).toBe(join(homedir(), "custom-solist"));
		expect(getSolistAuthPath(env)).toBe(resolve("/tmp/solist-auth.json"));
		expect(getSolistConfigPath(env)).toBe(resolve("/tmp/solist-config.json"));
		expect(getSolistMcpConfigPaths("/tmp/project", env)[0]).toBe(
			resolve("/tmp/solist-mcp.json"),
		);
	});
});
