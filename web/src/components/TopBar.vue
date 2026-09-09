<script setup>
import { useSbb, POLICY_LABEL } from '../store/sbb.js';
import Icon from './Icon.vue';

const store = useSbb();
const views = [
  { id: 'console', label: '控制台' },
  { id: 'org', label: '组织图' },
  { id: 'log', label: '回执日志' },
];
const TONE = { open: 'tone-green', moderated: 'tone-yellow', closed: 'tone-muted' };
</script>

<template>
  <header class="bar flex h-[56px] shrink-0 items-center gap-4 border-b px-5">
    <div class="flex items-center gap-[10px]">
      <div class="flex h-7 w-7 items-center justify-center rounded-[8px] bg-es-green">
        <Icon name="brand" :size="16" stroke="#ffffff" />
      </div>
      <div class="text-[15px] font-semibold tracking-[0.02em]">SBB</div>
      <div class="text-[12px] text-es-muted">Switch Brain Brain</div>
    </div>

    <div class="h-5 w-px" style="background: var(--es-divider)" />

    <nav class="seg">
      <button
        v-for="view in views"
        :key="view.id"
        class="seg-item"
        :class="{ 'seg-item-active': store.view === view.id }"
        @click="store.setView(view.id)"
      >
        {{ view.label }}
      </button>
    </nav>

    <div class="h-5 w-px" style="background: var(--es-divider)" />

    <div class="flex items-center gap-2">
      <div
        v-for="chip in store.quota"
        :key="chip.key"
        class="glass flex items-center gap-2 whitespace-nowrap rounded-[999px] px-[10px] py-[4px] text-[12px]"
      >
        <span class="text-es-dim dark:text-es-dark-muted">{{ chip.label }}</span>
        <span v-if="chip.pct !== null" class="track relative h-1 w-14 rounded-[2px]">
          <span
            class="absolute left-0 top-0 h-1 rounded-[2px]"
            :style="{ width: `${chip.pct}%`, background: chip.pct < 80 ? '#e5a835' : '#2d6b4f' }"
          />
        </span>
        <span class="mono">{{ chip.pct !== null ? `${chip.pct}%` : chip.note }}</span>
      </div>
    </div>

    <div class="flex-grow" />

    <div class="flex items-center gap-2">
      <button
        class="flex items-center gap-[6px] rounded-[999px] px-[10px] py-[5px] text-[12px] font-medium"
        :class="TONE[store.policyMode]"
        :title="`主脑互通：${POLICY_LABEL[store.policyMode]}，点击切换`"
        @click="store.setPolicy(store.policyMode === 'open' ? 'moderated' : store.policyMode === 'moderated' ? 'closed' : 'open')"
      >
        <span
          class="h-[6px] w-[6px] rounded-[3px]"
          :style="{ background: store.policyMode === 'open' ? '#2d6b4f' : store.policyMode === 'moderated' ? '#e5a835' : '#8a938e' }"
        />
        主脑互通 {{ POLICY_LABEL[store.policyMode] }}
      </button>

      <div
        class="flex items-center gap-[6px] rounded-[999px] px-[10px] py-[5px] text-[12px]"
        :class="store.heldCount ? 'tone-red-solid' : 'glass tone-muted'"
      >
        待批准 {{ store.heldCount }}
      </div>

      <button
        class="btn-primary flex items-center gap-[6px] px-3 py-[6px] text-[13px]"
        @click="store.dialog = 'spawn'"
      >
        <Icon name="plus" :size="14" stroke="#ffffff" />
        开脑
      </button>

      <button
        class="btn-ghost flex h-7 w-7 items-center justify-center"
        :title="store.theme === 'dark' ? '切到浅色' : '切到深色'"
        @click="store.toggleTheme()"
      >
        <Icon :name="store.theme === 'dark' ? 'sun' : 'moon'" :size="14" />
      </button>
    </div>
  </header>
</template>
