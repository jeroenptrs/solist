import { describe, expect, it } from "vitest";
import { SOLIST_HARDENING_FLAGS } from "./orchestratorPolicy.js";
import type { FeasibilityResult } from "./feasibility.js";

describe("feasibility check payload shape", () => {
  it("includes wrapperHardeningActive and wrapperHardeningFlags in the result type", () => {
    const result: FeasibilityResult = {
      ok: true,
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "off",
      availableModelCount: 1,
      providerAuthConfigured: true,
      mcpAllowlist: "solo",
      wrapperHardeningActive: true,
      wrapperHardeningFlags: [...SOLIST_HARDENING_FLAGS],
      message: "Test",
    };

    expect(result.wrapperHardeningActive).toBe(true);
    expect(result.wrapperHardeningFlags).toEqual(SOLIST_HARDENING_FLAGS);
  });

  it("reports hardening flags in the expected order", () => {
    expect(SOLIST_HARDENING_FLAGS).toEqual([
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ]);
  });
});
