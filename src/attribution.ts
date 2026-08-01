import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";

import { USER_ID_ENV } from "./config.js";

/**
 * Spend attribution: OpenOrange bills the user an inference key belongs to.
 * LiteLLM already records the key's `user_id` server-side; sending it on the
 * request as well populates `end_user` in the spend log so console reports can
 * attribute Pi traffic to that user without parsing agent metadata.
 */
export function withAttribution<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	const userId = options?.env?.[USER_ID_ENV];
	if (!userId) return options;

	const previous = options?.onPayload;
	const onPayload: StreamOptions["onPayload"] = async (payload, payloadModel) => {
		const resolved = (await previous?.(payload, payloadModel)) ?? payload;
		if (!isRecord(resolved)) return resolved;
		return model.api === "anthropic-messages"
			? { ...resolved, metadata: { ...asRecord(resolved["metadata"]), user_id: userId } }
			: { ...resolved, user: userId };
	};

	return { ...(options as TOptions), onPayload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}
