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

## Development

`.npmrc` sets `omit=dev` so installing this package into Pi does not pull the
test toolchain. Ask for dev dependencies explicitly:

```bash
npm install --include=dev
npm test
npm run typecheck
```

| Path | Purpose |
| --- | --- |
| `extensions/openorange.ts` | Pi entry point; registers the provider |
| `src/provider.ts` | Provider: login, auth resolution, model refresh, streaming |
| `src/litellm.ts` | LiteLLM client and catalog mapping |
| `src/attribution.ts` | Spend-attribution payload injection |
| `src/config.ts` | Instance URL rules and endpoint layout |
