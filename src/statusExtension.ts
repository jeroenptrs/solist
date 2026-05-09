import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SOLIST_MODEL_PATTERN, SOLIST_THINKING_LEVEL } from "./solistPrompt.js";
import { SOLIST_ALLOWED_TOOLS } from "./orchestratorPolicy.js";

function statusText(state: string, turnCount: number): string {
  const turn = turnCount > 0 ? `turn ${turnCount}` : "ready";
  return `Solist ${state} | ${SOLIST_MODEL_PATTERN} | reasoning ${SOLIST_THINKING_LEVEL} | tools ${SOLIST_ALLOWED_TOOLS.join(",")} | ${turn}`;
}

export function solistStatusExtension(pi: ExtensionAPI): void {
  let turnCount = 0;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("solist", ctx.ui.theme.fg("dim", statusText("orchestrator", turnCount)));
  });

  pi.on("turn_start", async (_event, ctx) => {
    turnCount += 1;
    ctx.ui.setStatus("solist", ctx.ui.theme.fg("accent", statusText("working", turnCount)));
  });

  pi.on("turn_end", async (_event, ctx) => {
    ctx.ui.setStatus("solist", ctx.ui.theme.fg("success", statusText("idle", turnCount)));
  });
}
