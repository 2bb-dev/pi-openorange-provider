import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

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
	sunportUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<LitellmDeployment[]> {
	const body = await request(sunportUrl, "/v1/model/info", apiKey, signal);
	const data = (body as { data?: unknown }).data;
	return Array.isArray(data) ? (data as LitellmDeployment[]) : [];
}

export async function fetchKeyIdentity(
	sunportUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<LitellmKeyIdentity> {
	const body = await request(sunportUrl, "/key/info", apiKey, signal);
	const info = (body as { info?: Record<string, unknown> }).info ?? {};
	return {
		userId: stringOrUndefined(info["user_id"]),
		keyAlias: stringOrUndefined(info["key_alias"]),
	};
}

async function request(
	sunportUrl: string,
	path: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(`${sunportUrl}${path}`, {
		headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	}).catch((error: unknown) => {
		throw new OpenOrangeApiError(
			`OpenOrange Sunport unreachable at ${sunportUrl}${path}: ${errorMessage(error)}`,
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

/**
 * LiteLLM `mode` values of models Pi can chat with; any other mode (embeddings,
 * speech, images, video) is not one. Same set OpenOrange Code accepts
 * (isCodeModelMode in services/openorange-api/src/code/modelApi.ts).
 */
const CHAT_MODES = new Set(["chat", "completion", "responses"]);

/** OpenOrange renders per-subscription-slot aliases such as `openai/gpt-5.5/2`. */
const SLOT_ALIAS = /\/\d+$/;

/**
 * Pi request protocols an OpenOrange deployment may declare in `model_info.pi_api`.
 * Same contract OpenOrange Code reads (services/openorange-api/src/code/modelApi.ts).
 */
const PI_APIS = new Set(["openai-responses", "openai-completions", "anthropic-messages"]);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Claude models that only accept `thinking.type: "adaptive"`; `enabled` is a 400.
 * Fallback for deployments whose `pi_compat` does not say so, aligned with Pi's
 * bundled Anthropic catalog and OpenOrange Code.
 */
const ADAPTIVE_THINKING_CLAUDE = [
	"claude-fable-5",
	"claude-opus-4-6",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
];

export function toModels(deployments: LitellmDeployment[], sunportUrl: string): Model<Api>[] {
	const models: Model<Api>[] = [];
	const seen = new Set<string>();

	for (const deployment of deployments) {
		const id = deployment.model_name?.trim();
		if (!id || seen.has(id) || SLOT_ALIAS.test(id)) continue;

		const info = deployment.model_info ?? {};
		const mode = stringOrUndefined(info["mode"])?.toLowerCase();
		if (mode && !CHAT_MODES.has(mode)) continue;

		seen.add(id);
		models.push(toModel(id, info, upstreamModel(deployment), sunportUrl));
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Deployments behind the Sunport's upstream proxy (`litellm_proxy/...`) carry no
 * LiteLLM capability flags, so the Sunport declares Pi metadata instead:
 * `pi_api`, `pi_reasoning`, `pi_thinking_level_map`, `pi_compat`. LiteLLM's own
 * `supports_*` flags are the fallback for directly-configured deployments.
 */
function toModel(
	id: string,
	info: Record<string, unknown>,
	upstream: string | undefined,
	sunportUrl: string,
): Model<Api> {
	const api = resolveApi(id, info, upstream);
	const contextWindow = numberOrUndefined(info["max_input_tokens"]) ?? 128_000;
	const reasoning =
		booleanOrUndefined(info["pi_reasoning"]) ?? booleanOrUndefined(info["supports_reasoning"]) ?? false;
	const thinkingLevelMap = toThinkingLevelMap(info["pi_thinking_level_map"]);
	const compat = toCompat(info["pi_compat"]);
	if (api === "anthropic-messages" && compat["forceAdaptiveThinking"] === undefined && isAdaptiveClaude(id, upstream)) {
		compat["forceAdaptiveThinking"] = true;
	}
	if (api === "openai-completions") {
		compat["supportsReasoningEffort"] ??= reasoning;
		compat["supportsUsageInStreaming"] ??= true;
	}

	const model: Model<Api> = {
		id,
		name: id,
		api,
		provider: PROVIDER_ID,
		baseUrl: api === "anthropic-messages" ? anthropicBaseUrl(sunportUrl) : openAiBaseUrl(sunportUrl),
		reasoning,
		...(reasoning && thinkingLevelMap ? { thinkingLevelMap } : {}),
		// Vision is assumed unless the Sunport denies it: proxied Claude/GPT
		// deployments omit `supports_vision`, and Pi silently drops images otherwise.
		input: booleanOrUndefined(info["supports_vision"]) === false ? ["text"] : ["text", "image"],
		cost: {
			input: perMillion(info["input_cost_per_token"]),
			output: perMillion(info["output_cost_per_token"]),
			cacheRead: perMillion(info["cache_read_input_token_cost"]),
			cacheWrite: perMillion(info["cache_creation_input_token_cost"]),
		},
		contextWindow,
		maxTokens: numberOrUndefined(info["max_output_tokens"]) ?? Math.min(contextWindow, 16_384),
		...(Object.keys(compat).length > 0 ? { compat: compat as Model<Api>["compat"] } : {}),
	};
	return model;
}

function resolveApi(id: string, info: Record<string, unknown>, upstream: string | undefined): Api {
	const declared = stringOrUndefined(info["pi_api"]);
	if (declared && PI_APIS.has(declared)) return declared;
	if (stringOrUndefined(info["mode"])?.toLowerCase() === "responses") return "openai-responses";
	return isAnthropic(id, upstream) ? "anthropic-messages" : "openai-completions";
}

function isAnthropic(modelName: string, upstream: string | undefined): boolean {
	return [modelName, upstream ?? ""].some(
		(value) => value.split("/").includes("anthropic") || /(^|[./:_-])claude([./:_-]|$)/.test(value),
	);
}

function isAdaptiveClaude(modelName: string, upstream: string | undefined): boolean {
	return [modelName, upstream ?? ""].some((value) => {
		const normalized = value.toLowerCase().replaceAll(".", "-");
		return ADAPTIVE_THINKING_CLAUDE.some((model) => normalized.includes(model));
	});
}

function toThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	if (!isRecord(value)) return undefined;
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		const mapped = value[level];
		if (mapped === null) map[level] = null;
		else if (typeof mapped === "string" && mapped.trim()) map[level] = mapped.trim();
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

function toCompat(value: unknown): Record<string, boolean | string> {
	const compat: Record<string, boolean | string> = {};
	if (!isRecord(value)) return compat;
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "boolean" || typeof entry === "string") compat[key] = entry;
	}
	return compat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
