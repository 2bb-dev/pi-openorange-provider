// Live checks against a real OpenOrange instance. Skipped unless both
// OPENORANGE_BASE_URL and OPENORANGE_API_KEY are set:
//
//   OPENORANGE_BASE_URL=https://acme.openorange.ai OPENORANGE_API_KEY=sk-... \
//     OPENORANGE_LIVE_MODEL=openai/gpt-5.6-luna npx vitest run test/live.test.ts
//
// These calls cost real tokens (~15k input per request).
import type { ApiKeyCredential, Model } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";

import { createOpenOrangeProvider } from "../src/provider.js";

const baseUrl = process.env["OPENORANGE_BASE_URL"];
const apiKey = process.env["OPENORANGE_API_KEY"];
const live = Boolean(baseUrl && apiKey);

const credential: ApiKeyCredential = {
	type: "api_key",
	key: apiKey ?? "",
	env: { OPENORANGE_BASE_URL: baseUrl ?? "", OPENORANGE_USER_ID: "pi-live-test" },
};

// Long enough to clear the upstream cache minimum.
const SYSTEM_PROMPT = Array.from(
	{ length: 400 },
	(_, i) =>
		`Rule ${i}: the operator must keep runtime mutations diffable, approvable, idempotent, backed up, smoke-tested, rollbackable, and audited.`,
).join("\n");

describe.skipIf(!live)("live instance", () => {
	const provider = createOpenOrangeProvider();
	let model: Model<never>;
	let sent: Record<string, unknown>[] = [];

	beforeAll(async () => {
		await provider.refreshModels?.({
			credential,
			store: { read: async () => undefined, write: async () => undefined } as never,
			allowNetwork: true,
		});
		const wanted = process.env["OPENORANGE_LIVE_MODEL"];
		const candidates = provider.getModels();
		const selected = wanted
			? candidates.find((candidate) => candidate.id === wanted)
			: candidates.find((candidate) => candidate.api === "openai-completions");
		if (!selected) throw new Error(`no usable model; instance serves: ${candidates.map((c) => c.id)}`);
		model = selected as Model<never>;

		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (typeof init?.body === "string") sent.push(JSON.parse(init.body));
			return realFetch(input, init);
		}) as typeof fetch;
	}, 60_000);

	it("serves a usable catalog", () => {
		expect(provider.getModels().length).toBeGreaterThan(0);
		expect(model.baseUrl).toContain(new URL(baseUrl ?? "https://x").host);
	});

	it(
		"caches the prompt prefix across turns of one session",
		async () => {
			// The upstream cache is best-effort: even with a stable cache key a
			// single turn can miss, so assert on the session, not on one request.
			const sessionId = `pi-live-${Date.now()}`;
			const usages = [];
			for (const _attempt of [1, 2, 3, 4]) {
				const message = await provider
					.streamSimple(
						model,
						{
							systemPrompt: SYSTEM_PROMPT,
							messages: [{ role: "user", content: "Reply with the single word: ok", timestamp: Date.now() }],
						},
						{ apiKey: credential.key, env: credential.env, sessionId, maxTokens: 16 },
					)
					.result();
				expect(message.stopReason).not.toBe("error");
				usages.push(message.usage);
			}

			const wire = sent.at(-1) ?? {};
			expect(wire["prompt_cache_key"]).toBe(sessionId);
			expect(wire["user"]).toBe("pi-live-test");
			expect(usages.slice(1).filter((usage) => usage.cacheRead > 0).length).toBeGreaterThan(0);
		},
		180_000,
	);
});
