import type { SoloTodo } from "./soloPlanning.js";
import {
  type SolistConfig,
  type SolistRoleBindings
} from "./solistConfig.js";
import {
  type SoloWorkerClient,
  type SoloWorkerProcess,
  type SoloWorkerRuntime,
  type WorkerDispatchResult,
  selectWorkerRuntimeForDispatch
} from "./soloWorkers.js";
import { SOLIST_ROLES } from "./solistRoles.js";

export interface VerificationStatus {
  state: "not-started" | "assigned" | "verified" | "blocked";
  evidence: string[];
  blockers: string[];
  verifierProcessId?: string;
}

export interface VerificationRequest {
  objective: string;
  scratchpadUri: string;
  todo: SoloTodo;
  ownershipBoundaries: string[];
  whatNotToChange: string[];
  expectedHandoff: string[];
  runtimeSelection?: string;
  workerName?: string;
  implementationEvidence?: string;
  config?: SolistConfig;
  projectId?: number | string;
  sessionRoleOverrides?: SolistRoleBindings;
}

export const VERIFICATION_ASSIGNMENT_PREFIX = "Solist verification assignment:";
export const VERIFICATION_EVIDENCE_PREFIX = "Solist verification evidence:";
export const VERIFICATION_BLOCKER_PREFIX = "Solist verification blocker:";

export const VERIFICATION_OVERRIDE_TAG = "solist:verification-overridden";

export function getVerificationStatus(todo: SoloTodo): VerificationStatus {
  const status: VerificationStatus = {
    state: "not-started",
    evidence: [],
    blockers: [],
  };

  if (todo.tags.includes(VERIFICATION_OVERRIDE_TAG)) {
    status.state = "verified";
    status.evidence.push("Verification explicitly overridden by user/tag.");
    return status;
  }

  for (const comment of todo.comments) {
    if (comment.body.startsWith(VERIFICATION_ASSIGNMENT_PREFIX)) {
      status.state = "assigned";
      const match = comment.body.match(/process=([^ (]+)/);
      if (match) {
        status.verifierProcessId = match[1];
      }
    } else if (comment.body.startsWith(VERIFICATION_EVIDENCE_PREFIX)) {
      status.state = "verified";
      status.evidence.push(comment.body.slice(VERIFICATION_EVIDENCE_PREFIX.length).trim());
    } else if (comment.body.startsWith(VERIFICATION_BLOCKER_PREFIX)) {
      status.state = "blocked";
      status.blockers.push(comment.body.slice(VERIFICATION_BLOCKER_PREFIX.length).trim());
    }
  }

  if (status.blockers.length > 0) {
    status.state = "blocked";
  }

  return status;
}

export function isReadyForCompletion(todo: SoloTodo): { ready: boolean; reason?: string } {
  const status = getVerificationStatus(todo);
  if (status.state === "verified") {
    return { ready: true };
  }
  if (status.state === "blocked") {
    return { ready: false, reason: `Verification found blockers: ${status.blockers.join(", ")}` };
  }
  if (status.state === "assigned") {
    return { ready: false, reason: "Verification is in progress." };
  }
  return { ready: false, reason: "Verification has not started." };
}

export function buildVerifierPrompt(request: VerificationRequest): string {
  const role = SOLIST_ROLES.verifier;
  const lines = [
    `Objective: Verify and review implementation for "${request.todo.title}".`,
    "",
    "Solo context:",
    `- Scratchpad: ${request.scratchpadUri}`,
    `- Todo: ${request.todo.uri}`,
    `- Todo title: ${request.todo.title}`,
    ...(request.todo.body ? [`- Todo body: ${request.todo.body}`] : []),
    "",
    "Implementation evidence:",
    ...(request.implementationEvidence ? [request.implementationEvidence] : ["- No explicit evidence provided by implementation worker."]),
    "",
    "Your Role: Verifier / Reviewer",
    `Role description: ${role.description}`,
    "Lane: verification",
    "",
    "Role framing:",
    ...role.promptFrame.map((line) => `- ${line}`),
    "",
    "Verification Tasks:",
    "1. Review the changes made in the implementation lane.",
    "2. Run relevant tests to confirm correctness.",
    "3. Identify any residual risks or architectural regressions.",
    "4. Provide a summary of verification evidence.",
    "5. If issues are found, explicitly list them as blockers.",
    "",
    "Ownership boundaries:",
    ...formatBullets(request.ownershipBoundaries),
    "",
    "Do not change:",
    ...formatBullets(request.whatNotToChange),
    "",
    "Expected handoff:",
    ...role.expectedHandoff.map((line) => `- ${line}`),
    "- Provide verification evidence using the prefix: " + VERIFICATION_EVIDENCE_PREFIX,
    "- List any residual risks or blockers using the prefix: " + VERIFICATION_BLOCKER_PREFIX,
    ...formatBullets(request.expectedHandoff)
  ];

  return lines.join("\n");
}

export async function dispatchVerification(
  client: SoloWorkerClient,
  request: VerificationRequest
): Promise<WorkerDispatchResult> {
  const selection = await selectWorkerRuntimeForDispatch(client, {
    role: "verifier",
    roleId: "verifier",
    runtimeSelection: request.runtimeSelection,
    config: request.config,
    projectId: request.projectId,
    sessionRoleOverrides: request.sessionRoleOverrides
  });
  if (selection.status === "decision-needed") {
    return selection;
  }

  const prompt = buildVerifierPrompt(request);
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
      verificationAssignmentCommentForProcesses(selection.selectedRuntimes, processes)
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

export function verificationAssignmentComment(
  runtime: SoloWorkerRuntime,
  process: SoloWorkerProcess
): string {
  return `${VERIFICATION_ASSIGNMENT_PREFIX} role=verifier; runtime=${runtime.id} (${runtime.name}); process=${process.id} (${process.name})`;
}

export function verificationAssignmentCommentForProcesses(
  runtimes: readonly SoloWorkerRuntime[],
  processes: readonly SoloWorkerProcess[]
): string {
  if (runtimes.length === 1 && processes.length === 1) {
    return verificationAssignmentComment(runtimes[0]!, processes[0]!);
  }
  const assignments = runtimes.map((runtime, index) => {
    const process = processes[index];
    return process
      ? `runtime=${runtime.id} (${runtime.name}); process=${process.id} (${process.name})`
      : `runtime=${runtime.id} (${runtime.name}); process=unknown`;
  }).join(" | ");
  return `${VERIFICATION_ASSIGNMENT_PREFIX} role=verifier; ${assignments}`;
}

function workerNameForRuntime(
  baseName: string | undefined,
  runtime: SoloWorkerRuntime,
  count: number
): string | undefined {
  if (count <= 1) {
    return baseName;
  }
  return `${baseName ?? "verifier"}-${runtime.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function formatBullets(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- None"];
}
