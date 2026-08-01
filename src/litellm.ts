import type { Api, Model } from "@earendil-works/pi-ai";

import { PROVIDER_ID, anthropicBaseUrl, openAiBaseUrl } from "./config.js";

const REQUEST_TIMEOUT_MS = 15_000;

/** Deployment entry as returned by LiteLLM `GET /v1/model/info`. */
export interface LitellmDeployment {
	model_name?: string;
	litellm_params?: { model?: string } & Record<string, unknown>;
	model_info?: Record<string, unknown>;
}

/** Identity of the calling key as returned by LiteLLM `GET /key/info`. */
export interface LitellmKeyIdentity {
	userId?: string;
	keyAlias?: string;
}

export class OpenOrangeApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "OpenOrangeApiError";
	}
}

export async function fetchDeployments(
	instanceUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<LitellmDeployment[]> {
	const body = await request(instanceUrl, "/v1/model/info", apiKey, signal);
	const data = (body as { data?: unknown }).data;
	return Array.isArray(data) ? (data as LitellmDeployment[]) : [];
}

export async function fetchKeyIdentity(
	instanceUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<LitellmKeyIdentity> {
	const body = await request(instanceUrl, "/key/info", apiKey, signal);
	const info = (body as { info?: Record<string, unknown> }).info ?? {};
	return {
		userId: stringOrUndefined(info["user_id"]),
		keyAlias: stringOrUndefined(info["key_alias"]),
	};
}

async function request(
	instanceUrl: string,
	path: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(`${instanceUrl}${path}`, {
		headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	}).catch((error: unknown) => {
		throw new OpenOrangeApiError(
			`OpenOrange instance unreachable at ${instanceUrl}${path}: ${errorMessage(error)}`,
		);
	});

	if (!response.ok) {
		const detail = response.status === 401 || response.status === 403 ? " (invalid inference key?)" : "";
		throw new OpenOrangeApiError(
			`OpenOrange ${path} failed: ${response.status} ${response.statusText}${detail}`,
			response.status,
		);
	}
	return (await response.json()) as unknown;
}

/** LiteLLM `mode` values that are not chat completions. */
const NON_CHAT_MODES = new Set([
	"embedding",
	"image_generation",
	"audio_transcription",
	"audio_speech",
	"moderation",
	"rerank",
	"batch",
]);

/** OpenOrange renders per-subscription-slot aliases such as `openai/gpt-5.5/2`. */
const SLOT_ALIAS = /\/\d+$/;

export function toModels(deployments: LitellmDeployment[], instanceUrl: string): Model<Api>[] {
	const models: Model<Api>[] = [];
	const seen = new Set<string>();

	for (const deployment of deployments) {
		const id = deployment.model_name?.trim();
		if (!id || seen.has(id) || SLOT_ALIAS.test(id)) continue;

		const info = deployment.model_info ?? {};
		const mode = stringOrUndefined(info["mode"]);
		if (mode && NON_CHAT_MODES.has(mode)) continue;

		seen.add(id);
		models.push(toModel(id, info, upstreamModel(deployment), instanceUrl));
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

function toModel(
	id: string,
	info: Record<string, unknown>,
	upstream: string | undefined,
	instanceUrl: string,
): Model<Api> {
	const anthropic = isAnthropic(id, upstream);
	const contextWindow = numberOrUndefined(info["max_input_tokens"]) ?? 128_000;
	const reasoning = booleanOrUndefined(info["supports_reasoning"]) ?? false;

	const model: Model<Api> = {
		id,
		name: id,
		api: anthropic ? "anthropic-messages" : "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: anthropic ? anthropicBaseUrl(instanceUrl) : openAiBaseUrl(instanceUrl),
		reasoning,
		input: (booleanOrUndefined(info["supports_vision"]) ?? false) ? ["text", "image"] : ["text"],
		cost: {
			input: perMillion(info["input_cost_per_token"]),
			output: perMillion(info["output_cost_per_token"]),
			cacheRead: perMillion(info["cache_read_input_token_cost"]),
			cacheWrite: perMillion(info["cache_creation_input_token_cost"]),
		},
		contextWindow,
		maxTokens: numberOrUndefined(info["max_output_tokens"]) ?? Math.min(contextWindow, 16_384),
	};

	if (!anthropic) {
		(model as Model<"openai-completions">).compat = {
			supportsReasoningEffort: reasoning,
			supportsUsageInStreaming: true,
		};
	}
	return model;
}

function isAnthropic(modelName: string, upstream: string | undefined): boolean {
	return modelName.startsWith("anthropic/") || (upstream?.startsWith("anthropic/") ?? false);
}

function upstreamModel(deployment: LitellmDeployment): string | undefined {
	return stringOrUndefined(deployment.litellm_params?.model);
}

function perMillion(value: unknown): number {
	const cost = numberOrUndefined(value);
	return cost === undefined ? 0 : cost * 1_000_000;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
