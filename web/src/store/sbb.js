// One store for the whole console (web-console.md: components never fetch on their own).
// It holds the /api/state snapshot, applies SSE events, and exposes the actions the UI calls.
import { defineStore } from 'pinia';
import { toQuotaChips } from '../lib/quota.js';
import { receiptRow } from '../lib/receipts.js';
import { createClient, FIXTURE } from '../api/index.js';

/** Team members arrive as ids/names (fixture) or as { id, name, role } rows (server). */
function memberName(member) {
  return typeof member === 'string' ? member : member?.name ?? member?.id ?? '';
}

/** A team tab talks to its channel address (#<main>, docs/spec/teams.md), never to one member. */
function teamAddress(team) {
  if (!team) return undefined;
  if (typeof team.name === 'string' && team.name.startsWith('#')) return team.name;
  return (team.members ?? []).map(memberName).find((name) => name && name !== '你');
}

export const STATUS_LABEL = {
  idle: '空闲',
  busy: '忙',
  blocked: '待批准',
  '?': '未知',
  gone: '已结束',
};

export const POLICY_LABEL = { open: '开', moderated: '先经我过目', closed: '关' };

const clock = () => new Date().toTimeString().slice(0, 5);

export const useSbb = defineStore('sbb', {
  state: () => ({
    client: null,
    fixture: FIXTURE,
    ready: false,
    error: null,
    version: '',
    user: { name: '你' },
    brains: [],
    tree: null,
    accounts: [],
    quota: [],
    catalog: [],
    policy: { peers: 'open', rows: [] },
    held: [],
    plans: [],
    claims: [],
    tps: { list: [], total: 0 },
    teams: [],
    threads: [],
    receipts: [],
    view: 'console',
    teamId: 'lead',
    threadId: null,
    selectedId: null,
    paneMode: 'view',
    search: '',
    dialog: null,
    moveDraft: null,
    killTarget: null,
    toasts: [],
    pending: {},
    waiting: {},
    theme: 'light',
    drawer: false,
  }),

  getters: {
    selected: (state) => state.brains.find((brain) => brain.id === state.selectedId) ?? null,
    brainById: (state) => (id) => state.brains.find((brain) => brain.id === id) ?? null,
    brainCount: (state) => state.brains.length,
    teamCount: (state) => state.teams.length,
    heldCount: (state) => state.held.length,
    policyMode: (state) => state.policy?.peers ?? 'open',
    tabs: (state) => [
      ...state.teams.map((team) => ({
        id: `team:${team.id}`,
        kind: 'team',
        teamId: team.id,
        label: team.name,
        sub: `组频道 · ${(team.members ?? []).map(memberName).join('、')}`,
        count: team.messages.length,
      })),
      ...state.threads.map((thread) => ({
        id: `thread:${thread.id}`,
        kind: 'thread',
        threadId: thread.id,
        label: thread.title,
        sub: thread.subtitle ?? '',
        count: thread.messages.length,
      })),
    ],
    activeTab() {
      const wanted = this.threadId ? `thread:${this.threadId}` : `team:${this.teamId}`;
      return this.tabs.find((tab) => tab.id === wanted) ?? this.tabs[0] ?? null;
    },
    messages() {
      const tab = this.activeTab;
      if (!tab) return [];
      if (tab.kind === 'team') return this.teams.find((team) => team.id === tab.teamId)?.messages ?? [];
      return this.threads.find((thread) => thread.id === tab.threadId)?.messages ?? [];
    },
    visibleBrains: (state) => {
      const needle = state.search.trim().toLowerCase();
      if (!needle) return state.brains;
      return state.brains.filter(
        (brain) =>
          brain.name.toLowerCase().includes(needle) ||
          brain.id.toLowerCase().includes(needle) ||
          `${brain.account}/${brain.cli}`.toLowerCase().includes(needle),
      );
    },
    tpsRows: (state) =>
      state.tps.list
        .map((row) => {
          const brain = state.brains.find((item) => item.id === row.brainId);
          return {
            ...row,
            name: brain?.name ?? row.brainId,
            id: row.brainId,
            modelLabel: brain?.modelLabel ?? brain?.model ?? '',
            pct: Math.min(100, Math.round((row.tps / 300) * 100)),
          };
        })
        .sort((a, b) => b.tps - a.tps),
    receiptStats: (state) => {
      const stats = { delivered: 0, queued: 0, unverified: 0, blocked: 0 };
      for (const row of state.receipts) if (stats[row.status] !== undefined) stats[row.status] += 1;
      return stats;
    },
    moveSubject() {
      return this.moveDraft ? this.brainById(this.moveDraft.brain) : null;
    },
    moveTarget() {
      return this.moveDraft ? this.brainById(this.moveDraft.to) : null;
    },
    killSubtree() {
      if (!this.killTarget) return [];
      const out = [];
      const walk = (id) => {
        const brain = this.brainById(id);
        if (!brain) return;
        out.push(brain);
        for (const child of this.brains) if (child.parent === id) walk(child.id);
      };
      walk(this.killTarget);
      return out;
    },
  },

  actions: {
    async init() {
      if (this.client) return;
      this.client = createClient();
      this.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      try {
        const snapshot = await this.client.loadState();
        this.applySnapshot(snapshot);
        this.client.subscribe((event) => this.applyEvent(event));
        this.ready = true;
      } catch (err) {
        this.error = err.message;
      }
    },

    applySnapshot(snapshot) {
      Object.assign(this, {
        version: snapshot.version ?? '',
        user: snapshot.user ?? this.user,
        brains: snapshot.brains ?? [],
        tree: snapshot.tree ?? null,
        accounts: snapshot.accounts ?? [],
        quota: toQuotaChips(snapshot.quota ?? [], { brains: snapshot.brains ?? [] }),
        catalog: snapshot.catalog ?? [],
        policy: snapshot.policy ?? this.policy,
        held: snapshot.held ?? [],
        plans: snapshot.plans ?? [],
        claims: snapshot.claims ?? [],
        tps: snapshot.tps ?? this.tps,
        teams: snapshot.teams ?? [],
        threads: snapshot.threads ?? [],
        receipts: (snapshot.receipts ?? []).slice(0, 500).map(receiptRow),
      });
      const ui = snapshot.ui ?? {};
      this.view = ui.view ?? this.view;
      this.teamId = ui.team ?? this.teamId;
      this.threadId = ui.thread ?? null;
      this.selectedId = ui.selected ?? this.brains[0]?.id ?? null;
      this.moveDraft = snapshot.moveDraft ?? null;
    },

    applyEvent({ event, data }) {
      switch (event) {
        case 'brain': {
          if (data?.deleted) {
            this.brains = this.brains.filter((brain) => brain.id !== data.id);
            if (this.selectedId === data.id) this.selectedId = this.brains[0]?.id ?? null;
          } else {
            const index = this.brains.findIndex((brain) => brain.id === data.id);
            if (index >= 0) this.brains[index] = { ...this.brains[index], ...data };
            else this.brains.push(data);
          }
          this.tree = data?.tree ?? this.tree;
          break;
        }
        case 'receipt': {
          this.receipts.unshift(receiptRow(data));
          // /api/state seeds the newest 500; keep the same window as events accumulate.
          if (this.receipts.length > 500) this.receipts.length = 500;
          // A later receipt for a message already in the stream replaces the earlier one,
          // so an approved held message stops reading "held" (web-console.md, screen 4).
          if (data?.msgId) {
            for (const list of [...this.threads.map((item) => item.messages), ...this.teams.map((item) => item.messages)]) {
              const message = list.find((item) => item.msgId === data.msgId);
              if (message) message.receipt = data;
            }
          }
          break;
        }
        case 'message': {
          // The data service files every message under a private thread (brain id) and/or a
          // team channel (main id); the same msgId may legitimately show in both.
          const push = (list) => {
            if (list && !list.some((message) => message.msgId === data.msgId)) list.push(data);
          };
          const thread = this.threads.find((item) => item.id === data.thread || item.with === data.thread);
          const team = this.teams.find((item) => item.mainId === data.team || item.id === data.team);
          if (thread) push(thread.messages);
          if (team) push(team.messages);
          if (!thread && !team) {
            const brain = this.brains.find((item) => item.id === data.to);
            push(this.teams.find((item) => item.id === brain?.team)?.messages);
          }
          if (data.replyTo) delete this.waiting[data.replyTo];
          break;
        }
        case 'held':
          this.held = Array.isArray(data) ? data : this.upsertHeld(data);
          break;
        case 'policy':
          this.policy = { ...this.policy, ...data };
          break;
        case 'tps':
          this.tps = data;
          break;
        case 'quota':
          this.quota = toQuotaChips(data, { brains: this.brains });
          break;
        case 'claim':
          this.claims = data;
          break;
        case 'plan': {
          const index = this.plans.findIndex((plan) => plan.id === data.id);
          if (index >= 0) this.plans[index] = data;
          else this.plans.push(data);
          break;
        }
        default:
          break;
      }
    },

    upsertHeld(item) {
      const list = this.held.slice();
      const index = list.findIndex((held) => held.msgId === item.msgId);
      if (index >= 0) list[index] = item;
      else list.push(item);
      return list;
    },

    select(id) {
      this.selectedId = id;
      this.paneMode = 'view';
    },
    setView(view) {
      this.view = view;
      this.dialog = null;
    },
    openTab(tab) {
      if (tab.kind === 'team') {
        this.teamId = tab.teamId;
        this.threadId = null;
      } else {
        this.threadId = tab.threadId;
      }
    },
    openThread(id) {
      this.threadId = id;
    },
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', this.theme === 'dark');
      localStorage.setItem('sbb-theme', this.theme);
    },

    toast(text, tone = 'ok') {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      this.toasts.push({ id, text, tone });
      setTimeout(() => {
        this.toasts = this.toasts.filter((item) => item.id !== id);
      }, 4200);
    },

    async act(path, body, { busy, label } = {}) {
      if (busy) this.pending[busy] = true;
      try {
        return await this.client.post(path, body);
      } catch (err) {
        this.toast(err.message, 'error');
        return null;
      } finally {
        if (busy) delete this.pending[busy];
        void label;
      }
    },

    /** The composer: plain send, or ⌘Enter which uses /api/ask and waits for the reply. */
    async send(text, { ask = false } = {}) {
      const body = text.trim();
      if (!body) return;
      const tab = this.activeTab;
      const to =
        tab?.kind === 'thread'
          ? this.threads.find((thread) => thread.id === tab.threadId)?.with
          : teamAddress(this.teams.find((team) => team.id === tab?.teamId));
      if (!to) {
        this.toast('这里没有可以接话的脑', 'error');
        return;
      }
      const payload = { to, text: body, thread: tab?.kind === 'thread' ? tab.threadId : undefined };
      if (ask) {
        const result = await this.act('/api/ask', payload);
        if (result?.msgId) {
          this.waiting[result.msgId] = clock();
          this.toast(`已发出，等 ${this.brainById(to)?.name ?? to} 回复`, 'ok');
        }
        return;
      }
      const receipt = await this.act('/api/tell', payload);
      if (receipt) this.toast(`${receipt.status} · ${receipt.via}`, receipt.status === 'delivered' ? 'ok' : 'warn');
    },

    async approve(msgId) {
      const receipt = await this.act('/api/approve', { msgId }, { busy: msgId });
      if (receipt) this.toast(`放行 ${msgId}：${receipt.status}`, 'ok');
    },
    async deny(msgId, reason) {
      const result = await this.act('/api/approve', { msgId, deny: true, reason }, { busy: msgId });
      if (result) this.toast(`已拒绝 ${msgId}`, 'warn');
    },
    async setPolicy(mode) {
      const policy = await this.act('/api/policy', { set: { peers: mode } });
      if (policy) this.toast(`主脑互通已切到${POLICY_LABEL[mode] ?? mode}`, 'ok');
    },

    openMove(brainId, target) {
      this.moveDraft = { brain: brainId, to: target ?? '', mode: 'afterIdle', handoff: true };
    },
    async confirmMove() {
      const draft = this.moveDraft;
      if (!draft?.to) {
        this.toast('先选一个上级', 'warn');
        return;
      }
      const result = await this.act('/api/move', { ...draft, wait: true }, { busy: draft.brain });
      if (result?.pending) this.toast('已登记，等它空闲后转移', 'ok');
      else if (result?.moved) this.toast(`已把 ${this.brainById(draft.brain)?.name ?? draft.brain} 转到 ${this.brainById(draft.to)?.name ?? draft.to} 名下`, 'ok');
      this.moveDraft = null;
    },

    async spawn(payload) {
      const result = await this.act('/api/spawn', payload);
      if (result) {
        this.toast(`开脑 ${result.name ?? payload.name}（${result.coord ?? ''}）`, 'ok');
        this.dialog = null;
      }
      return result;
    },

    async confirmKill() {
      const ids = this.killSubtree.map((brain) => brain.id);
      const result = await this.act('/api/kill', { brain: this.killTarget }, { busy: this.killTarget });
      if (result) this.toast(`已结束 ${ids.length} 个脑：${ids.join('、')}`, 'warn');
      this.killTarget = null;
    },

    async goTerminal(brainId) {
      const result = await this.act('/api/switch', { brain: brainId });
      if (!result) return;
      if (result.clients?.length) {
        this.toast(`有 ${result.clients.length} 个终端客户端，选一个：${result.clients.join('、')}`, 'warn');
        return;
      }
      if (result.opened) this.toast(`已打开 ${result.client ?? '终端'} 并 attach`, 'ok');
      else this.toast(`已切到 ${result.client ?? '终端'}`, 'ok');
    },

    handleKey(event) {
      const target = event.target;
      const typing = target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName);
      if (event.metaKey && event.key === '`') {
        event.preventDefault();
        if (this.selectedId) this.goTerminal(this.selectedId);
        return;
      }
      if (event.metaKey && ['1', '2', '3'].includes(event.key)) {
        event.preventDefault();
        this.setView(['console', 'org', 'log'][Number(event.key) - 1]);
        return;
      }
      if (event.metaKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.view = 'console';
        this.focusSearch?.();
        return;
      }
      if (typing) return;
      if (event.key === 'j' || event.key === 'k') {
        const list = this.visibleBrains;
        if (!list.length) return;
        event.preventDefault();
        const index = list.findIndex((brain) => brain.id === this.selectedId);
        const next = Math.min(list.length - 1, Math.max(0, index + (event.key === 'j' ? 1 : -1)));
        this.select(list[next].id);
        return;
      }
      if (event.key === 'Enter' && this.view === 'console') {
        const brain = this.selected;
        if (!brain) return;
        const thread = this.threads.find((item) => item.with === brain.id);
        if (thread) this.openThread(thread.id);
        else if (brain.team) this.teamId = brain.team;
      }
    },
  },
});
