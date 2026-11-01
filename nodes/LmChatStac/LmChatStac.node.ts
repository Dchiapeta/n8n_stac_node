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
import {
	MAX_WAIT_ATTEMPTS,
	headerValue,
	retryDelayMs,
	waitUnlessCancelled,
} from '../Stac/transport';

type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

type ModelOptions = {
	temperature?: number;
	maxTokens?: number;
	reasoningEffort?: ReasoningEffort;
	timeout?: number;
	maxRetries?: number;
};

// "Options" é uma collection: enquanto o usuário não ADICIONA a opção, ela não
// existe no objeto e o `default` declarado na UI nunca chega a ser lido. Sem
// este fallback a request sai sem max_tokens e quem decide o teto é o servidor
// — com thinking ligado, milhares de tokens de raciocínio para uma resposta de
// duas linhas. O mesmo número nos dois lugares para a UI não mentir sobre o
// valor efetivo.
const DEFAULT_MAX_TOKENS = 2048;

// Abaixo do piso do gateway (8000) o max_tokens só é seguro com o thinking
// desligado: com raciocínio pedido, o gateway respeita o teto baixo e o
// raciocínio é cortado no meio — resposta vazia. Então, com low/medium/high e
// sem Max Tokens explícito, a request sai SEM max_tokens e vale o piso.
function resolveMaxTokens(options: ModelOptions): number | undefined {
	if (options.maxTokens !== undefined) return options.maxTokens;
	if (options.reasoningEffort && options.reasoningEffort !== 'none') return undefined;
	return DEFAULT_MAX_TOKENS;
}

// Espera pelo 503/429 + Retry-After do gateway (auto-wake/provisionamento),
// com a mesma regra do node Stac (ver transport.ts).
//
// Por que um patch no AsyncCaller e não `onFailedAttempt` no supplyModel: o
// handler do @n8n/ai-utilities (makeN8nLlmFailedAttemptHandler) só deixa
// repetir quando `error.retriesLeft > 0`, mas o p-retry das versões testadas
// passa retriesLeft no contexto, não no erro, e o AsyncCaller repassa só o
// erro. Resultado: lança na primeira falha, com qualquer Max Retries; um
// handler nosso passado ao supplyModel roda dentro desse wrapper e não muda
// isso. O LangChain põe maxRetries: 0 no SDK da OpenAI, então o Retry-After
// também não é lido lá. O ChatOpenAI 1.x delega para os submodelos
// `completions`/`responses`, cada um com o seu caller: os três são embrulhados.
//
// Tudo é defensivo: se a estrutura do LangChain do n8n hospedeiro for outra
// (campos ausentes), nada é embrulhado e o comportamento fica como antes.
const PATCHED = Symbol.for('n8n-nodes-stac.retryAfterPatched');
const CALL_STATE = Symbol.for('n8n-nodes-stac.retryAfterCallState');

type CallState = { firstFailureAt?: number; waits: number };
type FailedAttemptHandler = (error: unknown) => unknown;
type PatchableCaller = {
	onFailedAttempt?: FailedAttemptHandler;
	call?: (callable: (...args: unknown[]) => unknown, ...args: unknown[]) => unknown;
	callWithOptions?: (
		options: unknown,
		callable: (...args: unknown[]) => unknown,
		...args: unknown[]
	) => unknown;
	[PATCHED]?: boolean;
};

// Estado por chamada do modelo: o caller é da instância e é reaproveitado em
// todas as chamadas de um AI Agent (loop de tools), então o orçamento não pode
// viver no caller. O callable de cada call() é embrulhado para carimbar no
// erro o estado daquela chamada; o onFailedAttempt só recebe o erro.
function tagErrors(
	callable: (...args: unknown[]) => unknown,
	state: CallState,
): (...args: unknown[]) => Promise<unknown> {
	return async (...args: unknown[]) => {
		try {
			return await callable(...args);
		} catch (error) {
			if (error && typeof error === 'object' && !(CALL_STATE in error)) {
				try {
					Object.defineProperty(error, CALL_STATE, { value: state, enumerable: false });
				} catch {
					// erro congelado: sem carimbo, cai no handler original
				}
			}
			// Repassa o erro original de propósito: isto roda dentro do AsyncCaller,
			// e o p-retry/LangChain/handler do n8n precisam do erro cru (status,
			// headers). Quem converte em NodeApiError é o handler do n8n mais adiante.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw error;
		}
	};
}

function patchCaller(caller: unknown, getSignal: () => AbortSignal | undefined): void {
	try {
		if (!caller || typeof caller !== 'object') return;
		const c = caller as PatchableCaller;
		if (c[PATCHED]) return;
		const original = c.onFailedAttempt;
		const originalCall = c.call;
		if (typeof original !== 'function' || typeof originalCall !== 'function') return;
		const originalCallWithOptions = c.callWithOptions;

		c.call = function (callable, ...args) {
			if (typeof callable !== 'function') return originalCall.call(this, callable, ...args);
			return originalCall.call(this, tagErrors(callable, { waits: 0 }), ...args);
		};
		if (typeof originalCallWithOptions === 'function') {
			c.callWithOptions = function (options, callable, ...args) {
				if (typeof callable !== 'function') {
					return originalCallWithOptions.call(this, options, callable, ...args);
				}
				return originalCallWithOptions.call(
					this,
					options,
					tagErrors(callable, { waits: 0 }),
					...args,
				);
			};
		}
		c.onFailedAttempt = async function (error: unknown) {
			const state =
				error && typeof error === 'object'
					? ((error as { [CALL_STATE]?: CallState })[CALL_STATE] ?? undefined)
					: undefined;
			if (state && state.waits < MAX_WAIT_ATTEMPTS) {
				const e = error as { status?: unknown; headers?: unknown };
				const status = typeof e.status === 'number' ? e.status : undefined;
				const now = Date.now();
				const elapsed = state.firstFailureAt === undefined ? 0 : now - state.firstFailureAt;
				const delay = retryDelayMs(status, headerValue(e.headers, 'retry-after'), elapsed, now);
				if (delay !== undefined) {
					state.firstFailureAt ??= now;
					state.waits++;
					// Retornar sem lançar faz o p-retry tentar de novo (até o Max
					// Retries do caller). Cancelada: segue o handler original.
					if (await waitUnlessCancelled(delay, getSignal)) return;
				}
			}
			return original.call(this, error);
		};
		c[PATCHED] = true;
	} catch {
		// Nunca quebrar o node por causa do patch.
	}
}

function patchRetryAfter(model: unknown, getSignal: () => AbortSignal | undefined): void {
	try {
		if (!model || typeof model !== 'object') return;
		const m = model as {
			caller?: unknown;
			completions?: { caller?: unknown };
			responses?: { caller?: unknown };
		};
		patchCaller(m.caller, getSignal);
		patchCaller(m.completions?.caller, getSignal);
		patchCaller(m.responses?.caller, getSignal);
	} catch {
		// idem
	}
}

export class LmChatStac implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stac Chat Model',
		name: 'lmChatStac',
		icon: { light: 'file:../../icons/stac-logo.svg', dark: 'file:../../icons/stac-logo.dark.svg' },
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
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						default: 2,
						description: 'Número máximo de tentativas em caso de falha',
					},
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						type: 'number',
						default: DEFAULT_MAX_TOKENS,
						description:
							'Teto de tokens da resposta, não uma meta de geração. Sem esta opção: 2048, ou o piso do servidor (8000) quando Reasoning Effort é Low, Medium ou High. Com raciocínio ligado, valores abaixo de 8000 podem cortar o raciocínio no meio.',
					},
					{
						displayName: 'Reasoning Effort',
						name: 'reasoningEffort',
						type: 'options',
						options: [
							{
								name: 'None',
								value: 'none',
								description: 'Responde direto, sem etapa de raciocínio',
							},
							{ name: 'Low', value: 'low', description: 'Raciocínio curto' },
							{ name: 'Medium', value: 'medium', description: 'Raciocínio moderado' },
							{
								name: 'High',
								value: 'high',
								description: 'Raciocínio mais profundo, respostas mais lentas',
							},
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
						description:
							'Controla a aleatoriedade: valores menores geram respostas mais determinísticas e repetitivas',
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 120000,
						description:
							'Tempo máximo de espera em milissegundos. Em saturação a Stac degrada velocidade, então valores baixos podem cortar respostas válidas.',
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

		const supplied = supplyModel(this, {
			type: 'openai',
			baseUrl: credentials.baseUrl as string,
			apiKey: credentials.apiKey as string,
			model,
			temperature: options.temperature,
			maxTokens: resolveMaxTokens(options),
			// Via additionalParams (modelKwargs) e não `reasoning`: o LangChain só
			// envia `reasoning` para nomes de modelo da OpenAI (o1, gpt-5...) e o
			// descartaria em silêncio para os modelos da Stac.
			additionalParams: options.reasoningEffort
				? { reasoning_effort: options.reasoningEffort }
				: undefined,
			streaming: true,
			streamUsage: true,
			timeout: options.timeout,
			maxRetries: options.maxRetries,
		});
		const getSignal = () => {
			try {
				return this.getExecutionCancelSignal?.();
			} catch {
				return undefined;
			}
		};
		patchRetryAfter(supplied.response, getSignal);
		return supplied;
	}
}
