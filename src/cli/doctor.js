// sbb doctor: environment check. Exit 0 when tmux is reachable. docs/spec/cli.md.
import { existsSync } from 'node:fs';
import net from 'node:net';
import { run as defaultRun } from '../lib/exec.js';
import { tmux as defaultTmux } from '../lib/tmux.js';
import { discoverAccounts, usageGuardDb } from '../lib/paths.js';
import { listClaudeSessions } from '../registry/claude-sessions.js';
import { duplicateIdentities, listBrains, listRetiredBrains } from '../registry/brains.js';
import { usageGuardBinary } from '../quota/usage-guard.js';
import { which as whichBinary } from '../quota/catalog.js';
import { EXIT, main, parse, writeJson } from './util.js';

const USAGE = `usage: sbb doctor [--json]

Prints the tmux server, discovered accounts, live Claude sessions with socket
connectivity, brain id health, the Codex binary, and Usage Guard presence.
Exit 1 when tmux is unreachable or a brain id/uuid is duplicated.`;

/**
 * @param {string} path
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
export function checkSocket(path, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (!path) {
      resolve('no_socket_path');
      return;
    }
    const socket = net.connect({ path });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('ok'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', (err) => done(`error:${err?.code ?? err?.message}`));
  });
}

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values } = parse(argv, {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const tmux = deps.tmux ?? defaultTmux;
    const exec = deps.exec ?? defaultRun;
    const accounts = deps.accounts ?? discoverAccounts();

    /** @type {string|null} */
    let tmuxSocket = null;
    /** @type {string|null} */
    let tmuxVersion = null;
    let tmuxOk = false;
    try {
      tmuxSocket = await tmux(['display-message', '-p', '#{socket_path}']);
      tmuxOk = Boolean(tmuxSocket);
    } catch (err) {
      tmuxSocket = `unreachable: ${err?.message ?? err}`;
    }
    if (tmuxOk) {
      try {
        tmuxVersion = (await tmux(['-V'])).trim();
      } catch {
        tmuxVersion = null;
      }
    }

    const sessions = (deps.listClaudeSessions ?? listClaudeSessions)(accounts);
    /** @type {{ pid: number, account: string, name: string|undefined, sock: string|undefined, connect: string, status: string|undefined }[]} */
    const sessionRows = [];
    for (const session of sessions) {
      sessionRows.push({
        pid: session.pid,
        account: session.account,
        name: session.name,
        sock: session.sock,
        connect: await (deps.checkSocket ?? checkSocket)(session.sock),
        status: session.status,
      });
    }

    const which = deps.which ?? ((name) => whichBinary(name));
    const codexPath = which('codex');
    const codexVersion = await (async () => {
      const result = await exec('codex', ['--version'], { timeoutMs: 10000 });
      return result.code === 0 ? result.stdout.trim() : `unavailable (${result.stderr.trim().split('\n')[0] || 'not found'})`;
    })();

    const brains = (deps.listBrains ?? listBrains)();
    const retired = (deps.listRetiredBrains ?? listRetiredBrains)();
    const duplicates = (deps.duplicateIdentities ?? duplicateIdentities)();
    const identitiesOk = duplicates.ids.length === 0 && duplicates.uuids.length === 0;

    const usageGuardApp = usageGuardBinary(deps.env);
    const usageGuardDbPath = deps.dbPath ?? usageGuardDb();
    const report = {
      tmux: { ok: tmuxOk, socket: tmuxSocket, version: tmuxVersion },
      accounts: accounts.map((a) => ({ name: a.name, claudeDir: a.claudeDir ?? null, codexDir: a.codexDir ?? null })),
      claudeSessions: sessionRows,
      brains: { live: brains.length, retired: retired.length, duplicates },
      codex: { path: codexPath ?? null, version: codexVersion },
      usageGuard: { app: usageGuardApp ?? null, db: usageGuardDbPath, dbExists: existsSync(usageGuardDbPath) },
    };

    if (values.json) {
      writeJson(report);
      return tmuxOk && identitiesOk ? EXIT.OK : EXIT.INTERNAL;
    }

    console.log(`tmux        ${tmuxOk ? 'ok' : 'UNREACHABLE'}  socket=${tmuxSocket ?? '-'}${tmuxVersion ? `  ${tmuxVersion}` : ''}`);
    console.log(`accounts    ${accounts.map((a) => a.name).join(' ') || '-'}`);
    if (sessionRows.length === 0) {
      console.log('claude      no live sessions');
    }
    for (const row of sessionRows) {
      console.log(`claude      pid=${row.pid}  account=${row.account}  name=${row.name ?? '-'}  status=${row.status ?? '-'}  sock=${row.sock ?? '-'}  connect=${row.connect}`);
    }
    console.log(
      identitiesOk
        ? `brains      live=${brains.length} retired=${retired.length}`
        : `brains      DUPLICATE ids=${duplicates.ids.join(',') || '-'} uuids=${duplicates.uuids.join(',') || '-'}`,
    );
    console.log(`codex       ${codexPath ?? '(not on PATH)'}  ${codexVersion}`);
    console.log(`usage-guard app=${usageGuardApp ?? '(not installed)'}  db=${usageGuardDbPath}  dbExists=${existsSync(usageGuardDbPath)}`);
    return tmuxOk && identitiesOk ? EXIT.OK : EXIT.INTERNAL;
  });
}
