import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { withOpenOrangePayload } from "../src/payload.js";

function model(api: Api): Model<Api> {
	return {
		id: "m",
		name: "m",
		api,
		provider: "openorange",
		baseUrl: "https://acme.openorange.ai",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const env = { OPENORANGE_USER_ID: "sasha" };

function options(overrides: StreamOptions = {}): StreamOptions {
	return { env, sessionId: "01997c1d-3f9c-7c2a-9a1f-1d2e3f4a5b6c", ...overrides };
}

async function payloadFor(api: Api, overrides: StreamOptions = {}, input: unknown = { model: "m" }) {
	const resolved = withOpenOrangePayload(model(api), options(overrides));
	return await resolved?.onPayload?.(input, model(api));
}

describe("spend attribution", () => {
	it("adds the key owner as `user` on OpenAI payloads", async () => {
		await expect(payloadFor("openai-completions")).resolves.toMatchObject({ user: "sasha" });
	});

	it("adds the key owner as `metadata.user_id` on Anthropic payloads", async () => {
		await expect(
			payloadFor("anthropic-messages", {}, { model: "m", metadata: { existing: true } }),
		).resolves.toEqual({ model: "m", metadata: { existing: true, user_id: "sasha" } });
	});

	it("is a no-op without a resolved user or session", () => {
		const empty: StreamOptions = { env: {} };
		expect(withOpenOrangePayload(model("openai-completions"), empty)).toBe(empty);
	});
});

describe("prompt cache key", () => {
	it("pins OpenAI requests to the session's cache partition", async () => {
		await expect(payloadFor("openai-completions")).resolves.toMatchObject({
			prompt_cache_key: "01997c1d-3f9c-7c2a-9a1f-1d2e3f4a5b6c",
		});
	});

	it("clamps the key to OpenAI's 64 character limit", async () => {
		const payload = await payloadFor("openai-completions", { sessionId: "s".repeat(80) });
		expect((payload as Record<string, string>)["prompt_cache_key"]).toHaveLength(64);
	});

	it("never overrides a cache key the caller already set", async () => {
		const payload = await payloadFor("openai-completions", {}, {
			model: "m",
			prompt_cache_key: "caller",
		});
		expect(payload).toMatchObject({ prompt_cache_key: "caller" });
	});

	it("is omitted on the Anthropic surface, which uses cache_control blocks", async () => {
		await expect(payloadFor("anthropic-messages")).resolves.not.toHaveProperty("prompt_cache_key");
	});

	it("is omitted when caching is disabled", async () => {
		await expect(
			payloadFor("openai-completions", { cacheRetention: "none" }),
		).resolves.not.toHaveProperty("prompt_cache_key");
	});

	it("is omitted without a session id", async () => {
		await expect(
			payloadFor("openai-completions", { sessionId: undefined }),
		).resolves.not.toHaveProperty("prompt_cache_key");
	});
});

describe("hook composition", () => {
	it("keeps an existing onPayload hook", async () => {
		const previous = vi.fn(async (payload: unknown, _model: Model<Api>) => ({
			...(payload as Record<string, unknown>),
			injected: true,
		}));
		const payload = await payloadFor("openai-completions", { onPayload: previous });
		expect(previous).toHaveBeenCalledOnce();
		expect(payload).toMatchObject({ injected: true, user: "sasha" });
	});
});
