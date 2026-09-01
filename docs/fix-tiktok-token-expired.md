# Fix — Badge "Token expired" falso para TikTok (threshold por plataforma)

**Branch:** `fixes-monolith` · **Natureza:** correção de UI/API — badge de saúde de token
mostrava "Token expired" para canais TikTok mesmo com token válido.

## Causa raiz

`app/channels/page.tsx` `tokenHealth()` usava thresholds fixos herdados do Instagram:

- `if (daysLeft < 1) return 'expired'` — 1 dia
- `if (daysLeft < 14) return 'expiring'` — 14 dias

O Instagram tem tokens de ~60 dias, então "1 dia restante = expirando/expired" é razoável.
Mas o **TikTok em sandbox retorna `expires_in` de 24 h** → `daysLeft` fica entre 0 e 1
durante QUASE TODA a vida do token → o badge vermelho "Token expired" aparecia
imediatamente após conectar, mesmo com o token válido.

Problema secundário: `app/api/channels/route.ts` `toSafeChannel()` montava
`has_token: Boolean(access_token)` — mas o TikTok guarda o token em
`Channel.settings.tiktok_access_token` (coluna `access_token` = null, `token_source=oauth`).
Sem a correção, um canal TikTok sem `token_expires_at` cairia em `'expired'` porque
`has_token` era `false`.

## O que mudou (arquivo:linha)

- `app/api/channels/route.ts` (~L108) — `has_token: Boolean(access_token) || has_tiktok_token`
  (o helper `has_tiktok_token` já existia, calculado do settings JSON e exposto na resposta).
- `app/channels/page.tsx` (~L35-57) — `tokenHealth()` agora é **por plataforma**:
  - `platform === 'tiktok'`: `expired` SÓ quando `expires_at <= now`; `expiring` nas
    últimas 2 h (antes de 1 dia/14 dias).
  - Instagram/outras: mantém o comportamento legado de 1 dia/14 dias.
  - Fallback `unknown`: `has_token || has_tiktok_token` (cobre TikTok sem data de
    expiração presente).
- `app/channels/page.tsx` (~L19) — campo `has_tiktok_token?: boolean` na interface
  `Channel`.

## Como testar

1. Conectar um canal TikTok (sandbox OK): token `expires_in` de 24 h → badge deve
   aparecer **Token OK** (verde) logo após conectar, e **Token expiring** (laranja)
   apenas nas últimas 2 h antes da expiração real.
2. Deixar o token expirar de verdade (ou forçar `token_expires_at` no passado no banco)
   → badge vira **Token expired** (vermelho).
3. Instagram: sem mudança de comportamento para o usuário (mantém expiração em
   1 dia/14 dias) — regressão esperada: nenhuma.

## Rodadas

- `npx tsc --noEmit` → 0 erros
- `npm run build` → Compiled successfully
- `scripts/gauntlet/tiktok-isolation.mts` → 16 PASS, 0 FAIL
- `scripts/gauntlet/tiktok-captions.mts` → 24 PASS, 0 FAIL
- `scripts/gauntlet/products-routing.mts` → 20 passaram, 0 falharam
- Nenhum segredo exposto: `toSafeChannel` continuou mantendo `tiktok_access_token` e
  `tiktok_refresh_token` fora do response (delete no bloco `has_tiktok_token`).
