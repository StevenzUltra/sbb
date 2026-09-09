<script setup>
import { useSbb } from '../store/sbb.js';
import Icon from './Icon.vue';

const store = useSbb();
const TONE = { ok: 'text-es-green dark:text-es-dark-green', warn: 'text-[#7a5410] dark:text-es-yellow', error: 'text-es-red' };
const ICON = { ok: 'check', warn: 'warn', error: 'warn' };
</script>

<template>
  <div class="pointer-events-none fixed bottom-[52px] right-5 z-50 flex w-[360px] flex-col gap-2">
    <div
      v-for="toast in store.toasts"
      :key="toast.id"
      class="glass flex items-start gap-2 rounded-[12px] px-3 py-[10px] text-[12px]"
    >
      <span :class="TONE[toast.tone] ?? TONE.ok" class="mt-[1px]">
        <Icon :name="ICON[toast.tone] ?? 'check'" :size="13" :width="2.4" />
      </span>
      <span class="leading-[1.5]">{{ toast.text }}</span>
    </div>
  </div>
</template>
