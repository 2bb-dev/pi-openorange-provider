import type {
	Api,
	ApiKeyCredential,
	AuthContext,
	AuthInteraction,
	Model,
	Provider,
	ProviderEnv,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

import { withOpenOrangePayload } from "./payload.js";
import {
	API_KEY_ENV,
	BASE_URL_ENV,
	PROVIDER_ID,
	PROVIDER_NAME,
	USER_ID_ENV,
	normalizeBaseUrl,
} from "./config.js";
import { type LitellmKeyIdentity, fetchDeployments, fetchKeyIdentity, toModels } from "./litellm.js";

interface ResolvedConfig {
	sunportUrl: string;
	apiKey: string;
	userId?: string;
	fromCredential: boolean;
}

export function createOpenOrangeProvider(): Provider<Api> {
	let models: Model<Api>[] = [];

	return {
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		auth: {
			apiKey: {
				name: "OpenOrange inference key",

				async login(interaction: AuthInteraction): Promise<ApiKeyCredential> {
					const entered = await interaction.prompt({
						type: "text",
						message: "OpenOrange Sunport address",
						placeholder: process.env[BASE_URL_ENV] ?? "https://acme.openorange.ai",
					});
					const sunportUrl = normalizeBaseUrl(entered.trim() || process.env[BASE_URL_ENV] || "");

					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "OpenOrange inference key (sk-...)",
						})
					).trim();
					if (!apiKey) throw new Error("An OpenOrange inference key is required");

					// Fail the login here rather than on the first model request.
					const deployments = await fetchDeployments(sunportUrl, apiKey, interaction.signal);
					const identity: LitellmKeyIdentity = await fetchKeyIdentity(
						sunportUrl,
						apiKey,
						interaction.signal,
					).catch(() => ({}) as LitellmKeyIdentity);
					models = toModels(deployments, sunportUrl);
					interaction.notify({
						type: "info",
						message: `OpenOrange: ${models.length} model(s) available on ${hostOf(sunportUrl)}`,
					});

					const userId = identity.userId ?? identity.keyAlias;
					return {
						type: "api_key",
						key: apiKey,
						env: {
							[BASE_URL_ENV]: sunportUrl,
							...(userId ? { [USER_ID_ENV]: userId } : {}),
						},
					};
				},

				async check({ ctx, credential }) {
					const config = await resolveConfig(ctx, credential);
					return config
						? { type: "api_key", source: sourceLabel(config) }
						: undefined;
				},

				async resolve({ ctx, credential }) {
					const config = await resolveConfig(ctx, credential);
					if (!config) return undefined;
					const env: ProviderEnv = {
						[BASE_URL_ENV]: config.sunportUrl,
						...(config.userId ? { [USER_ID_ENV]: config.userId } : {}),
					};
					return {
						auth: { apiKey: config.apiKey },
						env,
						source: sourceLabel(config),
					};
				},
			},
		},

		getModels: () => models,

		async refreshModels(context: RefreshModelsContext): Promise<void> {
			const sunportUrl = credentialSunportUrl(context.credential) ?? envSunportUrl();
			if (context.stored) {
				// Drop a catalog cached for a different Sunport.
				const restored = context.stored.models.filter(
					(model) => model.provider === PROVIDER_ID && belongsTo(model, sunportUrl),
				);
				const published = await context.publish({
					update: () => {
						models = restored;
					},
				});
				if (!published) return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (!sunportUrl) return;

			const apiKey =
				(context.credential?.type === "api_key" ? context.credential.key : undefined) ??
				process.env[API_KEY_ENV]?.trim();
			if (!apiKey) return;

			const deployments = await fetchDeployments(sunportUrl, apiKey, context.signal);
			if (context.signal.aborted) return;
			const refreshed = toModels(deployments, sunportUrl);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},

		stream: (model, context, options) =>
			stream(model, context, withOpenOrangePayload(model, options) as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) =>
			streamSimple(model, context, withOpenOrangePayload(model, options)),
	};
}

async function resolveConfig(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<ResolvedConfig | undefined> {
	const rawUrl = credential?.env?.[BASE_URL_ENV] ?? (await ctx.env(BASE_URL_ENV));
	const apiKey = credential?.key ?? (await ctx.env(API_KEY_ENV));
	if (!rawUrl?.trim() || !apiKey?.trim()) return undefined;

	let sunportUrl: string;
	try {
		sunportUrl = normalizeBaseUrl(rawUrl);
	} catch {
		return undefined;
	}
	return {
		sunportUrl,
		apiKey: apiKey.trim(),
		userId: credential?.env?.[USER_ID_ENV],
		fromCredential: Boolean(credential?.key),
	};
}

function credentialSunportUrl(credential: RefreshModelsContext["credential"]): string | undefined {
	if (credential?.type !== "api_key") return undefined;
	return safeNormalize(credential.env?.[BASE_URL_ENV]);
}

function envSunportUrl(): string | undefined {
	return safeNormalize(process.env[BASE_URL_ENV]);
}

function safeNormalize(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		return normalizeBaseUrl(value);
	} catch {
		return undefined;
	}
}

function belongsTo(model: Model<Api>, sunportUrl: string | undefined): boolean {
	return sunportUrl ? model.baseUrl.startsWith(sunportUrl) : false;
}

function sourceLabel(config: ResolvedConfig): string {
	return config.fromCredential
		? `stored credential (${hostOf(config.sunportUrl)})`
		: `${BASE_URL_ENV} (${hostOf(config.sunportUrl)})`;
}

function hostOf(sunportUrl: string): string {
	try {
		return new URL(sunportUrl).host;
	} catch {
		return sunportUrl;
	}
}
