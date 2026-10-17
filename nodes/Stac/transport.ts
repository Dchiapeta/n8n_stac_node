import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

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

/** Chamada autenticada à API da Stac. Devolve o corpo cru (JSON ou binário). */
export async function stacRequest(
	this: IExecuteFunctions,
	itemIndex: number,
	options: Omit<IHttpRequestOptions, 'url'> & { path: string },
): Promise<Buffer> {
	const credentials = await this.getCredentials('stacApi');
	const baseUrl = String(credentials.baseUrl).replace(/\/+$/, '');
	const { path, ...rest } = options;
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'stacApi', {
		timeout: REQUEST_TIMEOUT_MS,
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
}

export async function stacJson(
	this: IExecuteFunctions,
	itemIndex: number,
	options: Omit<IHttpRequestOptions, 'url'> & { path: string },
): Promise<IDataObject> {
	return parseJson(await stacRequest.call(this, itemIndex, options)) as IDataObject;
}
