// Fixture mode: the same client interface as http.js, driven by web/fixtures/*.
// `VITE_SBB_FIXTURE=1 npm run dev` (or `npm run build`) renders every screen with no server.
// ?scene=held|transfer applies an overlay from fixtures/scenes.json; ?events=0 stops the
// scripted stream (it already waits fixtures/events.json startDelayMs before the first tick).
import snapshot from '../../fixtures/state.json';
import events from '../../fixtures/events.json';
import panes from '../../fixtures/panes.json';
import scenes from '../../fixtures/scenes.json';

const clone = (value) => JSON.parse(JSON.stringify(value));
const clock = () => new Date().toTimeString().slice(0, 5);
const nextId = (() => {
  let seq = 0;
  return (prefix) => `${prefix}${(++seq).toString(16).padStart(7, '0')}`;
})();

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key === 'brains' || key === 'held' || key === 'moveDraft' || key === '_note') continue;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      merge(target[key], value);
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}

/**
 * Apply one POST /api/policy body to the fixture config, mirroring the server's argv mapping
 * (src/ui/server.js) and policy/config.js (blank values drop the entry).
 * @param {Record<string, any>} policy
 * @param {Record<string, any>} body
 */
export function applyPolicy(policy, body) {
  const spawn = policy.spawn ?? (policy.spawn = { cliArgs: {}, preamble: {}, command: {} });
  const map = (source, key, value) => {
    const next = { ...(source ?? {}) };
    if (value) next[key] = value;
    else delete next[key];
    return next;
  };
  if (body.peers !== undefined) policy.peers = String(body.peers);
  if (body.quota) policy.quota = { ...(policy.quota ?? {}), ...body.quota };
  if (body.spawnArgs) spawn.cliArgs = map(spawn.cliArgs, body.spawnArgs.cli, body.spawnArgs.args);
  if (body.spawnPreamble) spawn.preamble = map(spawn.preamble, body.spawnPreamble.cli, body.spawnPreamble.value);
  if (body.spawnCommand) spawn.command = map(spawn.command, body.spawnCommand.cli, body.spawnCommand.value);
  if (body.spawnShell !== undefined) {
    if (body.spawnShell) spawn.shell = body.spawnShell;
    else delete spawn.shell;
  }
  if (body.terminal !== undefined) {
    if (body.terminal) policy.terminal = body.terminal;
    else delete policy.terminal;
  }
  if (body.subsDirect !== undefined) policy.teams = { ...(policy.teams ?? {}), subsDirect: Boolean(body.subsDirect) };
  if (body.set) {
    const id = String(body.set.ref ?? body.set.brain ?? '').toUpperCase();
    const brains = { ...(policy.brains ?? {}) };
    const entry = { ...(brains[id] ?? {}) };
    if (body.set.peers !== undefined) {
      if (body.set.peers === 'on') delete entry.peers;
      else entry.peers = body.set.peers;
    }
    if (body.set.autonomous !== undefined) {
      if (body.set.autonomous) entry.autonomous = true;
      else delete entry.autonomous;
    }
    if (Object.keys(entry).length) brains[id] = entry;
    else delete brains[id];
    policy.brains = brains;
  }
  if (body.allow) policy.allow = [...(policy.allow ?? []), body.allow];
  if (body.deny) policy.allow = (policy.allow ?? []).filter(([a, b]) => !(a === body.deny[0] && b === body.deny[1]));
  return policy;
}

/** Rebuild the org tree from parent links, keeping the brains array order. */
export function buildTree(brains) {
  const node = (brain) => ({
    id: brain.id,
    name: brain.name,
    kind: 'brain',
    children: brains.filter((b) => b.parent === brain.id).map(node),
  });
  return { id: 'user', name: '你', kind: 'user', children: brains.filter((b) => !b.parent).map(node) };
}

export function createFixtureClient() {
  const params = new URLSearchParams(window.location.search);
  const state = clone(snapshot);
  const scene = scenes[params.get('scene')] ?? {};

  merge(state, scene);
  if (Array.isArray(scene.brains)) {
    for (const patch of scene.brains) {
      const row = state.brains.find((brain) => brain.id === patch.id);
      if (row) Object.assign(row, clone(patch));
    }
  }
  if (Array.isArray(scene.held)) state.held = clone(scene.held);
  if (scene.brains || scene.held) state.tree = buildTree(state.brains);
  state.moveDraft = scene.moveDraft ? clone(scene.moveDraft) : null;
  // ?view=console|org|log lets the screenshot script reach every screen.
  if (params.get('view')) state.ui = { ...(state.ui ?? {}), view: params.get('view') };

  const listeners = new Set();
  const emit = (event, data) => {
    for (const fn of listeners) fn({ event, data: clone(data) });
  };
  const nameOf = (id) =>
    id === 'user' || id === '你' ? '你' : state.brains.find((brain) => brain.id === id)?.name ?? id;

  function addReceipt(receipt) {
    state.receipts.unshift(receipt);
    emit('receipt', receipt);
  }

  function pushMessage(message) {
    const thread = state.threads.find((t) => t.id === message.thread);
    if (thread) thread.messages.push(message);
    else {
      const brain = state.brains.find((b) => b.id === message.to);
      const team = state.teams.find((t) => t.id === brain?.team) ?? state.teams[state.teams.length - 1];
      team.messages.push(message);
    }
    emit('message', message);
    return message;
  }

  const reply = (message, text, via) => {
    const receipt = {
      at: clock(), from: nameOf(message.to), to: message.fromName ?? '你',
      status: 'delivered', via: via ?? 'reply', preview: text, elapsedMs: 900,
      replyTo: message.msgId,
    };
    pushMessage({
      msgId: nextId('r'), from: message.to, fromName: nameOf(message.to), to: message.from,
      thread: message.thread, at: clock(), text, note: `回复 ${message.fromName ?? '你'}`, receipt,
    });
    addReceipt(receipt);
  };

  const actions = {
    '/api/tell': (body) => {
      const receipt = {
        at: clock(), from: '你', to: nameOf(body.to), status: 'delivered', via: 'uds+screen',
        preview: body.text, elapsedMs: 1200, msgId: nextId('t'),
      };
      pushMessage({
        msgId: receipt.msgId, from: 'user', fromName: '你', to: body.to, thread: body.thread,
        at: clock(), text: body.text, receipt,
      });
      addReceipt(receipt);
      return receipt;
    },

    '/api/ask': (body) => {
      const receipt = {
        at: clock(), from: '你', to: nameOf(body.to), status: 'delivered', via: 'uds+screen',
        preview: body.text, elapsedMs: 4000, msgId: nextId('a'),
      };
      const ask = pushMessage({
        msgId: receipt.msgId, from: 'user', fromName: '你', to: body.to, thread: body.thread,
        at: clock(), text: body.text, receipt,
      });
      addReceipt(receipt);
      setTimeout(() => reply(ask, `${nameOf(body.to)} 收到：${body.text}`, 'reply'), 1600);
      return { msgId: ask.msgId };
    },

    '/api/reply': (body) => {
      const receipt = {
        at: clock(), from: '你', to: nameOf(body.to), status: 'delivered', via: 'reply',
        preview: body.text, elapsedMs: 800, replyTo: body.replyTo,
      };
      pushMessage({
        msgId: nextId('r'), from: 'user', fromName: '你', to: body.to, thread: body.thread,
        at: clock(), text: body.text, receipt,
      });
      addReceipt(receipt);
      return receipt;
    },

    '/api/approve': (body) => {
      const index = state.held.findIndex((item) => item.msgId === body.msgId);
      const held = index >= 0 ? state.held[index] : null;
      if (index >= 0) state.held.splice(index, 1);
      emit('held', state.held);
      if (body.deny) {
        const denied = { at: clock(), from: held?.fromName ?? '', to: held?.toName ?? '', status: 'blocked', via: 'policy', preview: held?.text ?? '', reason: body.reason ?? 'denied' };
        addReceipt(denied);
        return { denied: true, receipt: denied };
      }
      const receipt = {
        at: clock(), from: held?.fromName ?? '', to: held?.toName ?? '', status: 'delivered',
        via: 'policy+screen', preview: held?.text ?? '', elapsedMs: 1400, msgId: body.msgId,
      };
      if (held) {
        pushMessage({
          msgId: held.msgId, from: held.from, fromName: held.fromName, to: held.to,
          thread: held.thread, at: clock(), text: held.text, receipt,
        });
      }
      addReceipt(receipt);
      return receipt;
    },

    '/api/policy': (body) => {
      applyPolicy(state.policy, body);
      emit('policy', state.policy);
      return state.policy;
    },

    '/api/move': (body) => {
      const brain = state.brains.find((b) => b.id === body.brain);
      const target = state.brains.find((b) => b.id === body.to);
      if (!brain || !target) throw new Error('no_such_brain: 找不到要转移的脑');
      brain.parent = target.id;
      brain.team = target.team ?? target.name;
      brain.lastMessage = `已转到 ${target.name} 名下`;
      state.tree = buildTree(state.brains);
      emit('brain', brain);
      return { moved: true, plan: { brain: brain.id, to: target.id, mode: body.mode ?? 'now', handoff: Boolean(body.handoff) } };
    },

    '/api/spawn': (body) => {
      const parent = state.brains.find((b) => b.id === body.parent);
      const brain = {
        id: body.id ?? `SSL-00${50 + state.brains.length}`,
        name: body.name ?? `brain${state.brains.length + 1}`,
        account: body.account ?? 'a',
        cli: body.cli ?? 'claude',
        model: body.model ?? 'claude-haiku-4-5',
        modelLabel: body.modelLabel ?? body.model ?? 'claude-haiku-4-5',
        role: body.role ?? 'sub',
        status: 'busy',
        parent: parent?.id ?? null,
        team: parent?.team ?? body.name ?? 'lead',
        paneId: `%${60 + state.brains.length}`,
        coord: `sbb-rehearsal:${7 + state.brains.length}.1`,
        cwd: body.cwd ?? parent?.cwd ?? '/Users/steven/developer/sbb',
        lastMessage: '刚开脑，正在启动',
      };
      state.brains.push(brain);
      state.tree = buildTree(state.brains);
      emit('brain', brain);
      addReceipt({
        at: clock(), from: '你', to: brain.name, status: 'delivered', via: 'spawn',
        preview: `开脑 ${brain.name}（${brain.account}/${brain.cli}）`, elapsedMs: 2400, msgId: nextId('s'),
      });
      return { id: brain.id, coord: brain.coord, name: brain.name };
    },

    '/api/kill': (body) => {
      const doomed = new Set();
      const collect = (id) => {
        doomed.add(id);
        for (const child of state.brains) if (child.parent === id) collect(child.id);
      };
      collect(body.brain);
      state.brains = state.brains.filter((brain) => !doomed.has(brain.id));
      state.tree = buildTree(state.brains);
      for (const id of doomed) emit('brain', { id, deleted: true });
      return { killed: [...doomed] };
    },

    '/api/switch': () => ({ switched: true, client: 'Ghostty', opened: true }),

    '/api/claims': (body) => {
      if (body?.add) state.claims.push({ path: body.add, by: 'user', note: body.note ?? '' });
      if (body?.release) state.claims = state.claims.filter((claim) => claim.path !== body.release);
      return state.claims;
    },
  };

  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  return {
    fixture: true,
    token: 'fixture',

    async loadState() {
      return clone(state);
    },

    async post(path, body) {
      const handler = actions[path];
      if (!handler) throw new Error(`fixture mode: ${path} is not scripted`);
      return clone(handler(body ?? {}));
    },

    subscribe(onEvent, onStatus) {
      listeners.add(onEvent);
      onStatus?.(true);
      if (params.get('events') !== '0') {
        for (const entry of events.timeline) {
          later(() => onEvent({ event: entry.event, data: clone(entry.data) }), events.startDelayMs + entry.at);
        }
      }
      return () => {
        listeners.delete(onEvent);
        for (const id of timers) clearTimeout(id);
        timers.clear();
      };
    },

    // Mirrors the server contract: the pane's geometry first (the console sizes the terminal
    // from it and never soft-wraps), then one frame with the current screen, then live output.
    openPane(paneId, { onData, onGeometry }) {
      const pane = panes[paneId] ?? { cols: 80, rows: 24, lines: [] };
      later(() => onGeometry?.({ cols: pane.cols, rows: pane.rows }), 30);
      later(() => onData?.(new TextEncoder().encode(`${pane.lines.join('\r\n')}\r\n`)), 60);
      return {
        send(frame) {
          if (frame.type === 'input') onData?.(new TextEncoder().encode(frame.data));
          if (frame.type === 'key' && frame.name === 'Enter') onData?.(new TextEncoder().encode('\r\n'));
          // resize is a request the real server may decline; fixture mode has no pane to resize.
        },
        close() {},
      };
    },
  };
}
