<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSbb } from '../store/sbb.js';
import { clampWidth, DEFAULTS, readLayout, writeLayout } from '../lib/layout.js';
import BrainTree from './BrainTree.vue';
import ConversationStream from './ConversationStream.vue';
import BrainPane from './BrainPane.vue';
import PolicyCard from './PolicyCard.vue';
import Icon from './Icon.vue';

const store = useSbb();
const narrow = ref(false);

// Column widths: dragged by the handles, remembered per browser, reset by a double-click.
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
})();
const saved = readLayout(storage);
const left = ref(saved.left);
const right = ref(saved.right);
const dragging = ref(/** @type {'left'|'right'|null} */ (null));

const fit = () => {
  narrow.value = window.innerWidth < 1180;
  const ctx = { viewport: window.innerWidth, narrow: narrow.value };
  left.value = clampWidth('left', left.value, { ...ctx, other: right.value });
  right.value = clampWidth('right', right.value, { ...ctx, other: left.value });
};

/** @param {'left'|'right'} side @param {PointerEvent} event */
function startDrag(side, event) {
  if (event.button !== 0) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = side === 'left' ? left.value : right.value;
  dragging.value = side;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  const move = (e) => {
    const delta = e.clientX - startX;
    const next = side === 'left' ? startWidth + delta : startWidth - delta;
    const ctx = { viewport: window.innerWidth, narrow: narrow.value, other: side === 'left' ? right.value : left.value };
    if (side === 'left') left.value = clampWidth('left', next, ctx);
    else right.value = clampWidth('right', next, ctx);
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    dragging.value = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    writeLayout(storage, { left: left.value, right: right.value });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

/** @param {'left'|'right'} side */
function resetWidth(side) {
  if (side === 'left') left.value = DEFAULTS.left;
  else right.value = DEFAULTS.right;
  fit();
  writeLayout(storage, { left: left.value, right: right.value });
}

onMounted(() => {
  fit();
  window.addEventListener('resize', fit);
});
onBeforeUnmount(() => window.removeEventListener('resize', fit));

const columns = computed(() => (narrow.value
  ? `${left.value}px 12px minmax(0, 1fr)`
  : `${left.value}px 12px minmax(0, 1fr) 12px ${right.value}px`));

// 主脑互通 · 先经我过目 puts the compact policy table above the pane (web-console.md, screen 4).
const showPolicy = computed(() => store.policyMode === 'moderated');
</script>

<template>
  <div class="grid min-h-0 flex-1 p-3" :style="{ gridTemplateColumns: columns }">
    <BrainTree />

    <div
      class="resize-handle"
      :class="{ active: dragging === 'left' }"
      title="拖动调整脑图宽度，双击恢复"
      @pointerdown="startDrag('left', $event)"
      @dblclick="resetWidth('left')"
    >
      <span />
    </div>

    <ConversationStream />

    <template v-if="!narrow">
      <div
        class="resize-handle"
        :class="{ active: dragging === 'right' }"
        title="拖动调整终端面板宽度，双击恢复"
        @pointerdown="startDrag('right', $event)"
        @dblclick="resetWidth('right')"
      >
        <span />
      </div>

      <div class="flex min-h-0 min-w-0 flex-col gap-3">
        <PolicyCard v-if="showPolicy" />
        <BrainPane class="flex-1" />
      </div>
    </template>

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

<style scoped>
/* The handle fills the 12px gutter; the visible bar is 3px and only shows on hover or drag. */
.resize-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}
.resize-handle span {
  width: 3px;
  height: 48px;
  border-radius: 2px;
  background: var(--es-divider);
  opacity: 0;
  transition: opacity 120ms ease, height 120ms ease, background 120ms ease;
}
.resize-handle:hover span,
.resize-handle.active span {
  opacity: 1;
  height: 96px;
  background: #9aa39e;
}
.resize-handle.active span {
  background: var(--color-es-green, #2d6b4f);
}
</style>
