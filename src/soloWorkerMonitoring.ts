import type { SoloTodo } from "./soloPlanning.js";

export interface MonitoredWorker {
  todo: SoloTodo;
  runtimeId: string;
  processId: string;
}

export type WorkerLifecycleState = "running" | "finished" | "failed" | "unknown";

export interface WorkerInspection {
  state: WorkerLifecycleState;
  exitCode?: number;
  output?: string;
  handoff?: string;
}

export interface WorkerInspectionClient {
  inspectWorker(input: { processId: string }): Promise<WorkerInspection>;
}

export interface WorkerCloseClient {
  closeWorkerProcess(processId: string): Promise<void>;
}

export interface WorkerTimer {
  id: string;
}

export interface WorkerTimerClient {
  setWorkerWakeTimer(input: {
    todoUri: string;
    processId: string;
    runtimeId: string;
    delayMs: number;
    reason: string;
    waitForIdle?: boolean;
  }): Promise<WorkerTimer>;
}

export interface WorkerHandoffCaptureClient {
  captureHandoff(input: {
    todoUri?: string;
    scratchpadUri?: string;
    processId: string;
    body: string;
  }): Promise<void>;
}

export interface WorkerMonitoringInput {
  workers: readonly MonitoredWorker[];
  checkDelayMs: number;
  inspectionClient: WorkerInspectionClient;
  timerClient: WorkerTimerClient;
  handoffCapture: WorkerHandoffCaptureClient;
  closeClient: WorkerCloseClient;
  shouldClose?: (input: { worker: MonitoredWorker; inspection: WorkerInspection }) => Promise<boolean> | boolean;
}

export interface RescheduledTimer {
  worker: MonitoredWorker;
  timerId: string;
}

export interface CompletedWorker {
  worker: MonitoredWorker;
  inspection: WorkerInspection;
  handoffCaptured: boolean;
  closed: boolean;
}

export interface WorkerMonitoringResult {
  stillRunning: readonly MonitoredWorker[];
  rescheduledTimers: readonly RescheduledTimer[];
  completed: readonly CompletedWorker[];
}

export const DEFAULT_REVIEW_AND_CLOSE = false;

function defaultShouldClose(): boolean {
  return DEFAULT_REVIEW_AND_CLOSE;
}

export function formatWorkerHandoffComment(input: {
  worker: MonitoredWorker;
  inspection: WorkerInspection;
}): string {
  const handoff = input.inspection.handoff ?? "No handoff payload was reported by the worker runtime.";
  const exitCode = input.inspection.exitCode;
  const output = input.inspection.output;
  const lines: string[] = [
    `Solist worker handoff: runtime=${input.worker.runtimeId}; process=${input.worker.processId}`,
    `- State: ${input.inspection.state}`,
    `- Exit code: ${exitCode ?? "n/a"}`,
    "- Hand-off:",
    handoff
  ];
  if (output) {
    lines.push("- Output:", output);
  }
  return lines.join("\n");
}

function isFinished(state: WorkerLifecycleState): boolean {
  return state === "finished" || state === "failed";
}

export async function monitorWorkers(input: WorkerMonitoringInput): Promise<WorkerMonitoringResult> {
  const completed: CompletedWorker[] = [];
  const stillRunning: MonitoredWorker[] = [];
  const rescheduledTimers: RescheduledTimer[] = [];

  const shouldClose = input.shouldClose ?? defaultShouldClose;

  for (const worker of input.workers) {
    const inspection = await input.inspectionClient.inspectWorker({
      processId: worker.processId
    });

    if (!isFinished(inspection.state)) {
      const timer = await input.timerClient.setWorkerWakeTimer({
        todoUri: worker.todo.uri,
        processId: worker.processId,
        runtimeId: worker.runtimeId,
        delayMs: input.checkDelayMs,
        reason: "Worker monitoring idle wake check.",
        waitForIdle: true
      });

      stillRunning.push(worker);
      rescheduledTimers.push({ worker, timerId: timer.id });
      continue;
    }

    const body = formatWorkerHandoffComment({ worker, inspection });
    await input.handoffCapture.captureHandoff({
      todoUri: worker.todo.uri,
      processId: worker.processId,
      body
    });

    const needToClose = await shouldClose({ worker, inspection });
    let closed = false;
    if (needToClose) {
      await input.closeClient.closeWorkerProcess(worker.processId);
      closed = true;
    }

    completed.push({
      worker,
      inspection,
      handoffCaptured: true,
      closed
    });
  }

  return { stillRunning, rescheduledTimers, completed };
}
