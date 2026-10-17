# Changelog

## 1.4.0 — 2026-10-17

- Node **Stac** reorganizado no formato do node da OpenAI, com todas as rotas da API:
  - **Text → Message a model** (`/chat/completions`): lista de mensagens, modelo carregado
    do `/models` (vazio = modelo da stack), Max Tokens, Output JSON, Reasoning Effort,
    Temperature e Top P.
  - **Image → Analyze image** (chat com imagem, de campo binário ou URL baixada pelo n8n),
    **Edit image** (`/images/edits`, até 4 referências), **Extract data from an image**
    (`/images/extract`) e **Generate an image** (`/images/generations`). Imagem gerada sai
    em campo binário; seed tratada como texto para não perder dígitos acima de 2^53.
  - **Document → Extract data** e **Generate a PDF** (como na 1.3.0).
  - **Model → List models** (`/models`, um item por modelo).
- Versão do node 1.1. A 1 mantém Document como resource padrão, então workflows salvos
  na 1.3.0 abrem iguais; nodes novos começam em Text.
- Código do node separado em `descriptions.ts` (parâmetros) e `transport.ts` (requests,
  multipart e erros).

## 1.3.0 — 2026-10-17

- Novo node **Stac** (node normal, resource **Document**):
  - **Extract Data**: PDF ou imagem do campo binário → JSON validado pelo schema, via
    `/v1/documents/extract` ou `/v1/images/extract` (detectado pelo MIME type). Vários
    arquivos numa extração com campos separados por vírgula (Pro em diante).
    **Simplify Output** devolve só os campos extraídos.
  - **Generate PDF**: `/v1/documents/generate` a partir de HTML pronto ou de uma
    instrução para o modelo; o PDF sai num campo binário.
  - Erros da API chegam com a mensagem dela (`detail`) e o status HTTP.
- Ícones renomeados para `icons/stac-logo.svg` e `icons/stac-logo.dark.svg`. A variante
  clara mantinha o caminho da 0.1.0 (`icons/stac.svg`), e o n8n continuava mostrando o
  logo antigo em cache; com o nome novo a URL do ícone muda.

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
