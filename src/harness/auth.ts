import { getEnvApiKey } from "@earendil-works/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderInterface } from "@earendil-works/pi-ai";
import { getSolistAuthPath } from "../solistPaths.js";

export type SolistApiKeyResolver = (
	provider: string,
) => Promise<string | undefined> | string | undefined;

export type SolistProviderAuthSource = "stored" | "environment";

export interface SolistProviderAuthStatus {
	readonly provider: string;
	readonly authPath: string;
	readonly configured: boolean;
	readonly source?: SolistProviderAuthSource;
}

interface AuthStorageLike {
	getApiKey(
		providerId: string,
		options?: { includeFallback?: boolean },
	): Promise<string | undefined>;
	has(provider: string): boolean;
	reload?(): void;
	login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void>;
	logout(provider: string): void;
	getOAuthProviders(): OAuthProviderInterface[];
}

interface AuthStorageFactory {
	create(authPath?: string): AuthStorageLike;
}

const storedAuthByPath = new Map<string, AuthStorageLike>();

export function createSolistApiKeyResolver(
	authPath = getSolistAuthPath(),
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

export async function createSolistAuthStorage(
	authPath = getSolistAuthPath(),
): Promise<AuthStorageLike> {
	const storage = await getStoredAuth(authPath);
	if (!storage) {
		throw new Error("Pi auth storage primitives are unavailable.");
	}
	return storage;
}

export async function getSolistProviderAuthStatus(
	provider: string,
	authPath = getSolistAuthPath(),
): Promise<SolistProviderAuthStatus> {
	const storage = await getStoredAuth(authPath);
	storage?.reload?.();

	if (storage?.has(provider)) {
		return {
			provider,
			authPath,
			configured: true,
			source: "stored",
		};
	}

	if (getEnvApiKey(provider)) {
		return {
			provider,
			authPath,
			configured: true,
			source: "environment",
		};
	}

	return {
		provider,
		authPath,
		configured: false,
	};
}

export async function loginSolistProvider(
	provider: string,
	callbacks: OAuthLoginCallbacks,
	authPath = getSolistAuthPath(),
): Promise<void> {
	const storage = await createSolistAuthStorage(authPath);
	await storage.login(provider, callbacks);
}

export async function logoutSolistProvider(
	provider: string,
	authPath = getSolistAuthPath(),
): Promise<void> {
	const storage = await createSolistAuthStorage(authPath);
	storage.logout(provider);
}

export async function getSolistOAuthProviderName(
	provider: string,
	authPath = getSolistAuthPath(),
): Promise<string> {
	const storage = await createSolistAuthStorage(authPath);
	return storage.getOAuthProviders().find((candidate) => candidate.id === provider)
		?.name ?? provider;
}

async function getStoredAuth(
	authPath = getSolistAuthPath(),
): Promise<AuthStorageLike | undefined> {
	const cacheKey = authPath;
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
