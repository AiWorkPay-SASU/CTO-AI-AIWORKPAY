# Real demonstration — evidence

Run on 2026-10-17 with `node scripts/demo.js` (Node 22.22, real `claude` CLI, model `claude-sonnet-5-5`).
Nothing in this run is simulated: both specialists are real Claude Code sessions in isolated git worktrees of a
disposable test repository (`/tmp/cto-demo-*`, deleted with the sandbox). The script acts as the owner **only on that
disposable repository** and the approvals record it as `demo-script (disposable test repo)`. The demo stops at `review`:
the completion approval, any merge and any deployment remain with the human owner.

## Objective given to the CTO
Add `slugify(text)` in `src/slug.js` (lowercase, strip accents, collapse non-alphanumeric runs into one hyphen, trim
hyphens, empty string for blank input) with `node:test` tests in `test/slug.test.js`. The owner also supplied 6 acceptance
tests that the agent never sees; the CTO runs them itself.

## What happened (from the persisted append-only event log)
| Time | Event |
|---|---|
| 15:16:58 | mission created → mission approval recorded → task leased → **architect** started (read-only worktree) |
| 15:17:11 | architect plan verified by the CTO (required sections present, worktree clean) → architecture approval requested → recorded |
| 15:17:11 | **backend** leased and started (separate worktree, branch `cto/061fac2b/backend-4229b5cd`) |
| 15:17:29 | backend verified by the CTO → completion approval requested; mission in `review` |

## CTO verification (independent of the agents' claims)
- Files changed, taken from git: `src/slug.js`, `test/slug.test.js` (+46 lines).
- Project tests run by the CTO: **7 passed, 0 failed**.
- Owner acceptance tests run by the CTO: **6 passed, 0 failed**.
- No forbidden path touched, no secret-like value in the diff.
- Committed on the task branch (`2e86a04`); `main` of the test repo unchanged (verified).
- Independent re-check outside the CTO code path (fresh detached worktree of the commit, same test files): project 7/0, acceptance 6/0.
- Cost: 0.285 USD of the 2 USD budget (architect 0.187, backend 0.098).
- Correction rounds requested: **0**. The correction loop was *not* triggered in the live run; it is covered by
  `test/cto.test.js` using scripted agent doubles that really modify worktrees (agent passes its own tests but fails the
  owner acceptance tests → correction → second attempt verified).

## Reproduce
```
node scripts/demo.js      # needs the `claude` CLI authenticated; spends real money (capped at 2 USD)
```
