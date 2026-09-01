# F5 — Título + produtos YT gerados por IA (via OpenRouter)

Decisão do dono: provider **OpenRouter** (API compatível com OpenAI — `POST
https://openrouter.ai/api/v1/chat/completions`), **sem SDKs pesados** — fetch
nativo com timeout. A partir da **descrição já existente** do vídeo
(`youtube_description` do planner / `caption_youtube` da library), o wizard YT
Short ganha o botão **"✨ Gerar título + produtos pela descrição"** que preenche
`youtube_title` + `youtube_products` (nomes para auto-seleção na publicação).

## Como obter a chave

1. Crie conta em https://openrouter.ai/keys (link direto: https://openrouter.ai/keys).
2. Gere uma API Key (basta um pouco de crédito — US$ 1–5 costuma durar muito com
   `gpt-4o-mini`).
3. Copie para `.env` (NUNCA commitada; já está fora do git via `.gitignore`):

```bash
OPENROUTER_API_KEY="sk-or-v1-..."
# Opcional — default barato e estável:
OPENROUTER_MODEL="openai/gpt-4o-mini"
```

O app lê as variáveis do `process.env` **no servidor** (a rota
`/api/ai/suggest` faz autenticação NextAuth e usa `getServerSession`). A chave
nunca é enviada ao browser e nunca aparece em mensagens de erro.

## Variáveis

| Variável             | Obrigatória | Padrão                   | Descrição |
| -------------------- | ----------- | ------------------------ | --------- |
| `OPENROUTER_API_KEY` | sim         | —                        | Chave de API do OpenRouter. Ausente → erro claro 500 no botão orientando a config. |
| `OPENROUTER_MODEL`   | não         | `openai/gpt-4o-mini`     | Modelo compatível OpenAI (lista em https://openrouter.ai/models). |

## Fluxo

1. Wizard YT Short → botão "✨ Gerar título + produtos pela descrição".
2. `POST /api/ai/suggest` `{ "description": <youtube_description || caption_youtube> }`.
3. A rota chama `lib/ai.ts` → `suggestYoutubeFromDescription(desc)`:
   - valida a chave (`OPENROUTER_API_KEY`); sem chave → erro claro em PT-BR;
   - `fetch` nativo com **timeout de 25s** (`AbortController`), header
     `Authorization: Bearer ${key}`;
   - prompt em PT-BR pedindo **JSON estrito** `{"title": "...", "products": ["..."]}`
     (título 1–100 chars; até 5 produtos de afiliado relevantes à descrição);
   - parse robusto: JSON puro → fence ` ```json ` → bloco `{…}` do texto →
     fallback linha-a-linha.
4. Retorna `{ title, products: string[] }`; o wizard preenche
   `youtube_title` com `title` e adiciona cada produto como draft de **nome**
   (`{query}` → auto-seleção na publicação via `/api/shorts/auto`), sem quebrar
   o picker de busca live nem o `youtube_products` fixo existente.

## Erros mapeados (PT-BR, sem expor a chave)

| Condição                   | Status | Mensagem (resumo) |
| -------------------------- | ------ | ------------------ |
| Sem `OPENROUTER_API_KEY`   | 500    | orienta .env + https://openrouter.ai/keys |
| Descrição vazia/ausente    | 400    | "Informe uma descrição…" |
| Timeout (>25s)             | 502    | "demorou mais de 25s — tente novamente" |
| HTTP não-ok do provider    | 502    | "O provedor de IA respondeu com erro: <detail>" |
| Falha de rede              | 502    | "Falha de rede ao chamar o provedor de IA…" |
| Resposta sem JSON         | 502    | "Não foi possível interpretar a resposta da IA…" |
| Não autorizado            | 401    | "Não autorizado." |

## Exemplo de resposta do provider

`POST https://openrouter.ai/api/v1/chat/completions` (body: `model`,
`messages[{system,user}]`, `temperature: 0.7`, `max_tokens: 400`) →

```json
{
  "id": "gen-...",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "{\"title\": \"5 truques de organização que você precisa testar\", \"products\": [\"Caixa organizadora\", \"Etiquetadora portátil\", \"Cesto suspenso\"]}"
      }
    }
  ]
}
```

A rota devolve ao frontend somente `{ "title": "...", "products": ["..."] }`.

## Files

- `lib/ai.ts` — config/validação, chamada fetch com timeout, parse robusto.
- `app/api/ai/suggest/route.ts` — rota autenticada (400/401/500/502 PT-BR).
- `components/PlannerWizard.tsx` — botão + loading/erro inline PT-BR no box YT Short.
- `scripts/gauntlet/ai-suggest.mts` — smoke (fetch mockado): parse de JSON,
  sem chave → erro claro, resposta não-JSON → fallback.

## Smoke

```bash
npx tsx scripts/gauntlet/ai-suggest.mts   # sem rede — fetch mockado
```