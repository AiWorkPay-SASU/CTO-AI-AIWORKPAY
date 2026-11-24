/**
 * Tool policy for the AIWORKPAY MCP (13 tools of aiworkpay-mcp-server 0.7.0).
 *
 * D3 — strict separation between technical orchestration and financial authority: the CTO can read and can *delegate*
 * (create/cancel a mission whose exact brief a human approved), but it can never validate a result, pay a Payworker or
 * send a mission back for changes. Those two tools are classified `authority`: they stay with the human, and the call
 * wrapper refuses them whatever the caller passes. The API key given to the CTO must not carry `missions:approve` either
 * (checked before every submission, see delegations.js): two independent locks.
 */
export const TOOL_CLASS = Object.freeze({
  create_mission: 'delegate',
  cancel_mission: 'delegate',
  get_mission: 'read',
  get_mission_status: 'read',
  get_mission_result: 'read',
  get_proof_file: 'read',
  list_missions: 'read',
  get_account: 'read',
  list_transactions: 'read',
  prepare_workforce_handoff: 'read',
  get_workforce_handoff: 'read',
  approve_result: 'authority',
  request_changes: 'authority'
});

export const EXPECTED_TOOLS = Object.freeze(Object.keys(TOOL_CLASS).sort());

export const CTO_CALLABLE = Object.freeze(
  new Set(Object.entries(TOOL_CLASS).filter(([, c]) => c === 'read' || c === 'delegate').map(([n]) => n))
);

export class ToolDeniedError extends Error {
  constructor(tool, reason) {
    super(`MCP tool "${tool}" refused: ${reason}`);
    this.name = 'ToolDeniedError';
    this.code = 'TOOL_DENIED';
    this.tool = tool;
  }
}

/** Throws unless the CTO may call this tool. Unknown tools are refused (fail closed). */
export function assertCallable(tool) {
  const cls = TOOL_CLASS[tool];
  if (!cls) throw new ToolDeniedError(tool, 'unknown tool (not in the audited contract)');
  if (cls === 'authority') throw new ToolDeniedError(tool, 'financial authority belongs to a human, never to the CTO');
  return cls;
}

/** The only API-key permission the CTO may hold is read + write; `missions:approve` makes delegation impossible. */
export function assertKeyScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.includes('missions:approve')) {
    const e = new Error('The AIWORKPAY key given to the CTO carries missions:approve: refusing to operate (D3).');
    e.code = 'KEY_HAS_APPROVE_SCOPE';
    throw e;
  }
  for (const needed of ['missions:read', 'missions:write']) {
    if (!list.includes(needed)) {
      const e = new Error(`The AIWORKPAY key lacks ${needed}.`);
      e.code = 'KEY_SCOPE_MISSING';
      throw e;
    }
  }
}
