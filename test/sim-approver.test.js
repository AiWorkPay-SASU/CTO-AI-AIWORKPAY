import test from 'node:test';
import assert from 'node:assert/strict';
import { AiworkpaySim } from '../testkit/aiworkpay-sim.js';

// Semantics of the PROPOSED backend evolution (approver key distinct from the creating key), as modelled by the simulator.
// This validates the model, not the real backend.
const H = (k) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
const CREATOR = 'awp_sim_cto_key_00000000';
const APPROVER = 'awp_sim_approver_0000000';

test('simulator: today the creating key alone can approve; a sibling key cannot', () => {
  const sim = new AiworkpaySim({ keys: { [CREATOR]: ['missions:read', 'missions:write'], [APPROVER]: ['missions:read', 'missions:approve'] } });
  const created = sim.handle('POST', '/api/missions', { ...H(CREATOR), 'idempotency-key': 'k1' },
    JSON.stringify({ title: 'T', description: 'Photo de la façade du magasin', type: 'photo', budget: 20, currency: 'EUR', deadline: '2099-01-01T10:00:00Z', paymentMode: 'checkout' }));
  const id = created.body.mission?.id ?? JSON.parse(created.body).mission.id;
  sim.ownerPays(id); sim.workerAccepts(id); sim.workerDelivers(id, { note: 'ok', data: {}, proofs: [] });
  assert.equal(sim.handle('POST', `/api/missions/${id}/approve`, H(CREATOR), '{}').status, 403, 'creator has no approve scope');
  assert.equal(sim.handle('POST', `/api/missions/${id}/approve`, H(APPROVER), '{}').status, 404, 'sibling key: not the creator → not found');
  sim.approverKeys.add(APPROVER); // proposed evolution enabled
  assert.equal(sim.handle('POST', `/api/missions/${id}/approve`, H(APPROVER), '{}').status, 200, 'approver key validates, the creator never held the scope');
});
