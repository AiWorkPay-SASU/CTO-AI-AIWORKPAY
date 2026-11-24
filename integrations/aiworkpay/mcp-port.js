import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sha256, canonical } from '../../src/human/brief.js';
import { ContractDriftError, PortError } from '../../src/human/errors.js';
import { EXPECTED_TOOLS, TOOL_CLASS, assertCallable } from '../../src/human/policy.js';
import { redact } from '../../src/util.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

/** What the contract check records for one tool: its class, annotations and a hash of its input schema. */
export function describeTool(tool) {
  const annotations = {};
  for (const h of HINTS) if (tool.annotations?.[h] !== undefined) annotations[h] = tool.annotations[h];
  return { class: TOOL_CLASS[tool.name] ?? 'unknown', annotations, inputSchemaHash: sha256(canonical(tool.inputSchema ?? {})) };
}

export function loadManifest(file = path.join(HERE, 'tools.manifest.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Compares the live tool list with the audited manifest. Any difference is drift and blocks delegation (fail closed). */
export function compareContract(serverInfo, tools, manifest) {
  const problems = [];
  if (serverInfo?.name !== manifest.server.name) problems.push(`server name ${serverInfo?.name} ≠ ${manifest.server.name}`);
  if (serverInfo?.version !== manifest.server.version) problems.push(`server version ${serverInfo?.version} ≠ pinned ${manifest.server.version}`);
  const live = new Map(tools.map((t) => [t.name, t]));
  // Three sets must agree: the audited policy, the reviewed manifest and what the server really exposes.
  for (const name of EXPECTED_TOOLS) if (!live.has(name)) problems.push(`missing tool ${name}`);
  for (const name of live.keys()) if (!EXPECTED_TOOLS.includes(name)) problems.push(`unexpected tool ${name}`);
  for (const name of live.keys()) if (!manifest.tools[name]) problems.push(`unexpected tool ${name} (not in the reviewed manifest)`);
  for (const name of Object.keys(manifest.tools)) if (!live.has(name)) problems.push(`missing tool ${name} (listed in the reviewed manifest)`);
  for (const name of EXPECTED_TOOLS) {
    const tool = live.get(name);
    const want = manifest.tools[name];
    if (!tool || !want) continue;
    const got = describeTool(tool);
    if (got.inputSchemaHash !== want.inputSchemaHash) problems.push(`input schema of ${name} changed`);
    for (const h of HINTS) if (got.annotations[h] !== want.annotations[h]) problems.push(`annotation ${h} of ${name} changed`);
  }
  if (problems.length) throw new ContractDriftError(problems);
  return { ok: true, tools: live.size, checkedAt: new Date().toISOString() };
}

const first = (r) => r.structuredContent ?? (() => { try { return JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? 'null'); } catch { return null; } })();

/**
 * MCP port: the CTO is the ONLY client of the AIWORKPAY MCP server. The server runs as a child process over stdio with a
 * minimal environment; the API key lives in that child's environment only (never in logs, records, events or agent prompts).
 * Every call goes through `assertCallable`, so approve_result / request_changes cannot be sent even by mistake.
 */
export class McpPort {
  #key;
  constructor({ mcpDir, baseUrl, apiKey, maxBudget, currency, maxPerHour = 5, manifest = loadManifest(), callTimeoutMs = 30000, command = process.execPath }) {
    if (!mcpDir || !baseUrl || !apiKey) throw new Error('mcpDir, baseUrl and apiKey are required');
    this.mcpDir = mcpDir;
    this.baseUrl = baseUrl;
    this.#key = apiKey;
    this.limits = { maxBudget, currency, maxPerHour };
    this.manifest = manifest;
    this.callTimeoutMs = callTimeoutMs;
    this.command = command;
    this.client = null;
    this.connecting = null;
  }

  toJSON() { return { mcpDir: this.mcpDir, baseUrl: this.baseUrl, limits: this.limits }; }

  async #connect() {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const transport = new StdioClientTransport({
        command: this.command,
        args: [path.join(this.mcpDir, 'dist', 'index.js')],
        env: {
          AIWORKPAY_BASE_URL: this.baseUrl, AIWORKPAY_API_KEY: this.#key,
          AIWORKPAY_MAX_MISSION_BUDGET: String(this.limits.maxBudget), AIWORKPAY_ALLOWED_CURRENCIES: this.limits.currency,
          AIWORKPAY_REQUIRE_CONFIRMATION: 'true', AIWORKPAY_MAX_CREATIONS_PER_HOUR: String(this.limits.maxPerHour)
        },
        stderr: 'ignore'
      });
      const client = new Client({ name: 'cto-ia', version: '0.1.0' });
      transport.onclose = () => { if (this.client === client) this.client = null; };
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #call(name, args = {}) {
    assertCallable(name);
    let result;
    try {
      const client = await this.#connect();
      result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.callTimeoutMs });
    } catch (error) {
      this.client = null;
      throw new PortError(/timed? ?out/i.test(error.message) ? 'TIMEOUT' : 'NETWORK_ERROR', redact(error.message).slice(0, 300), { retryable: true, source: 'mcp_transport' });
    }
    const body = first(result);
    if (result.isError) {
      const e = body?.error ?? {};
      throw new PortError(String(e.code ?? 'API_ERROR'), redact(String(e.message ?? 'MCP error')).slice(0, 300), { retryable: e.retryable === true, retryAfterSeconds: e.retry_after_seconds, httpStatus: e.http_status, source: e.source });
    }
    return { body, result };
  }

  async discover() {
    const client = await this.#connect().catch((error) => { throw new PortError('NETWORK_ERROR', redact(error.message).slice(0, 300), { retryable: true, source: 'mcp_transport' }); });
    const { tools } = await client.listTools();
    return compareContract(client.getServerVersion(), tools, this.manifest);
  }

  async account() {
    const { body } = await this.#call('get_account');
    return {
      scopes: body.permissions?.scopes ?? [], canApprove: body.permissions?.can_approve_and_review === true,
      maxMissionBudget: body.limits?.max_mission_budget ?? null, monthlyBudget: body.limits?.monthly_budget ?? null,
      remainingThisMonth: body.usage?.remaining_this_month ?? null, effectiveMaxBudget: body.effective_max_budget ?? null, canCreateNow: body.can_create_now
    };
  }

  async preview(args) { return (await this.#call('create_mission', { ...args, confirm: false })).body; }

  async create(args) {
    const { body } = await this.#call('create_mission', { ...args, confirm: true });
    return { missionId: body.mission_id, status: body.status, alreadyExisted: body.already_existed === true, paymentUrl: body.payment_url ?? null, paymentUrlExpiresAt: body.payment_url_expires_at ?? null };
  }

  async status(missionId) {
    const { body } = await this.#call('get_mission_status', { mission_id: missionId });
    return { status: body.status, nextAction: body.next_action, isPastDeadline: body.is_past_deadline === true };
  }

  async result(missionId) {
    const { body } = await this.#call('get_mission_result', { mission_id: missionId });
    return { available: body.available === true, status: body.status, validated: body.validated === true, deliveredAt: body.delivered_at ?? null, note: body.note ?? null, data: body.data ?? null, proofs: body.proofs ?? [] };
  }

  async proof(missionId, proofId) {
    const { body, result } = await this.#call('get_proof_file', { mission_id: missionId, proof_id: proofId });
    const part = result.content?.find((c) => c.type === 'image' || c.type === 'resource');
    const data = part?.type === 'image' ? part.data : part?.resource?.blob;
    if (typeof data !== 'string') throw new PortError('PROOF_NOT_RETURNED', 'The MCP returned no file content', { source: 'mcp_server' });
    return { meta: body, bytes: Buffer.from(data, 'base64'), mimeType: part.type === 'image' ? part.mimeType : part.resource.mimeType };
  }

  async cancel(missionId) {
    const { body } = await this.#call('cancel_mission', { mission_id: missionId, confirm: true });
    return { status: body.status };
  }

  async close() {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => {});
  }
}
