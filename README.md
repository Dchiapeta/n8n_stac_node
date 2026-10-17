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

A regular node (input and output on the canvas) for the document endpoints. Resource **Document**:

**Extract Data** — PDF or image in, JSON validated against your JSON Schema out. OCR runs automatically (scanned PDF pages; every image).

| Parameter | Description |
| --- | --- |
| **Input Binary Field** | Binary field with the file (default `data`). Several files in one extraction: comma-separated field names (Pro plan and up) |
| **File Type** | `Auto-Detect` (by MIME type), `PDF` (`/documents/extract`) or `Image` — JPEG, PNG, WEBP (`/images/extract`) |
| **Schema** | JSON Schema of the fields to extract. Put every field in `required` and use nullable types (`["string", "null"]`) on the ones that can be missing, or the model invents a value |
| **Simplify Output** | On (default): output only the extracted fields. Off: the full response, with `pages`, `files`, `ocr_used` and `usage` |
| **Options** | **Context** (`user`, extra context about the file), **System Prompt** (replaces the stack's for this request), **Max Tokens** (default `4000`, up to `16000`) |

**Generate PDF** — renders a PDF and puts it in a binary field.

| Parameter | Description |
| --- | --- |
| **Source** | `HTML` renders ready-made HTML (no model involved, no tokens spent); `Instruction` has the model write the HTML first |
| **HTML** / **Instruction** | The document. HTML must be self-contained: external URLs (images, fonts, `@import`) are never fetched — use `data:` URIs |
| **Put Output File in Field** | Binary field that receives the PDF (default `data`) |
| **Options** | **File Name** (default `document.pdf`); with `Instruction`, also **System Prompt** and **Max Tokens** (default `8000`) |

Both operations wait up to 5 minutes for the API: extracting a scanned multi-page PDF can take minutes. API errors surface with the API's own message (for example, a second file on the Go plan returns `413`).

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

**Stac:** put it after a node that outputs a file — **Read/Write Files from Disk**, **HTTP Request** with a file response, a form or email trigger with attachments — choose **Extract Data**, and paste your JSON Schema. For **Generate PDF**, follow it with a node that stores or sends the binary.

New to n8n? Start with the [Try it out](https://docs.n8n.io/try-it-out/) documentation.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
* [Stac documentation](https://trystac.com/docs)

## Version history

### 1.3.0

New **Stac** node with **Extract Data** (PDF/image → JSON, with OCR) and **Generate PDF**. Icon files renamed so n8n stops serving the old logo cached under the previous file name.

### 1.2.0

Adds the **Reasoning Effort** option and stops sending the `2048` token fallback when reasoning is requested, so the reasoning step isn't truncated. Dev dependencies aligned with n8n 2.43.7.

### 1.1.0

New Stac logo (light and dark variants), `Maximum Number of Tokens` defaults to `2048` even when the option isn't added, and streaming responses with usage. Tagged but never published to npm — its changes ship in 1.2.0.

### 0.1.0

Initial release: **Stac Chat Model** sub-node with dynamic model loading, plus the **Stac API** credential.
