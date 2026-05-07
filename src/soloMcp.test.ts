import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSoloMcpRuntimeConfig, writeSoloMcpRuntimeConfig } from "./soloMcp.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("solo MCP runtime config", () => {
  it("isolates the solo server and forces eager proxy mode", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "solist-mcp-test-"));
    const homeDir = join(tempDir, "home");
    const cwd = join(tempDir, "project");

    mkdirSync(cwd, { recursive: true });
    writeJson(join(homeDir, ".pi", "agent", "mcp.json"), {
      settings: {
        disableProxyTool: true,
        directTools: true
      },
      mcpServers: {
        solo: {
          command: "/Applications/Solo.app/Contents/MacOS/mcp",
          args: [],
          directTools: true
        }
      }
    });
    vi.stubEnv("HOME", homeDir);

    const result = resolveSoloMcpRuntimeConfig(cwd);

    expect(result.mergedServerNames).toEqual(["solo"]);
    expect(result.config.settings).toMatchObject({
      disableProxyTool: false,
      directTools: false
    });
    expect(result.config.mcpServers.solo).toMatchObject({
      command: "/Applications/Solo.app/Contents/MacOS/mcp",
      args: [],
      directTools: false,
      lifecycle: "eager"
    });
  });

  it("rejects non-solo MCP servers from merged config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "solist-mcp-test-"));
    const homeDir = join(tempDir, "home");
    const cwd = join(tempDir, "project");

    mkdirSync(cwd, { recursive: true });
    writeJson(join(homeDir, ".pi", "agent", "mcp.json"), {
      mcpServers: {
        solo: {
          command: "/Applications/Solo.app/Contents/MacOS/mcp"
        }
      }
    });
    writeJson(join(cwd, ".mcp.json"), {
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"]
        }
      }
    });
    vi.stubEnv("HOME", homeDir);

    expect(() => resolveSoloMcpRuntimeConfig(cwd)).toThrowError(
      "Remove non-solo MCP servers from Pi MCP config: github"
    );
  });

  it("writes a dedicated runtime config file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "solist-mcp-test-"));
    const homeDir = join(tempDir, "home");
    const cwd = join(tempDir, "project");

    mkdirSync(cwd, { recursive: true });
    writeJson(join(homeDir, ".pi", "agent", "mcp.json"), {
      mcpServers: {
        solo: {
          command: "/Applications/Solo.app/Contents/MacOS/mcp",
          args: []
        }
      }
    });
    vi.stubEnv("HOME", homeDir);

    const result = writeSoloMcpRuntimeConfig(cwd);
    const written = JSON.parse(readFileSync(result.path, "utf8")) as {
      mcpServers: { solo: { lifecycle: string } };
    };

    expect(written.mcpServers.solo.lifecycle).toBe("eager");
    expect(result.sourcePaths).toEqual([join(homeDir, ".pi", "agent", "mcp.json")]);
  });
});
