import { getEnvApiKey } from "@earendil-works/pi-ai";

export type SolistApiKeyResolver = (
	provider: string,
) => Promise<string | undefined> | string | undefined;

interface AuthStorageLike {
	getApiKey(
		providerId: string,
		options?: { includeFallback?: boolean },
	): Promise<string | undefined>;
}

interface AuthStorageFactory {
	create(authPath?: string): AuthStorageLike;
}

const storedAuthByPath = new Map<string, AuthStorageLike>();

export function createSolistApiKeyResolver(
	authPath?: string,
): SolistApiKeyResolver {
	return async (provider) => {
		const storage = await getStoredAuth(authPath);
		if (storage) {
			const key = await storage.getApiKey(provider, { includeFallback: false });
			if (key) return key;
		}

		return getEnvApiKey(provider);
	};
}

async function getStoredAuth(
	authPath?: string,
): Promise<AuthStorageLike | undefined> {
	const cacheKey = authPath ?? "";
	const cached = storedAuthByPath.get(cacheKey);
	if (cached) return cached;

	try {
		const { AuthStorage } = await import("@earendil-works/pi-coding-agent") as {
			AuthStorage: AuthStorageFactory;
		};
		const storage = AuthStorage.create(authPath);
		storedAuthByPath.set(cacheKey, storage);
		return storage;
	} catch {
		return undefined;
	}
}
