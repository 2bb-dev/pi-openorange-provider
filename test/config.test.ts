import { describe, expect, it } from "vitest";

import { anthropicBaseUrl, normalizeBaseUrl, openAiBaseUrl } from "../src/config.js";

describe("normalizeBaseUrl", () => {
	it("accepts a bare host and defaults to https", () => {
		expect(normalizeBaseUrl("acme.openorange.ai")).toBe("https://acme.openorange.ai");
	});

	it("keeps the instance root when a /v1 endpoint is pasted", () => {
		expect(normalizeBaseUrl("https://acme.openorange.ai/v1/")).toBe("https://acme.openorange.ai");
	});

	it("keeps an explicit port", () => {
		expect(normalizeBaseUrl("https://acme.openorange.ai:8443")).toBe(
			"https://acme.openorange.ai:8443",
		);
	});

	it.each(["http://acme.openorange.ai", "http://localhost:4000", "https://localhost:4000", "https://127.0.0.1", "https://box.local"])(
		"rejects %s",
		(input) => {
			expect(() => normalizeBaseUrl(input)).toThrow();
		},
	);

	it("rejects an unrelated path", () => {
		expect(() => normalizeBaseUrl("https://acme.openorange.ai/api")).toThrow(/instance root/);
	});

	it("rejects empty input", () => {
		expect(() => normalizeBaseUrl("   ")).toThrow(/required/);
	});
});

describe("api base urls", () => {
	it("appends /v1 for the OpenAI surface", () => {
		expect(openAiBaseUrl("https://acme.openorange.ai")).toBe("https://acme.openorange.ai/v1");
	});

	it("uses the instance root for the Anthropic surface", () => {
		// The Anthropic SDK appends /v1/messages itself.
		expect(anthropicBaseUrl("https://acme.openorange.ai")).toBe("https://acme.openorange.ai");
	});
});
