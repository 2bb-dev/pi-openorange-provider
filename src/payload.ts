import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";

import { USER_ID_ENV } from "./config.js";

/** OpenAI rejects longer cache keys. */
const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/**
 * Request fields OpenOrange needs that Pi does not send to a non-`api.openai.com`
 * endpoint:
 *
 * - `prompt_cache_key` pins a conversation to one upstream cache partition. Pi
 *   only sends it when the base URL is OpenAI's own, so requests through an
 *   OpenOrange instance land on arbitrary partitions and mostly miss the cache.
 *   Measured on a 14.8k-token prefix: 3/8 hits without the key, 7/8 with it.
 * - `user` / `metadata.user_id` attribute spend to the user the inference key
 *   belongs to, so LiteLLM records it as `end_user`.
 *
 * The Anthropic surface caches through `cache_control` blocks, which Pi already
 * emits, so only attribution is added there.
 */
export function withOpenOrangePayload<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	const userId = options?.env?.[USER_ID_ENV];
	const cacheKey = promptCacheKey(model, options);
	if (!userId && !cacheKey) return options;

	const previous = options?.onPayload;
	const onPayload: StreamOptions["onPayload"] = async (payload, payloadModel) => {
		const resolved = (await previous?.(payload, payloadModel)) ?? payload;
		if (!isRecord(resolved)) return resolved;

		let next = resolved;
		if (userId) {
			next =
				model.api === "anthropic-messages"
					? { ...next, metadata: { ...asRecord(next["metadata"]), user_id: userId } }
					: { ...next, user: userId };
		}
		if (cacheKey && next["prompt_cache_key"] === undefined) {
			next = { ...next, prompt_cache_key: cacheKey };
		}
		return next;
	};

	return { ...(options as TOptions), onPayload };
}

function promptCacheKey(model: Model<Api>, options: StreamOptions | undefined): string | undefined {
	if (model.api === "anthropic-messages") return undefined;
	if (options?.cacheRetention === "none") return undefined;
	const sessionId = options?.sessionId?.trim();
	if (!sessionId) return undefined;
	return Array.from(sessionId).slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}
