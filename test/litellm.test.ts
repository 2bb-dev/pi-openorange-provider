import { afterEach, describe, expect, it, vi } from "vitest";

import {
	OpenOrangeApiError,
	fetchDeployments,
	fetchKeyIdentity,
	toModels,
} from "../src/litellm.js";

const INSTANCE = "https://acme.openorange.ai";

const DEPLOYMENTS = [
	{
		model_name: "anthropic/claude-sonnet-5",
		litellm_params: { model: "anthropic/claude-sonnet-5-20260401" },
		model_info: {
			mode: "chat",
			max_input_tokens: 200_000,
			max_output_tokens: 64_000,
			input_cost_per_token: 0.000003,
			output_cost_per_token: 0.000015,
			cache_read_input_token_cost: 0.0000003,
			cache_creation_input_token_cost: 0.00000375,
			supports_vision: true,
			supports_reasoning: true,
		},
	},
	{
		model_name: "openai/gpt-5.5",
		litellm_params: { model: "litellm_proxy/chatgpt/gpt-5.5" },
		model_info: { mode: "responses", max_input_tokens: 1_050_000, supports_reasoning: true },
	},
	{ model_name: "openai/gpt-5.5/2", model_info: { mode: "responses" } },
	{ model_name: "gemini/gemini-embedding-001", model_info: { mode: "embedding" } },
	{ model_name: "groq/whisper-large-v3-turbo", model_info: { mode: "audio_transcription" } },
];

describe("toModels", () => {
	const models = toModels(DEPLOYMENTS, INSTANCE);

	it("keeps only chat-capable deployments and drops slot aliases", () => {
		expect(models.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-5", "openai/gpt-5.5"]);
	});

	it("routes anthropic aliases to /v1/messages and the rest to /v1/chat/completions", () => {
		const [claude, gpt] = models;
		expect(claude).toMatchObject({ api: "anthropic-messages", baseUrl: INSTANCE });
		expect(gpt).toMatchObject({ api: "openai-completions", baseUrl: `${INSTANCE}/v1` });
	});

	it("converts per-token prices to per-million", () => {
		expect(models[0]?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	});

	it("carries capability and window metadata from the instance", () => {
		expect(models[0]).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
	});

	it("falls back to safe defaults when the instance omits metadata", () => {
		expect(models[1]).toMatchObject({
			reasoning: true,
			input: ["text"],
			contextWindow: 1_050_000,
			maxTokens: 16_384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("ignores deployments without a model name", () => {
		expect(toModels([{ model_info: { mode: "chat" } }], INSTANCE)).toEqual([]);
	});
});

describe("litellm requests", () => {
	afterEach(() => vi.unstubAllGlobals());

	function stubFetch(response: Response) {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => response);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("sends the inference key as a bearer token", async () => {
		const fetchMock = stubFetch(Response.json({ data: DEPLOYMENTS }));
		await fetchDeployments(INSTANCE, "sk-test");
		expect(fetchMock.mock.calls[0]?.[0]).toBe(`${INSTANCE}/v1/model/info`);
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: "Bearer sk-test",
		});
	});

	it("reads the key owner from /key/info", async () => {
		stubFetch(Response.json({ info: { user_id: "sasha", key_alias: "pi-sasha" } }));
		await expect(fetchKeyIdentity(INSTANCE, "sk-test")).resolves.toEqual({
			userId: "sasha",
			keyAlias: "pi-sasha",
		});
	});

	it("reports an unauthorized key", async () => {
		stubFetch(new Response("nope", { status: 401, statusText: "Unauthorized" }));
		await expect(fetchDeployments(INSTANCE, "sk-bad")).rejects.toThrow(OpenOrangeApiError);
		await expect(fetchDeployments(INSTANCE, "sk-bad")).rejects.toThrow(/invalid inference key/);
	});

	it("reports an unreachable instance", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND");
			}),
		);
		await expect(fetchDeployments(INSTANCE, "sk-test")).rejects.toThrow(/unreachable/);
	});
});
