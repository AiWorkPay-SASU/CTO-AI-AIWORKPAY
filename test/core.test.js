import test from 'node:test';import assert from 'node:assert/strict';import {planMission,validateTransition,summarize} from '../src/core.js';
test('plans two isolated specialist tasks',()=>{const m=planMission('Build API','repo');assert.equal(m.tasks.length,2);assert.deepEqual(m.tasks.map(x=>x.role),['architect','backend']);assert.equal(m.status,'pending_approval')});
test('rejects empty mission',()=>assert.throws(()=>planMission('','repo')));
test('blocks unauthorized state jump',()=>assert.throws(()=>validateTransition('pending_approval','completed')));
test('consolidates blockers',()=>{const m=planMission('X','repo');assert.equal(summarize(m,[{role:'backend',status:'blocked',summary:'CI failed'}]).blockers[0],'CI failed')});
