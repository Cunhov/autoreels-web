# TikTok Dev Console — Textos Prontos para Copiar (formulário de review)

> Gerado em 2026-09-01 para o app **Autoreels** (`https://autoreels.cunhov.site`).
> Copie os textos nos campos indicados. Todos em inglês (o console/review da TikTok é em inglês).

---

## 1. Basic information

### App icon ✅ (já gerado)

Use o arquivo **`public/tiktok-app-icon.png`** do repositório:

- 1024×1024 px, JPEG/PNG, 94 KB (limite 5 MB)

### App name

```
Autoreels
```

(9/50 — ok, já digitado)

### Category

```
Productivity
```

### Description (≤ 120 chars) — COPIAR (112 chars ✅)

```
Auto-publish scheduled Instagram, YouTube and TikTok posts with captions, affiliate products and smart planners.
```

### Terms of Service URL

```
https://autoreels.cunhov.site/termos
```

### Privacy Policy URL

```
https://autoreels.cunhov.site/privacidade
```

> ✅ Já criei as duas páginas no app (`app/termos/page.tsx`, `app/privacidade/page.tsx`) — **públicas, sem login** (AuthGuard liberado). Ficam ativas após o próximo deploy na VPS.

### Platforms

- **Web** ✅ (único necessário)
- **Web/Desktop URL:**

```
https://autoreels.cunhov.site/
```

---

## 2. Verify URL properties (⚠️ obrigatório antes do submit)

1. No topo da página do app (Production mode), clique **URL properties** → **Verify properties**.
2. Verificação por **URL prefix** (recomendada para cobrir o upload):
   - URL: `https://autoreels.cunhov.site/`
3. A TikTok baixa um **signature file** (ex.: `9254c8d...txt`). Para servir esse arquivo em produção, crie em `public/<nome-do-arquivo>.txt` no app e faça deploy — `https://autoreels.cunhov.site/<nome-do-arquivo>.txt` deve responder 200 com o conteúdo.
4. Clique **Verify** → deve ficar verde "Verified".
5. Repita se pedir para `https://autoreels.cunhov.site/api/file/` (para PULL_FROM_URL) — coloque o signature file em `public/` e sirva na raiz; o caminho exato é o que o console pedir.

---

## 3. Products + Scopes (exatamente estes)

### Products → Add products

1. **Login Kit** — plataforma Web.
2. **Content Posting API** — e dentro dela **habilite "Direct Post"** (opção de postagem direta). Sem o Direct Post, `video/init` falha.

### Scopes → Add scopes

Adicione **somente**:

- `user.info.basic` (identificar o criador ao conectar o canal)
- `video.publish` (publicar os vídeos — usado pelo Direct Post)

> ⚠️ **NÃO adicione** scopes além desses neste primeiro review (cada scope extra precisa ser demonstrado no vídeo; menos scopes = aprovação mais rápida). `video.upload`, `video.list`, `comment.*`, `display.*` ficam para uma futura revisão se precisar.

---

## 4. App review — explanation (≤ 1000 chars, 991 ✅) — COPIAR

```
Autoreels is a content scheduling dashboard. A creator connects their TikTok account once, then schedules video posts that publish automatically at chosen times.

Products and scopes used:

1. Login Kit - scope user.info.basic: when the user clicks "Connect TikTok", they are redirected to TikTok's authorization screen. After approval we store the access/refresh tokens and open_id so the channel appears in the app. No content is published at this step.

2. Content Posting API (Direct Post) - scope video.publish: when a post is due, the app calls video/init/ with FILE_UPLOAD, uploads the chunks, then polls status/fetch/ until the video is live. Before posting, the user sets the title, privacy level (public by default) and optional duet/stitch/comment toggles.

Nothing is posted without an explicit action; the app never reads private videos. The demo video shows the full flow: connect a TikTok channel via OAuth, upload a video, create a TikTok planner, and watch the post publish.
```

## 5. Demo video — roteiro (mp4/mov, ≤50 MB, até 5 arquivos)

**Requisitos obrigatórios** (fail se faltar): domain exibido no vídeo deve ser `autoreels.cunhov.site`; mostrar UI e interações; TODOS os produtos e scopes selecionados demonstrados.

**Gravação (QuickTime: Arquivo → Nova Gravação de Tela, ou OBS):**

1. **Canais** — Abra `https://autoreels.cunhov.site/channels` → "Adicionar canal" → escolha **TikTok** → clique "Conectar TikTok" → mostra a tela de autorização da TikTok (com os scopes `user.info.basic` e `video.publish` listados) → aprovar → o canal TikTok aparece conectado no app (badge TikTok).
2. **Library** — Vá em "Conteúdo" → envie um vídeo MP4 (qualquer, 15–30 s) → aparece na biblioteca.
3. **Planner TikTok** — "Novo planner" → selecione o canal TikTok → preencha título (ex.: "Hello from Autoreels!"), deixe visível o dropdown de privacidade e os toggles duet/stitch/comments → salve.
4. **Publicação** — Rode o planner manualmente ("Run") ou use "Publicar agora" → NO MESMO VÍDEO, abra o perfil TikTok do usuário-test (aba ou segundo monitor) e mostre o vídeo JÁ PUBLICADO com o título.
5. (Opcional, acelera a review) Mostre também o mesmo fluxo do Instagram, e a página de planner com o badge TikTok isolado.

> **Sandbox:** como é o primeiro review, a TikTok exige demonstrar via **Sandbox** do Developer Portal (criador de teste). Siga: página do app → toggle **Sandbox** → adicione o criador de teste → FAÇA o vídeo conectando com essa conta de teste. Depois, para produção, volte o toggle e submeta o review.

**Duração ideal:** 2–4 min. Sem música. Narração ou legendas opcionais.

---

## 6. Checklist final antes do Submit

- [ ] App icon enviado (`tiktok-app-icon.png`)
- [ ] App name = Autoreels; Category = Productivity
- [ ] Description colada (≤120)
- [ ] ToS URL = `https://autoreels.cunhov.site/termos` (deploy feito, 200 OK sem login)
- [ ] Privacy URL = `https://autoreels.cunhov.site/privacidade` (200 OK)
- [ ] Web/Desktop URL = `https://autoreels.cunhov.site/`
- [ ] **URL properties VERIFIED** (signature file servido em public/)
- [ ] Products: Login Kit + Content Posting API (Direct Post habilitado)
- [ ] Scopes: apenas `user.info.basic` + `video.publish`
- [ ] Explanation colada (≤1000)
- [ ] Demo video enviado (sandbox, com domínio correto e todo o fluxo)
- [ ] (pós-aprovação) na VPS: setar `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI=https://autoreels.cunhov.site/api/tiktok/oauth/callback`

---

## Anexo — validação rápida das URLs na VPS (depois do deploy)

```bash
curl -s -o /dev/null -w "termos:%{http_code}\n" https://autoreels.cunhov.site/termos
curl -s -o /dev/null -w "privacidade:%{http_code}\n" https://autoreels.cunhov.site/privacidade
# ambos devem responder 200 mesmo deslogado
```
