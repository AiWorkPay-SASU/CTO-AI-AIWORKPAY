import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from '../src/server.js';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/index.js';
import {
  makeRepo, tmpDir, write, scriptedRunner, PLAN, GOOD_SLUG, SLUG_TEST, trustedFixtureTests
} from '../testkit/fixtures.js';

// Real Chromium driving the real MissionControl UI against the real HTTP server and the real CTO engine.
// Only the agents are scripted doubles (they really edit the git worktrees). Playwright is not a dependency of
// the project: without it these tests are skipped with an explicit reason, and CI makes that a failure
// (CTO_REQUIRE_BROWSER_TESTS=1).

const ADMIN = 'admin-token-0123456789-abcdefghij';
const VIEWER = 'viewer-token-0123456789-abcdefghij';
const require = createRequire(import.meta.url);

let chromium = null;
let unavailable = null;
try {
  ({ chromium } = require('playwright'));
  const probe = await chromium.launch();
  await probe.close();
} catch (error) {
  unavailable = `browser automation unavailable: ${String(error.message).split('\n')[0]}`;
}
const guard = (t) => {
  if (!unavailable) return false;
  if (process.env.CTO_REQUIRE_BROWSER_TESTS === '1') assert.fail(unavailable);
  t.skip(unavailable);
  return true;
};

const backendGood = async ({ cwd }) => { write(cwd, 'src/slug.js', GOOD_SLUG); write(cwd, 'test/slug.test.js', SLUG_TEST); return { result: 'ok' }; };

async function boot(t, steps = {}) {
  const runner = scriptedRunner({ architect: [async () => ({ result: PLAN })], backend: [backendGood], ...steps });
  const cto = new Cto({
    store: new FileStore(tmpDir('cto-e2e-data-')), runner, repoPath: makeRepo(), workspacesDir: tmpDir('cto-e2e-ws-'),
    testRunner: trustedFixtureTests, limits: { backoffMs: 5, reconcileGraceMs: 0 }
  });
  const server = createServer({ cto, adminToken: ADMIN, viewerToken: VIEWER });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cto.startWorker(100);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await browser.close();
    await cto.stopWorker();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { cto, page, base, errors, runner };
}

const login = async (page, base, token) => {
  await page.goto(base);
  await page.fill('#token', token);
  await page.getByRole('button', { name: 'Connexion' }).click();
};
const status = (page, s, timeout = 25000) =>
  page.waitForFunction((expected) => document.querySelector('article.mission .badge')?.textContent === expected, s, { timeout });
const createMission = async (page, budget = '5') => {
  await page.fill('#project', 'owner/repo');
  await page.fill('#objective', 'Add a slugify helper with tests');
  await page.fill('#budget', budget);
  await page.getByRole('button', { name: 'Créer' }).click();
  await status(page, 'pending_approval');
};

test('browser: wrong token, login, mission, approvals, evidence, reload keeps history, completion offers no merge', async (t) => {
  if (guard(t)) return;
  const { page, base, errors } = await boot(t);

  await login(page, base, 'wrong-token-0123456789-abcdefgh');
  await page.waitForSelector('#banner:not([hidden])');
  assert.match(await page.textContent('#banner'), /jeton invalide|Session expirée/);

  await login(page, base, ADMIN);
  await page.waitForFunction(() => /Connecté : owner \(jeton [0-9a-f]{8}\)/.test(document.getElementById('who').textContent));
  assert.equal(await page.locator('#agents li').count(), 4, 'agents panel lists qa, security, architect, backend');

  await createMission(page);
  assert.equal(await page.locator('article.mission tr[data-role]').count(), 4);
  assert.match(await page.locator('tr[data-role="qa"] td').nth(2).textContent(), /backend/, 'dependencies are visible');
  assert.match(await page.locator('tr[data-role="backend"] td').nth(2).textContent(), /architect.*approbation architecture/);

  await page.getByRole('button', { name: 'Démarrer la mission' }).click();
  await status(page, 'awaiting_owner');
  await page.getByRole('button', { name: "Valider l'architecture" }).click();
  await status(page, 'review');

  await page.getByText('Rapports, audit, PR').click();
  const delivery = page.locator('[id^="delivery-"]');
  await delivery.waitFor();
  await page.waitForFunction(() => /cto\/[0-9a-f]{8}\/backend-[0-9a-f]{8} @ [0-9a-f]{12}/.test(document.querySelector('[id^="delivery-"]').textContent));
  assert.match(await delivery.textContent(), /tests exécutés par le CTO : [1-9]\d* ok \/ 0 ko/);
  const journal = await page.locator('details table').last().textContent();
  for (const type of ['approval_recorded', 'task_verified', 'approval_requested']) assert.match(journal, new RegExp(type));

  // The UI keeps no credential: a reload logs out, and after logging in again the history is still there.
  await page.reload();
  assert.equal(await page.locator('article.mission').count(), 0);
  await login(page, base, ADMIN);
  await status(page, 'review');
  await page.getByText('Rapports, audit, PR').click();
  await page.waitForFunction(() => document.querySelector('details table')?.textContent.includes('approval_recorded'));

  await page.getByRole('button', { name: /Valider le résultat/ }).click();
  await status(page, 'completed');
  assert.equal(await page.getByRole('button', { name: /merge|fusionner/i }).count(), 0, 'merging is never offered');
  assert.deepEqual(errors, [], 'no uncaught error in the page');
});

test('browser: the read-only viewer sees everything and can change nothing', async (t) => {
  if (guard(t)) return;
  const { page, base, cto } = await boot(t);
  await cto.createMission({ objective: 'Add a slugify helper', project: 'owner/repo' });
  await login(page, base, VIEWER);
  await status(page, 'pending_approval');
  assert.match(await page.textContent('#who'), /viewer/);
  for (const name of [/Démarrer/, /Refuser/, /Annuler/, /Relever/, /Reprendre/]) {
    assert.equal(await page.getByRole('button', { name }).count(), 0, `${name} is hidden`);
  }
  const forced = await page.request.post(`${base}/api/missions/${(await cto.listMissions())[0].id}/approvals`, {
    headers: { authorization: `Bearer ${VIEWER}`, 'content-type': 'application/json' }, data: { kind: 'mission', decision: 'approve' }
  });
  assert.equal(forced.status(), 403, 'the server refuses it even when the UI is bypassed');
});

test('browser: refusing the mission cancels it', async (t) => {
  if (guard(t)) return;
  const { page, base } = await boot(t);
  await login(page, base, ADMIN);
  await createMission(page);
  await page.getByRole('button', { name: 'Refuser' }).click();
  await status(page, 'cancelled');
  assert.equal(await page.getByRole('button', { name: /Démarrer|Annuler|Refuser/ }).count(), 0);
});

test('browser: a budget block is shown, and raising the budget lets the mission finish', async (t) => {
  if (guard(t)) return;
  const { page, base } = await boot(t);
  await login(page, base, ADMIN);
  await createMission(page, '0.7');
  await page.getByRole('button', { name: 'Démarrer la mission' }).click();
  await status(page, 'awaiting_owner');
  await page.getByRole('button', { name: "Valider l'architecture" }).click();
  await status(page, 'blocked');
  assert.match(await page.locator('article.mission').textContent(), /Budget would be exceeded/);
  await page.getByLabel('Nouveau budget en USD').fill('5');
  await page.getByRole('button', { name: 'Relever le budget' }).click();
  await status(page, 'review');
});

test('browser: an escalated mission is resumed from the UI after the agent kept crashing', async (t) => {
  if (guard(t)) return;
  const crash = async () => { throw new Error('agent crashed'); };
  const { page, base } = await boot(t, { backend: [crash, crash, crash, backendGood] });
  await login(page, base, ADMIN);
  await createMission(page, '10');
  await page.getByRole('button', { name: 'Démarrer la mission' }).click();
  await status(page, 'awaiting_owner');
  await page.getByRole('button', { name: "Valider l'architecture" }).click();
  await status(page, 'blocked');
  assert.equal(await page.locator('tr[data-role="backend"] .badge').textContent(), 'failed');
  await page.getByRole('button', { name: 'Reprendre' }).click();
  await status(page, 'review');
  assert.equal(await page.locator('tr[data-role="backend"] .badge').textContent(), 'done');
});
