import { describe, expect, it } from "vitest";
import {
  SOLIST_DEFAULT_MCP_ALLOWLIST,
  assertNoPolicyToolOverrides,
  resolveSoloMcpAllowlist,
  splitCommaList
} from "./orchestratorPolicy.js";

describe("orchestrator policy validation", () => {
  it("normalizes MCP allowlist input", () => {
    expect(splitCommaList("solo, , solo ")).toEqual(["solo", "solo"]);
  });

  it("accepts a Solo-only MCP allowlist", () => {
    expect(resolveSoloMcpAllowlist("solo")).toEqual(SOLIST_DEFAULT_MCP_ALLOWLIST);
  });

  it("defaults to Solo MCP allowlist when config is missing", () => {
    expect(resolveSoloMcpAllowlist(undefined)).toEqual(SOLIST_DEFAULT_MCP_ALLOWLIST);
    expect(resolveSoloMcpAllowlist("")).toEqual(SOLIST_DEFAULT_MCP_ALLOWLIST);
  });

  it("rejects non-Solo MCP allowlist entries", () => {
    expect(() => resolveSoloMcpAllowlist("solo,other")).toThrowError(
      "Remove non-solo MCP servers: other"
    );
  });

  it("rejects runtime tool-override arguments", () => {
    expect(() => assertNoPolicyToolOverrides(["--tools", "read", "ls"])).toThrowError(
      "Disallowed orchestrator runtime flags"
    );
    expect(() => assertNoPolicyToolOverrides(["--no-tools"])).toThrowError(
      "Disallowed orchestrator runtime flags"
    );
    expect(() => assertNoPolicyToolOverrides(["--mcp-config", "/tmp/mcp.json"])).toThrowError(
      "Disallowed orchestrator runtime flags"
    );
    expect(() => assertNoPolicyToolOverrides(["--extensions", "/tmp/ext.js"])).toThrowError(
      "Disallowed orchestrator runtime flags"
    );
  });

  it("allows non-policy CLI args", () => {
    expect(() => assertNoPolicyToolOverrides(["foo", "bar", "--help"])).not.toThrow();
  });
});
