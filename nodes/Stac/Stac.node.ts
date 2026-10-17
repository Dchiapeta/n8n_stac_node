import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

type FilePart = { field: string; fileName: string; mimeType: string; data: Buffer };
type FieldPart = { field: string; value: string };

// Extração com OCR de PDF escaneado leva minutos: o servidor corta em 240s, então
// o cliente espera um pouco mais para o erro que chega ser o do servidor, com
// mensagem útil, e não um timeout cru daqui.
const EXTRACT_TIMEOUT_MS = 300_000;
const GENERATE_TIMEOUT_MS = 300_000;

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const DEFAULT_SCHEMA = JSON.stringify(
	{
		type: 'object',
		properties: {
			invoice_number: { type: 'string' },
			vendor_tax_id: { type: ['string', 'null'] },
			total: { type: 'number' },
		},
		required: ['invoice_number', 'vendor_tax_id', 'total'],
	},
	null,
	2,
);

// Multipart montado à mão: o pacote não pode ter dependência de runtime, e o
// corpo como Buffer com boundary explícito não depende de como a versão do n8n
// serializa FormData no httpRequest.
function buildMultipart(parts: Array<FilePart | FieldPart>): { body: Buffer; boundary: string } {
	const boundary = `----n8nStac${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
	const chunks: Buffer[] = [];
	for (const part of parts) {
		chunks.push(Buffer.from(`--${boundary}\r\n`));
		if ('data' in part) {
			const fileName = part.fileName.replace(/["\r\n]/g, '_');
			chunks.push(
				Buffer.from(
					`Content-Disposition: form-data; name="${part.field}"; filename="${fileName}"\r\n` +
						`Content-Type: ${part.mimeType}\r\n\r\n`,
				),
			);
			chunks.push(part.data);
		} else {
			chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.field}"\r\n\r\n`));
			chunks.push(Buffer.from(part.value, 'utf8'));
		}
		chunks.push(Buffer.from('\r\n'));
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`));
	return { body: Buffer.concat(chunks), boundary };
}

function toBuffer(body: unknown): Buffer {
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	if (typeof body === 'string') return Buffer.from(body, 'utf8');
	return Buffer.from(JSON.stringify(body ?? null), 'utf8');
}

function parseJson(body: unknown): unknown {
	if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !ArrayBuffer.isView(body)) {
		return body;
	}
	const text = toBuffer(body).toString('utf8');
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

// A API responde `{ "detail": "..." }` (às vezes `detail` é uma lista, nas
// validações de campo). Vira a mensagem do erro do node, que é o que o usuário lê.
function errorMessage(payload: unknown, statusCode: number): string {
	if (payload && typeof payload === 'object') {
		const detail = (payload as IDataObject).detail;
		if (typeof detail === 'string') return detail;
		if (Array.isArray(detail)) {
			return detail
				.map((d) => (d && typeof d === 'object' ? String((d as IDataObject).msg ?? '') : String(d)))
				.filter(Boolean)
				.join('; ');
		}
	}
	if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 500);
	return `A API da Stac respondeu ${statusCode}`;
}

function normalizeSchema(value: unknown): string {
	if (value !== null && typeof value === 'object') return JSON.stringify(value);
	const text = String(value ?? '').trim();
	JSON.parse(text);
	return text;
}

export class Stac implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stac',
		name: 'stac',
		icon: { light: 'file:../../icons/stac-logo.svg', dark: 'file:../../icons/stac-logo.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{ $parameter.operation === "extract" ? "Extract Data" : "Generate PDF" }}',
		description: 'Extração de dados com OCR e geração de PDF via Stac',
		defaults: { name: 'Stac' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// Exigido pelo lint (o tipo só aceita true). Como tool, Extract Data
		// depende de um binário que o agente não fornece; Generate PDF funciona.
		usableAsTool: true,
		credentials: [{ name: 'stacApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Document', value: 'document' }],
				default: 'document',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['document'] } },
				options: [
					{
						name: 'Extract Data',
						value: 'extract',
						description: 'Extrai campos de um PDF ou imagem em JSON validado por schema (OCR automático)',
						action: 'Extract data from a document',
					},
					{
						name: 'Generate PDF',
						value: 'generatePdf',
						description: 'Renderiza um PDF a partir de HTML ou de uma instrução para o modelo',
						action: 'Generate a PDF',
					},
				],
				default: 'extract',
			},

			// ---------- Extract Data ----------
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				placeholder: 'data',
				displayOptions: { show: { resource: ['document'], operation: ['extract'] } },
				description:
					'Campo binário do item com o arquivo. Vários arquivos numa só extração: separe os campos por vírgula (a partir do plano Pro).',
			},
			{
				displayName: 'File Type',
				name: 'fileType',
				type: 'options',
				displayOptions: { show: { resource: ['document'], operation: ['extract'] } },
				options: [
					{
						name: 'Auto-Detect',
						value: 'auto',
						description: 'Pelo MIME type do arquivo: PDF ou imagem (JPEG, PNG, WEBP)',
					},
					{
						name: 'PDF',
						value: 'pdf',
						description: 'OCR só nas páginas escaneadas',
					},
					{
						name: 'Image',
						value: 'image',
						description: 'Foto, print ou scan solto: toda imagem passa por OCR',
					},
				],
				default: 'auto',
			},
			{
				displayName: 'Schema',
				name: 'schema',
				type: 'json',
				required: true,
				default: DEFAULT_SCHEMA,
				typeOptions: { rows: 10 },
				displayOptions: { show: { resource: ['document'], operation: ['extract'] } },
				description:
					'JSON Schema dos campos a extrair. Marque como required todos os campos e use tipo nullable (["string", "null"]) nos que podem faltar, senão o modelo inventa um valor.',
			},
			{
				displayName: 'Simplify Output',
				name: 'simplify',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['document'], operation: ['extract'] } },
				description:
					'Whether to return only the extracted fields instead of the full response (with pages, files, ocr_used and usage)',
			},
			{
				displayName: 'Options',
				name: 'extractOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['document'], operation: ['extract'] } },
				options: [
					{
						displayName: 'Context',
						name: 'user',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						description:
							'Contexto extra sobre este arquivo, somado à instrução de extração (ex.: que tipo de documento é)',
					},
					{
						displayName: 'Max Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 16000 },
						default: 4000,
						description: 'Teto da resposta, até 16000',
					},
					{
						displayName: 'System Prompt',
						name: 'system',
						type: 'string',
						typeOptions: { rows: 4 },
						default: '',
						description: 'Substitui o system prompt configurado na stack só nesta request',
					},
				],
			},

			// ---------- Generate PDF ----------
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				displayOptions: { show: { resource: ['document'], operation: ['generatePdf'] } },
				options: [
					{
						name: 'HTML',
						value: 'html',
						description: 'Renderiza um HTML pronto. Sem modelo: não gasta tokens.',
					},
					{
						name: 'Instruction',
						value: 'instruction',
						description: 'O modelo escreve o HTML a partir de uma instrução e o PDF é renderizado',
					},
				],
				default: 'html',
			},
			{
				displayName: 'HTML',
				name: 'html',
				type: 'string',
				required: true,
				typeOptions: { rows: 8 },
				default: '',
				placeholder: '<h1>Relatório</h1>',
				displayOptions: {
					show: { resource: ['document'], operation: ['generatePdf'], source: ['html'] },
				},
				description:
					'HTML autocontido. URLs externas (imagens, fontes, @import) não são baixadas: use data: URIs.',
			},
			{
				displayName: 'Instruction',
				name: 'instruction',
				type: 'string',
				required: true,
				typeOptions: { rows: 5 },
				default: '',
				placeholder: 'Relatório de vendas de agosto, com uma tabela por região',
				displayOptions: {
					show: { resource: ['document'], operation: ['generatePdf'], source: ['instruction'] },
				},
				description: 'O que o documento deve conter',
			},
			{
				displayName: 'Put Output File in Field',
				name: 'outputBinaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: { show: { resource: ['document'], operation: ['generatePdf'] } },
				description: 'Campo binário do item de saída que recebe o PDF',
			},
			{
				displayName: 'Options',
				name: 'generateOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['document'], operation: ['generatePdf'] } },
				options: [
					{
						displayName: 'File Name',
						name: 'fileName',
						type: 'string',
						default: 'document.pdf',
					},
					{
						displayName: 'Max Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 16000 },
						default: 8000,
						displayOptions: { show: { '/source': ['instruction'] } },
						description: 'Teto da resposta do modelo, até 16000',
					},
					{
						displayName: 'System Prompt',
						name: 'system',
						type: 'string',
						typeOptions: { rows: 4 },
						default: '',
						displayOptions: { show: { '/source': ['instruction'] } },
						description: 'Substitui o system prompt configurado na stack só nesta request',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('stacApi');
		const baseUrl = String(credentials.baseUrl).replace(/\/+$/, '');

		const request = async (
			itemIndex: number,
			options: Omit<IHttpRequestOptions, 'url'> & { path: string },
		): Promise<Buffer> => {
			const { path, ...rest } = options;
			const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'stacApi', {
				...rest,
				url: `${baseUrl}${path}`,
				encoding: 'arraybuffer',
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			})) as { body: unknown; statusCode: number };
			if (response.statusCode >= 400) {
				const payload = parseJson(response.body);
				throw new NodeApiError(
					this.getNode(),
					(payload && typeof payload === 'object' ? payload : { detail: payload }) as JsonObject,
					{
						itemIndex,
						httpCode: String(response.statusCode),
						message: errorMessage(payload, response.statusCode),
					},
				);
			}
			return toBuffer(response.body);
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;

				if (operation === 'extract') {
					const fieldNames = (this.getNodeParameter('binaryPropertyName', i) as string)
						.split(',')
						.map((name) => name.trim())
						.filter(Boolean);
					if (fieldNames.length === 0) {
						throw new NodeOperationError(this.getNode(), 'Informe o campo binário com o arquivo', {
							itemIndex: i,
						});
					}

					const files: FilePart[] = [];
					for (const field of fieldNames) {
						const binary = this.helpers.assertBinaryData(i, field);
						files.push({
							field: fieldNames.length > 1 ? 'files' : 'file',
							fileName: binary.fileName ?? field,
							mimeType: binary.mimeType,
							data: await this.helpers.getBinaryDataBuffer(i, field),
						});
					}

					let fileType = this.getNodeParameter('fileType', i) as string;
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
						throw new NodeOperationError(this.getNode(), 'O Schema não é um JSON válido', {
							itemIndex: i,
						});
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
					const raw = await request(i, {
						method: 'POST',
						path: fileType === 'pdf' ? '/documents/extract' : '/images/extract',
						headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
						body,
						timeout: EXTRACT_TIMEOUT_MS,
					});
					const result = parseJson(raw) as IDataObject;

					const simplify = this.getNodeParameter('simplify', i) as boolean;
					let json: IDataObject = result;
					if (simplify) {
						const data = result.data;
						json =
							data !== null && typeof data === 'object' && !Array.isArray(data)
								? (data as IDataObject)
								: { data };
					}
					returnData.push({ json, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'generatePdf') {
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

					const pdf = await request(i, {
						method: 'POST',
						path: '/documents/generate',
						headers: { 'Content-Type': 'application/json', Accept: 'application/pdf' },
						body: Buffer.from(JSON.stringify(payload), 'utf8'),
						timeout: GENERATE_TIMEOUT_MS,
					});

					const fileName = options.fileName || 'document.pdf';
					const binary = await this.helpers.prepareBinaryData(pdf, fileName, 'application/pdf');
					returnData.push({
						json: { fileName, mimeType: 'application/pdf', fileSize: pdf.length },
						binary: { [outputField]: binary },
						pairedItem: { item: i },
					});
					continue;
				}

				throw new NodeOperationError(this.getNode(), `Operação desconhecida: ${operation}`, {
					itemIndex: i,
				});
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
