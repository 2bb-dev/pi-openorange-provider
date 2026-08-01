export const PROVIDER_ID = "openorange";
export const PROVIDER_NAME = "OpenOrange";

/** Instance root, e.g. https://acme.openorange.ai (LiteLLM is served from the apex host). */
export const BASE_URL_ENV = "OPENORANGE_BASE_URL";
/** Inference key (LiteLLM virtual key) issued by the OpenOrange console. */
export const API_KEY_ENV = "OPENORANGE_API_KEY";
/** LiteLLM user the inference key belongs to; sent for spend attribution. */
export const USER_ID_ENV = "OPENORANGE_USER_ID";

/**
 * OpenOrange serves LiteLLM on the apex host and the web console on `web.<host>`
 * (deploy/nginx/templates/llm.conf.template). Only public HTTPS instances are
 * accepted: an inference key is a bearer secret and loopback/plain-HTTP targets
 * are not OpenOrange instances.
 */
export function normalizeBaseUrl(input: string): string {
	const raw = input.trim();
	if (!raw) throw new Error("OpenOrange instance URL is required");

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`Invalid OpenOrange instance URL: ${raw}`);
	}

	if (url.protocol !== "https:") {
		throw new Error(`OpenOrange instance URL must use https, got: ${url.protocol}//`);
	}
	if (isLoopbackHost(url.hostname)) {
		throw new Error(`OpenOrange instance URL must be a remote host, got: ${url.hostname}`);
	}

	// Accept pasted endpoints such as https://host/v1 or https://host/v1/ and keep the instance root.
	const path = url.pathname.replace(/\/+$/, "");
	if (path && path !== "/v1") {
		throw new Error(`OpenOrange instance URL must be the instance root, got path: ${path}`);
	}
	return `${url.protocol}//${url.host}`;
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|]$/g, "");
	return (
		host === "localhost" ||
		host === "::1" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		/^127\./.test(host)
	);
}

/** OpenAI-compatible surface: POST {base}/v1/chat/completions. */
export function openAiBaseUrl(instanceUrl: string): string {
	return `${instanceUrl}/v1`;
}

/** Anthropic surface: the SDK appends /v1/messages to this base. */
export function anthropicBaseUrl(instanceUrl: string): string {
	return instanceUrl;
}
