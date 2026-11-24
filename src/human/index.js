import path from 'node:path';
import { HumanLoop } from './delegations.js';
import { humanConfigFromEnv } from './ledger.js';

/**
 * Builds the human-delegation service from the environment. Disabled (returns a disabled HumanLoop without a port) unless
 * CTO_HUMAN_LOOP=on AND every ceiling is set AND the MCP location, backend URL and key are given. The MCP client (and its
 * only npm dependency) is loaded lazily: the rest of the CTO needs no `npm install`.
 *
 *   CTO_HUMAN_LOOP=on  CTO_HUMAN_CURRENCY=EUR  CTO_HUMAN_MAX_PER_DELEGATION=20  CTO_HUMAN_MONTHLY_BUDGET=60  CTO_HUMAN_MAX_PER_DAY=3
 *   AIWORKPAY_MCP_DIR=/path/to/built/aiworkpay-mcp-server  AIWORKPAY_BASE_URL=https://…  AIWORKPAY_API_KEY=awp_…  (server-side only)
 */
export async function humanFromEnv(store, env = process.env, { log = console.error } = {}) {
  const config = humanConfigFromEnv(env);
  config.quarantineDir ??= path.resolve(env.CTO_DATA_DIR || '.cto-data', 'quarantine');
  const missing = ['AIWORKPAY_MCP_DIR', 'AIWORKPAY_BASE_URL', 'AIWORKPAY_API_KEY'].filter((n) => !env[n]);
  if (config.enabled && missing.length) {
    config.enabled = false;
    config.disabledReasons.push(`missing ${missing.join(', ')}`);
  }
  let port = null;
  if (config.enabled) {
    try {
      const { McpPort } = await import('../../integrations/aiworkpay/mcp-port.js');
      port = new McpPort({
        mcpDir: env.AIWORKPAY_MCP_DIR, baseUrl: env.AIWORKPAY_BASE_URL, apiKey: env.AIWORKPAY_API_KEY,
        maxBudget: config.maxPerDelegation, currency: config.currency, maxPerHour: config.maxPerDay
      });
    } catch (error) {
      config.enabled = false;
      config.disabledReasons.push('MCP client unavailable (run `npm ci --prefix integrations/aiworkpay`)');
      log(`human loop disabled: ${error.code ?? 'error'}`);
    }
  }
  const unavailable = { discover: async () => { throw new Error('disabled'); } };
  return new HumanLoop({ store, port: port ?? unavailable, config });
}
