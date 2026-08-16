# Reference corpus — upload gauntlet

Authority order (highest first):

1. `diagnosis.md` — root-cause analysis of the production log (primary evidence: the user's
   own error log, quoted verbatim; code locations verified against the repo at HEAD e5f5315).
2. `bar-scenarios.md` — the measurable bar: scenarios A–E with pass criteria and gate commands.
3. Production log excerpt (in diagnosis.md) — the raw failure evidence the bar is derived from.

Ground truth to never lose sight of: the current code FAILS scenarios A–E today (proven by
the production log). A candidate revision wins only when the executable tests pass AND the
critic cannot name a failure mode the tests miss.
