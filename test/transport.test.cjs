'use strict';
// Roda sobre o dist compilado: `npm test` faz o build antes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { NodeApiError } = require('n8n-workflow');

const { parseRetryAfterMs, retryDelayMs, headerValue, stacRequest, RETRY_BUDGET_MS } = require(
	path.join(__dirname, '..', 'dist', 'nodes', 'Stac', 'transport.js'),
);

test('parseRetryAfterMs: segundos, data HTTP e lixo', () => {
	const now = Date.parse('2026-01-01T00:00:00Z');
	assert.equal(parseRetryAfterMs('60', now), 60_000);
	assert.equal(parseRetryAfterMs(' 0 ', now), 0);
	assert.equal(parseRetryAfterMs(['120', '5'], now), 120_000);
	assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT', now), 30_000);
	assert.equal(parseRetryAfterMs('Wed, 31 Dec 2025 23:59:00 GMT', now), undefined); // passado
	for (const bad of [
		undefined,
		null,
		'',
		'abc',
		'-5',
		'1.5',
		'1e3',
		'Infinity',
		'NaN',
		'99999999999',
	]) {
		assert.equal(parseRetryAfterMs(bad, now), undefined, `valor ${String(bad)}`);
	}
});

test('retryDelayMs: status, header e orçamento', () => {
	assert.equal(retryDelayMs(503, '60', 0), 60_000);
	assert.equal(retryDelayMs(503, '120', 0), 120_000);
	assert.equal(retryDelayMs(429, '2', 0), 2_000);
	assert.equal(retryDelayMs(429, '3600', 0), undefined); // quota diária: falha na hora
	assert.equal(retryDelayMs(503, undefined, 0), undefined); // sem header
	assert.equal(retryDelayMs(503, 'xyz', 0), undefined);
	assert.equal(retryDelayMs(500, '5', 0), undefined);
	assert.equal(retryDelayMs(502, '5', 0), undefined);
	assert.equal(retryDelayMs(503, '120', 61_000), undefined); // 61 + 120 > 180
	assert.equal(retryDelayMs(503, '120', RETRY_BUDGET_MS - 120_000), 120_000);
});

test('headerValue: sem depender da caixa', () => {
	assert.equal(headerValue({ 'Retry-After': '5' }, 'retry-after'), '5');
	assert.equal(headerValue({ 'retry-after': 7 }, 'retry-after'), '7');
	assert.equal(headerValue(new Headers({ 'Retry-After': '9' }), 'retry-after'), '9');
	assert.equal(headerValue(undefined, 'retry-after'), undefined);
});

function fakeCtx(responses, { signal } = {}) {
	const calls = [];
	return {
		calls,
		getCredentials: async () => ({ baseUrl: 'http://stac.local/v1/', apiKey: 'k' }),
		getNode: () => ({ name: 'Stac', type: 'stac', typeVersion: 1, parameters: {} }),
		getExecutionCancelSignal: () => signal,
		helpers: {
			httpRequestWithAuthentication: async function (_cred, opts) {
				calls.push(opts);
				const next = responses.shift();
				if (!next) throw new Error('fila de respostas vazia');
				return next;
			},
		},
	};
}

const json = (obj) => Buffer.from(JSON.stringify(obj));

test('stacRequest: 503 + Retry-After 1 e depois 200 => repete e devolve o corpo', async () => {
	const body = Buffer.from('{"x":1}');
	const ctx = fakeCtx([
		{
			statusCode: 503,
			headers: { 'retry-after': '1' },
			body: json({ detail: 'Sua máquina está sendo iniciada' }),
		},
		{ statusCode: 200, headers: {}, body: Buffer.from('ok') },
	]);
	const t0 = Date.now();
	const out = await stacRequest.call(ctx, 0, { method: 'POST', path: '/chat/completions', body });
	assert.equal(out.toString(), 'ok');
	assert.equal(ctx.calls.length, 2);
	assert.ok(Date.now() - t0 >= 950, 'esperou o Retry-After');
	assert.equal(ctx.calls[0].url, 'http://stac.local/v1/chat/completions');
	assert.strictEqual(ctx.calls[1].body, body);
});

test('stacRequest: 503 sem Retry-After => NodeApiError depois de 1 chamada', async () => {
	const ctx = fakeCtx([
		{ statusCode: 503, headers: {}, body: json({ detail: 'máquina indisponível' }) },
	]);
	await assert.rejects(
		stacRequest.call(ctx, 0, { method: 'POST', path: '/x' }),
		(e) =>
			e instanceof NodeApiError && e.message === 'máquina indisponível' && e.httpCode === '503',
	);
	assert.equal(ctx.calls.length, 1);
});

test('stacRequest: 429 com Retry-After 3600 (quota) => falha na hora', async () => {
	const ctx = fakeCtx([
		{ statusCode: 429, headers: { 'Retry-After': '3600' }, body: json({ detail: 'quota diária' }) },
	]);
	const t0 = Date.now();
	await assert.rejects(
		stacRequest.call(ctx, 0, { method: 'POST', path: '/x' }),
		(e) => e.message === 'quota diária',
	);
	assert.equal(ctx.calls.length, 1);
	assert.ok(Date.now() - t0 < 500);
});

test('stacRequest: execução cancelada durante a espera => lança o erro do 503', async () => {
	const ac = new AbortController();
	const ctx = fakeCtx(
		[
			{
				statusCode: 503,
				headers: { 'retry-after': '60' },
				body: json({ detail: 'Sua máquina está sendo iniciada' }),
			},
			{ statusCode: 200, headers: {}, body: Buffer.from('nunca') },
		],
		{ signal: ac.signal },
	);
	setTimeout(() => ac.abort(), 200);
	const t0 = Date.now();
	await assert.rejects(
		stacRequest.call(ctx, 0, { method: 'POST', path: '/x' }),
		(e) => e instanceof NodeApiError && e.message === 'Sua máquina está sendo iniciada',
	);
	assert.equal(ctx.calls.length, 1);
	assert.ok(Date.now() - t0 < 2_000, 'parou na fatia seguinte, sem esperar os 60 s');
});
