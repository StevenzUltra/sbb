// sbb ui CLI: argument parsing, the printed URL, and that --no-open really skips the opener.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT } from '../src/cli/util.js';
import { run } from '../src/cli/ui.js';

/** @param {string[]} argv @param {Record<string, any>} [deps] */
async function capture(argv, deps = {}) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    let value;
    try {
      value = await run(argv, deps);
    } catch (err) {
      value = { threw: String(err?.message ?? err) };
    }
    return { value, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

const INFO = { url: 'http://127.0.0.1:4789/?t=abc', port: 4789, token: 'abc' };

function fakeServer() {
  const calls = [];
  return {
    calls,
    create: async (opts) => {
      calls.push(['create', opts]);
      return {
        start: async (startOpts) => {
          calls.push(['start', startOpts]);
          return INFO;
        },
        stop: async () => {
          calls.push(['stop']);
        },
      };
    },
  };
}

test('--no-open serves and stops without touching the browser', async () => {
  const fake = fakeServer();
  let opened = 0;
  const { value, logs } = await capture(['--no-open'], {
    createUiServer: fake.create,
    openBrowser: () => {
      opened += 1;
    },
    waitForSignal: async () => {},
  });
  assert.equal(value, EXIT.OK);
  assert.equal(opened, 0, 'the opener must not run with --no-open');
  assert.deepEqual(logs, [`sbb ui: ${INFO.url}`]);
  assert.deepEqual(fake.calls.map((c) => c[0]), ['create', 'start', 'stop']);
  assert.equal(fake.calls[0][1].port, 4789);
});

test('the browser opens by default and --json prints the token', async () => {
  const fake = fakeServer();
  const urls = [];
  const { value, logs } = await capture(['--json'], {
    createUiServer: fake.create,
    openBrowser: (url) => urls.push(url),
    waitForSignal: async () => {},
  });
  assert.equal(value, EXIT.OK);
  assert.deepEqual(urls, [INFO.url]);
  assert.deepEqual(JSON.parse(logs.join('\n')), INFO);
});

test('--port validates the range and 0 picks a free port', async () => {
  const fake = fakeServer();
  const bad = await capture(['--port', '99999', '--no-open'], { createUiServer: fake.create });
  assert.notEqual(bad.value, EXIT.OK);
  assert.match(bad.errors.join('\n'), /--port must be 0\.\.65535/);
  assert.deepEqual(fake.calls, [], 'a bad port must not start a server');
  const zero = await capture(['--port', '0', '--no-open'], {
    createUiServer: fake.create,
    waitForSignal: async () => {},
  });
  assert.equal(zero.value, EXIT.OK);
  assert.equal(fake.calls[0][1].port, 0);
});

test('--help prints the usage without starting a server', async () => {
  const fake = fakeServer();
  const { value, logs } = await capture(['--help'], { createUiServer: fake.create });
  assert.equal(value, EXIT.OK);
  assert.match(logs.join('\n'), /usage: sbb ui \[--port <n>\] \[--no-open\] \[--json\]/);
  assert.deepEqual(fake.calls, []);
});
