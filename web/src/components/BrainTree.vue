<script setup>
import { useSbb, STATUS_LABEL } from '../store/sbb.js';
import Icon from './Icon.vue';

const store = useSbb();

const DOT = { idle: 'dot-idle', busy: 'dot-busy', blocked: 'dot-blocked', '?': 'dot-unknown', gone: 'dot-unknown' };
const indent = (brain) => (brain.role === 'sub' && brain.parent ? 'pl-[30px]' : 'pl-[10px]');

function detail(brain) {
  if (brain.status === 'blocked') return `${brain.account} / ${brain.cli} · ${brain.lastMessage ?? ''}`;
  const parts = [
    `${brain.account} / ${brain.cli}`,
    brain.modelLabel ?? brain.model,
    brain.effort ? `effort ${brain.effort}` : null,
    STATUS_LABEL[brain.status] ?? brain.status,
  ];
  return parts.filter(Boolean).join(' · ');
}

</script>

<template>
  <aside class="glass flex min-h-0 flex-col overflow-hidden rounded-[16px]">
    <div class="flex items-center gap-[10px] border-b px-4 py-3" style="border-color: var(--es-divider)">
      <div class="text-[14px] font-semibold">脑图</div>
      <div class="text-[12px] text-es-muted">{{ store.brainCount }} 个脑 · {{ store.teamCount }} 个组</div>
      <button class="btn-primary ml-auto flex items-center gap-[4px] px-[9px] py-[4px] text-[12px]" @click="store.dialog = 'spawn'">
        <Icon name="plus" :size="12" stroke="#ffffff" />
        新建
      </button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto px-2">
      <button
        v-for="brain in store.visibleBrains"
        :key="brain.id"
        class="flex items-center gap-[10px] rounded-[8px] py-[9px] pr-[10px] text-left"
        :class="[indent(brain), brain.id === store.selectedId ? 'row-selected' : '']"
        @click="store.select(brain.id)"
      >
        <span class="h-2 w-2 shrink-0 rounded-[4px]" :class="DOT[brain.status] ?? 'dot-unknown'" />
        <span class="flex min-w-0 flex-grow flex-col gap-[2px]">
          <span class="flex items-baseline gap-[6px] whitespace-nowrap">
            <span class="text-[13px] font-semibold">{{ brain.name }}</span>
            <span class="mono text-[11px] text-es-muted">{{ brain.id }}</span>
            <span v-if="brain.role === 'main'" class="tone-green rounded-[999px] px-[6px] py-px text-[11px]">主脑</span>
          </span>
          <span class="truncate text-[11px] text-es-muted">{{ detail(brain) }}</span>
        </span>
      </button>

      <div v-if="!store.visibleBrains.length" class="px-[10px] py-4 text-[12px] text-es-muted">
        没有匹配的脑。
      </div>
    </div>

    <div class="flex flex-col gap-[6px] border-t px-4 py-3" style="border-color: var(--es-divider)">
      <div class="text-[11px] tracking-[0.06em] text-es-muted">组频道</div>
      <div class="flex flex-wrap gap-[6px]">
        <button
          v-for="team in store.teams"
          :key="team.id"
          class="mono rounded-[999px] px-2 py-[3px] text-[12px]"
          :class="
            store.teamId === team.id && !store.threadId
              ? 'bg-es-green-dark text-white dark:bg-es-green'
              : 'tone-muted'
          "
          @click="store.openTab({ kind: 'team', teamId: team.id })"
        >
          {{ team.name }}
        </button>
      </div>
    </div>
  </aside>
</template>
