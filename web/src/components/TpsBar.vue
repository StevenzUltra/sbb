<script setup>
import { useSbb } from '../store/sbb.js';

const store = useSbb();
</script>

<template>
  <footer class="bar flex h-9 shrink-0 items-center gap-[22px] border-t px-5">
    <span class="whitespace-nowrap text-[11px] tracking-[0.06em] text-es-muted">吐字速度 · 近 60 秒</span>

    <div v-for="row in store.tpsRows" :key="row.id" class="flex items-center gap-2 whitespace-nowrap">
      <span class="text-[12px] font-semibold">{{ row.name }}</span>
      <span class="mono text-[11px] text-es-muted">{{ row.id }}</span>
      <span class="text-[11px] text-es-dim dark:text-es-dark-muted">{{ row.modelLabel }}</span>
      <span class="track relative h-1 w-16 rounded-[2px]">
        <span
          class="absolute left-0 top-0 h-1 rounded-[2px] bg-es-green dark:bg-es-dark-green"
          :style="{ width: `${row.pct}%` }"
        />
      </span>
      <span class="mono text-[12px]">{{ row.tps }}</span>
      <span class="text-[11px] text-es-muted">tok/s</span>
    </div>

    <div class="flex-grow" />

    <div class="flex items-center gap-2 whitespace-nowrap">
      <span class="text-[11px] text-es-muted">总吞吐</span>
      <span class="mono text-[12px] font-semibold">{{ store.tps.total }}</span>
      <span class="text-[11px] text-es-muted">tok/s</span>
      <span class="h-[14px] w-px" style="background: var(--es-divider)" />
      <span class="text-[11px] text-es-muted">来源：各脑会话记录里的输出 token 与用时</span>
    </div>
  </footer>
</template>
