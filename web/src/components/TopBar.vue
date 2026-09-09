<script setup>
// 44 px top bar (web-console.md, screen 1): the view dropdown, the ⌘K brain search, the gear.
// Everything else that used to live here moved to the status bar or the settings view.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSbb } from '../store/sbb.js';
import Icon from './Icon.vue';

const store = useSbb();
const VIEWS = [
  { id: 'console', label: '控制台', icon: 'console', key: '1' },
  { id: 'org', label: '组织图', icon: 'org', key: '2' },
  { id: 'log', label: '回执日志', icon: 'log', key: '3' },
  { id: 'settings', label: '设置', icon: 'gear', key: '4' },
];
const DOT = { idle: 'dot-idle', busy: 'dot-busy', blocked: 'dot-blocked', '?': 'dot-unknown', gone: 'dot-unknown' };

const current = computed(() => VIEWS.find((view) => view.id === store.view) ?? VIEWS[0]);
const menu = ref(false);
const box = ref(null);
const matches = computed(() => (store.search.trim() ? store.visibleBrains.slice(0, 6) : []));

function pick(view) {
  store.setView(view.id);
  menu.value = false;
}

function choose(brain) {
  store.setView('console');
  store.select(brain.id);
  store.search = '';
}

/** @param {KeyboardEvent} event */
function onSearchKey(event) {
  if (event.key === 'Enter' && matches.value.length) {
    event.preventDefault();
    choose(matches.value[0]);
  }
  if (event.key === 'Escape') {
    store.search = '';
    event.target instanceof HTMLElement && event.target.blur();
  }
}

/** @param {PointerEvent} event */
const onDown = (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest('[data-menu]')) menu.value = false;
};
onMounted(() => document.addEventListener('pointerdown', onDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDown));

// ⌘K focuses the top-bar field (web-console.md, "Keyboard").
store.focusSearch = () => box.value?.focus();
</script>

<template>
  <header class="bar top-bar relative z-30 flex h-11 shrink-0 items-center gap-2 border-b px-3.5">
    <div class="relative" data-menu>
      <button
        class="flex items-center gap-[8px] rounded-[8px] px-[8px] py-[5px] text-[13px]"
        :class="menu ? 'btn-ghost' : 'hover:bg-[var(--es-hover)]'"
        title="切换视图"
        @click="menu = !menu"
      >
        <Icon :name="current.icon" :size="15" />
        <span>{{ current.label }}</span>
        <span class="text-[10px] text-es-muted">▾</span>
      </button>

      <div v-if="menu" class="glass absolute left-0 top-[38px] z-40 w-[188px] rounded-[12px] p-[6px]">
        <button
          v-for="view in VIEWS"
          :key="view.id"
          class="flex w-full items-center gap-[10px] rounded-[8px] px-[10px] py-[8px] text-left text-[13px]"
          :class="{ 'row-selected': store.view === view.id }"
          @click="pick(view)"
        >
          <Icon :name="view.icon" :size="15" />
          <span>{{ view.label }}</span>
          <span class="mono ml-auto text-[10.5px] text-es-muted">⌘{{ view.key }}</span>
        </button>
      </div>
    </div>

    <div class="flex-grow" />

    <div class="relative" data-menu>
      <div class="flex min-w-[240px] items-center gap-2 rounded-[8px] px-[10px] py-[5px] text-[12px]" style="background: var(--es-sunken)">
        <Icon name="search" :size="13" class="text-es-muted" />
        <input
          ref="box"
          v-model="store.search"
          class="field w-full bg-transparent outline-none"
          placeholder="按名字或编号找脑，或输入命令"
          @keydown="onSearchKey"
        />
        <span class="mono shrink-0 rounded-[4px] px-[5px] py-px text-[10.5px] text-es-muted" style="background: var(--es-sunken-strong)">⌘K</span>
      </div>

      <div v-if="matches.length" class="glass absolute right-0 top-[34px] z-40 w-[280px] rounded-[12px] p-[6px]">
        <button
          v-for="brain in matches"
          :key="brain.id"
          class="flex w-full items-center gap-2 rounded-[8px] px-[10px] py-[7px] text-left text-[12px]"
          @click="choose(brain)"
        >
          <span class="h-[7px] w-[7px] shrink-0 rounded-[4px]" :class="DOT[brain.status]" />
          <span class="font-medium">{{ brain.name }}</span>
          <span class="mono text-[11px] text-es-muted">{{ brain.id }}</span>
          <span class="ml-auto text-[11px] text-es-muted">{{ brain.account }}/{{ brain.cli }}</span>
        </button>
      </div>
    </div>

    <button
      class="flex h-7 w-7 items-center justify-center rounded-[8px]"
      :class="store.view === 'settings' ? 'row-selected' : 'btn-ghost'"
      title="设置 ⌘,"
      @click="store.setView('settings')"
    >
      <Icon name="gear" :size="15" />
    </button>
  </header>
</template>

<style scoped>
/* The desktop shell makes the whole bar a drag region; its controls must stay clickable. */
.top-bar :is(button, input, [data-menu]) {
  -webkit-app-region: no-drag;
}
</style>
