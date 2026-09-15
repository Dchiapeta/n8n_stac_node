# Changelog

## 0.1.1 — 2026-09-15

- `Maximum Number of Tokens` passa a valer mesmo sem a opção adicionada em **Options**
  (fallback 2048). Na 0.1.0 a request saía sem `max_tokens` e o servidor aplicava o piso
  de 8000 com thinking ligado — respostas curtas viravam minutos de raciocínio e morriam
  no timeout do gateway.
- Respostas em streaming (`streaming: true`, com `usage` no último chunk).

## 0.1.0 — 2026-08-31

- Primeira publicação: node **Stac Chat Model** (Language Models → Chat Models).
