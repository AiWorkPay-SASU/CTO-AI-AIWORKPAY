import { createHash } from 'node:crypto';
import { containsSecret, sanitizeText } from '../util.js';

export const MISSION_TYPES = Object.freeze(['physical_verification', 'photo', 'phone_call', 'data_collection', 'document_check', 'other']);
const PRIORITIES = ['low', 'medium', 'high'];

export class BriefError extends Error {
  constructor(problems) {
    super(`Invalid brief: ${problems.join('; ')}`);
    this.name = 'BriefError';
    this.code = 'INVALID_BRIEF';
    this.problems = problems;
  }
}

/** Canonical JSON: sorted keys, no undefined, so the same content always hashes the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const briefHash = (brief) => sha256(canonical(brief));

const text = (v, min, max, name, problems) => {
  const s = typeof v === 'string' ? sanitizeText(v, max + 1) : '';
  if (s.length < min || s.length > max) problems.push(`${name} must be ${min}-${max} characters`);
  return s;
};

/**
 * Validates and normalizes a brief: the exact text a human Payworker will read. Content is limited to what a stranger may
 * see (the mission is published on a marketplace): anything that looks like a secret or source code is refused.
 */
export function normalizeBrief(input) {
  const problems = [];
  const b = input && typeof input === 'object' ? input : {};
  const out = {
    type: MISSION_TYPES.includes(b.type) ? b.type : (problems.push(`type must be one of ${MISSION_TYPES.join(', ')}`), null),
    title: text(b.title, 3, 200, 'title', problems),
    instructions: text(b.instructions, 10, 4000, 'instructions', problems),
    budget: null,
    currency: typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency) ? b.currency.toUpperCase() : (problems.push('currency must be a 3-letter ISO code'), null),
    deadline: null,
    priority: PRIORITIES.includes(b.priority ?? 'medium') ? (b.priority ?? 'medium') : (problems.push('priority must be low, medium or high'), null)
  };
  const cents = Math.round(Number(b.budget) * 100);
  if (!(Number(b.budget) > 0) || !Number.isFinite(cents) || Math.abs(cents - Number(b.budget) * 100) > 1e-6) {
    problems.push('budget must be a positive amount with at most 2 decimals');
  } else out.budget = cents / 100;
  const when = typeof b.deadline === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(b.deadline) ? Date.parse(b.deadline) : NaN;
  if (!Number.isFinite(when)) problems.push('deadline must be an ISO 8601 date-time with offset');
  else if (when <= Date.now()) problems.push('deadline must be in the future');
  else out.deadline = new Date(when).toISOString();
  if (b.location !== undefined) {
    const l = b.location && typeof b.location === 'object' ? b.location : {};
    const loc = {};
    for (const [k, max] of [['city', 200], ['address', 500], ['country', 100], ['details', 1000]]) {
      if (l[k] !== undefined) loc[k] = text(l[k], 1, max, `location.${k}`, problems);
    }
    if (Object.keys(loc).length) out.location = loc;
  }
  if (b.deliverables !== undefined) {
    if (!Array.isArray(b.deliverables) || b.deliverables.length > 20) problems.push('deliverables must be at most 20 items');
    else out.deliverables = b.deliverables.map((d, i) => text(d, 1, 300, `deliverables[${i}]`, problems));
  }
  if (problems.length) throw new BriefError(problems);
  const hard = screenBrief(out);
  if (hard.blocking.length) throw new BriefError(hard.blocking);
  return out;
}

const CODE_PATTERNS = [
  [/```/, 'contains a code fence'],
  [/\b(import|export)\s+[\w{*]/, 'looks like source code (import/export)'],
  [/\b(require|eval)\s*\(/, 'looks like source code (require/eval)'],
  [/\b(function|class|const|let|var)\s+[\w$]+\s*[=({]/, 'looks like source code (declaration)'],
  [/(^|\s)(\/home\/|\/etc\/|\/Users\/|[A-Za-z]:\\)/, 'contains a local file path'],
  [/\.env\b|id_rsa|BEGIN [A-Z ]*PRIVATE KEY/i, 'mentions credentials files'],
  [/\bawp_[A-Za-z0-9]{6,}|\bsk-[A-Za-z0-9]{10,}|\bgh[pousr]_[A-Za-z0-9]{10,}/, 'contains an API key']
];
const WARN_PATTERNS = [
  [/https?:\/\/\S+/i, 'contains a URL (visible to every Payworker)'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, 'contains an e-mail address (personal data)'],
  [/(\+?\d[\d .-]{8,}\d)/, 'contains a phone-like number (personal data)']
];

/**
 * Returns `blocking` problems (refuse) and `warnings` (shown to the human approver). The mission is public to Payworkers:
 * G5 — never put confidential code, secrets or personal data in a brief.
 */
export function screenBrief(brief) {
  const body = [brief.title, brief.instructions, ...(brief.deliverables ?? []), ...Object.values(brief.location ?? {})].join('\n');
  const blocking = [];
  const warnings = [];
  if (containsSecret(body)) blocking.push('contains a secret-like value');
  for (const [re, why] of CODE_PATTERNS) if (re.test(body)) blocking.push(why);
  for (const [re, why] of WARN_PATTERNS) if (re.test(body)) warnings.push(why);
  return { blocking: [...new Set(blocking)], warnings };
}

/** Exact arguments of `create_mission` for a brief (without `confirm`), reference stable per delegation + brief. */
export function missionArgs(brief, reference) {
  const args = {
    type: brief.type, title: brief.title, instructions: brief.instructions,
    budget: brief.budget, currency: brief.currency, deadline: brief.deadline, priority: brief.priority,
    client_reference: reference
  };
  if (brief.location) args.location = brief.location;
  if (brief.deliverables) args.deliverables = brief.deliverables;
  return args;
}

/** Idempotency reference: same delegation + same brief ⇒ same reference ⇒ never a second mission. */
export const referenceFor = (delegationId, hash) => `cto-${sha256(`${delegationId}:${hash}`).slice(0, 40)}`;
