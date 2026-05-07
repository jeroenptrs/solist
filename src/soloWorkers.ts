import type { SoloTodo } from "./soloPlanning.js";

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
}

export interface WorkerDispatchRequest {
  objective: string;
  scratchpadUri: string;
  todo: SoloTodo;
  role: string;
  lane: string;
  ownershipBoundaries: string[];
  whatNotToChange: string[];
  expectedHandoff: string[];
  runtimeSelection?: string;
  workerName?: string;
}

export type WorkerRuntimeSelectionResult =
  | {
      status: "selected";
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
      runtime: SoloWorkerRuntime;
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
    return { status: "selected", runtime: selected, runtimes };
  }

  if (runtimes.length === 1) {
    return { status: "selected", runtime: runtimes[0], runtimes };
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
    `- Role: ${request.role}`,
    `- Lane: ${request.lane}`,
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
    ...formatBullets(request.expectedHandoff)
  ].join("\n");
}

export async function dispatchWorker(
  client: SoloWorkerClient,
  request: WorkerDispatchRequest
): Promise<WorkerDispatchResult> {
  const selection = await selectWorkerRuntime(client, request.runtimeSelection);
  if (selection.status === "decision-needed") {
    return selection;
  }

  const prompt = buildWorkerPrompt(request);
  const process = await client.spawnWorker({
    runtimeId: selection.runtime.id,
    prompt,
    name: request.workerName
  });
  const todo = await client.addTodoComment(
    request.todo.uri,
    assignmentComment(selection.runtime, process)
  );

  return {
    status: "spawned",
    runtime: selection.runtime,
    process,
    prompt,
    todo
  };
}

export function assignmentComment(runtime: SoloWorkerRuntime, process: SoloWorkerProcess): string {
  return `Solist worker assignment: runtime=${runtime.id} (${runtime.name}); process=${process.id} (${process.name})`;
}

function formatBullets(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- None"];
}
