<script setup>
import { useSbb } from '../store/sbb.js';

const store = useSbb();
</script>

<template>
  <footer class="bar flex h-9 shrink-0 items-center gap-[22px] overflow-hidden whitespace-nowrap border-t px-5">
    <span class="shrink-0 text-[11px] tracking-[0.06em] text-es-muted">吐字速度 · 近 60 秒</span>

    <!-- The per-brain rows are clipped before anything on the right; 总吞吐 never is. -->
    <div class="flex min-w-0 items-center gap-[22px] overflow-hidden">
      <div v-for="row in store.tpsRows" :key="row.id" class="flex shrink-0 items-center gap-2">
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
    </div>

    <div class="ml-auto flex min-w-0 items-center gap-2">
      <span class="shrink-0 text-[11px] text-es-muted">总吞吐</span>
      <span class="mono shrink-0 text-[12px] font-semibold">{{ store.tps.total }}</span>
      <span class="shrink-0 text-[11px] text-es-muted">tok/s</span>
      <span class="h-[14px] w-px shrink-0" style="background: var(--es-divider)" />
      <!-- The only shrinkable item: the 来源 note ellipsizes (and then disappears) first. -->
      <span class="min-w-0 shrink-[999] truncate text-[11px] text-es-muted">来源：各脑会话记录里的输出 token 与用时</span>
    </div>
  </footer>
</template>
