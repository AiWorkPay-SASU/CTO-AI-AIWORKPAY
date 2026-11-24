/**
 * Spending ceilings for human delegations, in the mission currency (one currency). Deny by default: a ceiling that is not set
 * (or is 0) disables delegation. Reservations are persisted on the delegation record itself, so they survive restarts.
 */
export function humanConfigFromEnv(env = process.env) {
  const num = (name) => { const n = Number(env[name]); return Number.isFinite(n) && n > 0 ? n : 0; };
  const cfg = {
    on: env.CTO_HUMAN_LOOP === 'on',
    currency: /^[A-Za-z]{3}$/.test(env.CTO_HUMAN_CURRENCY ?? '') ? env.CTO_HUMAN_CURRENCY.toUpperCase() : null,
    maxPerDelegation: num('CTO_HUMAN_MAX_PER_DELEGATION'),
    monthlyBudget: num('CTO_HUMAN_MONTHLY_BUDGET'),
    maxPerDay: Math.floor(num('CTO_HUMAN_MAX_PER_DAY')),
    approvalTtlMs: num('CTO_HUMAN_APPROVAL_TTL_MS') || 24 * 3600 * 1000,
    pollMinMs: env.CTO_HUMAN_POLL_MS === undefined ? 300000 : Math.max(0, Number(env.CTO_HUMAN_POLL_MS) || 0),
    maxSubmitAttempts: 10,
    quarantineDir: env.CTO_HUMAN_QUARANTINE_DIR || null
  };
  const reasons = [];
  if (!cfg.on) reasons.push('CTO_HUMAN_LOOP is not "on"');
  if (!cfg.currency) reasons.push('CTO_HUMAN_CURRENCY is not set');
  if (!cfg.maxPerDelegation) reasons.push('CTO_HUMAN_MAX_PER_DELEGATION is not set');
  if (!cfg.monthlyBudget) reasons.push('CTO_HUMAN_MONTHLY_BUDGET is not set');
  if (!cfg.maxPerDay) reasons.push('CTO_HUMAN_MAX_PER_DAY is not set');
  return { ...cfg, enabled: reasons.length === 0, disabledReasons: reasons };
}

const COUNTED = new Set(['reserved', 'committed']);
const sameMonth = (a, b) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
const sameDay = (a, b) => sameMonth(a, b) && a.getUTCDate() === b.getUTCDate();

/** What is already engaged this month / today, from the persisted records. */
export function usage(records, now) {
  const at = new Date(now);
  let month = 0;
  let day = 0;
  for (const r of records) {
    if (!r.ledger || !COUNTED.has(r.ledger.status)) continue;
    const when = new Date(r.ledger.at);
    if (sameMonth(when, at)) month += r.ledger.amount;
    if (sameDay(when, at)) day += 1;
  }
  return { month: Math.round(month * 100) / 100, day };
}

/** Returns { ok, reasons[] } for one more delegation of `amount`. */
export function checkCeilings({ config, records, amount, currency, now }) {
  const reasons = [];
  if (!config.enabled) reasons.push(`delegation disabled: ${config.disabledReasons.join(', ')}`);
  if (currency !== config.currency) reasons.push(`currency ${currency} is not the allowed currency ${config.currency}`);
  if (amount > config.maxPerDelegation) reasons.push(`budget ${amount} exceeds the per-delegation ceiling ${config.maxPerDelegation}`);
  const u = usage(records, now);
  if (Math.round((u.month + amount) * 100) / 100 > config.monthlyBudget) reasons.push(`monthly ceiling ${config.monthlyBudget} would be exceeded (already engaged ${u.month})`);
  if (u.day + 1 > config.maxPerDay) reasons.push(`daily limit of ${config.maxPerDay} delegations reached`);
  return { ok: reasons.length === 0, reasons, usage: u };
}
