// sbb ui: serve the local web console (docs/spec/ui-server.md). Owner: docs/tasks/m3-h1-ui-server.md.
import { execFile } from 'node:child_process';
import { createUiServer, DEFAULT_PORT } from '../ui/server.js';
import { EXIT, main, parse, UsageError, writeJson } from './util.js';

const USAGE = `usage: sbb ui [--port <n>] [--no-open] [--json]

Serves the web console on 127.0.0.1 only. Every request needs the token printed at
startup (also stored in ~/.sbb/ui-token, mode 0600); the URL carries it as ?t=.
  --port <n>  listen port (default ${DEFAULT_PORT}, 0 picks a free one)
  --no-open   do not open a browser (macOS opens it by default)
  --json      print {url, port, token} instead of the human line
Stop with Ctrl-C. The console drives the same commands as the CLI; it never
implements policy or delivery itself.`;

/** @param {string} url */
function defaultOpen(url, deps = {}) {
  if (process.platform !== 'darwin') {
    console.error(`sbb ui: open ${url} in a browser (no automatic opener on ${process.platform})`);
    return;
  }
  (deps.execFile ?? execFile)('open', [url], (err) => {
    if (err) console.error(`sbb ui: cannot open the browser: ${err.message}`);
  });
}

/** Resolve on the first SIGINT/SIGTERM so the caller can close cleanly. */
function waitForSignal() {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
}

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values } = parse(argv, {
      port: { type: 'string' },
      open: { type: 'boolean', default: true },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    let port = DEFAULT_PORT;
    if (values.port !== undefined) {
      port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new UsageError(`--port must be 0..65535, got "${values.port}"`);
      }
    }
    const server = await (deps.createUiServer ?? createUiServer)({ port, deps: deps.serverDeps });
    const info = await server.start({ port });
    if (values.json) writeJson({ url: info.url, port: info.port, token: info.token });
    else console.log(`sbb ui: ${info.url}`);
    if (values.open) (deps.openBrowser ?? defaultOpen)(info.url, deps);
    await (deps.waitForSignal ?? waitForSignal)();
    await server.stop();
    return EXIT.OK;
  });
}
