import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brainsDir } from '../src/lib/paths.js';
import { allocateId, machineTag, maxSeqFromState, sanitizeTag, seqOf, tagFromHostname, tagOf } from '../src/registry/brain-id.js';
import { duplicateIdentities, removeBrain } from '../src/registry/brains.js';
import { appendReceipt } from '../src/registry/receipts.js';
import { tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const MODULE_URL = new URL('../src/registry/brain-id.js', import.meta.url).href;

test('machine tag: config.json wins, hostname initials otherwise', () => {
  const home = tempDir();
  const sbb = join(home, '.sbb');
  mkdirSync(sbb, { recursive: true });
  assert.equal(tagFromHostname('Stevens-Mac-Studio'), 'SMS');
  assert.equal(tagFromHostname('StevendeMac-Studio.local'), 'SSL');
  assert.equal(tagFromHostname('mac'), 'M');
  assert.equal(tagFromHostname(''), 'SBB');
  assert.equal(sanitizeTag('ms'), 'MS');
  assert.equal(sanitizeTag('m b p 1'), 'MBP1');
  assert.equal(sanitizeTag('!!'), undefined);
  assert.equal(machineTag({ sbbDir: sbb, hostname: 'Stevens-Mac-Studio' }), 'SMS');

  writeFileSync(join(sbb, 'config.json'), JSON.stringify({ machineTag: 'ms' }));
  assert.equal(machineTag({ sbbDir: sbb, hostname: 'Stevens-Mac-Studio' }), 'MS');
  writeFileSync(join(sbb, 'config.json'), '{ not json');
  assert.equal(machineTag({ sbbDir: sbb, hostname: 'Stevens-Mac-Studio' }), 'SMS', 'a corrupt config falls back');
});

test('id shape and seq parsing', () => {
  assert.equal(seqOf('SMS-0012'), 12);
  assert.equal(seqOf('sms-0012'), 12);
  assert.equal(seqOf('SMS-12'), undefined, 'at least four digits');
  assert.equal(seqOf('nope'), undefined);
  assert.equal(tagOf('SMS-0012'), 'SMS');
  assert.equal(tagOf('nope'), undefined);
});

test('allocateId increments, pads to 4 and never pads down', () => {
  const home = tempDir();
  const sbb = join(home, '.sbb');
  // The receipt-log probe inside allocateId follows SBB_DIR, so isolate it here too:
  // a unit test must never read (or depend on) the operator's real ~/.sbb log.
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: sbb });
  try {
    const opts = { sbbDir: sbb, tag: 'TST' };
    assert.equal(allocateId(opts), 'TST-0001');
    assert.equal(allocateId(opts), 'TST-0002');
    assert.equal(readFileSync(join(sbb, 'counter'), 'utf8').trim(), '2');

    writeFileSync(join(sbb, 'counter'), '41\n');
    assert.equal(allocateId(opts), 'TST-0042');

    writeFileSync(join(sbb, 'counter'), '9999\n');
    assert.equal(allocateId(opts), 'TST-10000', 'past 9999 the number simply grows');
  } finally {
    restore();
  }
});

test('a missing counter recovers the max seq from brains, retired records and receipts', () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    writeBrain({ id: 'TST-0003', uuid: 'u3', name: 'lead' });
    writeBrain({ id: 'TST-0007', uuid: 'u7', name: 'ios' });
    removeBrain('ios');
    assert.equal(maxSeqFromState('TST'), 7);
    assert.equal(allocateId({ tag: 'TST' }), 'TST-0008');

    appendReceipt({ msgId: 'x', from: 'lead', fromId: 'TST-0011', to: 'h3', text: 'hi   (sbb:xxxxxxxx)' });
    writeFileSync(join(home, '.sbb', 'counter'), '0\n');
    assert.equal(allocateId({ tag: 'TST' }), 'TST-0012', 'a regressed counter cannot reissue an id');
    assert.equal(maxSeqFromState('OTH'), 0, 'another tag does not inflate this one');
  } finally {
    restore();
  }
});

test('20 concurrent allocations never repeat an id', async () => {
  const home = tempDir();
  const dir = join(home, '.sbb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ machineTag: 'TST' }));
  const script = `import(${JSON.stringify(MODULE_URL)}).then((m) => process.stdout.write(m.allocateId()))`;
  const env = { ...process.env, SBB_HOME_OVERRIDE: home, SBB_DIR: dir };
  const results = await Promise.all(
    Array.from({ length: 20 }, () => new Promise((resolve, reject) => {
      execFile(process.execPath, ['-e', script], { env, timeout: 20000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      });
    })),
  );
  assert.equal(results.length, 20);
  assert.equal(new Set(results).size, 20, `duplicate ids: ${results.join(', ')}`);
  assert.deepEqual(
    [...results].sort(),
    Array.from({ length: 20 }, (_, i) => `TST-${String(i + 1).padStart(4, '0')}`),
    'every seq is handed out exactly once',
  );
  assert.equal(readFileSync(join(dir, 'counter'), 'utf8').trim(), '20');
});

test('duplicate ids and uuids are detected across live and retired records', () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    const lead = writeBrain({ id: 'TST-0001', uuid: 'u1', name: 'lead' });
    writeBrain({ id: 'TST-0002', uuid: 'u2', name: 'ios' });
    removeBrain('ios');
    assert.deepEqual(duplicateIdentities(), { ids: [], uuids: [] });

    writeFileSync(join(brainsDir(), 'TST-0001b.json'), `${JSON.stringify({ ...lead, uuid: 'u9' })}\n`);
    assert.deepEqual(duplicateIdentities().ids, ['TST-0001']);
    writeFileSync(join(brainsDir(), 'TST-0005.json'), `${JSON.stringify({ ...lead, id: 'TST-0005' })}\n`);
    assert.deepEqual(duplicateIdentities().uuids, ['u1'], 'the retired record still counts');
  } finally {
    restore();
  }
});
