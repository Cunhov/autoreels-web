# Contrato de integração — /api/calendar (consumido por app/page.tsx)

## Campos que o frontend espera no payload `{ posts: [...] }` (ou array direto):

```
id, status, scheduled_at, published_at, media_type,
video_url, image_url, thumbnail_url, caption,
channel_id, planner_id, error_message, failed_reason
```

Todos renderizados no MonthView/WeekView/DayDetailsModal/LocalPreviewModal.

## ⚠️ REQUISITO para a ação "Duplicar" (DayDetailsModal.handleDuplicate):

O modal duplica posts via POST /api/posts usando `children_urls` (carrosséis),
`video_url`, `image_url`, `thumbnail_url`, `caption`, `media_type`, `channel_id`.
O contrato acima NÃO lista `children_urls` → se o select do /api/calendar omitir,
**duplicar um carrossel a partir do calendário perde as mídias filhas** (cria carrossel
vazio). Pedir ao agente backend (calbe) para INCLUIR: `children_urls` (e idealmente
`collaborators`, `audio_configuration`, `user_tags`, `share_to_feed`, `location_id`).

## Comportamento esperado:
- GET /api/calendar?start=&end= → `{ posts: [...] }` (ou array), ordenado por scheduled_at asc
- start/end ISO; end exclusivo ou inclusivo (o front tolera ambos)
- 401 sem sessão (como as demais rotas)
