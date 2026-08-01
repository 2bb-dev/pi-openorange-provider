# pi-openorange-provider

Pi extension that registers **OpenOrange** as a model provider, so `/login` can
sign in to an OpenOrange instance and `/model` can pick any model that instance
serves.

## Install

```bash
pi install git:github.com/2bb-dev/pi-openorange-provider
```

Try it without installing:

```bash
pi -e git:github.com/2bb-dev/pi-openorange-provider
```

## Sign in

```text
/login  →  Sign in with an API key  →  OpenOrange
```

The flow asks for two things:

1. **Instance URL** — the OpenOrange instance root, e.g.
   `https://acme.openorange.ai`. Prefilled from `OPENORANGE_BASE_URL`.
   Only public HTTPS hosts are accepted; loopback/plain HTTP is rejected.
2. **Inference key** — the `sk-...` key issued in the OpenOrange console under
   *API keys*.

Login verifies the key against the instance and stores it in
`~/.pi/agent/auth.json`. `/login openorange` jumps straight to it.

Headless/CI use needs no login:

```bash
export OPENORANGE_BASE_URL=https://acme.openorange.ai
export OPENORANGE_API_KEY=sk-...
```

## What it does

**Model catalog.** The model list is fetched from the instance
(`GET /v1/model/info`) with your key, so you see exactly the models that key is
allowed to use, with the instance's own context windows, pricing, and
capabilities. Non-chat deployments (embeddings, speech) and per-subscription
slot aliases (`openai/gpt-5.5/2`) are hidden.

**Routing.** `anthropic/*` models are called on the instance's Anthropic
surface (`POST /v1/messages`) so native prompt caching and thinking work;
every other model uses the OpenAI-compatible surface
(`POST /v1/chat/completions`).

**Spend attribution.** Requests carry the LiteLLM user the inference key belongs
to (`user` for OpenAI, `metadata.user_id` for Anthropic), read from
`GET /key/info` at login, so OpenOrange spend reports attribute Pi traffic to
that user.

**Prompt caching.** On the Anthropic surface Pi already emits `cache_control`
blocks. On the OpenAI surface Pi only sends `prompt_cache_key` when the base URL
is `api.openai.com`, so requests to an OpenOrange instance carried no cache
affinity at all; this extension adds it, keyed by the Pi session id. It is
skipped when the caller disables caching or already set a key.

Measured on `gpt-5.6-*` (ChatGPT-subscription route, 14.8k-token prefix): cache
hits do occur but are backend-controlled and unreliable — 0–25% on a cold
prefix, 60–85% once the prefix is hot — and `prompt_cache_key` did not move
those numbers on that route. The parameter is still correct to send (the
OpenOrange LiteLLM fork forwards it to the Codex backend as a `session_id`
header); the remaining loss is upstream of Pi, in the instance's proxy chain.

## Development

`.npmrc` sets `omit=dev` so installing this package into Pi does not pull the
test toolchain. Ask for dev dependencies explicitly:

```bash
npm install --include=dev
npm test
npm run typecheck
```

`test/live.test.ts` runs against a real instance and is skipped unless
credentials are present. It costs real tokens (~15k input per request):

```bash
OPENORANGE_BASE_URL=https://acme.openorange.ai OPENORANGE_API_KEY=sk-... \
  OPENORANGE_LIVE_MODEL=openai/gpt-5.6-luna npx vitest run test/live.test.ts
```

| Path | Purpose |
| --- | --- |
| `extensions/openorange.ts` | Pi entry point; registers the provider |
| `src/provider.ts` | Provider: login, auth resolution, model refresh, streaming |
| `src/litellm.ts` | LiteLLM client and catalog mapping |
| `src/payload.ts` | Cache-affinity and spend-attribution payload fields |
| `src/config.ts` | Instance URL rules and endpoint layout |
