import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_AND_CLOSE,
  formatWorkerHandoffComment,
  monitorWorkers,
  type CompletedWorker,
  type MonitoredWorker,
  type WorkerCloseClient,
  type WorkerInspectionClient,
  type WorkerInspection,
  type WorkerTimerClient,
  type WorkerHandoffCaptureClient
} from "./soloWorkerMonitoring.js";
import type { SoloTodo } from "./soloPlanning.js";

interface FakeInspectionPlan {
  [processId: string]: WorkerInspection;
}

class FakeInspectionClient implements WorkerInspectionClient {
  public inspected: string[] = [];

  constructor(private readonly plan: FakeInspectionPlan) {}

  async inspectWorker(input: { processId: string }): Promise<WorkerInspection> {
    this.inspected.push(input.processId);
    const report = this.plan[input.processId];
    if (!report) {
      return { state: "unknown" };
    }
    return report;
  }
}

class FakeTimerClient implements WorkerTimerClient {
  public schedules: Array<{
    todoUri: string;
    processId: string;
    runtimeId: string;
    delayMs: number;
    reason: string;
  }> = [];

  async setWorkerWakeTimer(input: {
    todoUri: string;
    processId: string;
    runtimeId: string;
    delayMs: number;
    reason: string;
  }): Promise<{ id: string }> {
    this.schedules.push(input);
    return {
      id: `timer-${this.schedules.length}-${input.processId}`
    };
  }
}

class FakeCloseClient implements WorkerCloseClient {
  public closed: string[] = [];

  async closeWorkerProcess(processId: string): Promise<void> {
    this.closed.push(processId);
  }
}

class FakeHandoffCaptureClient implements WorkerHandoffCaptureClient {
  public captures: Array<{ todoUri: string; processId: string; body: string }> = [];

  async captureHandoff(input: { todoUri: string; processId: string; body: string }): Promise<void> {
    this.captures.push(input);
  }
}

const todo: SoloTodo = {
  uri: "solo://proj/11/todo/182",
  projectId: 11,
  title: "Implement timer-based worker monitoring, handoff capture, and cleanup",
  tags: [],
  comments: [],
  blockedBy: []
};

function workerForProcess(processId: string): MonitoredWorker {
  return {
    todo,
    runtimeId: "codex",
    processId
  };
}

describe("worker monitoring", () => {
  it("sets timers for still-running workers and leaves them unsafely unclosed", async () => {
    const workers: MonitoredWorker[] = [
      workerForProcess("proc-running-1"),
      workerForProcess("proc-running-2")
    ];

    const inspection = new FakeInspectionClient({
      "proc-running-1": { state: "running" },
      "proc-running-2": { state: "unknown" }
    });
    const timerClient = new FakeTimerClient();
    const closeClient = new FakeCloseClient();
    const handoffCapture = new FakeHandoffCaptureClient();

    const result = await monitorWorkers({
      workers,
      checkDelayMs: 2_000,
      inspectionClient: inspection,
      timerClient,
      closeClient,
      handoffCapture
    });

    expect(result.stillRunning).toHaveLength(2);
    expect(result.rescheduledTimers).toHaveLength(2);
    expect(result.completed).toHaveLength(0);
    expect(timerClient.schedules).toHaveLength(2);
    expect(timerClient.schedules[0]).toEqual({
      todoUri: todo.uri,
      processId: "proc-running-1",
      runtimeId: "codex",
      delayMs: 2_000,
      reason: "Worker monitoring wake check."
    });
    expect(closeClient.closed).toHaveLength(0);
    expect(handoffCapture.captures).toHaveLength(0);
    expect(inspection.inspected).toEqual(["proc-running-1", "proc-running-2"]);
  });

  it("captures handoff and closes finished workers when review policy allows it", async () => {
    const workers: MonitoredWorker[] = [workerForProcess("proc-finished-1"), workerForProcess("proc-failed-1")];
    const inspection = new FakeInspectionClient({
      "proc-finished-1": {
        state: "finished",
        exitCode: 0,
        handoff: "Implemented changes for todo.",
        output: "stdout: done"
      },
      "proc-failed-1": {
        state: "failed",
        exitCode: 1,
        handoff: "Compilation failed."
      }
    });
    const timerClient = new FakeTimerClient();
    const closeClient = new FakeCloseClient();
    const handoffCapture = new FakeHandoffCaptureClient();

    const result = await monitorWorkers({
      workers,
      checkDelayMs: 2_000,
      inspectionClient: inspection,
      timerClient,
      closeClient,
      handoffCapture,
      shouldClose: async () => true
    });

    expect(result.stillRunning).toHaveLength(0);
    expect(result.rescheduledTimers).toHaveLength(0);
    expect(result.completed).toHaveLength(2);
    expect(closeClient.closed).toEqual(["proc-finished-1", "proc-failed-1"]);
    expect(handoffCapture.captures.map((capture) => capture.processId)).toEqual([
      "proc-finished-1",
      "proc-failed-1"
    ]);
    const first = result.completed[0] as CompletedWorker;
    expect(first.handoffCaptured).toBe(true);
    expect(first.closed).toBe(true);
    expect(handoffCapture.captures[0].body).toContain("- State: finished");
    expect(handoffCapture.captures[1].body).toContain("Compilation failed.");
    expect(timerClient.schedules).toHaveLength(0);
  });

  it("returns completed workers but skips closure when review policy disallows it", async () => {
    const workers: MonitoredWorker[] = [workerForProcess("proc-finished-2")];
    const inspection = new FakeInspectionClient({
      "proc-finished-2": {
        state: "finished",
        exitCode: 0,
        handoff: "Worker completed with no blockers."
      }
    });
    const timerClient = new FakeTimerClient();
    const closeClient = new FakeCloseClient();
    const handoffCapture = new FakeHandoffCaptureClient();

    const result = await monitorWorkers({
      workers,
      checkDelayMs: 2_000,
      inspectionClient: inspection,
      timerClient,
      closeClient,
      handoffCapture,
      shouldClose: async () => false
    });

    expect(result.completed).toHaveLength(1);
    expect(closeClient.closed).toHaveLength(0);
    expect(handoffCapture.captures).toHaveLength(1);
  });

  it("formats durable handoff comments with stable keys", () => {
    const comment = formatWorkerHandoffComment({
      worker: workerForProcess("proc-finished-3"),
      inspection: { state: "finished", exitCode: 7, handoff: "Done", output: "worker log line" }
    });

    expect(comment).toBe(`Solist worker handoff: runtime=codex; process=proc-finished-3
- State: finished
- Exit code: 7
- Hand-off:
Done
- Output:
worker log line`);
  });

  it("uses default false-close behavior when policy is not provided", async () => {
    const workers: MonitoredWorker[] = [workerForProcess("proc-finished-3")];
    const inspection = new FakeInspectionClient({
      "proc-finished-3": {
        state: "finished",
        exitCode: 0,
        handoff: "done"
      }
    });
    const timerClient = new FakeTimerClient();
    const closeClient = new FakeCloseClient();
    const handoffCapture = new FakeHandoffCaptureClient();

    const result = await monitorWorkers({
      workers,
      checkDelayMs: 2_000,
      inspectionClient: inspection,
      timerClient,
      closeClient,
      handoffCapture
    });

    expect(result.completed).toHaveLength(1);
    expect(closeClient.closed).toHaveLength(0);
    expect(DEFAULT_REVIEW_AND_CLOSE).toBe(false);
  });
});
