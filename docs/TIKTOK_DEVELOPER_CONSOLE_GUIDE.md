# TikTok Developers — Guia Completo de Configuração

> Para o app **autoreels-web** (produção: `https://autoreels.cunhov.site`)
> **Branch:** `feat/tiktok-posting` (merged em `fixes-monolith@9242e7a`) · Integração implementada em A1–A5.

---

## 0. Resumo do que o app espera

| Variável (VPS `.env`) | Valor que o app lê | Uso |
| --- | --- | --- |
| `TIKTOK_CLIENT_KEY` | **Client Key** do app TikTok | `authorize` (client_key) |
| `TIKTOK_CLIENT_SECRET` | **Client Secret** | troca code→token, refresh |
| `TIKTOK_REDIRECT_URI` | `https://autoreels.cunhov.site/api/tiktok/oauth/callback` | whitelist OAuth + destino do redirect |

Scopes pedidos pelo app: `user.info.basic` (identidade/open_id) + `video.publish` (postagem). Tokens e open_id ficam em `Channel.settings` (JSON), nunca no client (mascarados).

---

## 1. Criar conta + organização

1. Acesse **<https://developers.tiktok.com/signup>** e crie a conta de **desenvolvedor** com seu e-mail (login também aceita conta TikTok normal).
2. Recomendado: crie (ou entre em) uma **organização** — **<https://developers.tiktok.com/orgs>** (ou painel → Organizations → Create). Não é obrigatório, mas apps reais ficam melhor sob organização.
   - *Pré-requisito real do TikTok: você precisa de uma conta TikTok com pelo menos 1 vídeo publicado para usar Direct Post (o próprio criador valida ao conectar). Se sua conta for nova sem vídeo, grave/ative um vídeo antes de testar o OAuth.*

---

## 2. Registrar o app

1. Faça login em **<https://developers.tiktok.com>**.
2. Clique no ícone de perfil (canto superior) → **Manage apps** → **<https://developers.tiktok.com/apps>**.
3. Clique em **Connect an app**.
4. **Select the app owner:** escolha a organização criada (ou conta individual) → **Confirm**.
5. Preencha a página do app:

### App details

- **App name:** `Autoreels` (ou algo descritivo)
- **App description:** "Ferramenta de agendamento e publicação automática de vídeos para TikTok/YouTube/Instagram."
- **Logo:** (opcional) imagem do app.

### Platforms (na aba App details)

- Selecione **Web**.
- **Web URL:**
  - **Website URL:** `https://autoreels.cunhov.site`
  - **Redirect URI:** `https://autoreels.cunhov.site/api/tiktok/oauth/callback`
  - (Desktop **opcional**: marcar e usar o mesmo site, se quiser.)
- Game = **não**.

> A **Redirect URI deve bater EXATAMENTE** com `TIKTOK_REDIRECT_URI` da VPS, inclusive sem barra final, mesma capitalização.

### Products (aba Products → Add products)

Adicione estes dois produtos:

1. **Login Kit**
   - Configuração Web: Redirect URI `https://autoreels.cunhov.site/api/tiktok/oauth/callback`
   - **Scopes solicitados:** `user.info.basic`, `video.publish` (e `video.upload` se aparecer — marque; hoje o app faz FILE_UPLOAD via Direct Post, que usa `video.publish`).

2. **Content Posting API**
   - **Enable Direct Post** (configuração de postagem direta) — é o que permite publicar no perfil do usuário autorizado.
   - Sem a opção **Direct Post** habilitada, o `video/init` vai falhar com erro de permissão.

### Credentials

Depois de salvar, vá na aba **App details → Credentials** e anote:

- **Client key** → `TIKTOK_CLIENT_KEY`
- **Client secret** → `TIKTOK_CLIENT_SECRET` (revelar — regenera se necessário)

---

## 3. URL properties (verificação de domínio)

> Necessário para qualquer app que use **Content Posting API** (upload URL), e para apps criados após 2024-09-09 (ToS/Privacy/Web URL).

1. No topo da página do app, clique no botão **URL properties** (ícone de cadeado/url).
2. Garanta que está em **Production** e clique **Verify properties**.
3. **Verificação por Domain** (recomendado para cobrir o site todo):
   - Domínio: `autoreels.cunhov.site`
   - Siga o fluxo (arquivo de confirmação ou DNS TXT no painel da Cunhov/Easypanel).
4. **Verificação por URL prefix** (adicional, para o endpoint de upload):
   - URL: `https://autoreels.cunhov.site/api/file/`
   - Baixe o **signature file** fornecido e suba na raiz pública do domínio (via Easypanel/arquivos do `public/` da build) em:
     - `https://autoreels.cunhov.site/api/file/<signature-file-name>`
     - ou coloque na raiz do site (`/public/<nome_do_arquivo>` do Next) e sirva em `https://autoreels.cunhov.site/<nome_do_arquivo>` conforme o que o console pedir.
5. Confirme a verificação no console (fica verde "Verified").

> Isso desbloqueia o **PULL_FROM_URL** (TikTok baixa o vídeo do nosso `/api/file/...`). Sem verificação, o app usa **FILE_UPLOAD** (chunked) — que funciona independente disso; a verificação só habilita o modo mais barato de banda.

---

## 4. ToS / Privacy / Legal URLs (obrigatório p/ review)

Antes da submissão, o console pede:

- **Terms of Service URL** — precisa de página. Sugestão: crie `/termos` e `/privacidade` no app ou use páginas estáticas; o domínio já estará verificado.
  - Ex.: `https://autoreels.cunhov.site/termos`, `https://autoreels.cunhov.site/privacidade`
- Se o app pedir **Company info**, preencha com dados da organização.

---

## 5. Sandbox vs Production + teste

### Sandbox (para desenvolvimento, sem review)

1. No topo da página do app, toggle **Production → Sandbox**.
2. Em Sandbox, a verificação de URL é obrigatória **só para Content Posting API** (já feita acima funciona igual).
3. Adicione **criadores de teste** à lista de Sandbox (usuários TikTok que poderão autorizar o app sem review).
4. Configure `.env` local com `TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI` e conecte um canal de teste no app.

### Produção (quando for live)

- Toggle de volta para **Production** e **submit para review** (aba Production → "Submit for review").
- Enquanto estiver em **Draft/Pending**, tokens de produção não funcionam para criadores reais além dos de teste.

---

## 6. Env na VPS (`autoreels.cunhov.site`)

No painel do app (Easypanel) → variáveis de ambiente:

```bash
TIKTOK_CLIENT_KEY=<client_key_do_console>
TIKTOK_CLIENT_SECRET=<client_secret_do_console>
TIKTOK_REDIRECT_URI=https://autoreels.cunhov.site/api/tiktok/oauth/callback
```

> ⚠️ Se o console usar o caminho separado por traço ou barra (`v2/auth/authorize` está coberto no código), **nada além das 3 variáveis acima é necessário**.

---

## 7. Como conectar um canal TikTok no app (pós-deploy)

1. No app (autoreels), vá em **Canais** → **Adicionar canal** → **TikTok**.
2. O app redireciona para o login TikTok → autorização concede `user.info.basic` + `video.publish`.
3. Callback salva `tiktok_open_id`, tokens e validade em `Channel.settings`.
4. O canal aparece com badge **TikTok** e funciona no planner (isolation TikTok).
5. **Proxy:** se o IP da VPS for bloqueado pela TikTok, setar `proxy_url` no modal do canal (mesmo formato já suportado: `http://user:pass@host:porta`) — o publisher repassa o proxy em todas as chamadas TikTok.

---

## 8. Submissão para review (Produção) — checklist

1. URL properties verificadas (Production mode).
2. ToS + Privacy Policy URLs preenchidas e acessíveis.
3. Platforms: Web com URL + Redirect URI válidos.
4. Products: Login Kit + Content Posting API (Direct Post habilitado) adicionados.
5. (Se usado) Web/Desktop URL preenchida.
6. Clique **Submit for review** → acompanhe status na página (Draft → In Review → Approved/Rejected com comentários na aba Changelog/Review comments).
7. Review típica: dias a semanas. Não bloqueia desenvolvimento (Sandbox cobre).

---

## 9. Teste E2E pós-configuração

1. `GET /api/tiktok/health?channelId=X` → 200 sem expor token.
2. `POST /api/tiktok/creator-info?channelId=X` → retorna `privacy_level_options`, `max_video_post_duration_sec`, flags duet/stitch/comment.
3. Planner TikTok → Criar Short → preencher caption/privacy/toggles → run → `POST /api/tiktok/...` → publish → status published no Post.
4. Library → editar item → Legenda TikTok aparece → grava `caption_tiktok`.
5. Fallback: `tiktok.txt` na pasta da library (case-insensitive) também vira `caption_tiktok`.
6. Erros: vídeo longo demais, título > 2200, token expirado → `failed_reason` PT-BR no Post.

---

## 10. Erros típicos e solução

| Sintoma | Causa | Conserto |
| --- | --- | --- |
| `400 invalid redirect_uri` no OAuth | Redirect URI não confere com o console | Comparar byte a byte com `TIKTOK_REDIRECT_URI` |
| `access_token_invalid` | Token expirou / revogado | App faz refresh automático; reconectar canal se persistir |
| `privacy_not_allowed` | `privacy_level` não está entre `privacy_level_options` do creator | Usar valores do `creator-info` (dropdown já filtra) |
| `video too long` | Duração > `max_video_post_duration_sec` | Validado antes do upload (A5) |
| 429 rate_limit | Limite por app/usuário | App aplica backoff + Retry-After |
| image not allowed | Tentativa de foto em v1 | **v1 só vídeo** — foto/carrossel em fase 2 |
| `Failed to init Direct Post` | Direct Post não habilitado no produto Content Posting API | Ativar "Direct Post" no console (seção 2) |

---

*Gerado em 2026-09-01. Fontes: TikTok for Developers (Use app → Register Your App, Content Posting API Get Started, Media Transfer Guide) + implementação A1–A5 em autoreels-web.*
