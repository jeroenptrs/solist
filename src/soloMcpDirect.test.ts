import { describe, expect, it } from "vitest";
import type { SolistResolvedSoloMcp } from "./soloMcp.js";
import {
  checkSoloMcpReachability,
  createSoloMcpToolSet,
  createSoloMcpTools,
  SOLO_MCP_EXPOSED_OPERATIONS,
  type SoloMcpClient,
  type SoloMcpToolCallResult,
  type SoloMcpToolDefinition,
} from "./soloMcpDirect.js";

class FakeSoloMcpClient implements SoloMcpClient {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  closed = false;

  constructor(
    private readonly tools: readonly SoloMcpToolDefinition[] = SOLO_MCP_EXPOSED_OPERATIONS.map((name) => ({ name })),
    private readonly responses: Record<string, SoloMcpToolCallResult> = {},
  ) {}

  async listTools(): Promise<readonly SoloMcpToolDefinition[]> {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<SoloMcpToolCallResult> {
    this.calls.push({ name, args });
    return this.responses[name] ?? {
      content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const soloResolved: SolistResolvedSoloMcp = {
  mergedServerNames: ["solo"],
  sourcePaths: ["/tmp/mcp.json"],
  config: {
    mcpServers: {
      solo: { command: "/Applications/Solo.app/Contents/MacOS/mcp" },
    },
  },
};

describe("direct Solo MCP tools", () => {
  it("exposes a scoped Solo MCP wrapper namespace for selected Solo operations", () => {
    const tools = createSoloMcpTools(soloResolved, {
      clientFactory: () => new FakeSoloMcpClient(),
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      SOLO_MCP_EXPOSED_OPERATIONS.map((operation) => `solo_mcp_${operation}`),
    );
    expect(tools.find((tool) => tool.name === "solo_mcp_todo_get")?.description)
      .toContain('Maps directly to Solo MCP tool "todo_get"');
    expect(tools.map((tool) => tool.name)).toContain("solo_mcp_close_process");
    expect(tools.map((tool) => tool.name)).toContain("solo_mcp_todo_delete");
  });

  it("maps wrapper calls to the underlying Solo MCP tool name", async () => {
    const client = new FakeSoloMcpClient(undefined, {
      todo_get: { content: [{ type: "text", text: "todo payload" }] },
    });
    const tools = createSoloMcpTools(soloResolved, { clientFactory: () => client });
    const todoGet = tools.find((tool) => tool.name === "solo_mcp_todo_get");

    const result = await todoGet?.execute("call-1", { args: { todo_id: 208, include_comments: true } });

    expect(client.calls).toEqual([
      { name: "todo_get", args: { todo_id: 208, include_comments: true } },
    ]);
    expect(result?.content).toEqual([{ type: "text", text: "todo payload" }]);
    expect(result?.details).toMatchObject({ operation: "todo_get" });
  });

  it("returns a closable tool set for the long-lived direct MCP client", async () => {
    const client = new FakeSoloMcpClient();
    const toolSet = createSoloMcpToolSet(soloResolved, { clientFactory: () => client });

    expect(toolSet.tools.map((tool) => tool.name)).toContain("solo_mcp_todo_get");
    await toolSet.close();

    expect(client.closed).toBe(true);
  });

  it("rejects non-Solo MCP servers at the direct client boundary", () => {
    const resolved: SolistResolvedSoloMcp = {
      ...soloResolved,
      config: {
        mcpServers: {
          solo: { command: "solo-mcp" },
          github: { command: "github-mcp" },
        },
      },
    };

    expect(() => createSoloMcpTools(resolved, { clientFactory: () => new FakeSoloMcpClient() }))
      .toThrowError("exposes only the solo server");
  });

  it("checks Solo MCP reachability through a fake direct client without Pi", async () => {
    const client = new FakeSoloMcpClient([
      { name: "todo_get" },
      { name: "scratchpad_read" },
      { name: "unexposed_extra_tool" },
    ]);

    const result = await checkSoloMcpReachability(soloResolved, {
      clientFactory: () => client,
    });

    expect(result).toEqual({
      ok: true,
      exposedOperations: ["scratchpad_read", "todo_get"],
      serverTools: ["todo_get", "scratchpad_read", "unexposed_extra_tool"],
    });
    expect(client.closed).toBe(true);
  });
});
