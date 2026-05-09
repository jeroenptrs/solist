import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getEnvApiKey, getModel } from "@earendil-works/pi-ai";
import type {
  AuthStorage as AuthStorageType,
  createAgentSessionFromServices as createAgentSessionFromServicesType,
  createAgentSessionServices as createAgentSessionServicesType,
  ModelRegistry as ModelRegistryType,
  SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import {
  SOLIST_MODEL_ID,
  SOLIST_MODEL_PROVIDER,
  SOLIST_THINKING_LEVEL,
  SOLIST_MODEL_PATTERN
} from "./solistPrompt.js";
import {
  SOLIST_ALLOWED_TOOLS,
  SOLIST_HARDENING_FLAGS
} from "./orchestratorPolicy.js";
import { resolveSoloMcpAllowlist } from "./orchestratorPolicy.js";
import { resolveSoloMcpRuntimeConfig, writeSoloMcpRuntimeConfig } from "./soloMcp.js";
import { createSolistReadOnlyTools, SOLIST_READ_ONLY_TOOL_NAMES } from "./harness/readOnlyTools.js";
import {
  checkSoloMcpReachability,
  createSoloMcpTools,
  SOLO_MCP_EXPOSED_OPERATIONS,
} from "./soloMcpDirect.js";

const hardeningReport = `Hardening active: ${SOLIST_HARDENING_FLAGS.join(", ")}`;

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
  wrapperHardeningActive: boolean;
  wrapperHardeningFlags: readonly string[];
  message: string;
}

export interface HarnessBoundaryCheckResult {
  ok: boolean;
  runtime: "solist-harness";
  model: string;
  thinkingLevel: string;
  modelAvailable: boolean;
  providerAuthConfigured: boolean;
  providerAuthSource?: "stored" | "environment";
  mcpConfigSources?: readonly string[];
  mcpConfiguredServers?: readonly string[];
  localReadOnlyTools: readonly string[];
  soloMcpTools: readonly string[];
  soloMcpReachable: boolean;
  soloMcpExposedOperations: readonly string[];
  soloMcpServerTools: readonly string[];
  message: string;
}

export async function checkPiSessionFeasibility(): Promise<FeasibilityResult> {
  const {
    AuthStorage,
    createAgentSessionFromServices,
    createAgentSessionServices,
    ModelRegistry,
    SessionManager,
  } = await import("@earendil-works/pi-coding-agent") as {
    AuthStorage: typeof AuthStorageType;
    createAgentSessionFromServices: typeof createAgentSessionFromServicesType;
    createAgentSessionServices: typeof createAgentSessionServicesType;
    ModelRegistry: typeof ModelRegistryType;
    SessionManager: typeof SessionManagerType;
  };
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
      wrapperHardeningActive: true,
      wrapperHardeningFlags: [...SOLIST_HARDENING_FLAGS],
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
        "then verify the model with `pi --list-models gpt-5.5`." +
        ` ${hardeningReport}.`
    };
  }

  // Apply check-time hardening equivalent to the CLI wrapper flags.
  // This is defense in depth; the definitive boundary is the wrapper CLI args
  // and the future harness check path (WP5).
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    authStorage,
    modelRegistry,
    extensionFlagValues: new Map([["mcp-config", soloMcp.path]]),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    }
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
      wrapperHardeningActive: true,
      wrapperHardeningFlags: [...SOLIST_HARDENING_FLAGS],
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
        "then ensure the solo server is configured in Pi MCP config." +
        ` ${hardeningReport}.`
    };
  }

  return {
    ok: true,
    wrapperHardeningActive: true,
    wrapperHardeningFlags: [...SOLIST_HARDENING_FLAGS],
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
      "Pi SDK created a constrained Solist session with a solo-only eager MCP config." +
      ` ${hardeningReport}.`
  };
}

export async function checkHarnessRuntimeBoundary(): Promise<HarnessBoundaryCheckResult> {
  const localReadOnlyTools = (await createSolistReadOnlyTools(process.cwd()))
    .map((tool) => tool.name);
  const expectedReadOnlyTools = [...SOLIST_READ_ONLY_TOOL_NAMES];
  const readOnlyToolsOk = namesEqual(localReadOnlyTools, expectedReadOnlyTools);
  const modelAvailable = isHarnessModelAvailable();
  const providerAuth = getHarnessProviderAuthStatus();

  let mcpConfigSources: readonly string[] | undefined;
  let mcpConfiguredServers: readonly string[] | undefined;
  let soloMcpTools: readonly string[] = [];
  let soloMcpReachable = false;
  let soloMcpExposedOperations: readonly string[] = [];
  let soloMcpServerTools: readonly string[] = [];
  let mcpError: string | undefined;

  try {
    const soloMcp = resolveSoloMcpRuntimeConfig();
    mcpConfigSources = soloMcp.sourcePaths;
    mcpConfiguredServers = soloMcp.mergedServerNames;
    soloMcpTools = createSoloMcpTools(soloMcp, {
      clientFactory: () => ({
        async listTools() {
          return [];
        },
        async callTool() {
          return { content: [{ type: "text", text: "" }] };
        },
      }),
    }).map((tool) => tool.name);
    const reachability = await checkSoloMcpReachability(soloMcp);
    soloMcpReachable = reachability.ok;
    soloMcpExposedOperations = reachability.exposedOperations;
    soloMcpServerTools = reachability.serverTools;
  } catch (error) {
    mcpError = error instanceof Error ? error.message : String(error);
  }

  const soloToolBoundaryOk = namesEqual(
    soloMcpTools,
    SOLO_MCP_EXPOSED_OPERATIONS.map((operation) => `solo_mcp_${operation}`),
  );
  const soloMcpOperationsAvailable = namesEqual(soloMcpExposedOperations, [...SOLO_MCP_EXPOSED_OPERATIONS]);
  const ok = modelAvailable
    && providerAuth.configured
    && readOnlyToolsOk
    && soloToolBoundaryOk
    && soloMcpReachable
    && soloMcpOperationsAvailable;
  const boundary = `Harness boundary: local tools=${localReadOnlyTools.join(", ")}; Solo MCP tools=${soloMcpTools.length}.`;

  return {
    ok,
    runtime: "solist-harness",
    model: SOLIST_MODEL_PATTERN,
    thinkingLevel: SOLIST_THINKING_LEVEL,
    modelAvailable,
    providerAuthConfigured: providerAuth.configured,
    providerAuthSource: providerAuth.source,
    mcpConfigSources,
    mcpConfiguredServers,
    localReadOnlyTools,
    soloMcpTools,
    soloMcpReachable,
    soloMcpExposedOperations,
    soloMcpServerTools,
    message: ok
      ? `${boundary} Solo MCP is reachable and the explicit tool boundary is intact.`
      : `${boundary} ${mcpError ?? "Model auth, Solo MCP reachability, or tool boundary validation failed."}`,
  };
}

function namesEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((name, index) => name === expected[index]);
}

function isHarnessModelAvailable(): boolean {
  try {
    getModel(
      SOLIST_MODEL_PROVIDER as Parameters<typeof getModel>[0],
      SOLIST_MODEL_ID as Parameters<typeof getModel>[1],
    );
    return true;
  } catch {
    return false;
  }
}

function getHarnessProviderAuthStatus(): {
  readonly configured: boolean;
  readonly source?: "stored" | "environment";
} {
  if (hasStoredProviderAuth(SOLIST_MODEL_PROVIDER)) {
    return { configured: true, source: "stored" };
  }

  if (getEnvApiKey(SOLIST_MODEL_PROVIDER)) {
    return { configured: true, source: "environment" };
  }

  return { configured: false };
}

function hasStoredProviderAuth(provider: string): boolean {
  const authPath = join(resolvePiAgentDir(), "auth.json");
  if (!existsSync(authPath)) {
    return false;
  }

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    return typeof raw === "object"
      && raw !== null
      && !Array.isArray(raw)
      && provider in raw;
  } catch {
    return false;
  }
}

function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}
