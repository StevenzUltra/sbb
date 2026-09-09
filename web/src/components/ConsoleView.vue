<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSbb } from '../store/sbb.js';
import BrainTree from './BrainTree.vue';
import ConversationStream from './ConversationStream.vue';
import BrainPane from './BrainPane.vue';
import PolicyCard from './PolicyCard.vue';
import Icon from './Icon.vue';

const store = useSbb();
const narrow = ref(false);
const measure = () => {
  narrow.value = window.innerWidth < 1180;
};
onMounted(() => {
  measure();
  window.addEventListener('resize', measure);
});
onBeforeUnmount(() => window.removeEventListener('resize', measure));

// 主脑互通 · 先经我过目 puts the compact policy table above the pane (web-console.md, screen 4).
const showPolicy = computed(() => store.policyMode === 'moderated');
</script>

<template>
  <div class="grid min-h-0 flex-1 gap-3 p-3" :style="{ gridTemplateColumns: narrow ? '300px minmax(0, 1fr)' : '300px minmax(0, 1fr) 460px' }">
    <BrainTree />
    <ConversationStream />

    <div v-if="!narrow" class="flex min-h-0 min-w-0 flex-col gap-3">
      <PolicyCard v-if="showPolicy" />
      <BrainPane class="flex-1" />
    </div>

    <template v-else>
      <button
        class="btn-primary absolute right-4 top-[68px] z-30 flex items-center gap-[6px] px-3 py-2 text-[12px]"
        @click="store.drawer = !store.drawer"
      >
        <Icon name="terminal" :size="13" stroke="#ffffff" />
        终端
      </button>
      <div v-if="store.drawer" class="glass absolute inset-y-3 right-3 z-30 flex w-[460px] flex-col gap-3 rounded-[16px] p-3">
        <PolicyCard v-if="showPolicy" />
        <BrainPane class="flex-1" />
      </div>
    </template>
  </div>
</template>
