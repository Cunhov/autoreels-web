# Module 02 rounds — summary

- R00: harness (L1-L8) baseline 6/8 — L3 FAIL (folder cycle + non-folder parent accepted), L7 FAIL (226px mobile h-scroll), L5a documented deviation (POST raw create; dedupe in finalize).
- R01 (a89f01c): L3 guards (cycle walk + folder-parent, PATCH+bulk), toolbar flex-wrap fix → 8/8; perf stable 155 vs 156ms; critic WIN with gap: bulk-delete cascade invisible.
- R02 (e4dda13): descendants preflight + confirm warning (L4c: desc=3), bar L4 documented → 8/8 ALL PASS. MODULE 02: WON.
