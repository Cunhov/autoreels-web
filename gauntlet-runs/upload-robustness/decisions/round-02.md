# Round 02 — finally-guard fix (b37df3b, merged 9b51aca) + C reframe
- Fix: cleanupParts + lock.release only when the request owns the lock. Harness: C FAIL → C1/C2 reframe (client unique paths = C1; server convergence under forced shared path = C2), justified by contract.
- Harness final: A PASS, B PASS, C1 PASS, C2 PASS, D PASS, E PASS — ALL GREEN.
- Critics (fresh, parallel): critic-upload WIN (residual: TOCTOU orphan + no staging GC; process sins in evidence trail). critic-token NOT-WIN (D re-selection hole: token_expires_at within 14d re-selects active channel every tick after missing-creds pause → spam returns; harness seed had token_expires_at null so it could not catch it).
