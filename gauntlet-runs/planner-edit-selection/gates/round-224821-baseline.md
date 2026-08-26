# Planner edit-selection/tags — round-224821-baseline — 2026-08-23T01:48:21Z

Mode: prod | Commit: 2cbe47b | BASELINE=1

## S1/S2 (wizard UI) + S3/S4 preview (HTTP)

```
SCENARIO S1: FAIL — reopened counter=100 (want 130), badge={"selected":100,"total":130}, checked=100/130
SCENARIO S2: FAIL — reopened counter=98 (want 127), checked=98, deselectedIntact={"Sel Item 005":true,"Sel Item 060":true,"Sel Item 120":true}
SCENARIO S3-preview: FAIL — caption="A  B {date} C {unknown_var}" (no "{" allowed; {date} must resolve)
SCENARIO S4-preview: PASS — caption="A MinhaLegenda B {date} C {unknown_var}" (must contain "A MinhaLegenda B")
PLANNER-EDIT VISUAL: FAIL — consoleErrors=0 pageErrors=0
```

## S3/S4 direct (runPlannerOnce)

```
SCENARIO S3direct: FAIL — caption="A A {post_caption} B {date} C {unknown_var} B 22/08/2026 C " (no "{" allowed; {date} must resolve)
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
      "pass": false,
      "reopenedBadge": {
        "selected": 100,
        "total": 130
      },
      "reopenedWizardCounter": 100,
      "checkedAfterFullLoad": 100,
      "rowsRendered": 130
    },
    "S2": {
      "pass": false,
      "reopenedBadge": {
        "selected": 98,
        "total": 130
      },
      "reopenedWizardCounter": 98,
      "checkedAfterFullLoad": 98,
      "deselectedStillUnchecked": {
        "Sel Item 005": true,
        "Sel Item 060": true,
        "Sel Item 120": true
      }
    },
    "S3preview": {
      "pass": false,
      "caption": "A  B {date} C {unknown_var}"
    },
    "S4preview": {
      "pass": true,
      "caption": "A MinhaLegenda B {date} C {unknown_var}"
    }
  },
  "evidence": {
    "s1_createdWithSelection": 130,
    "s1_reopenedBadge": {
      "selected": 100,
      "total": 130
    },
    "s1_reopenedWizardCounter": 100,
    "s1_rowsRendered": 130,
    "s1_checkedAfterFullLoad": 100,
    "s1_badgeAfterFullLoad": {
      "selected": 100,
      "total": 130
    },
    "s2_afterDeselect": {
      "selected": 99,
      "total": 130
    },
    "s2_reopenedBadge": {
      "selected": 98,
      "total": 130
    },
    "s2_reopenedWizardCounter": 98,
    "s2_checkedAfterFullLoad": 98,
    "s2_deselectedStillUnchecked": {
      "Sel Item 005": true,
      "Sel Item 060": true,
      "Sel Item 120": true
    },
    "s3_previewCaption": "A  B {date} C {unknown_var}",
    "s4_previewCaption": "A MinhaLegenda B {date} C {unknown_var}"
  },
  "consoleErrors": [],
  "pageErrors": [],
  "pass": false
}```

```
{
  "S3direct": {
    "pass": false,
    "ok": true,
    "skipped": null,
    "errors": [],
    "caption": "A A {post_caption} B {date} C {unknown_var} B 22/08/2026 C ",
    "dateResolved": true,
    "noLiteralBraces": false
  },
  "S4direct": {
    "pass": true,
    "ok": true,
    "caption": "A MinhaLegenda B 22/08/2026 C ",
    "containsResolved": true
  }
}```
