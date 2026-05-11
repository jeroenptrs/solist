import { describe, expect, it } from "vitest";
import {
  getVerificationStatus,
  isReadyForCompletion,
  buildVerifierPrompt,
  dispatchVerification,
  VERIFICATION_ASSIGNMENT_PREFIX,
  VERIFICATION_EVIDENCE_PREFIX,
  VERIFICATION_BLOCKER_PREFIX,
  VERIFICATION_OVERRIDE_TAG
} from "./soloVerification.js";
import type { SoloTodo } from "./soloPlanning.js";
import { defaultSolistConfig, setSolistRoleBinding, setSolistRoleBindings } from "./solistConfig.js";
import { 
  type SoloWorkerClient, 
  type SoloWorkerProcess, 
  type SoloWorkerRuntime 
} from "./soloWorkers.js";

class FakeWorkerClient implements SoloWorkerClient {
  public spawnCalls: Array<{ runtimeId: string; prompt: string; name?: string }> = [];
  public commentsAdded: Array<{ uri: string; body: string }> = [];
  public closedProcessIds: string[] = [];

  constructor(
    public runtimes: SoloWorkerRuntime[],
    public todo: SoloTodo,
    private readonly process: SoloWorkerProcess = { id: "proc-1", name: "Worker 1" },
    private readonly failSpawnAt?: number
  ) {}

  async listWorkerRuntimes(): Promise<SoloWorkerRuntime[]> {
    return this.runtimes;
  }

  async spawnWorker(input: {
    runtimeId: string;
    prompt: string;
    name?: string;
  }): Promise<SoloWorkerProcess> {
    this.spawnCalls.push(input);
    if (this.failSpawnAt === this.spawnCalls.length) {
      throw new Error(`spawn failed at ${this.spawnCalls.length}`);
    }
    return this.process;
  }

  async addTodoComment(uri: string, body: string): Promise<SoloTodo> {
    this.commentsAdded.push({ uri, body });
    this.todo = {
      ...this.todo,
      comments: [...this.todo.comments, { body }]
    };
    return this.todo;
  }

  async closeWorkerProcess(processId: string): Promise<void> {
    this.closedProcessIds.push(processId);
  }
}

const baseTodo: SoloTodo = {
  uri: "solo://proj/11/todo/183",
  projectId: 11,
  title: "Add verification and review orchestration path",
  body: "Implementation of verification path.",
  tags: [],
  comments: [],
  blockedBy: []
};

describe("Solo verification orchestration", () => {
  it("determines verification status from todo comments", () => {
    const todoWithComments: SoloTodo = {
      ...baseTodo,
      comments: [
        { body: `${VERIFICATION_ASSIGNMENT_PREFIX} runtime=codex; process=proc-123` },
        { body: `${VERIFICATION_EVIDENCE_PREFIX} All tests passed.` },
        { body: `${VERIFICATION_BLOCKER_PREFIX} Missing documentation.` }
      ]
    };

    const status = getVerificationStatus(todoWithComments);
    expect(status.state).toBe("blocked");
    expect(status.verifierProcessId).toBe("proc-123");
    expect(status.evidence).toContain("All tests passed.");
    expect(status.blockers).toContain("Missing documentation.");
  });

  it("identifies verified state when evidence is present without blockers", () => {
    const todoWithEvidence: SoloTodo = {
      ...baseTodo,
      comments: [
        { body: `${VERIFICATION_ASSIGNMENT_PREFIX} runtime=codex; process=proc-123` },
        { body: `${VERIFICATION_EVIDENCE_PREFIX} Verified behavior with integration tests.` }
      ]
    };

    const status = getVerificationStatus(todoWithEvidence);
    expect(status.state).toBe("verified");
    expect(status.evidence).toEqual(["Verified behavior with integration tests."]);
  });

  it("honors verification overrides via tags", () => {
    const todoWithOverride: SoloTodo = {
      ...baseTodo,
      tags: [VERIFICATION_OVERRIDE_TAG]
    };

    const status = getVerificationStatus(todoWithOverride);
    expect(status.state).toBe("verified");
    expect(status.evidence).toContain("Verification explicitly overridden by user/tag.");
  });

  it("reports readiness for completion based on verification status", () => {
    expect(isReadyForCompletion(baseTodo)).toMatchObject({
      ready: false,
      reason: "Verification has not started."
    });

    const overridden: SoloTodo = {
      ...baseTodo,
      tags: [VERIFICATION_OVERRIDE_TAG]
    };
    expect(isReadyForCompletion(overridden)).toMatchObject({
      ready: true
    });

    const assigned: SoloTodo = {
      ...baseTodo,
      comments: [{ body: `${VERIFICATION_ASSIGNMENT_PREFIX} process=p1` }]
    };
    expect(isReadyForCompletion(assigned)).toMatchObject({
      ready: false,
      reason: "Verification is in progress."
    });

    const blocked: SoloTodo = {
      ...assigned,
      comments: [...assigned.comments, { body: `${VERIFICATION_BLOCKER_PREFIX} Bug found.` }]
    };
    expect(isReadyForCompletion(blocked)).toMatchObject({
      ready: false,
      reason: "Verification found blockers: Bug found."
    });

    const verified: SoloTodo = {
      ...assigned,
      comments: [...assigned.comments, { body: `${VERIFICATION_EVIDENCE_PREFIX} Tests pass.` }]
    };
    expect(isReadyForCompletion(verified)).toMatchObject({
      ready: true
    });
  });

  it("builds a verifier prompt with implementation evidence and tasks", () => {
    const prompt = buildVerifierPrompt({
      objective: "Verify the new verification path.",
      scratchpadUri: "solo://proj/11/scratchpad/50",
      todo: baseTodo,
      implementationEvidence: "I added src/soloVerification.ts and tests.",
      ownershipBoundaries: ["Own src/soloVerification.ts"],
      whatNotToChange: ["Do not change src/soloWorkers.ts"],
      expectedHandoff: ["Report coverage."]
    });

    expect(prompt).toContain("Objective: Verify and review implementation");
    expect(prompt).toContain("Implementation evidence:");
    expect(prompt).toContain("I added src/soloVerification.ts and tests.");
    expect(prompt).toContain("Your Role: Verifier / Reviewer");
    expect(prompt).toContain("Lane: verification");
    expect(prompt).toContain(VERIFICATION_EVIDENCE_PREFIX);
    expect(prompt).toContain(VERIFICATION_BLOCKER_PREFIX);
  });

  it("dispatches a verifier worker and records unique verification assignment", async () => {
    const client = new FakeWorkerClient([{ id: "codex", name: "Codex" }], baseTodo, {
      id: "solo-proc-v1",
      name: "verifier-worker"
    });

    const result = await dispatchVerification(client, {
      objective: "Verify the new verification path.",
      scratchpadUri: "solo://proj/11/scratchpad/50",
      todo: baseTodo,
      ownershipBoundaries: [],
      whatNotToChange: [],
      expectedHandoff: [],
      workerName: "verifier-worker",
      implementationEvidence: "Implementation is done."
    });

    expect(result.status).toBe("spawned");
    if (result.status === "spawned") {
      // Exact prompt passed to spawnWorker
      expect(client.spawnCalls[0].prompt).toContain("Lane: verification");
      expect(client.spawnCalls[0].prompt).toContain("Implementation is done.");
      expect(result.prompt).toBe(client.spawnCalls[0].prompt);
    }
    
    // Should have ONLY the verification-specific assignment
    expect(client.commentsAdded).toHaveLength(1);
    expect(client.commentsAdded[0].body).toContain(VERIFICATION_ASSIGNMENT_PREFIX);
    expect(client.commentsAdded[0].body).toContain("role=verifier");
    expect(client.commentsAdded[0].body).not.toContain("Solist worker assignment:");
  });

  it("uses the configured verifier role binding when dispatching verification", async () => {
    const client = new FakeWorkerClient([
      { id: "codex", name: "Codex" },
      { id: "codex-high", name: "Codex High" },
    ], baseTodo);
    const config = setSolistRoleBinding(defaultSolistConfig(), "verifier", {
      agentToolName: "Codex High",
    });

    const result = await dispatchVerification(client, {
      objective: "Verify the new verification path.",
      scratchpadUri: "solo://proj/11/scratchpad/50",
      todo: baseTodo,
      ownershipBoundaries: [],
      whatNotToChange: [],
      expectedHandoff: [],
      config,
    });

    expect(result.status).toBe("spawned");
    expect(client.spawnCalls[0]?.runtimeId).toBe("codex-high");
  });

  it("closes already spawned verifier workers when a later multi-runtime spawn fails", async () => {
    const client = new FakeWorkerClient([
      { id: "27", name: "Codex High" },
      { id: "31", name: "Gemini" },
    ], baseTodo, { id: "solo-proc-v1", name: "verifier-27" }, 2);
    const config = setSolistRoleBindings(defaultSolistConfig(), "verifier", [
      { agentToolId: 27, lastKnownName: "Codex High" },
      { agentToolId: 31, lastKnownName: "Gemini" },
    ]);

    await expect(dispatchVerification(client, {
      objective: "Verify the new verification path.",
      scratchpadUri: "solo://proj/11/scratchpad/50",
      todo: baseTodo,
      ownershipBoundaries: [],
      whatNotToChange: [],
      expectedHandoff: [],
      config,
    })).rejects.toThrow("spawn failed at 2");

    expect(client.closedProcessIds).toEqual(["solo-proc-v1"]);
    expect(client.commentsAdded).toEqual([]);
  });
});
