# Audit corrections — 22 October 2026

## Verified commit contents

The CTO snapshots the staged Git tree before executing tests. After project and owner acceptance tests, it snapshots again and rejects any tracked or non-ignored file mutation. It scans the complete final changed blobs and forbidden paths against the task's base commit, then commits only if the index still matches the verified tree. Acceptance files are removed in a finally block. Verification errors block the mission instead of leaving its task stuck in review.

This prevents a passing test from adding SECURITY.md, adding a credential or replacing the implementation after the initial scan. Ignored build/cache files are not committed. Tests which intentionally update versioned snapshots must instead have the agent write the snapshot, then rerun tests without modifying it.

## Budget reservations

Before dispatch, a compare-and-set on the mission reserves the role's entire per-call cap. Concurrent dispatchers cannot allocate the same remaining balance. Actual reported cost settles the reservation; another task waits while the available balance is reserved, and blocks/escalates if the final balance cannot cover its cap. A lost claim releases its reservation.

Reservations and settlement are persisted. Missing/failed/cancelled CLI output and expired leases consume the full cap as an explicit **estimate**, never as an invented zero. The API exposes estimated_usd and cost records carry estimated=true; MissionControl labels estimated amounts. Orphan reservations from a crash between reservation and task claim are conservatively settled after the lease interval. A cost ledger entry is idempotent per reservation.

These controls prevent the reproduced double allocation (1.90 USD budget, 2.30 USD combined planned cost). Provider billing remains external: if the CLI reports a cost above its cap, that actual amount is recorded and the mission is blocked. FileStore remains single-process; multiple processes must share a store providing atomic CAS, rather than opening the same JSON file independently.

## Test isolation

Production test execution requires Linux and bubblewrap (`bwrap`). The sandbox has private user, PID, IPC and network namespaces, drops capabilities, mounts only system runtime directories read-only and the task workspace writable at /work, masks Git metadata, and supplies private /tmp, /proc and /dev. It receives a fixed minimal environment: no provider keys, proxy credentials, host HOME, NODE_OPTIONS or preload configuration. It cannot see the host's /home, /etc, other worktrees or database credentials through ordinary host paths. A timeout bounds execution and bubblewrap ties the sandbox lifetime to its parent.

No fallback executes generated tests on the host. Missing bubblewrap, an unsupported OS, or refusal by the kernel causes test verification to fail. Specialist Bash tools are removed and globally denied, so agents submit code and tests; only the CTO invokes tests through the sandbox. This is not an OS sandbox for the Claude CLI itself, nor a guarantee against kernel exploits or all resource exhaustion attacks.

Install on the Linux worker: `sudo apt-get install bubblewrap`. The worker kernel must allow bubblewrap to create its namespaces. There is no environment flag to disable production test isolation.

## Validation scope

The repository's trusted fixture code uses an explicitly injected testRunner in unit/integration tests; production configuration and the real Claude demo always use runTests and its mandatory sandbox. The regression suite executes real fixture tests and Git worktrees to verify rejection of test-time file mutations, commit-tree mismatch, concurrent budget allocation and unknown cost accounting.

The local Work host refuses nested namespace creation. Local tests therefore prove fail-closed behavior and skip the positive sandbox integration test with the kernel error. GitHub Actions installs bubblewrap and sets CTO_REQUIRE_SANDBOX_TESTS=1: inability to run the real filesystem/network isolation test fails CI. The live Supabase test remains opt-in and is not claimed as executed without credentials.

No paid Claude invocation, migration, merge or deployment is part of these corrections. Multi-repository routing, frontend/DevOps specialists and per-user authentication remain separate work.

Local validation on Node 24.19.0: `npm run check` succeeded (lint, secret scan, 109 tests: 107 passed, 0 failed, 2 skipped). Skips are the positive Linux sandbox integration and the opt-in live Supabase check. These results do not claim a live Claude run or a successful sandbox integration.
