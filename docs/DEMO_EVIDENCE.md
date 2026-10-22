# Real demonstration — evidence

Run on 2026-10-17 with `node scripts/demo.js` (Node 22.22, real `claude` CLI, model `claude-sonnet-5-5`).
Nothing in this run is simulated: the four specialists (architect, backend, QA, security) are real Claude Code sessions,
each in its own isolated git worktree of a disposable test repository (`/tmp/cto-demo-*`, deleted with the sandbox).
The script acts as the owner **only on that disposable repository**; the approvals record it as
`demo-script (disposable test repo)`. The demo stops at `review`: the completion approval, any merge and any deployment
remain with the human owner.

## Objective given to the CTO
Add `slugify(text)` in `src/slug.js` (lowercase, strip accents, collapse non-alphanumeric runs into one hyphen, trim
hyphens, empty string for blank input) with `node:test` tests in `test/slug.test.js`. The owner also supplied 6 acceptance
tests that the agent never sees; the CTO runs them itself.

## What happened (from the persisted append-only event log)
| Time | Event |
|---|---|
| 15:25:35 | mission created → mission approval recorded → **architect** leased and started (read-only worktree) |
| 15:25:47 | plan verified by the CTO (required sections present, worktree clean) → architecture approval requested and recorded |
| 15:25:47 | **backend** leased and started (own worktree, branch `cto/e6ef21d5/backend-252f67b1`) |
| 15:26:00 | backend verified by the CTO, committed |
| 15:26:01 | **QA and security leased and started in the same second** (parallel, each in its own detached worktree on the verified commit) |
| 15:26:10–11 | both reviews received and validated → completion approval requested; mission in `review` |

## CTO verification (independent of the agents' claims)
- Files changed, taken from git: `src/slug.js`, `test/slug.test.js`.
- Project tests run by the CTO: **10 passed, 0 failed**. Owner acceptance tests run by the CTO: **6 passed, 0 failed**.
- No forbidden path touched, no secret-like value in the diff.
- Independent re-check outside the CTO code path (fresh detached worktree of the commit, same test files): project 10/0, acceptance 6/0.
- `main` of the test repo unchanged (verified); work is on the task branch only.
- Reviews (advisory, they can only add blockers): QA **pass** with 1 low finding (stylistic: literal combining characters in a regex instead of `̀-ͯ` escapes); security **pass**, 0 findings. Neither reviewer modified a file.
- Cost: 0.300 USD of the 3 USD budget (architect 0.070, backend 0.082, QA 0.079, security 0.069).
- Correction rounds: **0**. Rework rounds after review: **0**.

## What this run does not prove
The correction loop and the review-triggered rework loop were **not** triggered in the live run (every agent passed first
time). They are covered by `test/cto.test.js` with scripted agent doubles that really modify worktrees: an agent that passes
its own tests but fails the owner acceptance tests; a blocking QA finding that sends the work back to the backend and makes
both reviewers re-run on the new commit; bounded rework ending in escalation.

## Reproduce
```
node scripts/demo.js      # needs the `claude` CLI authenticated; spends real money (about 0.30 USD, capped at 3 USD)
```
