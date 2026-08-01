import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { withAttribution } from "../src/attribution.js";

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
	return { env, ...overrides };
}

describe("withAttribution", () => {
	it("adds the key owner as `user` on OpenAI payloads", async () => {
		const resolved = withAttribution(model("openai-completions"), options());
		const payload = await resolved?.onPayload?.({ model: "m" }, model("openai-completions"));
		expect(payload).toEqual({ model: "m", user: "sasha" });
	});

	it("adds the key owner as `metadata.user_id` on Anthropic payloads", async () => {
		const resolved = withAttribution(model("anthropic-messages"), options());
		const payload = await resolved?.onPayload?.(
			{ model: "m", metadata: { existing: true } },
			model("anthropic-messages"),
		);
		expect(payload).toEqual({ model: "m", metadata: { existing: true, user_id: "sasha" } });
	});

	it("keeps an existing onPayload hook", async () => {
		const previous = vi.fn(async (payload: unknown, _model: Model<Api>) => ({
			...(payload as Record<string, unknown>),
			injected: true,
		}));
		const resolved = withAttribution(
			model("openai-completions"),
			options({ onPayload: previous }),
		);
		const payload = await resolved?.onPayload?.({ model: "m" }, model("openai-completions"));
		expect(previous).toHaveBeenCalledOnce();
		expect(payload).toEqual({ model: "m", injected: true, user: "sasha" });
	});

	it("is a no-op without a resolved user", () => {
		const empty: StreamOptions = { env: {} };
		expect(withAttribution(model("openai-completions"), empty)).toBe(empty);
	});
});
