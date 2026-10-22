# n8n-nodes-stac

This is an n8n community node package. It lets you use [Stac](https://trystac.com) as a language model provider in your n8n workflows, and extract data from documents or generate PDFs with it.

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

This package provides two nodes.

### Stac Chat Model

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

### Stac

A regular node (input and output on the canvas) that covers the Stac API endpoints, grouped like n8n's OpenAI node:

| Resource | Action | Endpoint |
| --- | --- | --- |
| **Text** | Message a model | `POST /chat/completions` |
| **Image** | Analyze image | `POST /chat/completions` with image input |
| | Edit image | `POST /images/edits` (image plan) |
| | Extract data from an image | `POST /images/extract` |
| | Generate an image | `POST /images/generations` (image plan) |
| **Document** | Extract data from a document | `POST /documents/extract` (or `/images/extract` for an image) |
| | Generate a PDF | `POST /documents/generate` |
| **Decision** | Make a decision | `POST /decisions` |
| **Model** | List models | `GET /models` |

**Message a model** — a list of messages (`user`, `assistant`, `system`; a `system` message replaces the stack's system prompt). **Model** is loaded from `GET /models`; leave it on *Stack Default Model* to use your stack's own. Options: **Maximum Number of Tokens** (not sent unless added — the server's 8000 floor applies), **Output JSON** (`response_format: json_object`), **Reasoning Effort** (`none`/`low`/`medium`/`high`; not added = the key's level), **Sampling Temperature**, **Top P**. **Simplify Output** returns `content` and `finish_reason`; with Output JSON on, `content` is parsed into an object.

**Analyze image** — a question plus one or more images, from binary fields (comma-separated) or URLs. URLs are downloaded by n8n and sent inline as data URIs, so the image only has to be reachable from n8n. Same model and options as Message a model.

**Extract data** (document or image) — PDF or image in, JSON validated against your JSON Schema out. OCR runs automatically (scanned PDF pages; every image). Put every field in `required` and use nullable types (`["string", "null"]`) on the ones that can be missing, or the model invents a value. Several files in one extraction: comma-separated binary fields (Pro plan and up). **Simplify Output** returns only the extracted fields. Options: **Context**, **System Prompt**, **Max Tokens** (default `4000`).

**Generate an image / Edit image** — needs a key from a stack on the image plan. Pick the image model in **Model** (loaded from `GET /models`). The PNG goes into a binary field and the JSON carries `meta` (effective size, steps, seed…) and `usage`. Edit takes up to 4 reference images (comma-separated binary fields). Options: **Size** (`1024x1024`, `1536x1024`, `1024x1536`), **Steps** (1–8), **Guidance Scale** (0–20), **Seed** (kept as text, so the full 0–2^64−1 range survives), **File Name**. An empty prompt uses the prompt configured on the key; prompts are cut at 512 tokens.

**Generate a PDF** — from ready-made HTML (no model involved, no tokens spent) or from an instruction the model turns into HTML. HTML must be self-contained: external URLs are never fetched — use `data:` URIs.

**Make a decision** — typed answers from a decision model (Jev, by TypeSafe) instead of free text. **State** is a JSON object describing the situation (build it from the item with an expression); **Questions** is a JSON object of named questions, each with a `type` (`choice`, `noul` or `score`), `instructions` and `criteria`. The response carries one answer per question with its choice, confidence and probabilities. **Model** is a text field (default `typesafe/jev-1.13`) because `GET /models` doesn't list decision models; a model outside your plan comes back as `403`, and an unknown one as `404` listing the accepted ones. **Simplify Output** returns only the answers; off, it also returns `usage`.

All operations wait up to 5 minutes for the API. API errors surface with the API's own message and HTTP status (for example, `403` when an image action runs with a text-plan key).

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

**Stac Chat Model:** add an **AI Agent** (or any AI root node) to your canvas, then connect **Stac Chat Model** to its `Model` input. Pick a model from the dropdown — if the list is empty, your credential is wrong or the base URL is unreachable.

**Stac:** pick an action from the node panel. For the file-based actions (extract, analyze from binary, edit image), put the node after one that outputs a file — **Read/Write Files from Disk**, **HTTP Request** with a file response, a form or email trigger with attachments. Actions that produce a file (generate image, edit image, generate PDF) put it in a binary field for the next node to store or send.

New to n8n? Start with the [Try it out](https://docs.n8n.io/try-it-out/) documentation.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
* [Stac documentation](https://trystac.com/docs)

## Version history

### 1.5.0

New **Decision → Make a decision** action on the **Stac** node, for the Jev typed-decision model (`POST /decisions`).

### 1.4.1

**Generate an image** and **Edit image** get a required **Model** field, loaded from the image key's `GET /models` and sent as `model`.

### 1.4.0

The **Stac** node now covers every Stac endpoint, grouped like the OpenAI node: Text (message a model), Image (analyze, edit, extract data, generate), Document (extract data, generate PDF) and Model (list). Workflows built on 1.3.0 keep working.

### 1.3.0

New **Stac** node with **Extract Data** (PDF/image → JSON, with OCR) and **Generate PDF**. Icon files renamed so n8n stops serving the old logo cached under the previous file name.

### 1.2.0

Adds the **Reasoning Effort** option and stops sending the `2048` token fallback when reasoning is requested, so the reasoning step isn't truncated. Dev dependencies aligned with n8n 2.43.7.

### 1.1.0

New Stac logo (light and dark variants), `Maximum Number of Tokens` defaults to `2048` even when the option isn't added, and streaming responses with usage. Tagged but never published to npm — its changes ship in 1.2.0.

### 0.1.0

Initial release: **Stac Chat Model** sub-node with dynamic model loading, plus the **Stac API** credential.
