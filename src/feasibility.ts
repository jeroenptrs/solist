import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRegistry,
  SessionManager
} from "@mariozechner/pi-coding-agent";
import {
  SOLIST_MODEL_ID,
  SOLIST_MODEL_PROVIDER,
  SOLIST_THINKING_LEVEL
} from "./solistPrompt.js";
import { SOLIST_ALLOWED_TOOLS } from "./orchestratorPolicy.js";
import { resolveSoloMcpAllowlist } from "./orchestratorPolicy.js";
import { writeSoloMcpRuntimeConfig } from "./soloMcp.js";

export interface FeasibilityResult {
  ok: boolean;
  model: string;
  thinkingLevel: string;
  availableModelCount: number;
  providerAuthConfigured: boolean;
  providerAuthSource?: string;
  mcpAllowlist: string;
  mcpConfigPath?: string;
  mcpConfigSources?: readonly string[];
  mcpConfiguredServers?: readonly string[];
  mcpToolAvailable?: boolean;
  message: string;
}

export async function checkPiSessionFeasibility(): Promise<FeasibilityResult> {
  const mcpAllowlist = resolveSoloMcpAllowlist();
  const soloMcp = writeSoloMcpRuntimeConfig();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const available = await modelRegistry.getAvailable();
  const providerAuth = authStorage.getAuthStatus(SOLIST_MODEL_PROVIDER);
  const model = available.find(
    (candidate) => candidate.provider === SOLIST_MODEL_PROVIDER && candidate.id === SOLIST_MODEL_ID
  );

  if (!model) {
    return {
      ok: false,
      model: `${SOLIST_MODEL_PROVIDER}/${SOLIST_MODEL_ID}`,
      thinkingLevel: SOLIST_THINKING_LEVEL,
      availableModelCount: available.length,
      providerAuthConfigured: providerAuth.configured,
      providerAuthSource: providerAuth.source,
      mcpAllowlist: mcpAllowlist.join(","),
      mcpConfigPath: soloMcp.path,
      mcpConfigSources: soloMcp.sourcePaths,
      mcpConfiguredServers: soloMcp.mergedServerNames,
      message:
        `Pi did not report ${SOLIST_MODEL_PROVIDER}/${SOLIST_MODEL_ID} as available. ` +
        `Run \`pi /login\` or configure Pi auth for ${SOLIST_MODEL_PROVIDER}, ` +
        "then verify the model with `pi --list-models gpt-5.5`."
    };
  }

  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    authStorage,
    modelRegistry,
    extensionFlagValues: new Map([["mcp-config", soloMcp.path]])
  });
  const { session } = await createAgentSessionFromServices({
    services,
    model,
    thinkingLevel: SOLIST_THINKING_LEVEL,
    tools: [...SOLIST_ALLOWED_TOOLS],
    sessionManager: SessionManager.inMemory(process.cwd()),
    noTools: "builtin"
  });

  await session.bindExtensions({});
  const mcpToolAvailable = session.getAllTools().some((tool) => tool.name === "mcp");

  if (!mcpToolAvailable) {
    return {
      ok: false,
      model: `${model.provider}/${model.id}`,
      thinkingLevel: SOLIST_THINKING_LEVEL,
      availableModelCount: available.length,
      providerAuthConfigured: providerAuth.configured,
      providerAuthSource: providerAuth.source,
      mcpAllowlist: mcpAllowlist.join(","),
      mcpConfigPath: soloMcp.path,
      mcpConfigSources: soloMcp.sourcePaths,
      mcpConfiguredServers: soloMcp.mergedServerNames,
      mcpToolAvailable,
      message:
        "Pi did not expose the MCP adapter tool. Install and enable `npm:pi-mcp-adapter`, " +
        "then ensure the solo server is configured in Pi MCP config."
    };
  }

  return {
    ok: true,
    model: `${model.provider}/${model.id}`,
    thinkingLevel: SOLIST_THINKING_LEVEL,
    availableModelCount: available.length,
    providerAuthConfigured: providerAuth.configured,
    providerAuthSource: providerAuth.source,
    mcpAllowlist: mcpAllowlist.join(","),
    mcpConfigPath: soloMcp.path,
    mcpConfigSources: soloMcp.sourcePaths,
    mcpConfiguredServers: soloMcp.mergedServerNames,
    mcpToolAvailable,
    message: "Pi SDK created a constrained Solist session with a solo-only eager MCP config."
  };
}
