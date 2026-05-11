import { describe, expect, it } from "vitest";
import {
  buildWorkerPrompt,
  dispatchWorker,
  selectWorkerRuntime,
  selectWorkerRuntimeForDispatch,
  type SoloWorkerClient,
  type SoloWorkerProcess,
  type SoloWorkerRuntime
} from "./soloWorkers.js";
import type { SoloTodo } from "./soloPlanning.js";
import { defaultSolistConfig, setSolistRoleBinding, setSolistRoleBindings } from "./solistConfig.js";

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

const todo: SoloTodo = {
  uri: "solo://proj/11/todo/181",
  projectId: 11,
  title: "Implement worker runtime selection, dispatch, and assignment recording",
  body: "Dispatch workers through Solo.",
  tags: [],
  comments: [],
  blockedBy: []
};

describe("Solo worker dispatch", () => {
  it("honors explicit runtime selection by id or name", async () => {
    const client = new FakeWorkerClient(
      [
        { id: "codex", name: "Codex" },
        { id: "explorer", name: "Explorer" }
      ],
      todo
    );

    await expect(selectWorkerRuntime(client, "explorer")).resolves.toMatchObject({
      status: "selected",
      runtime: { id: "explorer" }
    });
    await expect(selectWorkerRuntime(client, "Codex")).resolves.toMatchObject({
      status: "selected",
      runtime: { id: "codex" }
    });
  });

  it("returns decision-needed when runtime choice is ambiguous or unavailable", async () => {
    const ambiguous = new FakeWorkerClient(
      [
        { id: "codex", name: "Codex" },
        { id: "worker", name: "Worker" }
      ],
      todo
    );
    const unavailable = new FakeWorkerClient([], todo);

    await expect(selectWorkerRuntime(ambiguous)).resolves.toMatchObject({
      status: "decision-needed",
      reason: "Multiple Solo worker runtimes are available; choose one before dispatch."
    });
    await expect(selectWorkerRuntime(unavailable, "codex")).resolves.toMatchObject({
      status: "decision-needed",
      reason: 'Requested worker runtime "codex" is not available.'
    });
  });

  it("selects a worker runtime through configured role binding", async () => {
    const client = new FakeWorkerClient(
      [
        { id: "4", name: "Codex" },
        { id: "27", name: "Codex High" }
      ],
      todo
    );
    const config = setSolistRoleBinding(
      defaultSolistConfig(),
      "feature-worker",
      { agentToolId: 27, lastKnownName: "Codex High" }
    );

    await expect(selectWorkerRuntimeForDispatch(client, {
      role: "feature-worker",
      roleId: "feature-worker",
      config
    })).resolves.toMatchObject({
      status: "selected",
      runtime: { id: "27", name: "Codex High" }
    });
  });

  it("returns decision-needed when a configured role has no available runtime", async () => {
    const client = new FakeWorkerClient([{ id: "4", name: "Codex" }], todo);
    const config = setSolistRoleBinding(
      defaultSolistConfig(),
      "reviewer",
      { agentToolId: 1, lastKnownName: "Gemini" }
    );

    await expect(selectWorkerRuntimeForDispatch(client, {
      role: "reviewer",
      roleId: "reviewer",
      config
    })).resolves.toMatchObject({
      status: "decision-needed",
      reason: expect.stringContaining("does not match")
    });
  });

  it("builds a narrow worker prompt with coordination and ownership constraints", () => {
    const prompt = buildWorkerPrompt({
      objective: "Implement runtime dispatch only.",
      scratchpadUri: "solo://proj/11/scratchpad/solo-orchestration-a--50",
      todo,
      role: "worker",
      lane: "runtime-dispatch",
      ownershipBoundaries: ["Own src/soloWorkers.ts and focused tests."],
      whatNotToChange: ["Do not implement timer monitoring."],
      expectedHandoff: ["List files changed.", "Report tests run."]
    });

    expect(prompt).toContain("Objective: Implement runtime dispatch only.");
    expect(prompt).toContain("Scratchpad: solo://proj/11/scratchpad/solo-orchestration-a--50");
    expect(prompt).toContain("Todo: solo://proj/11/todo/181");
    expect(prompt).toContain("Role: worker");
    expect(prompt).toContain("Lane: runtime-dispatch");
    expect(prompt).toContain("Own src/soloWorkers.ts and focused tests.");
    expect(prompt).toContain("You are not alone in the codebase.");
    expect(prompt).toContain("Do not revert edits made by others.");
    expect(prompt).toContain("Do not implement timer monitoring.");
    expect(prompt).toContain("Report tests run.");
  });

  it("spawns the selected worker and records process metadata on the todo", async () => {
    const client = new FakeWorkerClient([{ id: "codex", name: "Codex" }], todo, {
      id: "solo-process-42",
      name: "runtime-dispatch-worker"
    });

    const result = await dispatchWorker(client, {
      objective: "Implement runtime dispatch only.",
      scratchpadUri: "solo://proj/11/scratchpad/solo-orchestration-a--50",
      todo,
      role: "worker",
      lane: "runtime-dispatch",
      ownershipBoundaries: ["Own worker dispatch files."],
      whatNotToChange: ["Do not mark the Solo todo complete."],
      expectedHandoff: ["Summarize behavior and tests."],
      workerName: "runtime-dispatch-worker"
    });

    expect(result.status).toBe("spawned");
    expect(client.spawnCalls).toEqual([
      {
        runtimeId: "codex",
        prompt: expect.stringContaining("Objective: Implement runtime dispatch only."),
        name: "runtime-dispatch-worker"
      }
    ]);
    expect(client.commentsAdded).toEqual([
      {
        uri: todo.uri,
        body: "Solist worker assignment: runtime=codex (Codex); process=solo-process-42 (runtime-dispatch-worker)"
      }
    ]);
    expect(result).toMatchObject({
      process: { id: "solo-process-42", name: "runtime-dispatch-worker" },
      todo: {
        comments: [
          {
            body: "Solist worker assignment: runtime=codex (Codex); process=solo-process-42 (runtime-dispatch-worker)"
          }
        ]
      }
    });
  });

  it("spawns role-bound workers and records the role in the assignment comment", async () => {
    const client = new FakeWorkerClient(
      [
        { id: "4", name: "Codex" },
        { id: "27", name: "Codex High" }
      ],
      todo,
      {
        id: "solo-process-44",
        name: "feature-worker"
      }
    );
    const config = setSolistRoleBinding(
      defaultSolistConfig(),
      "feature-worker",
      { agentToolId: 27, lastKnownName: "Codex High" }
    );

    const result = await dispatchWorker(client, {
      objective: "Implement a mode registry.",
      scratchpadUri: "solo://proj/11/scratchpad/solo-orchestration-a--50",
      todo,
      role: "feature-worker",
      roleId: "feature-worker",
      lane: "mode-registry",
      ownershipBoundaries: ["Own src/solistModes.ts and tests."],
      whatNotToChange: ["Do not alter auth behavior."],
      expectedHandoff: ["Summarize mode defaults."],
      workerName: "feature-worker",
      config
    });

    expect(result.status).toBe("spawned");
    expect(client.spawnCalls).toEqual([
      {
        runtimeId: "27",
        prompt: expect.stringContaining("Role: feature-worker"),
        name: "feature-worker"
      }
    ]);
    expect(client.commentsAdded).toEqual([
      {
        uri: todo.uri,
        body: "Solist worker assignment: role=feature-worker; runtime=27 (Codex High); process=solo-process-44 (feature-worker)"
      }
    ]);
  });

  it("spawns one worker per configured agent when a role maps to multiple agents", async () => {
    const client = new FakeWorkerClient(
      [
        { id: "27", name: "Codex High" },
        { id: "31", name: "Gemini" }
      ],
      todo
    );
    const config = setSolistRoleBindings(
      defaultSolistConfig(),
      "reviewer",
      [
        { agentToolId: 27, lastKnownName: "Codex High" },
        { agentToolId: 31, lastKnownName: "Gemini" }
      ]
    );

    const result = await dispatchWorker(client, {
      objective: "Review the implementation.",
      scratchpadUri: "solo://proj/11/scratchpad/50",
      todo,
      role: "reviewer",
      roleId: "reviewer",
      lane: "review",
      ownershipBoundaries: [],
      whatNotToChange: [],
      expectedHandoff: [],
      workerName: "reviewer",
      config
    });

    expect(result.status).toBe("spawned");
    expect(client.spawnCalls.map((call) => call.runtimeId)).toEqual(["27", "31"]);
    expect(client.spawnCalls.map((call) => call.name)).toEqual(["reviewer-27", "reviewer-31"]);
    expect(client.commentsAdded[0]?.body).toContain("runtime=27 (Codex High)");
    expect(client.commentsAdded[0]?.body).toContain("runtime=31 (Gemini)");
  });

  it("closes already spawned workers when a later multi-runtime spawn fails", async () => {
    const client = new FakeWorkerClient(
      [
        { id: "27", name: "Codex High" },
        { id: "31", name: "Gemini" }
      ],
      todo,
      { id: "solo-process-27", name: "reviewer-27" },
      2
    );
    const config = setSolistRoleBindings(
      defaultSolistConfig(),
      "reviewer",
      [
        { agentToolId: 27, lastKnownName: "Codex High" },
        { agentToolId: 31, lastKnownName: "Gemini" }
      ]
    );

    await expect(dispatchWorker(client, {
      objective: "Review the implementation.",
      scratchpadUri: "solo://proj/11/scratchpad/50",
      todo,
      role: "reviewer",
      roleId: "reviewer",
      lane: "review",
      ownershipBoundaries: [],
      whatNotToChange: [],
      expectedHandoff: [],
      workerName: "reviewer",
      config
    })).rejects.toThrow("spawn failed at 2");

    expect(client.closedProcessIds).toEqual(["solo-process-27"]);
    expect(client.commentsAdded).toEqual([]);
  });

  it("does not spawn or comment when runtime selection needs a decision", async () => {
    const client = new FakeWorkerClient(
      [
        { id: "codex", name: "Codex" },
        { id: "worker", name: "Worker" }
      ],
      todo
    );

    const result = await dispatchWorker(client, {
      objective: "Implement runtime dispatch only.",
      scratchpadUri: "solo://proj/11/scratchpad/solo-orchestration-a--50",
      todo,
      role: "worker",
      lane: "runtime-dispatch",
      ownershipBoundaries: [],
      whatNotToChange: [],
      expectedHandoff: []
    });

    expect(result.status).toBe("decision-needed");
    expect(client.spawnCalls).toEqual([]);
    expect(client.commentsAdded).toEqual([]);
  });
});
