# Human delegation (AIWORKPAY MCP) — design and guarantees

The CTO IA can hand a task to a human Payworker through the **AIWORKPAY MCP server** (`aiworkpay-mcp-server`, pinned in
`integrations/aiworkpay/MCP_PIN.json`) and follow it to a result. **Status: implemented against a SIMULATED API only.** No real
mission, payment or backend has been used; delegation is **off by default**.

## Who does what
| Actor | Role |
| --- | --- |
| Owner (in Open Cortex Code) | Reads the exact brief, approves it (bound to its hash), pays the Checkout page, reviews the result. |
| CTO IA | Orchestrator and **only MCP client**. Previews, submits once approved, tracks, ingests results as untrusted data. |
| Technical agents (Claude) | **No access** to the key, the MCP or the network path to AIWORKPAY (their environment is an allowlist). |
| Human payment authority | Validates a delivered result and thereby pays the Payworker — **outside the CTO** (D3). |

## D3 — the CTO can never trigger a payment (two independent locks)
1. `approve_result` and `request_changes` are classified `authority` in `src/human/policy.js`; the MCP port refuses them, and
   no code path in `src/human/` calls them.
2. Before every preview and every submission the CTO reads `get_account`: a key holding `missions:approve` is refused
   (`KEY_HAS_APPROVE_SCOPE`). The key given to the CTO must carry `missions:read` and `missions:write` only.

## Lifecycle
`awaiting_approval → submitting → awaiting_payment → open → assigned → in_progress → delivered → completed`, or `rejected`,
`expired`, `canceled`, `blocked`. States follow only what the backend reports; text never moves a state. Anomalies (backwards
move, unknown status, vanished mission) block instead of guessing. `delivered` means "result ingested, waiting for the
human"; `completed` is only observed after the human authority validated.

1. **Create** — brief validated and screened (no secret, no source code, no credentials; URLs/e-mails/phones are *warnings*
   because a published mission is visible to every Payworker). Contract, key permissions and ceilings are checked, then the MCP
   **preview** (`create_mission` with `confirm=false`, no network) is recorded with the brief hash.
2. **Approve** — owner only, with the hash of the brief they saw (`BRIEF_CHANGED` otherwise), within `CTO_HUMAN_APPROVAL_TTL_MS`.
   Ceilings are re-checked and the reservation is written **in the same atomic update** that moves to `submitting`.
3. **Submit** — `create_mission(confirm=true)` with exactly the approved arguments (hash re-verified). The backend always uses
   Checkout: nothing is charged until a human pays the page.
4. **Track** — `get_mission_status` at most every `CTO_HUMAN_POLL_MS` (default 5 min; webhooks need a public endpoint).
5. **Result** — `get_mission_result` / `get_proof_file`, ingested once as **untrusted data** (see below).

## No duplicates, interruptions, restarts
- The idempotency reference is `cto-<hash(delegation id, brief hash)>`: same delegation + same brief ⇒ same reference.
- The delegation is persisted as `submitting` **before** the call. If the answer is lost, it stays `submitting` with its
  reservation; `recover()` (start-up and periodic) **replays the same call**, which the backend answers with the existing mission
  (`already_existed`). Cancelling during doubt reconciles first, then withdraws the real mission.
- A definite refusal (permission, cap…) releases the reservation and blocks. An outcome that stays uncertain after
  `maxSubmitAttempts` keeps the reservation and blocks for a human check.

## Ceilings (deny by default)
`CTO_HUMAN_LOOP=on`, `CTO_HUMAN_CURRENCY`, `CTO_HUMAN_MAX_PER_DELEGATION`, `CTO_HUMAN_MONTHLY_BUDGET`, `CTO_HUMAN_MAX_PER_DAY`
must **all** be set, plus `AIWORKPAY_MCP_DIR`, `AIWORKPAY_BASE_URL`, `AIWORKPAY_API_KEY` (server side only). One currency. The
same limits are passed to the MCP server as its own caps (defence in depth).

## Untrusted results
Note, data, file names and proofs come from an external human. `src/human/untrusted.js` sanitizes, bounds and **flags**
(instruction override, role markup, tool names, `confirm=true`, credential bait, shell commands, bidi characters, encoded blobs,
prototype keys…) and redacts secrets. Proof files must match their declared type, be bounded and antivirus-clean; only then are
they written (mode 0600) to a quarantine directory, never opened or executed; flagged files are not written at all. Nothing is
shown to a model automatically: `fenceUntrusted()` is the only sanctioned rendering.

## Contract drift
`discover()` compares the live `tools/list` of the pinned server with `tools.manifest.json` (13 tools: class, annotations,
input-schema hash, server name/version). Any difference blocks delegation (`CONTRACT_DRIFT`). Regenerate the manifest only after a
human review: `AIWORKPAY_MCP_DIR=… node scripts/gen-mcp-manifest.js`.

## Dependency (D2)
`@modelcontextprotocol/sdk` **1.32.2**, pinned exactly in the isolated `integrations/aiworkpay/` package (own lockfile). Audit
2026-11-24: `npm audit --omit=dev` = 0 vulnerabilities, MIT, no install scripts, 95 packages, Node ≥ 18. The core CTO keeps zero
dependencies; the client is loaded lazily only when delegation is enabled.

## Tests
`test/human-*.test.js` (unit, state machine, API) run everywhere; `test/human-mcp.integration.test.js` runs the REAL pinned MCP
over stdio against `testkit/aiworkpay-sim.js` (set `AIWORKPAY_MCP_DIR`; CI job `human-loop-mcp`).

## Not done / pending owner decisions
Real backend, real Stripe, production MCP endpoint: untested. Open questions D4 (transport), D5 (pilot ceilings), D6 (pre-production
rehearsal) are tracked in the owner's report. A human-authority path to validate results from Open Cortex needs a backend change
(a proposal is handed to the owner separately; nothing was changed on the backend).
