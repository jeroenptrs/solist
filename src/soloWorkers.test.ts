import { describe, expect, it } from "vitest";
import {
  buildWorkerPrompt,
  dispatchWorker,
  selectWorkerRuntime,
  type SoloWorkerClient,
  type SoloWorkerProcess,
  type SoloWorkerRuntime
} from "./soloWorkers.js";
import type { SoloTodo } from "./soloPlanning.js";

class FakeWorkerClient implements SoloWorkerClient {
  public spawnCalls: Array<{ runtimeId: string; prompt: string; name?: string }> = [];
  public commentsAdded: Array<{ uri: string; body: string }> = [];

  constructor(
    public runtimes: SoloWorkerRuntime[],
    public todo: SoloTodo,
    private readonly process: SoloWorkerProcess = { id: "proc-1", name: "Worker 1" }
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
