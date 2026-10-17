import type { INodeProperties } from 'n8n-workflow';

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

const SCHEMA_DESCRIPTION =
	'JSON Schema dos campos a extrair. Marque como required todos os campos e use tipo nullable (["string", "null"]) nos que podem faltar, senão o modelo inventa um valor.';

const show = (resource: string, operation: string[]) => ({
	show: { resource: [resource], operation },
});

// ---------- resource e operações ----------

// Fora da ordem alfabética de propósito: o painel de ações do n8n agrupa pela
// ordem destas opções, e Text e Image vêm primeiro, como no node da OpenAI.
const resourceOptions = [
	{ name: 'Text', value: 'text' },
	{ name: 'Image', value: 'image' },
	{ name: 'Document', value: 'document' },
	{ name: 'Model', value: 'model' },
];

// O n8n só grava no workflow o que difere do default. A versão 1 (1.3.0) tinha
// só Document, então ela mantém esse default: um workflow salvo nela não muda de
// resource ao abrir. Nodes novos (1.1) começam em Text, como o node da OpenAI.
export const resourceProperties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: resourceOptions,
		default: 'document',
		displayOptions: { show: { '@version': [1] } },
	},
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: resourceOptions,
		default: 'text',
		displayOptions: { show: { '@version': [{ _cnd: { gte: 1.1 } }] } },
	},
];

export const operationProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['text'] } },
		options: [
			{
				name: 'Message a Model',
				value: 'message',
				description: 'Envia mensagens ao modelo e devolve a resposta',
				action: 'Message a model',
			},
		],
		default: 'message',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['image'] } },
		options: [
			{
				name: 'Analyze Image',
				value: 'analyze',
				description: 'Pergunta ao modelo sobre uma ou mais imagens',
				action: 'Analyze image',
			},
			{
				name: 'Edit Image',
				value: 'edit',
				description: 'Edita até 4 imagens de referência a partir de um prompt (plano de imagem)',
				action: 'Edit image',
			},
			{
				name: 'Extract Data From Image',
				value: 'extract',
				description: 'Extrai campos de uma imagem em JSON validado por schema, com OCR',
				action: 'Extract data from an image',
			},
			{
				name: 'Generate an Image',
				value: 'generate',
				description: 'Gera uma imagem a partir de um prompt (plano de imagem)',
				action: 'Generate an image',
			},
		],
		default: 'analyze',
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
				description:
					'Extrai campos de um PDF (ou imagem) em JSON validado por schema, com OCR automático',
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
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['model'] } },
		options: [
			{
				name: 'List Models',
				value: 'list',
				description: 'Lista os modelos que a chave pode chamar',
				action: 'List models',
			},
		],
		default: 'list',
	},
];

// ---------- campos compartilhados ----------

const modelProperty = (operations: Array<[string, string]>): INodeProperties[] =>
	operations.map(([resource, operation]) => ({
		displayName: 'Model Name or ID',
		name: 'modelId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getModels' },
		default: '',
		displayOptions: show(resource, [operation]),
		description:
			'Modelo a usar. Vazio = modelo da stack. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	}));

const chatOptions = (resource: string, operation: string): INodeProperties => ({
	displayName: 'Options',
	name: 'chatOptions',
	type: 'collection',
	placeholder: 'Add Option',
	default: {},
	displayOptions: show(resource, [operation]),
	options: [
		{
			displayName: 'Maximum Number of Tokens',
			name: 'maxTokens',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 16000 },
			default: 8000,
			description:
				'Teto de tokens gerados, raciocínio incluído. Sem a opção vale o piso de 8000 do servidor; com raciocínio ligado, valores abaixo de 8000 podem cortar o raciocínio.',
		},
		{
			displayName: 'Output JSON',
			name: 'jsonOutput',
			type: 'boolean',
			default: false,
			description:
				'Whether to force the response to be valid JSON (response_format json_object). Peça o formato no prompt.',
		},
		{
			displayName: 'Reasoning Effort',
			name: 'reasoningEffort',
			type: 'options',
			options: [
				{ name: 'High', value: 'high', description: 'Raciocínio mais profundo, respostas mais lentas' },
				{ name: 'Low', value: 'low', description: 'Raciocínio curto' },
				{ name: 'Medium', value: 'medium', description: 'Raciocínio moderado' },
				{ name: 'None', value: 'none', description: 'Responde direto, sem etapa de raciocínio' },
			],
			default: 'medium',
			description:
				'Nível de raciocínio do modelo. Sem esta opção vale o nível configurado na chave de API.',
		},
		{
			displayName: 'Sampling Temperature',
			name: 'temperature',
			type: 'number',
			typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
			default: 0.7,
			description: 'Quanto menor, mais determinística a resposta',
		},
		{
			displayName: 'Top P',
			name: 'topP',
			type: 'number',
			typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
			default: 1,
			description: 'Nucleus sampling. Ajuste este ou a temperatura, não os dois.',
		},
	],
});

const simplifyProperty = (resource: string, operations: string[]): INodeProperties => ({
	displayName: 'Simplify Output',
	name: 'simplify',
	type: 'boolean',
	default: true,
	displayOptions: show(resource, operations),
	description: 'Whether to return a simplified version of the response instead of the raw data',
});

// ---------- Text → Message a Model ----------

const messageProperties: INodeProperties[] = [
	{
		displayName: 'Messages',
		name: 'messages',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		placeholder: 'Add Message',
		default: { values: [{ role: 'user', content: '' }] },
		displayOptions: show('text', ['message']),
		options: [
			{
				displayName: 'Message',
				name: 'values',
				values: [
					{
						displayName: 'Prompt',
						name: 'content',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
					},
					{
						displayName: 'Role',
						name: 'role',
						type: 'options',
						options: [
							{
								name: 'Assistant',
								value: 'assistant',
								description: 'Resposta anterior do modelo, para dar contexto ou exemplos',
							},
							{
								name: 'System',
								value: 'system',
								description: 'Instruções de comportamento. Substitui o system prompt da stack.',
							},
							{ name: 'User', value: 'user', description: 'Mensagem do usuário' },
						],
						default: 'user',
					},
				],
			},
		],
	},
	simplifyProperty('text', ['message']),
	chatOptions('text', 'message'),
];

// ---------- Image → Analyze Image ----------

const analyzeProperties: INodeProperties[] = [
	{
		displayName: 'Text Input',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 2 },
		default: 'Descreva esta imagem.',
		displayOptions: show('image', ['analyze']),
		description: 'O que perguntar sobre a imagem',
	},
	{
		displayName: 'Input Type',
		name: 'inputType',
		type: 'options',
		options: [
			{ name: 'Binary File(s)', value: 'binary' },
			{ name: 'Image URL(s)', value: 'url' },
		],
		default: 'binary',
		displayOptions: show('image', ['analyze']),
	},
	{
		displayName: 'Input Binary Field(s)',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		placeholder: 'data',
		displayOptions: { show: { resource: ['image'], operation: ['analyze'], inputType: ['binary'] } },
		description: 'Campo binário com a imagem. Várias imagens: separe os campos por vírgula.',
	},
	{
		displayName: 'URL(s)',
		name: 'imageUrls',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'https://exemplo.com/foto.jpg',
		displayOptions: { show: { resource: ['image'], operation: ['analyze'], inputType: ['url'] } },
		description:
			'URL da imagem. Várias: separe por vírgula. O n8n baixa a imagem e a envia junto da request.',
	},
	simplifyProperty('image', ['analyze']),
	chatOptions('image', 'analyze'),
];

// ---------- Extract Data (Document e Image) ----------

const extractProperties: INodeProperties[] = [
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		placeholder: 'data',
		displayOptions: { show: { resource: ['document', 'image'], operation: ['extract'] } },
		description:
			'Campo binário do item com o arquivo. Vários arquivos numa só extração: separe os campos por vírgula (a partir do plano Pro).',
	},
	{
		displayName: 'File Type',
		name: 'fileType',
		type: 'options',
		displayOptions: show('document', ['extract']),
		options: [
			{
				name: 'Auto-Detect',
				value: 'auto',
				description: 'Pelo MIME type do arquivo: PDF ou imagem (JPEG, PNG, WEBP)',
			},
			{
				name: 'Image',
				value: 'image',
				description: 'Foto, print ou scan solto: toda imagem passa por OCR',
			},
			{
				name: 'PDF',
				value: 'pdf',
				description: 'OCR só nas páginas escaneadas',
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
		displayOptions: { show: { resource: ['document', 'image'], operation: ['extract'] } },
		description: SCHEMA_DESCRIPTION,
	},
	{
		displayName: 'Simplify Output',
		name: 'simplify',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: ['document', 'image'], operation: ['extract'] } },
		description:
			'Whether to return only the extracted fields instead of the full response (with pages, files, ocr_used and usage)',
	},
	{
		displayName: 'Options',
		name: 'extractOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['document', 'image'], operation: ['extract'] } },
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
];

// ---------- Image → Generate / Edit ----------

const imageOptions = (operation: string): INodeProperties => ({
	displayName: 'Options',
	name: 'imageOptions',
	type: 'collection',
	placeholder: 'Add Option',
	default: {},
	displayOptions: show('image', [operation]),
	options: [
		{
			displayName: 'File Name',
			name: 'fileName',
			type: 'string',
			default: 'image.png',
		},
		{
			displayName: 'Guidance Scale',
			name: 'guidanceScale',
			type: 'number',
			typeOptions: { minValue: 0, maxValue: 20, numberPrecision: 1 },
			default: 1,
			description: 'Quanto seguir o prompt à risca, de 0 a 20',
		},
		{
			displayName: 'Seed',
			name: 'seed',
			type: 'string',
			default: '',
			description:
				'Número de 0 a 2^64−1 para reproduzir uma imagem. Vazio = o servidor sorteia e devolve em meta.seed.',
		},
		{
			displayName: 'Size',
			name: 'size',
			type: 'options',
			options: [
				{ name: '1024x1024 (Square)', value: '1024x1024' },
				{ name: '1024x1536 (Portrait)', value: '1024x1536' },
				{ name: '1536x1024 (Landscape)', value: '1536x1024' },
			],
			default: '1024x1024',
		},
		{
			displayName: 'Steps',
			name: 'steps',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 8 },
			default: 4,
			description: 'Passos de denoising, de 1 a 8',
		},
	],
});

const promptDescription =
	'Até 512 tokens: o que passar disso é cortado em silêncio. Vazio = usa o prompt configurado na chave.';

const generateImageProperties: INodeProperties[] = [
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		placeholder: 'Uma camisa branca dobrada sobre uma mesa de madeira',
		displayOptions: show('image', ['generate']),
		description: promptDescription,
	},
	{
		displayName: 'Put Output Image in Field',
		name: 'outputBinaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		displayOptions: show('image', ['generate']),
		description: 'Campo binário do item de saída que recebe o PNG',
	},
	imageOptions('generate'),
];

const editImageProperties: INodeProperties[] = [
	{
		displayName: 'Input Binary Field(s)',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		placeholder: 'data',
		displayOptions: show('image', ['edit']),
		description:
			'Campo binário com a imagem de referência. Até 4: separe os campos por vírgula (PNG, JPEG ou WEBP, 5 MB cada).',
	},
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		placeholder: 'Deixe a foto em preto e branco',
		displayOptions: show('image', ['edit']),
		description: promptDescription,
	},
	{
		displayName: 'Put Output Image in Field',
		name: 'outputBinaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		displayOptions: show('image', ['edit']),
		description: 'Campo binário do item de saída que recebe o PNG',
	},
	imageOptions('edit'),
];

// ---------- Document → Generate PDF ----------

const generatePdfProperties: INodeProperties[] = [
	{
		displayName: 'Source',
		name: 'source',
		type: 'options',
		displayOptions: show('document', ['generatePdf']),
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
		displayOptions: show('document', ['generatePdf']),
		description: 'Campo binário do item de saída que recebe o PDF',
	},
	{
		displayName: 'Options',
		name: 'generateOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('document', ['generatePdf']),
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
];

export const stacProperties: INodeProperties[] = [
	...resourceProperties,
	...operationProperties,
	...modelProperty([
		['text', 'message'],
		['image', 'analyze'],
	]),
	...messageProperties,
	...analyzeProperties,
	...extractProperties,
	...generateImageProperties,
	...editImageProperties,
	...generatePdfProperties,
];
