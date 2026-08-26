# Planner edit-selection/tags — round-232319-baseline — 2026-08-23T02:23:19Z

Mode: prod | Commit: 2cbe47b | BASELINE=0

## S1/S2 (wizard UI) + S3/S4 preview (HTTP)

```
SCENARIO S1: PASS — reopened counter=130 (want 130), badge={"selected":130,"total":130}, checked=130/130
SCENARIO S2: PASS — reopened counter=127 (want 127), checked=127, deselectedIntact={"Sel Item 005":true,"Sel Item 060":true,"Sel Item 120":true}
SCENARIO S3-preview: PASS — caption="A  B 22/08/2026 C " (no "{" allowed; {date} must resolve)
SCENARIO S4-preview: PASS — caption="A MinhaLegenda B 22/08/2026 C " (must contain "A MinhaLegenda B")
PLANNER-EDIT VISUAL: PASS — consoleErrors=0 pageErrors=0
```

## S3/S4 direct (runPlannerOnce)

```
SCENARIO S3direct: PASS — caption="A  B 22/08/2026 C " (no "{" allowed; {date} must resolve)
SCENARIO S4direct: PASS — caption="A MinhaLegenda B 22/08/2026 C " (must contain "A MinhaLegenda B")
```

## server.log greps

- Unhandled/TypeError: 0
- '[api-error]' lines: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0

## reports

```
{
  "scenarios": {
    "S1": {
      "pass": true,
      "reopenedBadge": {
        "selected": 130,
        "total": 130
      },
      "reopenedWizardCounter": 130,
      "checkedAfterFullLoad": 130,
      "rowsRendered": 130
    },
    "S2": {
      "pass": true,
      "reopenedBadge": {
        "selected": 127,
        "total": 130
      },
      "reopenedWizardCounter": 127,
      "checkedAfterFullLoad": 127,
      "deselectedStillUnchecked": {
        "Sel Item 005": true,
        "Sel Item 060": true,
        "Sel Item 120": true
      }
    },
    "S3preview": {
      "pass": true,
      "caption": "A  B 22/08/2026 C "
    },
    "S4preview": {
      "pass": true,
      "caption": "A MinhaLegenda B 22/08/2026 C "
    }
  },
  "evidence": {
    "s1_createdWithSelection": 130,
    "s1_reopenedBadge": {
      "selected": 130,
      "total": 130
    },
    "s1_reopenedWizardCounter": 130,
    "s1_rowsRendered": 130,
    "s1_checkedAfterFullLoad": 130,
    "s1_badgeAfterFullLoad": {
      "selected": 130,
      "total": 130
    },
    "s2_afterDeselect": {
      "selected": 127,
      "total": 130
    },
    "s2_reopenedBadge": {
      "selected": 127,
      "total": 130
    },
    "s2_reopenedWizardCounter": 127,
    "s2_checkedAfterFullLoad": 127,
    "s2_deselectedStillUnchecked": {
      "Sel Item 005": true,
      "Sel Item 060": true,
      "Sel Item 120": true
    },
    "s3_previewCaption": "A  B 22/08/2026 C ",
    "s4_previewCaption": "A MinhaLegenda B 22/08/2026 C "
  },
  "consoleErrors": [],
  "pageErrors": [],
  "pass": true
}```

```
{
  "S3direct": {
    "pass": true,
    "ok": true,
    "skipped": null,
    "errors": [],
    "caption": "A  B 22/08/2026 C ",
    "dateResolved": true,
    "noLiteralBraces": true
  },
  "S4direct": {
    "pass": true,
    "ok": true,
    "caption": "A MinhaLegenda B 22/08/2026 C ",
    "containsResolved": true
  }
}```
