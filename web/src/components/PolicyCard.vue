<script setup>
import { useSbb, POLICY_LABEL } from '../store/sbb.js';

const store = useSbb();
const modes = ['open', 'moderated', 'closed'];
const TONE = { green: 'text-es-green dark:text-es-dark-green', yellow: 'text-[#7a5410] dark:text-es-yellow', muted: 'text-es-muted' };
</script>

<template>
  <section class="glass flex flex-col gap-[10px] rounded-[16px] px-4 py-3">
    <div class="flex items-center justify-between">
      <div class="text-[13px] font-semibold">谁能和谁说话</div>
      <div class="seg">
        <button
          v-for="mode in modes"
          :key="mode"
          class="seg-item"
          :class="{ 'seg-item-active': store.policyMode === mode }"
          @click="store.policyMode === mode ? null : store.setPolicy(mode)"
        >
          {{ POLICY_LABEL[mode] }}
        </button>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
      <div v-for="row in store.policy.rows" :key="row.label" class="flex justify-between gap-2">
        <span class="text-es-dim dark:text-es-dark-muted">{{ row.label }}</span>
        <span class="font-medium" :class="TONE[row.tone] ?? TONE.muted">{{ row.value }}</span>
      </div>
    </div>
  </section>
</template>
