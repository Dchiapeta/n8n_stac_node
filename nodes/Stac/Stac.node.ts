import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { stacProperties } from './descriptions';
import type { FieldPart, FilePart } from './transport';
import { buildMultipart, stacJson, stacRequest, toBuffer } from './transport';

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_EDIT_IMAGES = 4;

type ChatOptions = {
	maxTokens?: number;
	jsonOutput?: boolean;
	reasoningEffort?: string;
	temperature?: number;
	topP?: number;
};

type ImageOptions = {
	fileName?: string;
	guidanceScale?: number;
	seed?: string;
	size?: string;
	steps?: number;
};

function fieldList(value: string): string[] {
	return value
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
}

function normalizeSchema(value: unknown): string {
	if (value !== null && typeof value === 'object') return JSON.stringify(value);
	const text = String(value ?? '').trim();
	JSON.parse(text);
	return text;
}

async function readBinaryFiles(
	this: IExecuteFunctions,
	itemIndex: number,
	fields: string[],
	multipartField: (count: number) => string,
): Promise<FilePart[]> {
	if (fields.length === 0) {
		throw new NodeOperationError(this.getNode(), 'Informe o campo binário com o arquivo', {
			itemIndex,
		});
	}
	const files: FilePart[] = [];
	for (const field of fields) {
		const binary = this.helpers.assertBinaryData(itemIndex, field);
		files.push({
			field: multipartField(fields.length),
			fileName: binary.fileName ?? field,
			mimeType: binary.mimeType,
			data: await this.helpers.getBinaryDataBuffer(itemIndex, field),
		});
	}
	return files;
}

function chatBody(model: string, messages: IDataObject[], options: ChatOptions): IDataObject {
	const body: IDataObject = { messages, stream: false };
	if (model) body.model = model;
	if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (options.topP !== undefined) body.top_p = options.topP;
	if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
	if (options.jsonOutput) body.response_format = { type: 'json_object' };
	return body;
}

function simplifyChat(response: IDataObject, jsonOutput: boolean): IDataObject {
	const choice = ((response.choices as IDataObject[] | undefined) ?? [])[0] ?? {};
	const message = (choice.message as IDataObject | undefined) ?? {};
	let content: unknown = message.content ?? '';
	if (jsonOutput && typeof content === 'string') {
		try {
			content = JSON.parse(content);
		} catch {
			// devolve o texto como veio: o finish_reason "length" costuma explicar
		}
	}
	const result: IDataObject = { content: content as IDataObject, finish_reason: choice.finish_reason };
	if (message.tool_calls) result.tool_calls = message.tool_calls;
	return result;
}

// Seed vai até 2^64−1, além do que um number do JS representa sem perder
// dígitos. O valor entra no JSON como texto já validado, sem passar por number.
function jsonWithSeed(payload: IDataObject, seed: string | undefined): string {
	if (!seed) return JSON.stringify(payload);
	const marker = '__STAC_SEED__';
	return JSON.stringify({ ...payload, seed: marker }).replace(`"${marker}"`, seed);
}

function validSeed(this: IExecuteFunctions, itemIndex: number, seed: string | undefined) {
	const value = (seed ?? '').trim();
	if (value && !/^\d{1,20}$/.test(value)) {
		throw new NodeOperationError(this.getNode(), 'Seed deve ser um inteiro de 0 a 2^64−1', {
			itemIndex,
		});
	}
	return value || undefined;
}

async function imageResult(
	this: IExecuteFunctions,
	itemIndex: number,
	response: IDataObject,
	outputField: string,
	fileName: string,
): Promise<INodeExecutionData> {
	const first = ((response.data as IDataObject[] | undefined) ?? [])[0];
	const b64 = first?.b64_json;
	if (typeof b64 !== 'string' || !b64) {
		throw new NodeOperationError(this.getNode(), 'A API não devolveu a imagem (data[0].b64_json)', {
			itemIndex,
		});
	}
	const binary = await this.helpers.prepareBinaryData(
		Buffer.from(b64, 'base64'),
		fileName,
		'image/png',
	);
	return {
		json: { created: response.created, meta: response.meta, usage: response.usage },
		binary: { [outputField]: binary },
		pairedItem: { item: itemIndex },
	};
}

export class Stac implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stac',
		name: 'stac',
		icon: { light: 'file:../../icons/stac-logo.svg', dark: 'file:../../icons/stac-logo.dark.svg' },
		group: ['transform'],
		version: [1, 1.1],
		defaultVersion: 1.1,
		subtitle: '={{ $parameter.operation + ": " + $parameter.resource }}',
		description: 'Texto, imagem, OCR e PDF com os modelos da Stac',
		defaults: { name: 'Stac' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// Exigido pelo lint (o tipo só aceita true). Como tool, as operações que
		// dependem de binário na entrada não servem; Message a Model e Generate PDF sim.
		usableAsTool: true,
		credentials: [{ name: 'stacApi', required: true }],
		properties: stacProperties,
	};

	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('stacApi');
				const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'stacApi', {
					method: 'GET',
					url: `${String(credentials.baseUrl).replace(/\/+$/, '')}/models`,
					json: true,
				})) as { data?: Array<{ id: string }> };
				return [
					{ name: 'Stack Default Model', value: '' },
					...(response.data ?? []).map((model) => ({ name: model.id, value: model.id })),
				];
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const key = `${resource}:${operation}`;

				if (key === 'text:message') {
					returnData.push(await messageModel.call(this, i));
				} else if (key === 'image:analyze') {
					returnData.push(await analyzeImage.call(this, i));
				} else if (key === 'image:extract' || key === 'document:extract') {
					returnData.push(await extractData.call(this, i, resource));
				} else if (key === 'image:generate') {
					returnData.push(await generateImage.call(this, i));
				} else if (key === 'image:edit') {
					returnData.push(await editImage.call(this, i));
				} else if (key === 'document:generatePdf') {
					returnData.push(await generatePdf.call(this, i));
				} else if (key === 'model:list') {
					returnData.push(...(await listModels.call(this, i)));
				} else {
					throw new NodeOperationError(this.getNode(), `Operação desconhecida: ${key}`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				throw nodeError;
			}
		}

		return [returnData];
	}
}

// ---------- Text ----------

async function messageModel(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const model = this.getNodeParameter('modelId', i, '') as string;
	const collection = this.getNodeParameter('messages', i, {}) as {
		values?: Array<{ role: string; content: string }>;
	};
	const messages = (collection.values ?? [])
		.filter((m) => m.content !== undefined && String(m.content).trim() !== '')
		.map((m) => ({ role: m.role || 'user', content: String(m.content) }));
	if (messages.length === 0) {
		throw new NodeOperationError(this.getNode(), 'Adicione ao menos uma mensagem com texto', {
			itemIndex: i,
		});
	}
	const options = this.getNodeParameter('chatOptions', i, {}) as ChatOptions;
	const response = await stacJson.call(this, i, {
		method: 'POST',
		path: '/chat/completions',
		headers: { 'Content-Type': 'application/json' },
		body: Buffer.from(JSON.stringify(chatBody(model, messages, options)), 'utf8'),
	});
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	return {
		json: simplify ? simplifyChat(response, Boolean(options.jsonOutput)) : response,
		pairedItem: { item: i },
	};
}

// ---------- Image ----------

async function imageDataUris(this: IExecuteFunctions, i: number): Promise<string[]> {
	const inputType = this.getNodeParameter('inputType', i) as string;
	if (inputType === 'url') {
		const urls = fieldList(this.getNodeParameter('imageUrls', i) as string);
		if (urls.length === 0) {
			throw new NodeOperationError(this.getNode(), 'Informe ao menos uma URL de imagem', {
				itemIndex: i,
			});
		}
		// O n8n baixa e embute como data URI: o servidor de inferência não busca
		// URLs externas, e assim uma imagem privada ao alcance do n8n também funciona.
		const uris: string[] = [];
		for (const url of urls) {
			const response = (await this.helpers.httpRequest({
				method: 'GET',
				url,
				encoding: 'arraybuffer',
				returnFullResponse: true,
			})) as { body: unknown; headers: IDataObject };
			const mimeType = String(response.headers['content-type'] ?? '')
				.split(';')[0]
				.trim();
			if (!mimeType.startsWith('image/')) {
				throw new NodeOperationError(
					this.getNode(),
					`A URL não devolveu uma imagem (${mimeType || 'sem content-type'}): ${url}`,
					{ itemIndex: i },
				);
			}
			uris.push(`data:${mimeType};base64,${toBuffer(response.body).toString('base64')}`);
		}
		return uris;
	}
	const files = await readBinaryFiles.call(
		this,
		i,
		fieldList(this.getNodeParameter('binaryPropertyName', i) as string),
		() => 'image',
	);
	return files.map((f) => `data:${f.mimeType};base64,${f.data.toString('base64')}`);
}

async function analyzeImage(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const model = this.getNodeParameter('modelId', i, '') as string;
	const text = this.getNodeParameter('text', i, '') as string;
	const uris = await imageDataUris.call(this, i);
	const content: IDataObject[] = [];
	if (text.trim()) content.push({ type: 'text', text });
	for (const url of uris) content.push({ type: 'image_url', image_url: { url } });

	const options = this.getNodeParameter('chatOptions', i, {}) as ChatOptions;
	const response = await stacJson.call(this, i, {
		method: 'POST',
		path: '/chat/completions',
		headers: { 'Content-Type': 'application/json' },
		body: Buffer.from(
			JSON.stringify(chatBody(model, [{ role: 'user', content }], options)),
			'utf8',
		),
	});
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	return {
		json: simplify ? simplifyChat(response, Boolean(options.jsonOutput)) : response,
		pairedItem: { item: i },
	};
}

async function generateImage(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const prompt = this.getNodeParameter('prompt', i, '') as string;
	const outputField = this.getNodeParameter('outputBinaryPropertyName', i) as string;
	const options = this.getNodeParameter('imageOptions', i, {}) as ImageOptions;
	const seed = validSeed.call(this, i, options.seed);

	const payload: IDataObject = {};
	if (prompt.trim()) payload.prompt = prompt;
	if (options.size) payload.size = options.size;
	if (options.steps !== undefined) payload.steps = options.steps;
	if (options.guidanceScale !== undefined) payload.guidance_scale = options.guidanceScale;

	const response = await stacJson.call(this, i, {
		method: 'POST',
		path: '/images/generations',
		headers: { 'Content-Type': 'application/json' },
		body: Buffer.from(jsonWithSeed(payload, seed), 'utf8'),
	});
	return await imageResult.call(this, i, response, outputField, options.fileName || 'image.png');
}

async function editImage(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const fields = fieldList(this.getNodeParameter('binaryPropertyName', i) as string);
	if (fields.length > MAX_EDIT_IMAGES) {
		throw new NodeOperationError(
			this.getNode(),
			`No máximo ${MAX_EDIT_IMAGES} imagens de referência por edição`,
			{ itemIndex: i },
		);
	}
	const files = await readBinaryFiles.call(this, i, fields, () => 'image[]');
	const prompt = this.getNodeParameter('prompt', i, '') as string;
	const outputField = this.getNodeParameter('outputBinaryPropertyName', i) as string;
	const options = this.getNodeParameter('imageOptions', i, {}) as ImageOptions;
	const seed = validSeed.call(this, i, options.seed);

	const parts: FieldPart[] = [];
	if (prompt.trim()) parts.push({ field: 'prompt', value: prompt });
	if (options.size) parts.push({ field: 'size', value: options.size });
	if (options.steps !== undefined) parts.push({ field: 'steps', value: String(options.steps) });
	if (options.guidanceScale !== undefined) {
		parts.push({ field: 'guidance_scale', value: String(options.guidanceScale) });
	}
	if (seed) parts.push({ field: 'seed', value: seed });

	const { body, boundary } = buildMultipart([...files, ...parts]);
	const response = await stacJson.call(this, i, {
		method: 'POST',
		path: '/images/edits',
		headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
		body,
	});
	return await imageResult.call(this, i, response, outputField, options.fileName || 'image.png');
}

// ---------- Extract Data (Document e Image) ----------

async function extractData(
	this: IExecuteFunctions,
	i: number,
	resource: string,
): Promise<INodeExecutionData> {
	const files = await readBinaryFiles.call(
		this,
		i,
		fieldList(this.getNodeParameter('binaryPropertyName', i) as string),
		(count) => (count > 1 ? 'files' : 'file'),
	);

	let fileType = resource === 'image' ? 'image' : (this.getNodeParameter('fileType', i) as string);
	if (fileType === 'auto') {
		const kinds = new Set(
			files.map((f) =>
				f.mimeType === 'application/pdf'
					? 'pdf'
					: IMAGE_MIME_TYPES.includes(f.mimeType)
						? 'image'
						: 'unknown',
			),
		);
		if (kinds.has('unknown')) {
			const bad = files.find(
				(f) => f.mimeType !== 'application/pdf' && !IMAGE_MIME_TYPES.includes(f.mimeType),
			);
			throw new NodeOperationError(
				this.getNode(),
				`Tipo de arquivo não suportado: ${bad?.mimeType} (${bad?.fileName}). Use PDF, JPEG, PNG ou WEBP, ou escolha o File Type manualmente.`,
				{ itemIndex: i },
			);
		}
		if (kinds.size > 1) {
			throw new NodeOperationError(
				this.getNode(),
				'PDFs e imagens não podem ir na mesma extração. Separe em duas execuções.',
				{ itemIndex: i },
			);
		}
		fileType = kinds.has('pdf') ? 'pdf' : 'image';
	}

	let schema: string;
	try {
		schema = normalizeSchema(this.getNodeParameter('schema', i));
	} catch {
		throw new NodeOperationError(this.getNode(), 'O Schema não é um JSON válido', { itemIndex: i });
	}

	const options = this.getNodeParameter('extractOptions', i, {}) as {
		user?: string;
		system?: string;
		maxTokens?: number;
	};
	const fields: FieldPart[] = [{ field: 'schema', value: schema }];
	if (options.system) fields.push({ field: 'system', value: options.system });
	if (options.user) fields.push({ field: 'user', value: options.user });
	if (options.maxTokens !== undefined) {
		fields.push({ field: 'max_tokens', value: String(options.maxTokens) });
	}

	const { body, boundary } = buildMultipart([...files, ...fields]);
	const result = await stacJson.call(this, i, {
		method: 'POST',
		path: fileType === 'pdf' ? '/documents/extract' : '/images/extract',
		headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
		body,
	});

	const simplify = this.getNodeParameter('simplify', i) as boolean;
	let json: IDataObject = result;
	if (simplify) {
		const data = result.data;
		json =
			data !== null && typeof data === 'object' && !Array.isArray(data)
				? (data as IDataObject)
				: { data };
	}
	return { json, pairedItem: { item: i } };
}

// ---------- Document → Generate PDF ----------

async function generatePdf(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const source = this.getNodeParameter('source', i) as string;
	const outputField = this.getNodeParameter('outputBinaryPropertyName', i) as string;
	const options = this.getNodeParameter('generateOptions', i, {}) as {
		fileName?: string;
		system?: string;
		maxTokens?: number;
	};

	const payload: IDataObject = {};
	if (source === 'html') {
		payload.html = this.getNodeParameter('html', i) as string;
	} else {
		payload.user = this.getNodeParameter('instruction', i) as string;
		if (options.system) payload.system = options.system;
		if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
	}

	const pdf = await stacRequest.call(this, i, {
		method: 'POST',
		path: '/documents/generate',
		headers: { 'Content-Type': 'application/json', Accept: 'application/pdf' },
		body: Buffer.from(JSON.stringify(payload), 'utf8'),
	});

	const fileName = options.fileName || 'document.pdf';
	const binary = await this.helpers.prepareBinaryData(pdf, fileName, 'application/pdf');
	return {
		json: { fileName, mimeType: 'application/pdf', fileSize: pdf.length },
		binary: { [outputField]: binary },
		pairedItem: { item: i },
	};
}

// ---------- Model ----------

async function listModels(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const response = await stacJson.call(this, i, { method: 'GET', path: '/models' });
	return ((response.data as IDataObject[] | undefined) ?? []).map((model) => ({
		json: model,
		pairedItem: { item: i },
	}));
}
