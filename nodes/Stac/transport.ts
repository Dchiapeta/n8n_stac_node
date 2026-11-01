import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, JsonObject } from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

export type FilePart = { field: string; fileName: string; mimeType: string; data: Buffer };
export type FieldPart = { field: string; value: string };

// Extração com OCR de PDF escaneado e geração de imagem levam minutos: o
// servidor corta antes disso, então o cliente espera um pouco mais para o erro
// que chega ser o do servidor, com mensagem útil, e não um timeout cru daqui.
export const REQUEST_TIMEOUT_MS = 300_000;

// Multipart montado à mão: o pacote não pode ter dependência de runtime, e o
// corpo como Buffer com boundary explícito não depende de como a versão do n8n
// serializa FormData no httpRequest.
export function buildMultipart(parts: Array<FilePart | FieldPart>): {
	body: Buffer;
	boundary: string;
} {
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

export function toBuffer(body: unknown): Buffer {
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	if (typeof body === 'string') return Buffer.from(body, 'utf8');
	return Buffer.from(JSON.stringify(body ?? null), 'utf8');
}

export function parseJson(body: unknown): unknown {
	if (
		body !== null &&
		typeof body === 'object' &&
		!Buffer.isBuffer(body) &&
		!ArrayBuffer.isView(body) &&
		!(body instanceof ArrayBuffer)
	) {
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
// validações de campo); as rotas de imagem também usam `{ "error": { "message" } }`.
// Vira a mensagem do erro do node, que é o que o usuário lê.
export function errorMessage(payload: unknown, statusCode: number): string {
	if (payload && typeof payload === 'object') {
		const { detail, error } = payload as IDataObject;
		if (typeof detail === 'string') return detail;
		if (Array.isArray(detail)) {
			return detail
				.map((d) => (d && typeof d === 'object' ? String((d as IDataObject).msg ?? '') : String(d)))
				.filter(Boolean)
				.join('; ');
		}
		if (error && typeof error === 'object' && typeof (error as IDataObject).message === 'string') {
			return (error as IDataObject).message as string;
		}
	}
	if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 500);
	return `A API da Stac respondeu ${statusCode}`;
}

// Auto-wake e provisionamento: sem máquina de pé, o gateway religa ou cria o
// pod e responde 503 com Retry-After (60 waking, 120 provisioning/recreating,
// 30 preparing, 15 agent_starting, 5 capacity) contando com o retry do cliente.
// O 429 de rate-limit/concorrência também traz Retry-After. Regra única, usada
// pelos dois nodes: repetir SÓ 429/503 que trazem Retry-After legível e cuja
// espera cabe no que sobra do orçamento. Sem o header (ex.: 503 "máquina
// indisponível" depois do proxy), ilegível ou longo demais (a quota diária, 429
// com Retry-After 3600) falha na hora, com a mensagem do gateway.
// Repetir é seguro porque, no gateway atual, todo 429/503 com Retry-After é uma
// recusa sem processamento: a maioria sai antes do proxy, e o 429 de fila cheia
// de imagem vem do pod, que recusou sem processar (o gateway só reconstrói o
// Retry-After). Se o gateway passar a pôr Retry-After num erro que sai DEPOIS
// de processar, isto vira request duplicada (imagem, PDF, extração).
export const RETRY_BUDGET_MS = 180_000;
export const RETRYABLE_STATUS: readonly number[] = [429, 503];
// Trava contra laço infinito com Retry-After: 0.
export const MAX_WAIT_ATTEMPTS = 10;
// Fatia máxima de cada sleep: entre fatias olhamos se a execução foi cancelada.
const WAIT_SLICE_MS = 1_000;
// Acima disso o valor é tratado como absurdo (e de qualquer forma estoura o orçamento).
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Retry-After em ms: inteiro decimal >= 0 ou data HTTP no futuro; o resto vira undefined. */
export function parseRetryAfterMs(
	value: string | string[] | null | undefined,
	now: number = Date.now(),
): number | undefined {
	const raw = Array.isArray(value) ? value[0] : value;
	if (typeof raw !== 'string') return undefined;
	const text = raw.trim();
	if (!text) return undefined;
	let ms: number;
	if (/^\d+$/.test(text)) {
		ms = Number(text) * 1000;
	} else {
		// Data HTTP (IMF-fixdate e afins): precisa ter letras, para "1.5" ou "-3"
		// não virarem datas no Date.parse.
		if (!/[a-z]/i.test(text)) return undefined;
		const at = Date.parse(text);
		if (!Number.isFinite(at)) return undefined;
		ms = at - now;
		if (ms < 0) return undefined;
	}
	if (!Number.isFinite(ms) || ms < 0 || ms > MAX_RETRY_AFTER_MS) return undefined;
	return ms;
}

/**
 * Quanto esperar antes de repetir, ou undefined para falhar na hora.
 * `elapsedMs` é o tempo já gasto desde a primeira falha desta chamada.
 */
export function retryDelayMs(
	statusCode: number | undefined,
	retryAfter: string | string[] | null | undefined,
	elapsedMs: number,
	now: number = Date.now(),
): number | undefined {
	if (statusCode === undefined || !RETRYABLE_STATUS.includes(statusCode)) return undefined;
	const ms = parseRetryAfterMs(retryAfter, now);
	if (ms === undefined) return undefined;
	if (elapsedMs + ms > RETRY_BUDGET_MS) return undefined;
	return ms;
}

/** Lê um header sem depender da caixa do nome (objeto simples ou Headers). */
export function headerValue(headers: unknown, name: string): string | string[] | undefined {
	if (!headers || typeof headers !== 'object') return undefined;
	const maybeGet = (headers as { get?: unknown }).get;
	if (typeof maybeGet === 'function') {
		const v = (maybeGet as (n: string) => unknown).call(headers, name);
		return typeof v === 'string' ? v : undefined;
	}
	const wanted = name.toLowerCase();
	for (const [key, v] of Object.entries(headers as Record<string, unknown>)) {
		if (key.toLowerCase() !== wanted) continue;
		if (typeof v === 'string') return v;
		if (Array.isArray(v)) return v.map(String);
		if (typeof v === 'number') return String(v);
	}
	return undefined;
}

/**
 * Espera `ms` em fatias, olhando o sinal de cancelamento entre elas.
 * Devolve false se a execução foi cancelada (antes ou durante a espera).
 */
export async function waitUnlessCancelled(
	ms: number,
	getSignal: () => AbortSignal | undefined,
): Promise<boolean> {
	let remaining = ms;
	while (true) {
		if (getSignal()?.aborted) return false;
		if (remaining <= 0) return true;
		const slice = Math.min(remaining, WAIT_SLICE_MS);
		await sleep(slice);
		remaining -= slice;
	}
}

/** Chamada autenticada à API da Stac. Devolve o corpo cru (JSON ou binário). */
export async function stacRequest(
	this: IExecuteFunctions,
	itemIndex: number,
	options: Omit<IHttpRequestOptions, 'url'> & { path: string },
): Promise<Buffer> {
	const credentials = await this.getCredentials('stacApi');
	const baseUrl = String(credentials.baseUrl).replace(/\/+$/, '');
	const { path, ...rest } = options;
	const getSignal = () => {
		try {
			return this.getExecutionCancelSignal?.();
		} catch {
			return undefined;
		}
	};
	let firstFailureAt: number | undefined;
	for (let attempt = 0; ; attempt++) {
		// O corpo (JSON serializado ou multipart) é sempre um Buffer: reenviar é seguro.
		const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'stacApi', {
			timeout: REQUEST_TIMEOUT_MS,
			...rest,
			url: `${baseUrl}${path}`,
			encoding: 'arraybuffer',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		})) as { body: unknown; statusCode: number; headers?: unknown };
		if (response.statusCode < 400) return toBuffer(response.body);

		const payload = parseJson(response.body);
		const error = new NodeApiError(
			this.getNode(),
			(payload && typeof payload === 'object' ? payload : { detail: payload }) as JsonObject,
			{
				itemIndex,
				httpCode: String(response.statusCode),
				message: errorMessage(payload, response.statusCode),
			},
		);
		const now = Date.now();
		firstFailureAt ??= now;
		const delay =
			attempt < MAX_WAIT_ATTEMPTS
				? retryDelayMs(
						response.statusCode,
						headerValue(response.headers, 'retry-after'),
						now - firstFailureAt,
						now,
					)
				: undefined;
		if (delay === undefined) throw error;
		// Cancelada no meio da espera: o erro é o do gateway, não um genérico.
		if (!(await waitUnlessCancelled(delay, getSignal))) throw error;
	}
}

export async function stacJson(
	this: IExecuteFunctions,
	itemIndex: number,
	options: Omit<IHttpRequestOptions, 'url'> & { path: string },
): Promise<IDataObject> {
	return parseJson(await stacRequest.call(this, itemIndex, options)) as IDataObject;
}
