import { ChatOpenAI } from '@langchain/openai';
import {
  NodeConnectionTypes,
  type ILoadOptionsFunctions,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type SupplyData,
} from 'n8n-workflow';

export class LmChatStac implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Stac Chat Model',
    name: 'lmChatStac',
    icon: 'file:stac.svg',
    group: ['transform'],
    version: 1,
    description: 'Modelos open-source com preço fixo mensal via Stac',
    defaults: { name: 'Stac Chat Model' },
    codex: {
      categories: ['AI'],
      subcategories: {
        AI: ['Language Models'],
        'Language Models': ['Chat Models (Recommended)'],
      },
    },
    inputs: [],
    outputs: [NodeConnectionTypes.AiLanguageModel],
    outputNames: ['Model'],
    credentials: [{ name: 'stacApi', required: true }],
    properties: [
      {
        displayName: 'Model',
        name: 'model',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getModels' },
        default: '',
        required: true,
        description: 'Modelo disponível no seu plano Stac',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Temperature',
            name: 'temperature',
            type: 'number',
            typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
            default: 0.7,
          },
          {
            displayName: 'Max Tokens',
            name: 'maxTokens',
            type: 'number',
            default: 2048,
          },
          {
            displayName: 'Timeout (ms)',
            name: 'timeout',
            type: 'number',
            default: 120000,
            description: 'Tempo máximo de espera. Em saturação a Stac degrada velocidade, então valores baixos podem cortar respostas válidas.',
          },
          {
            displayName: 'Max Retries',
            name: 'maxRetries',
            type: 'number',
            default: 2,
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials('stacApi');

        const response = await this.helpers.httpRequestWithAuthentication.call(
          this,
          'stacApi',
          {
            method: 'GET',
            url: `${credentials.baseUrl}/models`,
            json: true,
          },
        );

        return (response.data ?? []).map((model: { id: string }) => ({
          name: model.id,
          value: model.id,
        }));
      },
    },
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const credentials = await this.getCredentials('stacApi');
    const model = this.getNodeParameter('model', itemIndex) as string;
    const options = this.getNodeParameter('options', itemIndex, {}) as {
      temperature?: number;
      maxTokens?: number;
      timeout?: number;
      maxRetries?: number;
    };

    return {
      response: new ChatOpenAI({
        apiKey: credentials.apiKey as string,
        model,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens,
        timeout: options.timeout ?? 120000,
        maxRetries: options.maxRetries ?? 2,
        configuration: {
          baseURL: credentials.baseUrl as string,
        },
      }),
    };
  }
}