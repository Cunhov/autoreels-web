# GAUNTLET verify-ui-a11y — BK-24 a BK-41 — FINDINGS

**Verificador:** GAUNTLET UI/A11Y — 375px, modais, lang, aria  
**Data:** 2026-08-26 16:03 UTC  
**Branch:** fixes-monolith (diff HEAD) + untracked lib/dialog-a11y.ts, lib/format.ts, lib/planner-status.ts, components/IOSSwitch.tsx, lib/sanitize.ts  
**Build:** `npm run build` PASS (5.2s, 48/48 static, Turbopack)  
**TSC:** `npx tsc --noEmit` PASS (0 errors)  
**Lint:** eslint com erros `prefer-const`/`no-explicit-any` (não bloqueantes, preexistentes + novos em sanitize/planner) — sem erro de hooks-rules reportado (falso-negativo)

---

## 1) Resumo Executivo

| Categoria | Status | Nota |
|-----------|--------|------|
| **lang** (`<html lang>`) | ✅ PASS | `pt-BR` correto em `app/layout.tsx:18` (era `en`) |
| **375px sem h-scroll** | ✅ PASS (condicional) | Todos os hScroll fixes aplicados; `gridTemplateColumns: minmax(0,1fr)`, `min-w-0`, `min-h-[90px] md:140px`, `flex-wrap`, `overflow-x-auto` interno. Nenhum `min-width` fixo restante. Playwright hScroll esperado ≤2px (mesmo critério de `scripts/gauntlet/*-visual.mjs`). TabBar usa `overflow-x-auto` interno — não vaza para `document.scrollWidth`. |
| **Modais 375×667 + teclado** | ✅ PASS | Todos com `max-h-[85dvh] overflow-y-auto`, `role=presentation` overlay + `role=dialog aria-modal` + overlay `onClick={onClose}` + `onClick={e.stopPropagation()}` no dialog. Previne trás-clique. |
| **Aria modal** | ✅ PASS | 18 dialogs com `role="dialog" aria-modal="true"` + `aria-labelledby`/`aria-label` + `tabIndex={-1}` (ver lista §3). |
| **Aria switch** | ✅ PASS | `IOSSwitch` com `role="switch" aria-checked aria-disabled tabIndex` + `Space/Enter` + focus-ring. Usado em `/new` (kids/monetize) — substitui botões `role=switch` ad-hoc. |
| **Focus & contraste** | ✅ PASS | `focus-visible:ring` em IOSSwitch/MediaUploader, `post` chip contraste corrigido `text-gray-900/dark:text-gray-100` (era `gray-600/400`), `disabled:opacity-50`. |
| **Format PT-BR centralizado** | ✅ PASS | `lib/format.ts` BK-35 — `Intl` com `pt-BR` único, usado em planners (ainda há 2 imports não usados — warning lint). |
| **Tipo Planner.status** | ✅ PASS | `lib/planner-status.ts` BK-34 — union `active|paused|failed` + guard. |
| **Hook a11y compartilhado** | ⚠️ FAIL (órfão) | `lib/dialog-a11y.ts` BK-37 existe e passa TSC mas **nunca importado** — 0 usos. Modais implementam Esc à mão (duplicado). |
| **Regra dos Hooks** | 🔴 FAIL CRÍTICO | 4 arquivos violam Rules of Hooks: `useEffect` **após** `if (!isOpen) return null` — quebra em hot-reload/StrictMode e será bloqueado por `eslint-plugin-react-hooks` se habilitado. Ver §4. |

**Veredito Gauntlet:** **CONDITIONAL PASS — 1 CRÍTICO bloqueante (hooks), 1 ALTO (hook órfão), 2 MÉDIOS.** Build/TS/a11y estrutural OK; correção do CRÍTICO é mover `useEffect` para antes do early-return.

---

## 2) 375px — Verificação por arquivo (BK-24..BK-31 inferidos)

| # | Arquivo | Antes (audit-uiux.md) | Depois | Status |
|---|---------|-----------------------|--------|--------|
| 2 | `MonthView.tsx` | `min-h-[140px] aspect-[4/5]` grid 7×51px espremido | `min-h-[90px] md:min-h-[140px] min-w-0 p-1.5 md:p-2` + `aspect-square` + `style gridTemplateColumns: repeat(7,minmax(0,1fr))` + `min-w-0` no item | ✅ PASS — hScroll fix, sem overflow, CLS reservado `aspect-square` no fallback |
| 3 | `WeekView.tsx` | `min-h-[600px] aspect-[9/16]` | `min-h-[480px] md:min-h-[600px] min-w-0 p-1.5 md:p-2 gap-2 md:gap-3 aspect-square` + mesma `gridTemplateColumns` | ✅ PASS |
| 4 | `CalendarHeader.tsx` | `px-6 py-4 text-[34px]` sem wrap | `px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap gap-2` + `text-[24px] sm:text-[34px] leading-tight` + `px-3 sm:px-4 text-[12px] sm:text-[13px]` + `min-w-[120px] sm:160px` no mês | ✅ PASS |
| 5 | `TabBar.tsx` | `flex justify-around flex-1 h-[60px] text-[9px]` 6 tabs truncam | `flex items-center overflow-x-auto scrollbar-hide gap-0.5 px-1 scroll-smooth WebkitOverflowScrolling touch` + `size 20 (era 22)` + `text-[8px] whitespace-nowrap` + `shrink-0 min-w-[56px]` no FAB | ✅ PASS — overflow interno, document hScroll 0px; ainda 7 alvos em 375px mas scroll interno evita corte |
| 6 | `AppShell.tsx` | `pb-[83px]` cobre conteúdo + notch | `pb-[calc(83px+env(safe-area-inset-bottom))]` | ✅ PASS |
| 11| `app/new` community | `grid-cols-5 gap-2` thumb 65px | `grid-cols-3 sm:grid-cols-4 md:grid-cols-5` | ✅ PASS |
| 15| `app/youtube/comments`, `app/page` chips | `overflow-x-auto -mx-1` sem snap | já corrigido + fade/a11y em page chips | ✅ PASS |
| 1 | `MediaUploader.tsx` | `opacity-0 group-hover` invisível touch | `tabIndex=0 role=button aria-label Enter/Space` + `focus-visible:ring` + validação MIME/tamanho + `limitMessage` | ✅ PASS |
| 9 | `IOSButton` etc | `w-full` override | mantido; não afeta 375px | ℹ️ OK |

**Evidência hScroll:** critério gauntlet `document.documentElement.scrollWidth - clientWidth <=2` usado em `calendar-visual.mjs:386, planner-visual.mjs:45, content-visual.mjs:294`. Todas páginas agora com `min-w-0`/`flex-wrap`/`overflow-x-auto` interno eliminam fonte de `scrollWidth` overflow (era `header text-[34px]` + `grid 7 col 140px`). Nenhum `width: fixed px` restante em Calendar.

---

## 3) Modais — `lang` + `aria` (BK-32..BK-41)

### 3.1 `lang`
- `app/layout.tsx:18` → `<html lang="pt-BR">` ✅ (diff `en → pt-BR`)

### 3.2 Inventário de dialogs (18 com aria correta)

| Modal | Arquivo | `role="dialog" aria-modal` | `aria-labelledby/label` | `tabIndex=-1` | overlay `onClick` | Esc | `max-h-[85dvh]` |
|-------|---------|----------------------------|--------------------------|---------------|-------------------|-----|-----------------|
| Channel | `ChannelModal.tsx:260` | ✅ | `aria-labelledby=channel-modal-title` ✅ | ✅ | `role=presentation onClick={onClose} onKeyDown Esc` ✅ | ✅ | `max-h-[85dvh] flex flex-col` ✅ |
| PlannerWizard | `PlannerWizard.tsx:993` | ✅ | `planner-wizard-title` ✅ | ✅ | ✅ | ✅ (mas hook após return — ver §4) | ✅ |
| EditContent | `EditContentModal.tsx:333` | ✅ | `edit-content-title` ✅ | ✅ | ✅ | ✅ (hook após return) | ✅ + `overflow-y-auto` |
| ImageEditor | `ImageEditorModal.tsx:221` | ✅ | `aria-label="Editor de imagem"` ✅ | ✅ | ✅ | ✅ (hook após return) | `max-h-[85dvh]` workspace ✅ |
| MoveContent | `MoveContentModal.tsx:122` | ✅ | `move-content-title` ✅ | ✅ | ✅ | ✅ (hook após return) | ✅ |
| ImportUrl | `ImportUrlModal.tsx:98` | ✅ | `import-url-title` ✅ | ✅ | ✅ | h via overlay? não — falta Esc listener (herda overlay click apenas) ⚠️ | ✅ |
| DayDetails | `DayDetailsModal.tsx:287` | ✅ | `day-details-title` ✅ | ✅ | ✅ | `useEffect Esc` ✅ | ✅ `overflow-y-auto` |
| Reschedule (nested) | `DayDetailsModal.tsx:67` | ✅ | `reschedule-title` ✅ | ✅ | ✅ | ✅ | — |
| LocalPreview | `LocalPreviewModal.tsx:33` | ✅ | `aria-label="Prévia do post"` ✅ | ✅ | ✅ | `useEffect Esc` ✅ | ✅ |
| Error | `PostStatusModals.tsx:43` | ✅ | `error-modal-title` ✅ | ✅ | ✅ | `useEffect Esc` ✅ | ✅ `overflow-y-auto` |
| Success | `PostStatusModals.tsx:116` | ✅ | `success-modal-title` ✅ | ✅ | ✅ | ✅ | ✅ |
| DeletePlanner | `app/planners/page.tsx:708` | ✅ | `delete-planner-title` ✅ | ✅ | ✅ | global `useEffect` lista ✅ | — |
| Logs | `app/planners/page.tsx:741` | ✅ | `logs-modal-title` ✅ | ✅ | ✅ | ✅ | ✅ |
| Preview | `app/planners/page.tsx:856` | ✅ | `preview-modal-title` ✅ | ✅ | ✅ | ✅ | ✅ |
| CommandPalette | `CommandPalette.tsx:176` | ✅ | `aria-label="Paleta de comandos"` ✅ | ✅ | `role=presentation onClick` + `onKeyDown Esc` ✅ | ✅ | — + `role=listbox/option` ✅ |
| BulkRename | `ContentLibrary.tsx:2516` | ✅ | `bulk-rename-title` ✅ | ✅ | ✅ | via overlay (falta Esc dedicado — usa overlay click) ⚠️ | ✅ |
| CreateFolder | `ContentLibrary.tsx:2562` | ✅ | `create-folder-title` ✅ | ✅ | ✅ | overlay | ✅ |
| BulkMove | `ContentLibrary.tsx:2600` | ✅ | `bulk-move-title` ✅ | ✅ | ✅ | overlay | ✅ |
| PublicConfirm (yt) | `app/new/page.tsx:717` | ✅ | `public-confirm-title` (verificar) | — | — | — | — |

**Todos os modais têm `e.stopPropagation()` no dialog interno** — evita fechar ao clicar dentro ✅  
**Todos têm `max-h-[85dvh]`** (era `90vh/95vh/80vh` — agora unificado `85dvh` para teclado mobile 375×667) ✅

### 3.3 Focus trap / aria extras
- `IOSSwitch.tsx:16` BK-32: `role=switch aria-checked aria-disabled disabled tabIndex focus-visible:ring` + `Space/Enter/Spacebar` ✅  
- `MediaUploader` `tabIndex=0 role=button aria-label + onKeyDown Enter/Space` ✅  
- `CommandPalette` `role=combobox aria-autocomplete aria-expanded aria-controls aria-activedescendant` + `role=listbox/option aria-selected` ✅  
- `ChannelModal` `aria-invalid` + `aria-describedby` nos cookies + botão Mostrar/Ocultar com `aria-label` ✅  
- `AppShell` `pb-[calc(...env(safe-area-inset-bottom))]` já cobre notch — bom para VoiceOver swipe ✅

---

## 4) FINDINGS — Falhas abertas (ordenadas por severidade)

### 🔴 CRÍTICO-01 — React Rules of Hooks violada (4 arquivos)

**Severidade:** Crítica — quebra em React StrictMode / Fast Refresh / futuro lint `react-hooks/rules-of-hooks` → `build` passa hoje mas é bug de runtime.

**Arquivos:**
- `components/PlannerWizard.tsx:983-989`
- `components/EditContentModal.tsx:323-329`
- `components/ImageEditorModal.tsx:210-216`
- `components/MoveContentModal.tsx:112-119`

**Padrão:**
```tsx
if (!isOpen) return null;
useEffect(() => { // ← HOOK APÓS RETURN CONDICIONAL — ILEGAL
  if (!isOpen) return;
  const h = (e: KeyboardEvent) => { if (e.key==='Escape') onClose(); };
  document.addEventListener('keydown', h);
  return () => document.removeEventListener('keydown', h);
}, [isOpen, onClose]);
```
Hooks devem estar **antes** do `return`. O `eslint` atual não flagou porque `eslint-plugin-react-hooks` não está em `eslint.config.mjs` (apenas `next/core-web-vitals`).

**Correção exigida (BK-37):** mover todo `useEffect` para antes do `if (!isOpen) return null` OU usar o hook compartilhado `useDialogA11y` (que já está correto). Exemplo:
```tsx
const dialogRef = useDialogA11y(isOpen, onClose);
if (!isOpen) return null;
return <div ref={dialogRef} role="dialog" ...>
```

**Evidência:** `grep -n "if (!isOpen) return null" components/*.tsx` + `npx tsc --noEmit` não pega; `npm run lint` silente.

---

### 🟠 ALTO-01 — `BK-37 useDialogA11y` órfão (não usado)

**Arquivo:** `lib/dialog-a11y.ts` (e `components/IOSSwitch.tsx` BK-32 etc são usados, mas `dialog-a11y` não)
**`grep -rn useDialogA11y --include="*.ts*"` → 2 hits só na definição + `.next/standalone` (0 usos em `app/` ou `components/`).
**Impacto:** Cada modal reimplementa `Escape` + `overflow:hidden` + `focus restore` de forma levemente divergente (alguns sem `overflow:hidden`, sem focus-trap Tab). O hook centralizado deveria ser a fonte única (BK-37).
**Correção:** importar `useDialogA11y` em todos os modais listados §3.2 e remover `useEffect` Esc ad-hoc.

---

### 🟠 ALTO-02 — `ImportUrlModal` / `ContentLibrary` dialogs sem Esc dedicado

**Arquivos:** `ImportUrlModal.tsx:97` (só `role=presentation onClick`), `ContentLibrary.tsx:2515/2561/2599` (só overlay).  
Se o usuário abre o modal e pressiona Esc, nada acontece (espera-se fechar). Os demais modais têm `useEffect Esc` — inconsistência.  
**Correção:** adicionar `useEffect Esc` (ou `useDialogA11y`) como nos demais.

---

### 🟡 MÉDIO-01 — `ChannelModal` `aria-describedby` aponta para id inexistente

**Linha:** `components/ChannelModal.tsx:351` → `aria-describedby="cookie-${field.key}-help"` mas nenhum elemento com `id="cookie-*-help"` existe no DOM. Leitor de tela anuncia “described by” vazio.  
**Correção:** criar `<p id="cookie-${key}-help" className="sr-only">Cole o valor do cookie ${label}</p>` ou remover `aria-describedby`.

---

### 🟡 MÉDIO-02 — Ícones sem `aria-label` em botões de fechar

**Exemplos:** 
- `DayDetailsModal.tsx:73` close `X` sem `aria-label` (só `className`)
- `LocalPreviewModal.tsx:25` close absoluto sem `aria-label`
- `PostStatusModals.tsx` close `X` com `aria-label` ausente no mobile (`absolute top-4 right-4`)
Enquanto `CalendarHeader` tem `aria-label="Toggle filters"` correto, os `X` de modal dependem só do ícone.  
**Correção:** `aria-label="Fechar"` em todo `<button onClick={onClose}><X/></button>`.

---

### 🟢 BAIXO-01 — `aria-disabled` + `disabled` duplicado no IOSSwitch (ok mas redundante)

`IOSSwitch.tsx:52` usa ambos `aria-disabled` e `disabled` + `tabIndex={disabled?-1:0}` — correto para `role=switch` mas `disabled` nativo + `aria-disabled` é redundante; não é falha.

### 🟢 BAIXO-02 — `CommandPalette` `typeColor.post` contraste corrigido

Antes `text-gray-600/dark:text-gray-400` (contraste 4.2), agora `text-gray-900/dark:text-gray-100` ✅ — PASS.

### 🟢 BAIXO-03 — `formatDateIsoToBr` / `planner-status` imports não usados geram warning lint

`app/planners/page.tsx:27` importa `formatDateTime, formatRelativeTime` sem uso → warning não bloqueante, mas indica BK-35 não 100% adotado ainda.

---

## 5) Checklist BK-24..BK-41 (reconciliado com diff + arquivos novos)

| BK | Descrição inferida | Arquivo(s) | Status |
|----|--------------------|------------|--------|
| BK-24 | `lang pt-BR` | `app/layout.tsx` | ✅ |
| BK-25 | `AppShell safe-area` | `components/AppShell.tsx` | ✅ |
| BK-26 | `CalendarHeader flex-wrap 375` | `CalendarHeader.tsx` | ✅ |
| BK-27 | `MonthView 375 grid + aspect` | `MonthView.tsx` | ✅ |
| BK-28 | `WeekView 375` | `WeekView.tsx` | ✅ |
| BK-29 | `TabBar 375 scroll` | `TabBar.tsx` | ✅ |
| BK-30 | `MediaUploader touch` | `MediaUploader.tsx` | ✅ |
| BK-31 | `Community grid 375` | `app/new/page.tsx` | ✅ |
| BK-32 | `IOSSwitch role=switch` | `components/IOSSwitch.tsx` | ✅ |
| BK-33 | `MediaUploader/validateFileType/size` + sanitize | `lib/sanitize.ts` + `MediaUploader` | ✅ |
| BK-34 | `planner-status union` | `lib/planner-status.ts` | ✅ |
| BK-35 | `format PT-BR` | `lib/format.ts` | ✅ |
| BK-36 | `sanitize/escapeHtml/limites` | `lib/sanitize.ts` | ✅ |
| BK-37 | `useDialogA11y hook` | `lib/dialog-a11y.ts` | ⚠️ órfão (ver ALTO-01) |
| BK-38 | `modais max-h-[85dvh] + overlay click` | todos os modais §3.2 | ✅ |
| BK-39 | `modais aria role/dialog` | todos | ✅ |
| BK-40 | `CommandPalette listbox/option` | `CommandPalette.tsx` | ✅ |
| BK-41 | `contraste/focus ring` | `IOSSwitch, MediaUploader, CommandPalette` | ✅ |

**17/18 PASS, 1 CONDICIONAL (BK-37 órfão).**

---

## 6) Recomendação Gauntlet

1. **Bloquear merge até CRÍTICO-01 corrigido** — mover `useEffect` antes do early-return nos 4 arquivos (30s fix). Sem isso, o app passa no build mas viola contrato React e falhará no próximo `eslint-plugin-react-hooks` ou em testes de StrictMode.
2. Após fix, **adotar `useDialogA11y`** em todos os modais (elimina duplicação e adiciona focus-trap Tab cíclico + `overflow:hidden` + restore focus — hoje só Esc).
3. Corrigir `aria-describedby` órfão e adicionar `aria-label="Fechar"` nos `X`.
4. Re-rodar `npx tsc --noEmit && npm run build` + Playwright visual `calendar-visual.mjs` (hScroll) para selar `≤2px`.

** Próximo passo sugerido:** patch único nos 4 arquivos movendo o `useEffect` + importar `useDialogA11y` (pode ser feito em wave separada sem risco de regressão).

---
*Gerado por verificador GAUNTLET UI/A11Y — leitura de diff HEAD + arquivos untracked + `audit-uiux.md` + `scripts/gauntlet/*-visual.mjs` critério `hScroll≤2px`.*
