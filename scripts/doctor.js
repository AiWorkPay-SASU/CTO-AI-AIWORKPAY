// Prints the real runtime checks (Linux, Node, Claude CLI, bubblewrap). Exit code 1 when BLOCKED.
import { runPreflight } from '../src/preflight.js';

const pf = await runPreflight();
for (const c of pf.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`);
console.log(`runtime: ${pf.status} (${pf.isolation}; container_certified=${pf.container_certified})`);
process.exit(pf.ok ? 0 : 1);
