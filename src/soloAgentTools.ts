import { writeSoloMcpRuntimeConfig } from "./soloMcp.js";
import { createDirectSoloMcpClient, type SoloMcpToolCallResult } from "./soloMcpDirect.js";
import type { SoloAgentToolReference } from "./solistConfig.js";

export async function listSoloAgentTools(): Promise<SoloAgentToolReference[]> {
	const soloMcp = writeSoloMcpRuntimeConfig();
	const client = createDirectSoloMcpClient(soloMcp.config.mcpServers.solo);
	try {
		const result = await client.callTool("list_agent_tools", {});
		return parseSoloAgentTools(result);
	} finally {
		await client.close?.();
	}
}

export async function getCurrentSoloProjectId(): Promise<number | undefined> {
	const soloMcp = writeSoloMcpRuntimeConfig();
	const client = createDirectSoloMcpClient(soloMcp.config.mcpServers.solo);
	try {
		const result = await client.callTool("whoami", {});
		const parsed = parseSoloToolJson(result);
		if (!isRecord(parsed)) {
			return undefined;
		}
		const candidates = [
			parsed.effective_project_id,
			parsed.selected_project_id,
			parsed.project_id,
		];
		for (const candidate of candidates) {
			const projectId = typeof candidate === "number" ? candidate : Number(candidate);
			if (Number.isInteger(projectId) && projectId > 0) {
				return projectId;
			}
		}
		return undefined;
	} finally {
		await client.close?.();
	}
}

export function parseSoloAgentTools(result: SoloMcpToolCallResult): SoloAgentToolReference[] {
	const parsed = parseSoloToolJson(result);
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.flatMap((item) => {
		if (!isRecord(item)) {
			return [];
		}
		const id = typeof item.id === "number" ? item.id : Number(item.id);
		if (!Number.isInteger(id) || typeof item.name !== "string") {
			return [];
		}
		return [{
			id,
			name: item.name,
			...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
		}];
	});
}

export function parseSoloToolJson(result: SoloMcpToolCallResult): unknown {
	const text = result.content
		?.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n")
		.trim();
	if (!text) {
		return undefined;
	}
	return JSON.parse(text) as unknown;
}

export function formatAgentToolChoices(agentTools: readonly SoloAgentToolReference[]): string {
	return agentTools
		.filter((tool) => tool.enabled !== false)
		.map((tool) => `${tool.id} (${tool.name})`)
		.join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
