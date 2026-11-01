'use strict';
// Stac Chat Model contra um servidor HTTP local, com o supplyModel real do
// @n8n/ai-node-sdk instalado. Roda sobre o dist (npm test faz o build antes).
// O proxy do ambiente não pode interceptar 127.0.0.1.
for (const k of [
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'http_proxy',
	'https_proxy',
	'ALL_PROXY',
	'all_proxy',
])
	delete process.env[k];

// Teste hermético: o tracing do n8n tenta baixar o encoder do tiktoken
// (tiktoken.pages.dev), o que sem rede pode travar por minutos. Só o mock local passa.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	if (!/^http:\/\/127\.0\.0\.1[:/]/.test(url)) {
		return Promise.reject(new TypeError(`rede bloqueada no teste: ${url}`));
	}
	return realFetch(input, init);
};

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { LmChatStac } = require(
	path.join(__dirname, '..', 'dist', 'nodes', 'LmChatStac', 'LmChatStac.node.js'),
);

const completion = (content) => ({
	id: 'x',
	object: 'chat.completion',
	created: 1,
	model: 'm',
	choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

function sse(res, content) {
	res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
	const chunk = (delta, finish = null) => ({
		id: 'x',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'm',
		choices: [{ index: 0, delta, finish_reason: finish }],
	});
	res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
	res.write(`data: ${JSON.stringify(chunk({ content }))}\n\n`);
	res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
	res.write(
		`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
	);
	res.end('data: [DONE]\n\n');
}

// script: lista de respostas por hit; 'ok' responde 200 (JSON ou SSE conforme o pedido).
async function withServer(script, fn) {
	let hits = 0;
	const streams = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			const step = script[hits] ?? script[script.length - 1];
			hits++;
			const body = JSON.parse(raw || '{}');
			streams.push(Boolean(body.stream));
			if (step === 'ok') {
				if (body.stream) return sse(res, 'ola');
				res.writeHead(200, { 'content-type': 'application/json' });
				return res.end(JSON.stringify(completion('ola')));
			}
			const headers = { 'content-type': 'application/json' };
			if (step.retryAfter !== undefined) headers['retry-after'] = step.retryAfter;
			res.writeHead(step.status, headers);
			res.end(JSON.stringify({ detail: step.detail ?? 'Sua máquina está sendo iniciada' }));
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		return await fn(`http://127.0.0.1:${server.address().port}/v1`, () => hits, streams);
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
}

function fakeCtx(baseUrl, options) {
	const target = {
		getCredentials: async () => ({ baseUrl, apiKey: 'k' }),
		getNodeParameter: (name, _i, fallback) =>
			name === 'model' ? 'm' : name === 'options' ? options : fallback,
		getNode: () => ({
			name: 'Stac Chat Model',
			type: 'lmChatStac',
			typeVersion: 1,
			parameters: {},
		}),
		getExecutionCancelSignal: () => undefined,
		// usados pelo callback de tracing do n8n
		addInputData: () => ({ index: 0 }),
		addOutputData: () => undefined,
		getInputData: () => [],
		getExecutionId: () => 'test',
		getWorkflow: () => ({ id: 'w', name: 'w', active: false }),
		helpers: { getSecureEgressFilter: () => 'disabled' },
	};
	return new Proxy(target, { get: (t, k) => (k in t ? t[k] : () => undefined) });
}

async function model(baseUrl, options = {}) {
	const { response } = await new LmChatStac().supplyData.call(fakeCtx(baseUrl, options), 0);
	return response;
}

for (const streaming of [false, true]) {
	test(`503 + Retry-After 1 duas vezes e depois 200 => sucesso com 3 hits (streaming=${streaming})`, async () => {
		await withServer(
			[{ status: 503, retryAfter: '1' }, { status: 503, retryAfter: '1' }, 'ok'],
			async (url, hits, streams) => {
				const m = await model(url);
				// O node liga streaming; aqui testamos os dois caminhos. No @langchain/openai
				// 1.x quem monta a request é o submodelo `completions`.
				if (!streaming) {
					m.streaming = false;
					if (m.completions) m.completions.streaming = false;
				}
				const r = await m.invoke('oi');
				assert.equal(r.content, 'ola');
				assert.equal(hits(), 3);
				assert.deepEqual(
					streams,
					[streaming, streaming, streaming],
					'a request saiu no modo esperado',
				);
			},
		);
	});
}

test('duas chamadas seguidas no mesmo modelo: as duas esperam (orçamento por chamada)', async () => {
	// Entre as chamadas o relógio salta 179,5 s. Se o orçamento de 180 s fosse
	// contado desde a primeira falha da instância (e não por chamada), a segunda
	// espera de 1 s estouraria o orçamento e a chamada falharia.
	const realNow = Date.now;
	let offset = 0;
	Date.now = () => realNow() + offset;
	try {
		await withServer(
			[{ status: 503, retryAfter: '1' }, 'ok', { status: 503, retryAfter: '1' }, 'ok'],
			async (url, hits) => {
				const m = await model(url);
				assert.equal((await m.invoke('oi')).content, 'ola');
				assert.equal(hits(), 2);
				offset = 179_500;
				assert.equal((await m.invoke('oi de novo')).content, 'ola');
				assert.equal(hits(), 4);
			},
		);
	} finally {
		Date.now = realNow;
	}
});

test('503 sem Retry-After => falha com 1 hit', async () => {
	await withServer([{ status: 503, detail: 'máquina indisponível' }, 'ok'], async (url, hits) => {
		const m = await model(url);
		await assert.rejects(m.invoke('oi'));
		assert.equal(hits(), 1);
	});
});

test('429 com Retry-After 3600 (quota) => falha na hora com 1 hit', async () => {
	await withServer(
		[{ status: 429, retryAfter: '3600', detail: 'quota' }, 'ok'],
		async (url, hits) => {
			const m = await model(url);
			const t0 = Date.now();
			await assert.rejects(m.invoke('oi'));
			assert.equal(hits(), 1);
			assert.ok(Date.now() - t0 < 3_000);
		},
	);
});
