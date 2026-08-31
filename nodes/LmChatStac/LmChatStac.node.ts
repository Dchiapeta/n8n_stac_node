import { supplyModel } from '@n8n/ai-node-sdk';
import {
	NodeConnectionTypes,
	type ILoadOptionsFunctions,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

type ModelOptions = {
	temperature?: number;
	maxTokens?: number;
	timeout?: number;
	maxRetries?: number;
};

export class LmChatStac implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stac Chat Model',
		name: 'lmChatStac',
		icon: 'file:../../icons/stac.svg',
		group: ['transform'],
		version: [1],
		description: 'Modelos open-source com preço fixo mensal via Stac',
		subtitle: '={{ $parameter.model }}',
		defaults: { name: 'Stac Chat Model' },
		codex: {
			categories: ['assistant'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [{ url: 'https://trystac.com/docs' }],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [{ name: 'stacApi', required: true }],
		properties: [
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getModels' },
				default: '',
				required: true,
				description:
					'Modelo disponível no seu plano Stac. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
						default: 0.7,
						description:
							'Controla a aleatoriedade: valores menores geram respostas mais determinísticas e repetitivas',
					},
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						type: 'number',
						default: 2048,
						description: 'Número máximo de tokens gerados na resposta',
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 120000,
						description:
							'Tempo máximo de espera em milissegundos. Em saturação a Stac degrada velocidade, então valores baixos podem cortar respostas válidas.',
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						default: 2,
						description: 'Número máximo de tentativas em caso de falha',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('stacApi');

				const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'stacApi', {
					method: 'GET',
					url: `${credentials.baseUrl as string}/models`,
					json: true,
				})) as { data?: Array<{ id: string }> };

				return (response.data ?? []).map((model) => ({
					name: model.id,
					value: model.id,
				}));
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('stacApi');
		const model = this.getNodeParameter('model', itemIndex) as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as ModelOptions;

		return supplyModel(this, {
			type: 'openai',
			baseUrl: credentials.baseUrl as string,
			apiKey: credentials.apiKey as string,
			model,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
			timeout: options.timeout,
			maxRetries: options.maxRetries,
		});
	}
}
