<script setup>
import { computed } from 'vue';
import { useSbb } from '../store/sbb.js';
import Icon from './Icon.vue';

const store = useSbb();
const draft = computed(() => store.moveDraft);
const subject = computed(() => store.moveSubject);
const target = computed(() => store.moveTarget);
const busy = computed(() => Boolean(store.pending[draft.value?.brain]));

const candidates = computed(() =>
  store.brains.filter((brain) => brain.id !== draft.value?.brain && brain.id !== subject.value?.parent),
);

const command = computed(() => {
  const parts = ['sbb move', subject.value?.name ?? '<脑>', '--to', target.value?.name ?? '<上级>'];
  if (draft.value?.mode === 'afterIdle') parts.push('--after-idle');
  if (draft.value?.handoff) parts.push('--handoff');
  return parts.join(' ');
});
</script>

<template>
  <div v-if="draft" class="glass absolute bottom-8 left-1/2 z-40 w-[420px] -translate-x-1/2 rounded-[16px] p-4" style="box-shadow: 0 16px 48px rgba(0, 0, 0, 0.16)">
    <div class="flex flex-col gap-[10px]">
      <div class="text-[13px] font-semibold">
        <template v-if="target">把 {{ subject?.name }}#{{ subject?.id }} 转到 {{ target.name }}#{{ target.id }} 名下</template>
        <template v-else>把 {{ subject?.name }}#{{ subject?.id }} 转到谁名下？</template>
      </div>
      <div class="text-[12px] text-es-dim dark:text-es-dark-muted">上下文原样保留；{{ subject?.name }}、{{ target?.name ?? '新上级' }} 各收到一条通知。</div>

      <div v-if="!target" class="flex flex-wrap gap-[6px]">
        <button
          v-for="candidate in candidates"
          :key="candidate.id"
          class="btn-ghost px-[10px] py-[6px] text-[12px]"
          @click="draft.to = candidate.id"
        >
          {{ candidate.name }}<span class="mono ml-1 text-[11px] text-es-muted">{{ candidate.id }}</span>
        </button>
      </div>

      <div class="flex gap-[6px]">
        <button
          class="rounded-[8px] px-[10px] py-[6px] text-[12px]"
          :class="draft.mode === 'afterIdle' ? 'tone-green font-medium' : 'btn-ghost text-es-dim dark:text-es-dark-muted'"
          @click="draft.mode = 'afterIdle'"
        >
          完成当前任务后
        </button>
        <button
          class="rounded-[8px] px-[10px] py-[6px] text-[12px]"
          :class="draft.mode === 'now' ? 'tone-green font-medium' : 'btn-ghost text-es-dim dark:text-es-dark-muted'"
          @click="draft.mode = 'now'"
        >
          立即
        </button>
      </div>

      <label class="flex cursor-pointer items-center gap-2 text-[12px]">
        <span
          class="flex h-[14px] w-[14px] items-center justify-center rounded-[4px]"
          :class="draft.handoff ? 'bg-es-green' : 'track'"
        >
          <Icon v-if="draft.handoff" name="check" :size="10" :width="3" stroke="#ffffff" />
        </span>
        <input v-model="draft.handoff" type="checkbox" class="hidden" />
        先让它写交接摘要
      </label>

      <div class="flex items-center justify-between">
        <span class="mono text-[11px] text-es-muted">{{ command }}</span>
        <span class="flex gap-[6px]">
          <button class="px-3 py-[7px] text-[12px] text-es-dim dark:text-es-dark-muted" @click="store.moveDraft = null">取消</button>
          <button class="btn-primary px-[14px] py-[7px] text-[12px] disabled:opacity-60" :disabled="busy" @click="store.confirmMove()">
            转移
          </button>
        </span>
      </div>
    </div>
  </div>
</template>
