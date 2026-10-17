# Changelog

## 1.2.0 — 2026-10-17

- Nova opção **Reasoning Effort** (`none`, `low`, `medium`, `high`), enviada como
  `reasoning_effort`. Sem a opção adicionada, vale o nível configurado na chave de API.
- Fallback de `Maximum Number of Tokens` ajustado ao raciocínio: com Reasoning Effort
  `low`/`medium`/`high` e sem Max Tokens explícito, a request sai sem `max_tokens` e vale
  o piso do servidor (8000). Com o fallback de 2048 o gateway mantinha o thinking ligado
  e o raciocínio era cortado no meio, devolvendo resposta vazia. Sem Reasoning Effort, ou
  com `none`, o fallback continua 2048.
- Opções do node em ordem alfabética (exigência do lint do `@n8n/node-cli` 0.52).
- Dependências de desenvolvimento alinhadas com o n8n 2.43.7: `@n8n/ai-node-sdk` 0.33.5,
  `n8n-workflow` 2.43.5, `@n8n/node-cli` 0.52.5, `prettier` 3.9.10.
- A 1.1.0 não chegou ao npm (o publish falhou por falta de autenticação); as mudanças dela
  saem nesta versão.

## 1.1.0 — 2026-10-16

- Ícone do node e da credencial trocado pelo logo novo da Stac, com variantes para o tema
  claro e o escuro do n8n.
- `Maximum Number of Tokens` passa a valer mesmo sem a opção adicionada em **Options**
  (fallback 2048). Na 0.1.0 a request saía sem `max_tokens` e o servidor aplicava o piso
  de 8000 com thinking ligado — respostas curtas viravam minutos de raciocínio e morriam
  no timeout do gateway.
- Respostas em streaming (`streaming: true`, com `usage` no último chunk).

## 0.1.0 — 2026-08-31

- Primeira publicação: node **Stac Chat Model** (Language Models → Chat Models).
