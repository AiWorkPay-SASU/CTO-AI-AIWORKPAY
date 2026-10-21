# MCP Atlas integration — CTO IA

Status: design and implementation specification; NOT deployed or connected.

## Separation
This repository implements the autonomous software-development CTO team, NOT AiWorkPay's business workforce. MCP Atlas is an external, read-only discovery source.

## Source
Base: https://zeroo.online
Candidate API (verify availability and schema before implementation):
- GET /api/v1/servers
- GET /api/v1/servers/:slug
- GET /api/v1/search?q=...
- GET /api/v1/categories
- GET /api/v1/sources
- GET /openapi.json

Never assume these endpoints are live: verify status codes, OpenAPI schema and actual responses before enabling integration.

## Proposed module
`integrations/mcp-atlas/` with typed client, schema validation, timeouts, retry/backoff for 429/5xx, conditional GET, local cache, source provenance, audit logs, no secrets in logs.

Expose read-only CTO tools:
- `search_mcp_servers(query, filters)`
- `get_mcp_server(slug)`
- `compare_mcp_servers(ids)`
- `get_new_mcp_servers(since)`
- `propose_mcp_integration(server_id, mission_id)`

## Security / governance
Directory metadata is untrusted input. Never execute install commands from listings or fetch arbitrary URLs server-side. Require explicit owner approval before installing, authorizing OAuth, running third-party code, or changing credentials. Validate maintainer identity, licensing, maintenance, permissions, security posture, transport and compatibility. Sandbox approved test installations, use least privilege and record decisions. No auto-install.

## Delivery stages
1. Confirm live MCP Atlas API and actual OpenAPI specification.
2. Implement typed client and contract tests using recorded API fixtures.
3. Add CTO-facing read-only tools and cache.
4. Implement qualification workflow and human approval.
5. Add scheduled novelty detection and deduplicated alerts.
6. Run integration tests in staging and document observed outcomes.

## Acceptance
Search returns real indexed entries with source attribution; unavailable APIs fail gracefully; updates are deduplicated; no server execution occurs from search; approval required for installation; integration never accesses AiWorkPay workforce data.
