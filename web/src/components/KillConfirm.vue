<script setup>
import { computed } from 'vue';
import { useSbb } from '../store/sbb.js';

const store = useSbb();
const subtree = computed(() => store.killSubtree);
const busy = computed(() => Boolean(store.pending[store.killTarget]));
</script>

<template>
  <div v-if="store.killTarget" class="fixed inset-0 z-40 flex items-center justify-center" style="background: rgba(0, 0, 0, 0.24)">
    <div class="glass w-[420px] rounded-[16px] p-4" style="box-shadow: 0 16px 48px rgba(0, 0, 0, 0.16)">
      <div class="flex flex-col gap-[10px]">
        <div class="text-[13px] font-semibold">结束 {{ subtree[0]?.name }}#{{ subtree[0]?.id }}？</div>
        <div class="text-[12px] text-es-dim dark:text-es-dark-muted">整棵子树一起结束，下面是会被关掉的脑：</div>
        <ul class="flex flex-col gap-1 text-[12px]">
          <li v-for="brain in subtree" :key="brain.id" class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-[4px] dot-busy" />
            <span class="font-semibold">{{ brain.name }}</span>
            <span class="mono text-[11px] text-es-muted">{{ brain.id }}</span>
            <span class="text-[11px] text-es-muted">{{ brain.account }} / {{ brain.cli }} · {{ brain.coord }}</span>
          </li>
        </ul>
        <div class="flex justify-end gap-[6px]">
          <button class="px-3 py-[7px] text-[12px] text-es-dim dark:text-es-dark-muted" @click="store.killTarget = null">取消</button>
          <button class="tone-red-solid px-[14px] py-[7px] text-[12px] font-medium disabled:opacity-60" :disabled="busy" @click="store.confirmKill()">
            结束
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
