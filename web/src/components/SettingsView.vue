<script setup>
// 设置 (web-console.md, screen 5): every switch that used to sit in the top bar, plus the config
// file keys the CLI could change. Each control reads store.policy and writes POST /api/policy
// through web/src/lib/policy.js, so the wire vocabulary lives in one place.
import { computed, reactive, ref, watch } from 'vue';
import { useSbb, POLICY_LABEL } from '../store/sbb.js';
import Icon from './Icon.vue';
import { BLUR, TINT, applyAppearance, readAppearance, writeAppearance } from '../lib/appearance.js';
import {
  allowBody, brainOverrides, brainPeersBody, denyBody, quotaBody,
  spawnArgsBody, spawnCommandBody, spawnPreambleBody, spawnShellBody, subsDirectBody, terminalBody, uiPeerMode,
} from '../lib/policy.js';

const store = useSbb();
const NAV = [
  { id: 'peers', label: '互通与策略' },
  { id: 'quota', label: '额度' },
  { id: 'launcher', label: '启动器' },
  { id: 'accounts', label: '账户' },
  { id: 'terminal', label: '终端' },
  { id: 'appearance', label: '外观' },
];
const MODES = [
  { id: 'open', label: '开' },
  { id: 'moderated', label: '审核' },
  { id: 'closed', label: '关' },
];
const TERMINALS = [
  { id: null, label: '自动' },
  { id: 'ghostty', label: 'Ghostty' },
  { id: 'iterm2', label: 'iTerm2' },
];
const THEMES = [
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
  { id: 'system', label: '跟随系统' },
];

const section = ref('peers');
const isDesktop = document.documentElement.dataset.shell === 'desktop';
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
})();

const policy = computed(() => store.policy ?? {});
const clis = computed(() => [...new Set(store.catalog.map((item) => item.cli))]);
const mains = computed(() => store.brains.filter((brain) => brain.role === 'main'));
const overrides = computed(() => brainOverrides(policy.value));
const pairs = computed(() => policy.value.allow ?? []);
const subsDirect = computed(() => policy.value.teams?.subsDirect !== false);
const terminal = computed(() => policy.value.terminal ?? null);
const accounts = computed(() =>
  store.accounts.map((account) => ({
    ...account,
    label: account.label ?? account.name,
    clis: account.clis ?? [],
    brains: store.brains.filter((brain) => brain.account === account.name).length,
  })),
);

/** Text fields are edited in a draft and written on blur/Enter, never on every keystroke. */
const draft = reactive({
  floorWeekly: 10, mainReserve: 20, shell: '', args: {}, preamble: {}, command: {},
  pair: { a: '', b: '' },
});
watch(
  policy,
  (next) => {
    draft.floorWeekly = next?.quota?.floorWeekly ?? 10;
    draft.mainReserve = next?.quota?.mainReserve ?? 20;
    draft.shell = next?.spawn?.shell ?? '';
    draft.args = { ...(next?.spawn?.cliArgs ?? {}) };
    draft.preamble = { ...(next?.spawn?.preamble ?? {}) };
    draft.command = { ...(next?.spawn?.command ?? {}) };
  },
  { immediate: true, deep: true },
);

const appearance = reactive(readAppearance(storage));
const tintPct = computed(() => Math.round(appearance.tint * 100));

function saveAppearance() {
  writeAppearance(storage, appearance);
  applyAppearance(document.documentElement, appearance);
}

const save = (body, ok) => store.updatePolicy(body, ok);

function overrideMode(id) {
  return uiPeerMode(overrides.value.find((row) => row.id === id)?.peers);
}

function addPair() {
  const [a, b] = [draft.pair.a, draft.pair.b];
  if (!a || !b || a === b) {
    store.toast('选两个不同的脑', 'warn');
    return;
  }
  save(allowBody([a, b]), '已放行这对脑').then((result) => {
    if (result) draft.pair = { a: '', b: '' };
  });
}

const nameOf = (id) => store.brainById(id)?.name ?? id;
</script>

<template>
  <div class="grid min-h-0 flex-1 gap-3 p-3" style="grid-template-columns: 240px minmax(0, 1fr)">
    <nav class="glass flex min-h-0 flex-col gap-[2px] overflow-y-auto rounded-[16px] p-2">
      <div class="px-3 pb-1 pt-3 text-[11px] tracking-[0.06em] text-es-muted">设置</div>
      <button
        v-for="item in NAV"
        :key="item.id"
        class="rounded-[10px] px-3 py-[9px] text-left text-[13px]"
        :class="section === item.id ? 'row-selected' : ''"
        @click="section = item.id"
      >
        {{ item.label }}
      </button>
      <div class="px-3 pb-1 pt-3 text-[11px] tracking-[0.06em] text-es-muted">关于</div>
      <div class="px-3 pb-2 text-[12px] text-es-muted">SBB v{{ store.version || '0.0.0' }}</div>
    </nav>

    <section class="glass min-h-0 overflow-y-auto rounded-[16px] px-7 py-5">
      <template v-if="section === 'peers'">
        <div class="sec">
          <h2>主脑互通</h2>
          <p>主脑之间能否直接说话。「审核」时消息先停在待批准列表，等你放行。</p>
          <div class="row">
            <div class="lab">默认</div>
            <div class="seg">
              <button
                v-for="mode in MODES"
                :key="mode.id"
                class="seg-item"
                :class="{ 'seg-item-active': store.policyMode === mode.id }"
                @click="store.policyMode === mode.id ? null : store.setPolicy(mode.id)"
              >
                {{ mode.label }}
              </button>
            </div>
            <div class="val text-es-muted">peers · {{ store.policyMode }}</div>
          </div>
          <div class="row">
            <div class="lab">同组子脑直接互通</div>
            <button class="toggle" :class="{ off: !subsDirect }" title="teams.subsDirect" @click="save(subsDirectBody(!subsDirect), '已保存 同组子脑互通')">
              <span />
            </button>
            <div class="val text-es-muted">teams.subsDirect</div>
          </div>
          <div v-for="brain in mains" :key="brain.id" class="row">
            <div class="lab">{{ brain.name }} 的覆盖</div>
            <div class="seg">
              <button
                v-for="mode in MODES"
                :key="mode.id"
                class="seg-item"
                :class="{ 'seg-item-active': overrideMode(brain.id) === mode.id }"
                @click="save(brainPeersBody(brain.id, mode.id), `已保存 ${brain.name}`)"
              >
                {{ mode.label }}
              </button>
            </div>
            <div class="val text-es-muted">{{ brain.id }}</div>
          </div>
          <div class="row">
            <div class="lab">额外放行的配对</div>
            <div class="val flex flex-col gap-[6px]">
              <div v-for="pair in pairs" :key="pair.join('-')" class="flex items-center gap-2">
                <span>{{ nameOf(pair[0]) }} ↔ {{ nameOf(pair[1]) }}</span>
                <button class="btn-ghost px-2 py-px text-[11px]" @click="save(denyBody(pair), '已取消这对')">取消</button>
              </div>
              <div class="flex items-center gap-2">
                <select v-model="draft.pair.a" class="field px-[10px] py-[6px] text-[12px]">
                  <option value="">选一个脑</option>
                  <option v-for="brain in store.brains" :key="brain.id" :value="brain.id">{{ brain.name }}</option>
                </select>
                <select v-model="draft.pair.b" class="field px-[10px] py-[6px] text-[12px]">
                  <option value="">再选一个</option>
                  <option v-for="brain in store.brains" :key="brain.id" :value="brain.id">{{ brain.name }}</option>
                </select>
                <button class="btn-ghost px-[10px] py-[6px] text-[12px]" @click="addPair">添加</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="section === 'quota'">
        <div class="sec">
          <h2>额度下限</h2>
          <p>周剩余低于下限时拒绝 spawn / ask；主脑账户再多留一段。</p>
          <div class="row">
            <div class="lab">周剩余下限</div>
            <input v-model="draft.floorWeekly" class="field mono w-[90px] px-[10px] py-[6px] text-[12px]" type="number" min="0" max="100" @change="save(quotaBody(draft), '已保存额度下限')" />
            <div class="val text-es-muted">%</div>
          </div>
          <div class="row">
            <div class="lab">主脑账户保留</div>
            <input v-model="draft.mainReserve" class="field mono w-[90px] px-[10px] py-[6px] text-[12px]" type="number" min="0" max="100" @change="save(quotaBody(draft), '已保存主脑保留')" />
            <div class="val text-es-muted">%</div>
          </div>
        </div>
      </template>

      <template v-else-if="section === 'launcher'">
        <div class="sec">
          <h2>启动器</h2>
          <p>每个 CLI 拉起前先跑什么、用什么命令、用哪个 shell。对应 sbb policy spawn-*。</p>
          <div class="row">
            <div class="lab">shell</div>
            <input v-model="draft.shell" class="field mono min-w-[320px] flex-1 px-[10px] py-[6px] text-[12px]" placeholder="sh" @change="save(spawnShellBody(draft.shell), '已保存 shell')" />
            <div class="val text-es-muted">spawn.shell</div>
          </div>
          <template v-for="cli in clis" :key="cli">
            <div class="row">
              <div class="lab">{{ cli }} · 前置</div>
              <input v-model="draft.preamble[cli]" class="field mono min-w-[320px] flex-1 px-[10px] py-[6px] text-[12px]" placeholder="启动前先跑的一行" @change="save(spawnPreambleBody(cli, draft.preamble[cli] ?? ''), `已保存 ${cli} 前置`)" />
              <div class="val text-es-muted">spawn.preamble</div>
            </div>
            <div class="row">
              <div class="lab">{{ cli }} · 参数</div>
              <input v-model="draft.args[cli]" class="field mono min-w-[320px] flex-1 px-[10px] py-[6px] text-[12px]" placeholder="默认参数" @change="save(spawnArgsBody(cli, draft.args[cli] ?? ''), `已保存 ${cli} 参数`)" />
              <div class="val text-es-muted">spawn.cliArgs</div>
            </div>
            <div class="row">
              <div class="lab">{{ cli }} · 启动命令</div>
              <input v-model="draft.command[cli]" class="field mono min-w-[320px] flex-1 px-[10px] py-[6px] text-[12px]" placeholder="替换 CLI 二进制的启动器" @change="save(spawnCommandBody(cli, draft.command[cli] ?? ''), `已保存 ${cli} 启动命令`)" />
              <div class="val text-es-muted">spawn.command</div>
            </div>
          </template>
        </div>
      </template>

      <template v-else-if="section === 'accounts'">
        <div class="sec">
          <h2>账户</h2>
          <p>sbb 认得的账号，以及每个账号上的脑。额度在状态栏里看。</p>
          <div v-for="account in accounts" :key="account.name" class="row">
            <div class="lab">{{ account.label }}</div>
            <div class="val">{{ account.clis.join(' / ') || '没有 CLI' }}</div>
            <div class="val text-es-muted">{{ account.brains }} 个脑</div>
          </div>
        </div>
      </template>

      <template v-else-if="section === 'terminal'">
        <div class="sec">
          <h2>终端</h2>
          <p>「去终端」在哪个终端里 attach 这个脑的 tmux 会话。</p>
          <div class="row">
            <div class="lab">终端</div>
            <div class="seg">
              <button
                v-for="item in TERMINALS"
                :key="String(item.id)"
                class="seg-item"
                :class="{ 'seg-item-active': terminal === item.id }"
                @click="terminal === item.id ? null : save(terminalBody(item.id), '已保存终端选择')"
              >
                {{ item.label }}
              </button>
            </div>
            <div class="val text-es-muted">terminal</div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="sec">
          <h2>外观</h2>
          <div class="row">
            <div class="lab">主题</div>
            <div class="seg">
              <button
                v-for="item in THEMES"
                :key="item.id"
                class="seg-item"
                :class="{ 'seg-item-active': store.themeChoice === item.id }"
                @click="store.setTheme(item.id)"
              >
                {{ item.label }}
              </button>
            </div>
            <div class="val text-es-muted">sbb-theme</div>
          </div>
          <template v-if="isDesktop">
            <div class="row">
              <div class="lab">窗口透明度</div>
              <input v-model.number="appearance.tint" class="slider" type="range" :min="TINT.min" :max="TINT.max" :step="TINT.step" @input="saveAppearance" />
              <div class="val">{{ tintPct }}%</div>
            </div>
            <div class="row">
              <div class="lab">背景模糊</div>
              <input v-model.number="appearance.blur" class="slider" type="range" :min="BLUR.min" :max="BLUR.max" :step="BLUR.step" @input="saveAppearance" />
              <div class="val">{{ appearance.blur }} px</div>
            </div>
          </template>
          <p v-else class="text-es-muted">窗口透明度与背景模糊只在桌面壳里生效（sbb 桌面版）。</p>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.sec {
  margin-bottom: 26px;
}
.sec h2 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
}
.sec p {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-es-muted);
}
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--es-divider);
  font-size: 13px;
}
.row .lab {
  width: 210px;
  flex: none;
  color: var(--color-es-dim);
}
.dark .row .lab {
  color: var(--color-es-dark-muted);
}
.row .val {
  font-family: var(--font-mono);
  font-size: 12px;
}
.toggle {
  width: 34px;
  height: 20px;
  flex: none;
  border-radius: 10px;
  background: var(--color-es-green);
  position: relative;
}
.toggle span {
  position: absolute;
  right: 2px;
  top: 2px;
  width: 16px;
  height: 16px;
  border-radius: 8px;
  background: #ffffff;
}
.toggle.off {
  background: var(--es-track);
}
.toggle.off span {
  right: auto;
  left: 2px;
}
.slider {
  flex: 1;
  max-width: 260px;
  accent-color: var(--color-es-green);
}
</style>
