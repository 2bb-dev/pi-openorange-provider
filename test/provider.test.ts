import type {
	ApiKeyCredential,
	AuthContext,
	AuthInteraction,
	AuthPrompt,
	ProviderModelsStore,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenOrangeProvider } from "../src/provider.js";

const INSTANCE = "https://acme.openorange.ai";

const MODEL_INFO = {
	data: [
		{
			model_name: "anthropic/claude-sonnet-5",
			model_info: { mode: "chat", max_input_tokens: 200_000, max_output_tokens: 64_000 },
		},
		{ model_name: "openai/gpt-5.5", model_info: { mode: "responses" } },
	],
};

function stubInstance(overrides: Record<string, unknown> = {}) {
	const fetchMock = vi.fn(async (url: string | URL) => {
		const path = new URL(String(url)).pathname;
		if (path === "/v1/model/info") return Response.json(overrides["modelInfo"] ?? MODEL_INFO);
		if (path === "/key/info") {
			return Response.json(overrides["keyInfo"] ?? { info: { user_id: "sasha", key_alias: "pi-sasha" } });
		}
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function interaction(answers: string[]): AuthInteraction {
	const queue = [...answers];
	return {
		prompt: async (_prompt: AuthPrompt) => {
			const next = queue.shift();
			if (next === undefined) throw new Error("unexpected prompt");
			return next;
		},
		notify: () => undefined,
	};
}

function authContext(env: Record<string, string> = {}): AuthContext {
	return {
		env: async (name: string) => env[name],
		fileExists: async () => false,
	};
}

function memoryStore(): ProviderModelsStore {
	let value: Awaited<ReturnType<ProviderModelsStore["read"]>>;
	return {
		read: async () => value,
		write: async (next) => {
			value = next;
		},
	} as ProviderModelsStore;
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env["OPENORANGE_BASE_URL"];
	delete process.env["OPENORANGE_API_KEY"];
});

describe("login", () => {
	it("stores the instance, the key, and the key owner", async () => {
		stubInstance();
		const provider = createOpenOrangeProvider();
		const credential = await provider.auth.apiKey?.login?.(
			interaction(["acme.openorange.ai", "sk-test"]),
		);
		expect(credential).toEqual({
			type: "api_key",
			key: "sk-test",
			env: { OPENORANGE_BASE_URL: INSTANCE, OPENORANGE_USER_ID: "sasha" },
		});
		expect(provider.getModels().map((model) => model.id)).toEqual([
			"anthropic/claude-sonnet-5",
			"openai/gpt-5.5",
		]);
	});

	it("rejects a localhost instance before asking for the key", async () => {
		stubInstance();
		const provider = createOpenOrangeProvider();
		await expect(
			provider.auth.apiKey?.login?.(interaction(["http://localhost:4000", "sk-test"])),
		).rejects.toThrow(/https/);
	});

	it("fails when the key is rejected by the instance", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
		const provider = createOpenOrangeProvider();
		await expect(
			provider.auth.apiKey?.login?.(interaction(["acme.openorange.ai", "sk-bad"])),
		).rejects.toThrow(/invalid inference key/);
	});

	it("still logs in when /key/info is unavailable", async () => {
		stubInstance({ keyInfo: undefined });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) =>
				new URL(String(url)).pathname === "/v1/model/info"
					? Response.json(MODEL_INFO)
					: new Response("forbidden", { status: 403 }),
			),
		);
		const provider = createOpenOrangeProvider();
		await expect(
			provider.auth.apiKey?.login?.(interaction(["acme.openorange.ai", "sk-test"])),
		).resolves.toEqual({
			type: "api_key",
			key: "sk-test",
			env: { OPENORANGE_BASE_URL: INSTANCE },
		});
	});
});

describe("resolve", () => {
	const credential: ApiKeyCredential = {
		type: "api_key",
		key: "sk-test",
		env: { OPENORANGE_BASE_URL: INSTANCE, OPENORANGE_USER_ID: "sasha" },
	};

	it("uses the stored credential", async () => {
		const provider = createOpenOrangeProvider();
		await expect(provider.auth.apiKey?.resolve({ ctx: authContext(), credential })).resolves.toEqual({
			auth: { apiKey: "sk-test" },
			env: { OPENORANGE_BASE_URL: INSTANCE, OPENORANGE_USER_ID: "sasha" },
			source: `stored credential (acme.openorange.ai)`,
		});
	});

	it("falls back to environment configuration", async () => {
		const provider = createOpenOrangeProvider();
		const ctx = authContext({
			OPENORANGE_BASE_URL: "acme.openorange.ai",
			OPENORANGE_API_KEY: "sk-env",
		});
		await expect(provider.auth.apiKey?.resolve({ ctx, credential: undefined })).resolves.toEqual({
			auth: { apiKey: "sk-env" },
			env: { OPENORANGE_BASE_URL: INSTANCE },
			source: "OPENORANGE_BASE_URL (acme.openorange.ai)",
		});
	});

	it("is unconfigured without a key", async () => {
		const provider = createOpenOrangeProvider();
		const ctx = authContext({ OPENORANGE_BASE_URL: INSTANCE });
		await expect(
			provider.auth.apiKey?.resolve({ ctx, credential: undefined }),
		).resolves.toBeUndefined();
	});

	it("is unconfigured when the stored instance URL is not usable", async () => {
		const provider = createOpenOrangeProvider();
		await expect(
			provider.auth.apiKey?.resolve({
				ctx: authContext(),
				credential: { type: "api_key", key: "sk-test", env: { OPENORANGE_BASE_URL: "localhost" } },
			}),
		).resolves.toBeUndefined();
	});
});

describe("refreshModels", () => {
	const credential: ApiKeyCredential = {
		type: "api_key",
		key: "sk-test",
		env: { OPENORANGE_BASE_URL: INSTANCE },
	};

	it("fetches and persists the instance catalog", async () => {
		stubInstance();
		const provider = createOpenOrangeProvider();
		const store = memoryStore();
		await provider.refreshModels?.({ credential, store, allowNetwork: true });
		expect(provider.getModels()).toHaveLength(2);
		expect((await store.read())?.models).toHaveLength(2);
	});

	it("serves the cached catalog offline", async () => {
		stubInstance();
		const store = memoryStore();
		const first = createOpenOrangeProvider();
		await first.refreshModels?.({ credential, store, allowNetwork: true });

		const offline = createOpenOrangeProvider();
		await offline.refreshModels?.({ credential, store, allowNetwork: false });
		expect(offline.getModels()).toHaveLength(2);
	});

	it("drops a catalog cached for another instance", async () => {
		stubInstance();
		const store = memoryStore();
		const first = createOpenOrangeProvider();
		await first.refreshModels?.({ credential, store, allowNetwork: true });

		const other = createOpenOrangeProvider();
		await other.refreshModels?.({
			credential: { ...credential, env: { OPENORANGE_BASE_URL: "https://other.openorange.ai" } },
			store,
			allowNetwork: false,
		});
		expect(other.getModels()).toEqual([]);
	});

	it("does nothing without configuration", async () => {
		const fetchMock = stubInstance();
		const provider = createOpenOrangeProvider();
		await provider.refreshModels?.({ credential: undefined, store: memoryStore(), allowNetwork: true });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(provider.getModels()).toEqual([]);
	});
});
