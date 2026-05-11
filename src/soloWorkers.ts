import type { SoloTodo } from "./soloPlanning.js";
import {
  resolveRoleBinding,
  type SoloAgentToolReference,
  type SolistConfig,
  type SolistRoleBindings
} from "./solistConfig.js";
import { SOLIST_ROLES, resolveSolistRoleId, type SolistRoleId } from "./solistRoles.js";

export interface SoloWorkerRuntime {
  id: string;
  name: string;
  description?: string;
}

export interface SoloWorkerProcess {
  id: string;
  name: string;
}

export interface SoloWorkerClient {
  listWorkerRuntimes(): Promise<SoloWorkerRuntime[]>;
  spawnWorker(input: {
    runtimeId: string;
    prompt: string;
    name?: string;
  }): Promise<SoloWorkerProcess>;
  addTodoComment(uri: string, body: string): Promise<SoloTodo>;
  closeWorkerProcess?(processId: string): Promise<void>;
}

export interface WorkerDispatchRequest {
  objective: string;
  scratchpadUri: string;
  todo: SoloTodo;
  role: string;
  roleId?: SolistRoleId;
  lane: string;
  ownershipBoundaries: string[];
  whatNotToChange: string[];
  expectedHandoff: string[];
  runtimeSelection?: string;
  workerName?: string;
  config?: SolistConfig;
  projectId?: number | string;
  sessionRoleOverrides?: SolistRoleBindings;
}

export type WorkerRuntimeSelectionResult =
  | {
      status: "selected";
      selectedRuntimes: SoloWorkerRuntime[];
      runtime: SoloWorkerRuntime;
      runtimes: SoloWorkerRuntime[];
    }
  | {
      status: "decision-needed";
      reason: string;
      runtimes: SoloWorkerRuntime[];
    };

export type WorkerDispatchResult =
  | {
      status: "spawned";
      runtimes: SoloWorkerRuntime[];
      runtime: SoloWorkerRuntime;
      processes: SoloWorkerProcess[];
      process: SoloWorkerProcess;
      prompt: string;
      todo: SoloTodo;
    }
  | {
      status: "decision-needed";
      reason: string;
      runtimes: SoloWorkerRuntime[];
    };

export async function selectWorkerRuntime(
  client: Pick<SoloWorkerClient, "listWorkerRuntimes">,
  runtimeSelection?: string
): Promise<WorkerRuntimeSelectionResult> {
  const runtimes = await client.listWorkerRuntimes();
  return selectWorkerRuntimeFromList(runtimes, runtimeSelection);
}

export async function selectWorkerRuntimeForDispatch(
  client: Pick<SoloWorkerClient, "listWorkerRuntimes">,
  request: Pick<WorkerDispatchRequest, "runtimeSelection" | "role" | "roleId" | "config" | "projectId" | "sessionRoleOverrides">
): Promise<WorkerRuntimeSelectionResult> {
  const runtimes = await client.listWorkerRuntimes();
  if (request.runtimeSelection) {
    return selectWorkerRuntimeFromList(runtimes, request.runtimeSelection);
  }

  const roleId = request.roleId ?? resolveSolistRoleId(request.role);
  if (request.config && roleId) {
    const resolution = resolveRoleBinding({
      roleId,
      config: request.config,
      projectId: request.projectId,
      sessionOverrides: request.sessionRoleOverrides,
      availableAgentTools: runtimesToAgentTools(runtimes),
    });
    if (resolution.status === "decision-needed") {
      return {
        status: "decision-needed",
        reason: resolution.reason,
        runtimes
      };
    }

    const selected = resolution.agentTools.flatMap((agentTool) => {
      const runtime = runtimes.find((candidate) =>
        candidate.name === agentTool.name
        || Number(candidate.id) === agentTool.id
      );
      return runtime ? [runtime] : [];
    });
    if (selected.length !== resolution.agentTools.length) {
      return {
        status: "decision-needed",
        reason: `One or more resolved Solo agent tools are not available as worker runtimes: ${resolution.agentTools.map((agentTool) => `${agentTool.id} (${agentTool.name})`).join(", ")}.`,
        runtimes
      };
    }
    return { status: "selected", runtime: selected[0]!, selectedRuntimes: selected, runtimes };
  }

  return selectWorkerRuntimeFromList(runtimes, undefined);
}

function selectWorkerRuntimeFromList(
  runtimes: SoloWorkerRuntime[],
  runtimeSelection?: string
): WorkerRuntimeSelectionResult {
  if (runtimeSelection) {
    const selected = runtimes.find(
      (runtime) => runtime.id === runtimeSelection || runtime.name === runtimeSelection
    );
    if (!selected) {
      return {
        status: "decision-needed",
        reason: `Requested worker runtime "${runtimeSelection}" is not available.`,
        runtimes
      };
    }
    return { status: "selected", runtime: selected, selectedRuntimes: [selected], runtimes };
  }

  if (runtimes.length === 1) {
    return { status: "selected", runtime: runtimes[0], selectedRuntimes: [runtimes[0]], runtimes };
  }

  return {
    status: "decision-needed",
    reason:
      runtimes.length === 0
        ? "No Solo worker runtimes are available."
        : "Multiple Solo worker runtimes are available; choose one before dispatch.",
    runtimes
  };
}

export function buildWorkerPrompt(request: WorkerDispatchRequest): string {
  const roleId = request.roleId ?? resolveSolistRoleId(request.role);
  const role = roleId ? SOLIST_ROLES[roleId] : undefined;
  return [
    `Objective: ${request.objective}`,
    "",
    "Solo context:",
    `- Scratchpad: ${request.scratchpadUri}`,
    `- Todo: ${request.todo.uri}`,
    `- Todo title: ${request.todo.title}`,
    ...(request.todo.body ? [`- Todo body: ${request.todo.body}`] : []),
    "",
    "Role and lane:",
    `- Role: ${role ? role.id : request.role}`,
    ...(role ? [`- Role description: ${role.description}`] : []),
    `- Lane: ${request.lane}`,
    ...(role ? [
      "",
      "Role framing:",
      ...formatBullets([...role.promptFrame]),
    ] : []),
    "",
    "Ownership boundaries:",
    ...formatBullets(request.ownershipBoundaries),
    "",
    "Coordination rules:",
    "- You are not alone in the codebase.",
    "- Do not revert edits made by others.",
    "- Adjust your implementation to accommodate nearby changes made by others.",
    "",
    "Do not change:",
    ...formatBullets(request.whatNotToChange),
    "",
    "Expected handoff:",
    ...formatBullets([
      ...(role?.expectedHandoff ?? []),
      ...request.expectedHandoff,
    ])
  ].join("\n");
}

export async function dispatchWorker(
  client: SoloWorkerClient,
  request: WorkerDispatchRequest
): Promise<WorkerDispatchResult> {
  const selection = await selectWorkerRuntimeForDispatch(client, request);
  if (selection.status === "decision-needed") {
    return selection;
  }

  const roleId = request.roleId ?? resolveSolistRoleId(request.role);
  const prompt = buildWorkerPrompt(request);
  const processes: SoloWorkerProcess[] = [];
  let todo: SoloTodo;
  try {
    for (const runtime of selection.selectedRuntimes) {
      processes.push(await client.spawnWorker({
        runtimeId: runtime.id,
        prompt,
        name: workerNameForRuntime(request.workerName, runtime, selection.selectedRuntimes.length)
      }));
    }
    todo = await client.addTodoComment(
      request.todo.uri,
      assignmentCommentForProcesses(selection.selectedRuntimes, processes, roleId)
    );
  } catch (error) {
    await cleanupSpawnedWorkers(client, processes);
    throw error;
  }

  return {
    status: "spawned",
    runtime: selection.runtime,
    runtimes: selection.selectedRuntimes,
    process: processes[0]!,
    processes,
    prompt,
    todo
  };
}

async function cleanupSpawnedWorkers(
  client: SoloWorkerClient,
  processes: readonly SoloWorkerProcess[]
): Promise<void> {
  if (!client.closeWorkerProcess || processes.length === 0) {
    return;
  }
  await Promise.allSettled(processes.map((process) => client.closeWorkerProcess!(process.id)));
}

export function assignmentComment(
  runtime: SoloWorkerRuntime,
  process: SoloWorkerProcess,
  roleId?: SolistRoleId
): string {
  const role = roleId ? `role=${roleId}; ` : "";
  return `Solist worker assignment: ${role}runtime=${runtime.id} (${runtime.name}); process=${process.id} (${process.name})`;
}

export function assignmentCommentForProcesses(
  runtimes: readonly SoloWorkerRuntime[],
  processes: readonly SoloWorkerProcess[],
  roleId?: SolistRoleId
): string {
  if (runtimes.length === 1 && processes.length === 1) {
    return assignmentComment(runtimes[0]!, processes[0]!, roleId);
  }
  const role = roleId ? `role=${roleId}; ` : "";
  const assignments = runtimes.map((runtime, index) => {
    const process = processes[index];
    return process
      ? `runtime=${runtime.id} (${runtime.name}); process=${process.id} (${process.name})`
      : `runtime=${runtime.id} (${runtime.name}); process=unknown`;
  }).join(" | ");
  return `Solist worker assignment: ${role}${assignments}`;
}

function workerNameForRuntime(
  baseName: string | undefined,
  runtime: SoloWorkerRuntime,
  count: number
): string | undefined {
  if (count <= 1) {
    return baseName;
  }
  const suffix = runtime.id.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `${baseName ?? "worker"}-${suffix}`;
}

function formatBullets(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- None"];
}

function runtimesToAgentTools(runtimes: readonly SoloWorkerRuntime[]): SoloAgentToolReference[] {
  return runtimes.map((runtime, index) => {
    const id = Number(runtime.id);
    return {
      id: Number.isInteger(id) ? id : -(index + 1),
      name: runtime.name,
      enabled: true,
    };
  });
}
