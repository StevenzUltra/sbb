// POST /api/policy wire shapes (docs/spec/ui-server.md): the console says 开 / 审核 / 关, the
// config file and the CLI say on / moderated / off. Every settings control builds its body here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowBody, brainOverrides, brainPeersBody, denyBody, peersBody, quotaBody,
  spawnArgsBody, spawnCommandBody, spawnPreambleBody, spawnShellBody, subsDirectBody, terminalBody,
  uiPeerMode, wirePeerMode,
} from '../web/src/lib/policy.js';

test('peer modes translate between the UI and the config file', () => {
  assert.equal(wirePeerMode('open'), 'on');
  assert.equal(wirePeerMode('moderated'), 'moderated');
  assert.equal(wirePeerMode('closed'), 'off');
  assert.equal(wirePeerMode('nonsense'), 'on', 'unknown modes never invent a wire value');

  assert.equal(uiPeerMode('on'), 'open');
  assert.equal(uiPeerMode('moderated'), 'moderated');
  assert.equal(uiPeerMode('off'), 'closed');
  assert.equal(uiPeerMode(undefined), 'open');
});

test('the status bar cycle sends the wire vocabulary, not the labels', () => {
  assert.deepEqual(peersBody('closed'), { peers: 'off' });
  assert.deepEqual(peersBody('open'), { peers: 'on' });
});

test('per-brain override and extra pairs use the set/allow/deny keys', () => {
  assert.deepEqual(brainPeersBody('SSL-0046', 'moderated'), { set: { ref: 'SSL-0046', peers: 'moderated' } });
  assert.deepEqual(brainPeersBody('SSL-0046', 'open', true), { set: { ref: 'SSL-0046', peers: 'on', autonomous: true } });
  assert.deepEqual(allowBody(['SSL-0045', 'SSL-0047']), { allow: ['SSL-0045', 'SSL-0047'] });
  assert.deepEqual(denyBody(['SSL-0045', 'SSL-0047']), { deny: ['SSL-0045', 'SSL-0047'] });
});

test('quota floors only carry the fields that were edited', () => {
  assert.deepEqual(quotaBody({ floorWeekly: '15', mainReserve: 25 }), { quota: { floorWeekly: 15, mainReserve: 25 } });
  assert.deepEqual(quotaBody({ floorWeekly: '' }), { quota: {} });
  assert.deepEqual(quotaBody({}), { quota: {} });
});

test('launcher and terminal settings use the keys the server added for layout v2', () => {
  assert.deepEqual(spawnArgsBody('claude', '--dangerously-skip-permissions'), { spawnArgs: { cli: 'claude', args: '--dangerously-skip-permissions' } });
  assert.deepEqual(spawnPreambleBody('claude', 'source ~/spxy.sh on'), { spawnPreamble: { cli: 'claude', value: 'source ~/spxy.sh on' } });
  assert.deepEqual(spawnCommandBody('codex', '/usr/local/bin/cc'), { spawnCommand: { cli: 'codex', value: '/usr/local/bin/cc' } });
  assert.deepEqual(spawnShellBody('/bin/zsh'), { spawnShell: '/bin/zsh' });
  assert.deepEqual(subsDirectBody(false), { subsDirect: false });
  assert.deepEqual(terminalBody('ghostty'), { terminal: 'ghostty' });
  assert.deepEqual(terminalBody(null), { terminal: null }, 'null means "whichever is installed"');
});

test('brainOverrides lists the per-brain rows of the policy', () => {
  assert.deepEqual(brainOverrides({ brains: { 'SSL-0046': { peers: 'moderated' }, 'SSL-0045': { autonomous: true } } }), [
    { id: 'SSL-0046', peers: 'moderated' },
    { id: 'SSL-0045', autonomous: true },
  ]);
  assert.deepEqual(brainOverrides(null), []);
});
