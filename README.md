# n8n-nodes-stac

This is an n8n community node. It lets you use [Stac](https://trystac.com) as a language model provider in your n8n workflows.

Stac gives you access to open-source LLMs for a fixed monthly price, through an OpenAI-compatible API. Instead of paying per token, you pay a flat subscription — under saturation Stac degrades speed rather than cutting you off.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation, using the package name `n8n-nodes-stac`.

## Operations

This package provides one sub-node:

**Stac Chat Model** — a language model that plugs into the `Model` input of any n8n AI root node (AI Agent, Basic LLM Chain, Question and Answer Chain, and so on).

Parameters:

| Parameter | Description |
| --- | --- |
| **Model** | Loaded dynamically from your Stac plan via `GET /models`, so the dropdown only lists models you can actually call |
| **Sampling Temperature** | `0`–`2`. Lower values make responses more deterministic |
| **Maximum Number of Tokens** | Upper bound on tokens generated in the response. When the option isn't added, the node sends `2048` — or nothing (the server's floor of `8000` applies) when **Reasoning Effort** is `low`, `medium` or `high`. With reasoning on, values below `8000` can cut the reasoning off mid-way |
| **Reasoning Effort** | `none`, `low`, `medium` or `high`, sent as `reasoning_effort`. When the option isn't added, the reasoning level configured on your API key applies |
| **Timeout** | Request timeout in milliseconds (default `120000`). Under saturation Stac degrades speed, so aggressive values can cut off otherwise valid responses |
| **Max Retries** | How many times to retry a failed request (default `2`) |

## Credentials

You need a Stac account and an API key.

1. Sign up at [trystac.com](https://trystac.com) and copy your API key.
2. In n8n, create a new **Stac API** credential.
3. Paste the **API Key**. Leave **Base URL** at `https://api.trystac.com/v1` unless you were given a different endpoint.

Authentication uses a bearer token (`Authorization: Bearer <key>`). The credential's test button calls `GET /models`, so a successful test confirms both the key and the base URL.

## Compatibility

Developed against **n8n 2.43.7** (`@n8n/ai-node-sdk` 0.33.5); versions up to 1.1.0 were tested against **n8n 2.36.9**.

The node builds the model through `supplyModel` from `@n8n/ai-node-sdk`, which n8n provides at runtime — the package declares `@n8n/ai-node-sdk` and `n8n-workflow` as peer dependencies and bundles no LangChain code of its own. This keeps a single `@langchain/core` instance in the process and means model executions show up in n8n's own log/tracing view. Older n8n releases ship earlier versions of that SDK and have not been tested.

## Usage

Add an **AI Agent** (or any AI root node) to your canvas, then connect **Stac Chat Model** to its `Model` input. Pick a model from the dropdown — if the list is empty, your credential is wrong or the base URL is unreachable.

New to n8n? Start with the [Try it out](https://docs.n8n.io/try-it-out/) documentation.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
* [Stac documentation](https://trystac.com/docs)

## Version history

### 1.2.0

Adds the **Reasoning Effort** option and stops sending the `2048` token fallback when reasoning is requested, so the reasoning step isn't truncated. Dev dependencies aligned with n8n 2.43.7.

### 1.1.0

New Stac logo (light and dark variants), `Maximum Number of Tokens` defaults to `2048` even when the option isn't added, and streaming responses with usage. Tagged but never published to npm — its changes ship in 1.2.0.

### 0.1.0

Initial release: **Stac Chat Model** sub-node with dynamic model loading, plus the **Stac API** credential.
