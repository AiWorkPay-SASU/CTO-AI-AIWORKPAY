// Child process for the SIGKILL recette: it starts a CTO worker whose agent never answers, so the parent can
// kill -9 the whole process while a task is leased and then prove that a new process recovers the mission.
import fs from 'node:fs';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/index.js';
import { trustedFixtureTests } from './fixtures.js';

const { DATA_DIR, REPO, WS_DIR, MARKER } = process.env;
const cto = new Cto({
  store: new FileStore(DATA_DIR), repoPath: REPO, workspacesDir: WS_DIR, testRunner: trustedFixtureTests,
  workerId: 'doomed-worker', limits: { leaseMs: 400, backoffMs: 1, reconcileGraceMs: 0 },
  runner: async () => {
    fs.writeFileSync(MARKER, 'agent running');
    await new Promise(() => {}); // never answers
  }
});
await cto.tick();
setInterval(() => {}, 1000); // keep the process (and its heartbeat) alive until it is killed
