import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSolistApiKeyResolver } from "./auth.js";

describe("createSolistApiKeyResolver", () => {
	it("resolves stored Pi auth credentials for the pinned Codex provider", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "solist-auth-test-"));
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({
			"openai-codex": { type: "api_key", key: "codex-test-key" },
		}));

		const resolver = createSolistApiKeyResolver(authPath);

		await expect(resolver("openai-codex")).resolves.toBe("codex-test-key");
	});
});
