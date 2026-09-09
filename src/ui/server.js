// sbb ui: the local server behind the web console (docs/spec/ui-server.md).
// Binds 127.0.0.1 only, requires a token on every request, and does nothing itself: every
// action is a call into the module the matching CLI command already uses.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { host } from '../host/index.js';
import { discoverAccounts, sbbDir } from '../lib/paths.js';
import { createTps } from '../metrics/tps.js';
import { listAllClaims } from '../policy/claims.js';
import { readConfig } from '../policy/config.js';
import { listHeld } from '../policy/held.js';
import { getPlan, listPlans } from '../policy/plans.js';
import { catalog } from '../quota/catalog.js';
import { readQuota } from '../quota/usage-guard.js';
import { getBrain, listBrains } from '../registry/brains.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { roster as defaultRoster } from '../registry/roster.js';
import { closeInboxes } from '../transports/claude-uds.js';
import { startInbox } from '../transports/uds-inbox.js';
import { deliver, deliveryInboxDir, parsePeerFrame } from '../cli/util.js';
import { createPaneStream } from './pane-stream.js';
import { snapshot as dataSnapshot, watch as dataWatch } from './data.js';
import { goToTerminal } from './switch.js';
import { DEFAULT_LIMIT, messagesFor, teamLog, transcriptFor } from './history.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The port the spec documents. */
export const DEFAULT_PORT = 4789;

/** Static build of the console. `sbb ui` serves it when it exists. */
export const WEB_DIST = join(ROOT, 'web', 'dist');

/** Console actions are the user, never a brain, even when `sbb ui` runs inside a pane. */
export const USER_IDENTITY = Object.freeze({
  sender: 'user',
  account: null,
  cli: null,
  coord: null,
  role: '用户',
  brain: null,
  id: null,
  address: null,
});

/** Reason vocabulary for HTTP errors: docs/spec/receipts.md. */
export const ERROR_STATUS = Object.freeze({
  usage: 400,
  invalid_input: 400,
  not_found: 404,
  unknown_plan: 404,
  not_pending: 409,
  blocked: 403,
  unverified: 502,
  tmux_failed: 500,
  internal: 500,
});

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
});

/** @param {number} [now] */
export function newToken() {
  return randomBytes(16).toString('hex');
}

/** @param {{ dir?: string }} [opts] */
export function tokenPath(opts = {}) {
  return join(opts.dir ?? sbbDir(), 'ui-token');
}

/**
 * Persist the token so the user can reopen the console without restarting the server.
 * @param {string} token @param {{ dir?: string }} [opts]
 */
export function writeToken(token, opts = {}) {
  const path = tokenPath(opts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return path;
}

/** @param {{ dir?: string }} [opts] */
export function readToken(opts = {}) {
  try {
    return readFileSync(tokenPath(opts), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Constant-time-ish comparison: both sides are fixed-length hex, so length check is enough. */
export function tokenMatches(expected, presented) {
  const a = String(expected ?? '');
  const b = String(presented ?? '');
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** @param {import('node:http').IncomingMessage} req @param {URL} url */
export function presentedToken(req, url) {
  const query = url.searchParams.get('t');
  if (query) return query;
  const header = req.headers['x-sbb-token'];
  if (typeof header === 'string' && header) return header;
  const cookie = String(req.headers.cookie ?? '');
  const match = /(?:^|;\s*)sbb_ui=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** @param {string} text */
function jsonBody(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

/** @param {import('node:http').ServerResponse} res @param {number} code @param {any} body */
function sendJson(res, code, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** @param {import('node:http').ServerResponse} res @param {number} code @param {string} reason @param {string} detail */
function sendError(res, code, reason, detail) {
  sendJson(res, code, { error: { reason, detail } });
}

/** @param {import('node:http').IncomingMessage} req */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{ port?: number, token?: string, host?: typeof host, deps?: Record<string, any>,
 *           dist?: string, open?: boolean }} [opts]
 */
export async function createUiServer(opts = {}) {
  const api = opts.host ?? host;
  const deps = opts.deps ?? {};
  const token = opts.token ?? newToken();
  const dist = opts.dist ?? WEB_DIST;
  // Everything this server writes (the token) and watches lives under one directory.
  const stateDir = deps.sbbDir ?? sbbDir();
  const tps = createTps({ host: api });
  /** @type {Map<string, any>} */
  const tpsValues = new Map();
  /** @type {Map<string, any>} */
  const streams = new Map();
  /** @type {Set<any>} */
  const sseClients = new Set();
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  /** @type {any} */
  let inbox;
  /** @type {{ close: () => void }|null} */
  let watcher = null;
  let closed = false;

  // ---------------------------------------------------------------- state

  /**
   * `/api/state` comes from src/ui/data.js `snapshot()` (docs/spec/ui-server.md). The server
   * adds only what data.js does not own: live roster status, its own TPS samples, and the
   * flattened account x CLI model catalog the spawn dialog reads.
   * @param {Record<string, any>} [extra]
   */
  async function buildState(extra = {}) {
    const base = await (deps.snapshot ?? dataSnapshot)({
      sbbDir: stateDir,
      readQuota: deps.readQuota,
      readConfig: deps.readConfig,
      listHeld: deps.listHeld,
      listPlans: deps.listPlans,
      listAllClaims: deps.listAllClaims,
      readReceipts: deps.readReceipts,
      listBrains: deps.listBrains,
      accountList: deps.accountList,
      allChannels: deps.allChannels,
      tps: deps.tps,
    });
    const brains = base.brains ?? [];
    /** @type {import('../registry/roster.js').RosterRow[]} */
    let rows = [];
    try {
      rows = await (deps.roster ?? defaultRoster)({ withStatus: true, onWarn: () => {} });
    } catch {
      rows = []; // a tmux hiccup must not blank the console
    }
    const enriched = brains.map((brain) => {
      const row = rows.find((r) => r.brainId === brain.id);
      return {
        ...brain,
        status: row?.status ?? '?',
        where: row?.where ?? brain.coord ?? null,
        paneId: row?.paneId ?? brain.paneId,
        live: Boolean(row?.paneId),
        sessionName: row?.name ?? null,
        threadId: row?.threadId ?? brain.threadId ?? null,
      };
    });
    return {
      ...base,
      brains: enriched,
      tree: consoleTree(brains),
      catalog: flattenCatalog((deps.catalog ?? catalog)()),
      tps: tpsPayload(),
      teams: (base.teams ?? []).map((team) => ({ ...team, messages: team.messages ?? [] })),
      ...extra,
    };
  }

  /** OrgChart.vue renders a nested tree rooted at the user, with `kind` on every node. */
  function consoleTree(brains) {
    const byId = new Map(brains.map((b) => [b.id, { id: b.id, name: b.name, kind: 'brain', children: [] }]));
    /** @type {Record<string, any>[]} */
    const roots = [];
    for (const brain of brains) {
      const node = byId.get(brain.id);
      const parent = brain.parent ? byId.get(brain.parent) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return { id: 'user', name: '你', kind: 'user', children: roots };
  }

  /** SpawnDialog.vue filters `{ cli, model }` rows out of the account x CLI catalog. */
  function flattenCatalog(rows) {
    return rows.flatMap((row) => (row.models ?? []).map((model) => ({
      account: row.account,
      cli: row.cli,
      model: model.id,
      label: model.label ?? null,
    })));
  }

  /** TpsBar.vue reads `{ list, total }` (web/src/store/sbb.js). */
  function tpsPayload() {
    const list = [...tpsValues.values()];
    const tokens = list.reduce((sum, row) => sum + (row.tokens60s ?? 0), 0);
    const activeMs = list.reduce((sum, row) => sum + (row.activeMs ?? 0), 0);
    return { list, total: activeMs > 0 ? Number((tokens / (activeMs / 1000)).toFixed(2)) : 0 };
  }

  // ---------------------------------------------------------------- events

  /**
   * One SSE frame per named event. docs/spec/ui-server.md lists the nine names and says each
   * carries the full updated object; web/src/api/http.js parses `msg.data` directly, so there
   * is no envelope.
   * @param {string} name @param {any} data
   */
  function emitEvent(name, data) {
    const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  /**
   * A server-side problem is not one of the nine event names and the console has no handler
   * for it, so it goes out as an SSE comment: visible in devtools, never a stray event.
   * @param {unknown} detail
   */
  function emitComment(detail) {
    const line = `: sbb ui ${String(detail).replace(/[\r\n]+/g, ' ')}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  /**
   * State events come from src/ui/data.js `watch()`; this maps its kinds onto the nine
   * documented event names and the payload each console handler expects.
   */
  function startWatcher() {
    watcher = (deps.watch ?? dataWatch)((kind, object) => {
      switch (kind) {
        case 'brain': {
          if (object?.removed) return emitEvent('brain', { id: object.id, deleted: true });
          const brains = (deps.listBrains ?? listBrains)();
          return emitEvent('brain', { ...object, tree: consoleTree(brains) });
        }
        case 'receipt':
          return emitEvent('receipt', object);
        case 'message':
          return emitEvent('message', object);
        case 'held':
          return emitEvent('held', (deps.listHeld ?? listHeld)({ sbbDir: stateDir }));
        case 'plan':
          return emitEvent('plan', { ...object, id: object.id ?? object.planId });
        case 'claim':
          return emitEvent('claim', (deps.listAllClaims ?? listAllClaims)({ sbbDir: stateDir }));
        case 'quota':
          return emitEvent('quota', object);
        case 'tps':
          return emitEvent('tps', tpsPayload());
        case 'policy':
          return emitEvent('policy', object);
        default:
          return undefined; // data.js owns the vocabulary; the spec names nine events
      }
    }, { sbbDir: stateDir });
  }

  async function refreshTps() {
    let brains = [];
    try {
      brains = (deps.listBrains ?? listBrains)();
    } catch {
      return;
    }
    for (const result of await tps.sampleAll(brains, {})) tpsValues.set(result.brainId, result);
    emitEvent('tps', tpsPayload());
  }

  /** The server keeps ONE inbox for its whole life: peer replies and receipts land here. */
  async function openInbox() {
    if (inbox) return inbox;
    const start = deps.startInbox ?? startInbox;
    inbox = await start({ dir: deps.inboxDir ?? deliveryInboxDir() });
    inbox.on('message', (frame) => {
      try {
        emitEvent('message', parsePeerFrame(frame));
      } catch (err) {
        emitComment(err?.message ?? err);
      }
    });
    inbox.on('receipt', (frame) => {
      emitEvent('receipt', { kind: 'peer-status', msgId: frame?.orig_msg_id ?? null, status: frame?.status ?? null });
    });
    inbox.on('error', (err) => emitComment(err?.message ?? err));
    return inbox;
  }

  // ---------------------------------------------------------------- actions

  /**
   * Run a CLI subcommand and capture its JSON. Serialized: the capture swaps console.log,
   * so two runs at once would interleave. Only commands whose argv wiring is the point
   * (reply/approve/spawn/kill/move/policy/claim/plan) go through here; tell and ask call
   * `deliver` directly so they never block.
   * @param {string} name @param {string[]} argv
   */
  let cliQueue = Promise.resolve();
  function runCli(name, argv) {
    const task = async () => {
      /** @type {string[]} */
      const lines = [];
      /** @type {string[]} */
      const errors = [];
      const log = console.log;
      const error = console.error;
      console.log = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      console.error = (...args) => errors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      try {
        const mod = await import(`../cli/${name}.js`);
        const code = await mod.run(argv, deps.cliDeps ?? {});
        return { code, lines, errors, json: parseJson(lines), stderr: errors.join('\n') };
      } finally {
        console.log = log;
        console.error = error;
      }
    };
    const result = cliQueue.then(task, task);
    cliQueue = result.then(() => {}, () => {});
    return result;
  }

  /** @param {string[]} lines */
  function parseJson(lines) {
    const text = lines.join('\n').trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** @param {string} ref */
  async function resolveTarget(ref) {
    return (deps.resolve ?? defaultResolve)(ref, {
      accounts: deps.accounts,
      rows: deps.rows,
      onWarn: () => {},
    });
  }

  /** @param {Record<string, any>} body */
  async function tell(body) {
    const to = String(body.to ?? '').trim();
    const text = String(body.text ?? '').trim();
    if (!to || !text) throw Object.assign(new Error('to and text are required'), { reason: 'invalid_input' });
    const target = await resolveTarget(to);
    const out = await deliver({
      target,
      body: text,
      identity: { ...USER_IDENTITY, role: body.role ? String(body.role) : USER_IDENTITY.role },
      priority: body.priority,
      inbox: await openInbox(),
      deps,
    });
    return out.receipt;
  }

  async function ask(body) {
    const to = String(body.to ?? '').trim();
    const text = String(body.text ?? '').trim();
    if (!to || !text) throw Object.assign(new Error('to and text are required'), { reason: 'invalid_input' });
    const target = await resolveTarget(to);
    const { receipt, entry } = await deliver({
      target,
      body: text,
      identity: USER_IDENTITY,
      priority: body.priority,
      inbox: await openInbox(),
      deps,
    });
    return { msgId: entry.msgId, receipt };
  }

  // ---------------------------------------------------------------- routes

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async function route(req, res, url) {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (path === '/api/state' && method === 'GET') return sendJson(res, 200, await buildState());
    if (path === '/api/events' && method === 'GET') return sse(req, res);
    if (path.startsWith('/api/brains/') && path.endsWith('/transcript') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/api/brains/'.length, -'/transcript'.length));
      const brain = getBrain(id);
      if (!brain) return sendError(res, 404, 'target_not_found', `unknown brain "${id}"`);
      const accounts = (deps.accounts ?? discoverAccounts)();
      const account = accounts.find((a) => a.name === brain.account);
      return sendJson(res, 200, transcriptFor({
        brain,
        account,
        limit: Number(url.searchParams.get('limit')) || DEFAULT_LIMIT,
      }));
    }
    if (path === '/api/messages' && method === 'GET') {
      const withRef = url.searchParams.get('with');
      const brain = withRef ? getBrain(withRef) : undefined;
      if (withRef && !brain) return sendError(res, 404, 'target_not_found', `unknown brain "${withRef}"`);
      return sendJson(res, 200, messagesFor({
        brainId: brain?.id,
        brainName: brain?.name,
        limit: Number(url.searchParams.get('limit')) || DEFAULT_LIMIT,
      }));
    }
    if (path.startsWith('/api/teams/') && method === 'GET') {
      const mainId = decodeURIComponent(path.slice('/api/teams/'.length));
      return sendJson(res, 200, teamLog({
        mainId,
        limit: Number(url.searchParams.get('limit')) || 300,
      }));
    }

    if (method === 'POST') return post(req, res, url);
    return sendError(res, 404, 'not_found', `${method} ${path}`);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async function post(req, res, url) {
    const path = url.pathname;
    let body;
    try {
      body = jsonBody(await readBody(req));
    } catch (err) {
      return sendError(res, 400, 'invalid_input', `cannot read request body: ${err?.message ?? err}`);
    }
    try {
      if (path === '/api/tell') return sendJson(res, 200, await tell(body));
      if (path === '/api/ask') return sendJson(res, 200, await ask(body));
      if (path === '/api/reply') {
        const msgId = String(body.msgId ?? '').trim();
        const text = String(body.text ?? '').trim();
        if (!msgId || !text) return sendError(res, 400, 'invalid_input', 'msgId and text are required');
        const out = await runCli('reply', [msgId, text, '--json']);
        return cliResult(res, out, 'reply');
      }
      if (path === '/api/approve') {
        const msgId = String(body.msgId ?? '').trim();
        if (!msgId) return sendError(res, 400, 'invalid_input', 'msgId is required');
        const argv = body.deny
          ? ['--deny', '--reason', String(body.reason ?? ''), msgId, '--json']
          : [msgId, '--json'];
        const out = await runCli('approve', argv);
        return cliResult(res, out, 'approve');
      }
      if (path === '/api/move') return move(res, body);
      if (path === '/api/spawn') {
        const argv = [];
        for (const [key, flag] of [
          ['name', '--name'], ['role', '--role'], ['parent', '--parent'], ['account', '--account'],
          ['cli', '--cli'], ['model', '--model'], ['cwd', '--cwd'], ['briefFile', '--brief-file'],
          ['cliArgs', '--cli-args'],
        ]) {
          if (body[key] !== undefined && body[key] !== null && body[key] !== '') argv.push(flag, String(body[key]));
        }
        if (body.split) argv.push('--split');
        if (body.force) argv.push('--force');
        argv.push('--json');
        const out = await runCli('spawn', argv);
        return cliResult(res, out, 'spawn');
      }
      if (path === '/api/kill') {
        const ref = String(body.brain ?? '').trim();
        if (!ref) return sendError(res, 400, 'invalid_input', 'brain is required');
        const argv = [ref, '--yes', '--json'];
        if (body.keepChildren) argv.push('--keep-children');
        const out = await runCli('kill', argv);
        return cliResult(res, out, 'kill');
      }
      if (path === '/api/switch') {
        const brain = getBrain(String(body.brain ?? '').trim());
        if (!brain) return sendError(res, 404, 'target_not_found', `unknown brain "${body.brain}"`);
        const result = await goToTerminal({ brain, deps: { host: api, ...deps.switch } });
        return sendJson(res, 200, result);
      }
      if (path === '/api/policy') return policy(res, body);
      if (path === '/api/claims') return claims(res, body);
      if (path.startsWith('/api/plans/')) return plan(res, path, body);
      return sendError(res, 404, 'not_found', `POST ${path}`);
    } catch (err) {
      const reason = err?.reason ?? (err?.name === 'ResolveError' ? err.reason : 'internal');
      const code = ERROR_STATUS[reason] ?? 500;
      return sendError(res, code, reason, String(err?.message ?? err));
    }
  }

  /** @param {import('node:http').ServerResponse} res @param {{code: number, json?: any, lines: string[], stderr: string}} out @param {string} what */
  function cliResult(res, out, what) {
    if (out.code === 0 && out.json !== undefined) return sendJson(res, 200, out.json);
    const detail = (out.stderr || out.lines.join('\n') || `${what} exited ${out.code}`).trim();
    const reason = out.code === 4 ? 'blocked' : out.code === 2 ? 'usage' : 'internal';
    return sendError(res, ERROR_STATUS[reason] ?? 500, reason, detail);
  }

  /** @param {import('node:http').ServerResponse} res @param {Record<string, any>} body */
  async function move(res, body) {
    const ref = String(body.brain ?? '').trim();
    const to = String(body.to ?? '').trim();
    if (!ref || !to) return sendError(res, 400, 'invalid_input', 'brain and to are required');
    const mode = body.mode === 'now' ? 'now' : 'afterIdle';
    if (mode === 'now') {
      const out = await runCli('move', [ref, '--to', to, '--now', '--yes', '--json']);
      return cliResult(res, out, 'move');
    }
    // afterIdle waits for the brain to finish its turn: answer immediately and let the
    // command run on, emitting `brain` when it lands (docs/spec/ui-server.md).
    runCli('move', [ref, '--to', to, '--after-idle', '--yes', '--json'])
      .then((out) => emitEvent('brain', { ...(getBrain(ref) ?? { ref }), move: { to, status: out.code === 0 ? 'moved' : 'failed', detail: out.stderr } }))
      .catch((err) => emitComment(err?.message ?? err));
    return sendJson(res, 202, { pending: true, mode, to });
  }

  /** @param {import('node:http').ServerResponse} res @param {Record<string, any>} body */
  async function policy(res, body) {
    /** @type {string[]|null} */
    let argv = null;
    if (body.peers !== undefined) argv = ['peers', String(body.peers)];
    else if (body.set !== undefined) {
      const set = body.set ?? {};
      argv = ['set', String(set.ref ?? set.brain ?? '')];
      if (set.peers !== undefined) argv.push('--peers', String(set.peers));
      if (set.autonomous !== undefined) argv.push('--autonomous', set.autonomous ? 'on' : 'off');
    } else if (body.allow !== undefined) argv = ['allow', String(body.allow[0] ?? ''), String(body.allow[1] ?? '')];
    else if (body.deny !== undefined) argv = ['deny', String(body.deny[0] ?? ''), String(body.deny[1] ?? '')];
    else if (body.quota !== undefined) {
      argv = ['quota'];
      if (body.quota.floorWeekly !== undefined) argv.push('--floor-weekly', String(body.quota.floorWeekly));
      if (body.quota.mainReserve !== undefined) argv.push('--main-reserve', String(body.quota.mainReserve));
    } else if (body.spawnArgs !== undefined) {
      argv = ['spawn-args', String(body.spawnArgs.cli ?? ''), String(body.spawnArgs.args ?? '')];
    }
    if (!argv) return sendError(res, 400, 'invalid_input', 'peers, set, allow, deny, quota or spawnArgs is required');
    const out = await runCli('policy', [...argv, '--json']);
    if (out.code !== 0) return cliResult(res, out, 'policy');
    const config = (deps.readConfig ?? readConfig)({});
    emitEvent('policy', config);
    return sendJson(res, 200, config);
  }

  /** @param {import('node:http').ServerResponse} res @param {Record<string, any>} body */
  async function claims(res, body) {
    if (body.add !== undefined) {
      const out = await runCli('claim', ['add', String(body.add), ...(body.note ? ['--note', String(body.note)] : []), '--json']);
      if (out.code !== 0) return cliResult(res, out, 'claim');
    } else if (body.release !== undefined) {
      const out = await runCli('claim', ['release', String(body.release), '--json']);
      if (out.code !== 0) return cliResult(res, out, 'claim');
    } else if (body.releaseAll !== true) {
      return sendError(res, 400, 'invalid_input', 'add or release is required');
    } else {
      const out = await runCli('claim', ['release', '--all', '--json']);
      if (out.code !== 0) return cliResult(res, out, 'claim');
    }
    const rows = (deps.listAllClaims ?? listAllClaims)({});
    emitEvent('claim', rows);
    return sendJson(res, 200, rows);
  }

  /** @param {import('node:http').ServerResponse} res @param {string} path @param {Record<string, any>} body */
  async function plan(res, path, body) {
    const match = /^\/api\/plans\/([^/]+)\/(approve|reject)$/.exec(path);
    if (!match) return sendError(res, 404, 'not_found', `POST ${path}`);
    const [, ref, action] = match;
    const found = getPlan(decodeURIComponent(ref), {});
    if (!found) return sendError(res, 404, 'unknown_plan', `unknown plan "${ref}"`);
    if (action === 'approve') {
      const argv = ['approve', found.plan.planId, '--json'];
      const out = await runCli('plan', argv);
      return cliResult(res, out, 'plan');
    }
    if (body.reason === undefined) return sendError(res, 400, 'invalid_input', 'reason is required to reject');
    const out = await runCli('plan', ['reject', found.plan.planId, '--reason', String(body.reason), '--json']);
    return cliResult(res, out, 'plan');
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  function sse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': sbb ui events\n\n');
    sseClients.add(res);
    // docs/spec/ui-server.md names `heartbeat` among the events; deps.heartbeatMs is a test seam.
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, deps.heartbeatMs ?? 15000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  }

  /** @param {string} paneId @returns {Promise<string|null>} */
  async function sessionForPane(paneId) {
    try {
      const panes = await api.listPanes();
      return panes.find((p) => p.paneId === paneId)?.session ?? null;
    } catch {
      return null;
    }
  }

  /** @param {string} session */
  function streamFor(session) {
    const existing = streams.get(session);
    if (existing) return existing;
    const stream = createPaneStream({
      session,
      host: api,
      controlFactory: deps.controlFactory,
      onError: (err) => emitComment(err?.message ?? err),
    });
    streams.set(session, stream);
    return stream;
  }

  /** @param {any} ws @param {string} paneId */
  async function handlePaneSocket(ws, paneId) {
    const session = await sessionForPane(paneId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'closed', reason: 'pane_gone' }));
      ws.close();
      return;
    }
    const stream = streamFor(session);
    await stream.start();
    const sub = stream.subscribe(paneId, {
      onOutput: (data, meta) => {
        if (ws.readyState === 1) ws.send(data, { binary: true });
        if (meta.initial) emitComment(`pane ${paneId} initial screen sent`);
      },
      onClosed: () => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'closed' }));
        ws.close();
      },
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: 'refused', reason: 'invalid_input' }));
        return;
      }
      handleFrame(ws, sub, frame).catch((err) => {
        ws.send(JSON.stringify({ type: 'refused', reason: 'internal', detail: String(err?.message ?? err) }));
      });
    });
    ws.on('close', () => {
      sub.close().catch(() => {});
    });
  }

  /** @param {any} ws @param {any} sub @param {Record<string, any>} frame */
  async function handleFrame(ws, sub, frame) {
    const type = frame?.type;
    if (type === 'mode') {
      sub.setInput(frame.input === true);
      return;
    }
    let result;
    if (type === 'input') {
      // Never type the string "undefined": a frame without `data` is a client bug.
      result = typeof frame.data === 'string'
        ? await sub.input(frame.data)
        : { refused: true, reason: 'invalid_input' };
    } else if (type === 'key') result = await sub.key(frame.name);
    else if (type === 'resize') result = await sub.resize(frame.cols, frame.rows);
    else result = { refused: true, reason: 'invalid_input' };
    if (result.refused && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'refused', reason: result.reason }));
    }
  }

  /** @param {string} pathname @param {import('node:http').ServerResponse} res */
  /**
   * Serve web/dist. `setCookie` is the token the first page load presented in `?t=`: the
   * browser requests the page's <script>/<link> assets before any of the page's code runs, so
   * the server has to hand the token back as the `sbb_ui` cookie or those asset loads get 401.
   * @param {string} pathname @param {import('node:http').ServerResponse} res @param {string} [setCookie]
   */
  function serveStatic(pathname, res, setCookie) {
    if (!existsSync(dist)) {
      const hint = `sbb ui: web/dist is not built. Run: cd web && npm install && npm run build\n`;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(hint);
      return;
    }
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, relative === '/' ? 'index.html' : relative);
    if (!file.startsWith(dist)) {
      sendError(res, 403, 'blocked', 'path outside web/dist');
      return;
    }
    if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
    if (!existsSync(file)) {
      sendError(res, 404, 'not_found', 'web/dist/index.html is missing');
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      ...(setCookie ? { 'set-cookie': `sbb_ui=${encodeURIComponent(setCookie)}; Path=/; SameSite=Strict` } : {}),
    });
    res.end(body);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!tokenMatches(token, presentedToken(req, url))) {
      res.writeHead(401);
      res.end();
      return;
    }
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      route(req, res, url).catch((err) => sendError(res, 500, 'internal', String(err?.stack ?? err)));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'usage', `${req.method} is not allowed`);
      return;
    }
    serveStatic(path, res, url.searchParams.get('t') ?? undefined);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!tokenMatches(token, presentedToken(req, url))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const match = /^\/ws\/pane\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const paneId = match[1]; // '%12' is not a valid percent-escape, so never decode it
    if (!/^%\d+$/.test(paneId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handlePaneSocket(ws, paneId).catch(() => {
        try {
          ws.send(JSON.stringify({ type: 'closed', reason: 'internal' }));
        } catch {
          // the socket is already gone
        }
        ws.close();
      });
    });
  });

  let listening = null;

  /** @param {{ port?: number }} [startOpts] */
  async function start(startOpts = {}) {
    if (listening) return listening;
    const port = startOpts.port ?? opts.port ?? DEFAULT_PORT;
    writeToken(token, { dir: stateDir });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    startWatcher();
    await openInbox().catch((err) => emitComment(`inbox unavailable: ${err?.message ?? err}`));
    const quotaTimer = setInterval(() => {
      readQuota({}).then((rows) => emitEvent('quota', rows)).catch(() => {});
    }, 60000);
    quotaTimer.unref?.();
    timers.push(quotaTimer);
    const tpsTimer = setInterval(() => {
      refreshTps().catch(() => {});
    }, 5000);
    tpsTimer.unref?.();
    timers.push(tpsTimer);
    refreshTps().catch(() => {});
    const actual = server.address();
    listening = {
      port: typeof actual === 'object' && actual ? actual.port : port,
      token,
      url: `http://127.0.0.1:${typeof actual === 'object' && actual ? actual.port : port}/?t=${token}`,
    };
    return listening;
  }

  async function stop() {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    try {
      watcher?.close();
    } catch {
      // already closed
    }
    watcher = null;
    for (const stream of streams.values()) await stream.stop().catch(() => {});
    streams.clear();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // the client is already gone
      }
    }
    sseClients.clear();
    await inbox?.close?.().catch(() => {});
    inbox = undefined;
    await closeInboxes().catch(() => {});
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise((resolve) => server.close(() => resolve()));
    listening = null;
  }

  return {
    server,
    token,
    url: () => `http://127.0.0.1:${opts.port ?? DEFAULT_PORT}/?t=${token}`,
    start,
    stop,
    buildState,
    emitEvent,
    runCli,
  };
}
