// sbb help: the overview, the protocol rules, and the drift guard against bin/sbb.js
// (task m2/h1-spawn-defaults item 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { COMMANDS, overviewText, protocolText, run } from '../src/cli/help.js';
import { renderBrief } from '../src/lifecycle/briefing.js';

const execFileP = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'bin', 'sbb.js');

/** Command names in bin/sbb.js, in table order. */
function binCommands() {
  const source = readFileSync(BIN, 'utf8');
  const block = source.slice(source.indexOf('const COMMANDS = {'), source.indexOf('\n};', source.indexOf('const COMMANDS = {')));
  return [...block.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);
}

test('help: the overview lists exactly the commands bin/sbb.js dispatches', () => {
  assert.deepEqual(COMMANDS.map(([name]) => name), binCommands());
  const text = overviewText();
  for (const [name, , summary] of COMMANDS) {
    assert.match(text, new RegExp(`^ {2}${name} +${summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.match(text, /sbb help protocol/);
});

test('help protocol: every command has one usage line and the rules match the briefing', () => {
  const text = protocolText();
  for (const [name, usage] of COMMANDS) {
    assert.ok(usage.startsWith(`sbb ${name}`), usage);
    assert.ok(text.includes(usage), `protocol is missing the usage of ${name}`);
  }
  const brief = renderBrief({ brain: { id: 'SMS-0001', name: 'lead', role: 'main' }, user: 'steven' });
  for (const line of text.split('\n').filter((l) => l.startsWith('- '))) {
    assert.ok(brief.includes(line), `briefing is missing: ${line}`);
  }
  assert.ok(text.includes('按用户指令处理'));
  assert.ok(brief.includes('按用户指令处理'), 'the brief carries the [用户] rule too');
});

test('help run: no topic and `protocol` print, anything else is a usage error', async () => {
  const logs = [];
  const errors = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => logs.push(String(line));
  console.error = (line) => errors.push(String(line));
  try {
    assert.equal(await run([]), 0);
    assert.equal(logs[0], overviewText());
    logs.length = 0;
    assert.equal(await run(['protocol']), 0);
    assert.equal(logs[0], protocolText());
    logs.length = 0;
    assert.equal(await run(['bogus']), 2);
    assert.deepEqual(logs, []);
    assert.match(errors[0], /unknown help topic "bogus"/);
  } finally {
    console.log = log;
    console.error = error;
  }
});

test('bin/sbb.js: `sbb help` works through the real entry point', async () => {
  const overview = await execFileP(process.execPath, [BIN, 'help']);
  assert.equal(overview.stdout, `${overviewText()}\n`);
  const protocol = await execFileP(process.execPath, [BIN, 'help', 'protocol']);
  assert.equal(protocol.stdout, `${protocolText()}\n`);
  await assert.rejects(
    execFileP(process.execPath, [BIN, 'help', 'bogus']),
    (err) => err.code === 2 && /unknown help topic/.test(err.stderr),
  );
});
