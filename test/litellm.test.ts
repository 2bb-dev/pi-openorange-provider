import { afterEach, describe, expect, it, vi } from "vitest";

import {
	OpenOrangeApiError,
	fetchDeployments,
	fetchKeyIdentity,
	toModels,
} from "../src/litellm.js";

const SUNPORT = "https://acme.openorange.ai";

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
	{ model_name: "runwayml/gen4.5", model_info: { mode: "video_generation" } },
];

/** Deployments as a Sunport renders them behind its upstream proxy: no
 * LiteLLM `supports_*` flags, Pi metadata instead. */
const PROXIED = [
	{
		model_name: "anthropic/claude-haiku-4-5",
		litellm_params: { model: "litellm_proxy/anthropic/claude-haiku-4-5" },
		model_info: { mode: "chat", pi_api: "anthropic-messages", pi_reasoning: true },
	},
	{
		model_name: "anthropic/claude-opus-5",
		litellm_params: { model: "litellm_proxy/anthropic/claude-opus-5" },
		model_info: { mode: "chat", pi_api: "anthropic-messages", pi_reasoning: true },
	},
	{
		// A model added with the Sunport's own Anthropic key: no pi_compat.
		model_name: "anthropic/claude-haiku-5-5",
		litellm_params: { model: "anthropic/claude-haiku-5-5" },
		model_info: { mode: "chat", pi_api: "anthropic-messages", pi_reasoning: true },
	},
	{
		model_name: "anthropic/claude-fable-5",
		litellm_params: { model: "litellm_proxy/anthropic/claude-fable-5" },
		model_info: {
			mode: "chat",
			pi_api: "anthropic-messages",
			pi_reasoning: true,
			pi_compat: { forceAdaptiveThinking: false, ignored: 1 },
			pi_thinking_level_map: { off: null, xhigh: "xhigh", bogus: "x", low: "" },
		},
	},
	{
		model_name: "openai/gpt-5.6-luna",
		litellm_params: { model: "litellm_proxy/openai/gpt-5.6-luna" },
		model_info: {
			mode: "responses",
			pi_api: "openai-responses",
			pi_reasoning: true,
			pi_thinking_level_map: { xhigh: "xhigh", max: "max" },
		},
	},
	{
		model_name: "deepseek/deepseek-v4-pro",
		litellm_params: { model: "litellm_proxy/deepseek/deepseek-v4-pro" },
		model_info: { mode: "chat", supports_reasoning: true, supports_vision: false },
	},
	{
		model_name: "custom/fast",
		litellm_params: { model: "openai/fast" },
		model_info: { mode: "chat", pi_api: "openai-completions", pi_reasoning: false },
	},
];

describe("toModels", () => {
	const models = toModels(DEPLOYMENTS, SUNPORT);

	it("keeps only chat-capable deployments and drops slot aliases", () => {
		expect(models.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-5", "openai/gpt-5.5"]);
	});

	it("routes anthropic aliases to /v1/messages and responses deployments to /v1/responses", () => {
		const [claude, gpt] = models;
		expect(claude).toMatchObject({ api: "anthropic-messages", baseUrl: SUNPORT });
		expect(gpt).toMatchObject({ api: "openai-responses", baseUrl: `${SUNPORT}/v1` });
	});

	it("converts per-token prices to per-million", () => {
		expect(models[0]?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	});

	it("carries capability and window metadata from the Sunport", () => {
		expect(models[0]).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
	});

	it("falls back to safe defaults when the Sunport omits metadata", () => {
		expect(models[1]).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_050_000,
			maxTokens: 16_384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("only drops image input when the Sunport denies vision", () => {
		const proxied = toModels(PROXIED, SUNPORT);
		expect(proxied.find((m) => m.id === "deepseek/deepseek-v4-pro")?.input).toEqual(["text"]);
		expect(proxied.find((m) => m.id === "anthropic/claude-haiku-4-5")?.input).toEqual(["text", "image"]);
	});

	it("ignores deployments without a model name", () => {
		expect(toModels([{ model_info: { mode: "chat" } }], SUNPORT)).toEqual([]);
	});
});

describe("toModels with Pi metadata", () => {
	const models = toModels(PROXIED, SUNPORT);
	const byId = (id: string) => models.find((model) => model.id === id);

	it("honours the declared Pi API and reasoning flag", () => {
		expect(byId("openai/gpt-5.6-luna")).toMatchObject({
			api: "openai-responses",
			baseUrl: `${SUNPORT}/v1`,
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		expect(byId("anthropic/claude-haiku-4-5")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: SUNPORT,
			reasoning: true,
		});
		expect(byId("anthropic/claude-haiku-4-5")).not.toHaveProperty("compat");
		expect(byId("custom/fast")).toMatchObject({
			api: "openai-completions",
			reasoning: false,
			compat: { supportsReasoningEffort: false, supportsUsageInStreaming: true },
		});
	});

	it("forces adaptive thinking on Claude models that reject budget thinking", () => {
		expect(byId("anthropic/claude-opus-5")?.compat).toEqual({ forceAdaptiveThinking: true });
		expect(byId("anthropic/claude-haiku-5-5")?.compat).toEqual({ forceAdaptiveThinking: true });
	});

	it("lets pi_compat override the adaptive fallback and keeps only scalar entries", () => {
		expect(byId("anthropic/claude-fable-5")?.compat).toEqual({ forceAdaptiveThinking: false });
	});

	it("keeps only valid thinking level entries", () => {
		expect(byId("anthropic/claude-fable-5")?.thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh" });
	});

	it("falls back to LiteLLM capability flags without Pi metadata", () => {
		expect(byId("deepseek/deepseek-v4-pro")).toMatchObject({
			api: "openai-completions",
			reasoning: true,
			compat: { supportsReasoningEffort: true, supportsUsageInStreaming: true },
		});
	});
});

describe("litellm requests", () => {
	afterEach(() => vi.unstubAllGlobals());

	function stubFetch(response: Response) {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => response.clone());
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("sends the inference key as a bearer token", async () => {
		const fetchMock = stubFetch(Response.json({ data: DEPLOYMENTS }));
		await fetchDeployments(SUNPORT, "sk-test");
		expect(fetchMock.mock.calls[0]?.[0]).toBe(`${SUNPORT}/v1/model/info`);
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: "Bearer sk-test",
		});
	});

	it("leaves out models the Sunport's model list does not include, as on a free trial", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) =>
				new URL(String(url)).pathname === "/v1/models"
					? Response.json({ object: "list", data: [{ id: "openai/gpt-5.5", object: "model" }] })
					: Response.json({ data: DEPLOYMENTS }),
			),
		);
		const deployments = await fetchDeployments(SUNPORT, "sk-test");
		expect(deployments.map((deployment) => deployment.model_name)).toEqual(["openai/gpt-5.5"]);
	});

	it("reads the key owner from /key/info", async () => {
		stubFetch(Response.json({ info: { user_id: "sasha", key_alias: "pi-sasha" } }));
		await expect(fetchKeyIdentity(SUNPORT, "sk-test")).resolves.toEqual({
			userId: "sasha",
			keyAlias: "pi-sasha",
		});
	});

	it("reports an unauthorized key", async () => {
		stubFetch(new Response("nope", { status: 401, statusText: "Unauthorized" }));
		await expect(fetchDeployments(SUNPORT, "sk-bad")).rejects.toThrow(OpenOrangeApiError);
		await expect(fetchDeployments(SUNPORT, "sk-bad")).rejects.toThrow(/invalid inference key/);
	});

	it("reports an unreachable Sunport", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND");
			}),
		);
		await expect(fetchDeployments(SUNPORT, "sk-test")).rejects.toThrow(/unreachable/);
	});
});
