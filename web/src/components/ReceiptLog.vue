<script setup>
import { computed, ref } from 'vue';
import { useSbb } from '../store/sbb.js';
import Icon from './Icon.vue';

const store = useSbb();
const brainFilter = ref('');
const statusFilter = ref('');
const viaFilter = ref('');
const open = ref(null);

const STATUS = ['delivered', 'queued', 'unverified', 'blocked'];
const TONE = {
  delivered: 'tone-green',
  queued: 'tone-yellow',
  unverified: 'tone-muted',
  blocked: 'tone-red',
};

const vias = computed(() => [...new Set(store.receipts.map((row) => row.via).filter(Boolean))]);
const rows = computed(() =>
  store.receipts.filter((row) => {
    if (brainFilter.value && row.from !== brainFilter.value && row.to !== brainFilter.value) return false;
    if (statusFilter.value && row.status !== statusFilter.value) return false;
    if (viaFilter.value && row.via !== viaFilter.value) return false;
    return true;
  }),
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 p-3">
    <section class="glass flex flex-col overflow-hidden rounded-[16px]">
      <div class="flex items-center gap-3 border-b px-4 py-3" style="border-color: var(--es-divider)">
        <div class="text-[14px] font-semibold">回执日志</div>
        <div class="text-[12px] text-es-muted">{{ rows.length }} 条</div>
        <div class="flex-grow" />
        <select v-model="brainFilter" class="field px-2 py-[6px] text-[12px] outline-none">
          <option value="">全部脑</option>
          <option v-for="brain in store.brains" :key="brain.id" :value="brain.name">{{ brain.name }}</option>
        </select>
        <select v-model="statusFilter" class="field px-2 py-[6px] text-[12px] outline-none">
          <option value="">全部状态</option>
          <option v-for="status in STATUS" :key="status" :value="status">{{ status }}</option>
        </select>
        <select v-model="viaFilter" class="field px-2 py-[6px] text-[12px] outline-none">
          <option value="">全部通道</option>
          <option v-for="via in vias" :key="via" :value="via">{{ via }}</option>
        </select>
      </div>

      <div class="grid grid-cols-[64px_120px_120px_96px_140px_minmax(0,1fr)] gap-3 border-b px-4 py-2 text-[11px] tracking-[0.04em] text-es-muted" style="border-color: var(--es-divider)">
        <span>时间</span><span>来自</span><span>发给</span><span>状态</span><span>通道</span><span>预览</span>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <button
          v-for="row in rows"
          :key="`${row.msgId}-${row.at}`"
          class="grid w-full grid-cols-[64px_120px_120px_96px_140px_minmax(0,1fr)] gap-3 border-b px-4 py-[10px] text-left text-[12px] hover:bg-[var(--es-hover)]"
          style="border-color: var(--es-divider)"
          @click="open = row"
        >
          <span class="mono text-es-muted">{{ row.at }}</span>
          <span class="truncate">{{ row.from }}</span>
          <span class="truncate">{{ row.to }}</span>
          <span>
            <span class="rounded-[999px] px-[8px] py-[2px] text-[11px]" :class="TONE[row.status] ?? 'tone-muted'">{{ row.status }}</span>
          </span>
          <span class="mono truncate text-es-muted">{{ row.via }}</span>
          <span class="truncate text-es-dim dark:text-es-dark-muted">{{ row.preview }}</span>
        </button>
        <div v-if="!rows.length" class="px-4 py-6 text-[13px] text-es-muted">没有匹配的回执。</div>
      </div>
    </section>

    <section v-if="open" class="glass flex flex-col gap-2 rounded-[16px] px-4 py-3">
      <div class="flex items-center gap-2">
        <Icon name="file" :size="13" class="text-es-muted" />
        <span class="mono text-[12px]">{{ open.msgId }}</span>
        <span class="rounded-[999px] px-[8px] py-[2px] text-[11px]" :class="TONE[open.status] ?? 'tone-muted'">{{ open.status }}</span>
        <span class="text-[12px] text-es-muted">{{ open.at }} · {{ open.from }} → {{ open.to }} · {{ open.via }}</span>
        <div class="flex-grow" />
        <button class="text-[12px] text-es-muted" @click="open = null">关闭</button>
      </div>
      <div class="text-[14px] leading-[1.6]">{{ open.preview }}</div>
    </section>
  </div>
</template>
