<script setup>
// 30 px status bar (web-console.md, screen 1): connection, tok/s, per-account weekly quota,
// 主脑互通, 待批准, version. One line; when the window is too narrow the bar scrolls sideways.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSbb, POLICY_LABEL } from '../store/sbb.js';
import { quotaTone, TONE_COLOR } from '../lib/quota.js';

const store = useSbb();
/** Quota items shown inline; the rest collapse behind `+N`. */
const INLINE = 4;

const shown = computed(() => store.quota.slice(0, INLINE));
const rest = computed(() => store.quota.slice(INLINE));
const more = ref(false);
const tps = computed(() => store.tpsRows.find((row) => row.id === store.selectedId) ?? null);
const one = (value) => Number(Number(value).toFixed(1));
const total = computed(() => one(store.tps?.total ?? 0));

const cycle = () =>
  store.setPolicy(store.policyMode === 'open' ? 'moderated' : store.policyMode === 'moderated' ? 'closed' : 'open');

const onDown = (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest('[data-more]')) more.value = false;
};
onMounted(() => document.addEventListener('pointerdown', onDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDown));
</script>

<template>
  <footer
    class="bar flex h-[30px] shrink-0 items-center gap-[18px] overflow-x-auto whitespace-nowrap border-t px-3.5 text-[11.5px] text-es-muted [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
  >
    <div class="flex shrink-0 items-center gap-[6px]">
      <span class="h-[7px] w-[7px] rounded-[4px]" :class="store.connected ? 'dot-idle' : 'dot-blocked'" />
      {{ store.connected ? 'tmux 已连接' : '未连接' }}
    </div>

    <span class="h-[14px] w-px shrink-0" style="background: var(--es-divider)" />

    <div class="flex shrink-0 items-center gap-[6px]">
      吐字
      <b v-if="tps" class="mono font-medium text-es-dim dark:text-es-dark-text">{{ tps.name }} {{ one(tps.tps) }}</b>
      <span>· 总</span>
      <b class="mono font-medium text-es-dim dark:text-es-dark-text">{{ total }}</b>
      <span>tok/s</span>
    </div>

    <span class="h-[14px] w-px shrink-0" style="background: var(--es-divider)" />

    <div v-for="chip in shown" :key="chip.key" class="flex shrink-0 items-center gap-[6px]" :title="chip.note">
      {{ chip.label }}
      <span v-if="chip.pct !== null" class="track relative h-[3px] w-[44px] rounded-[2px]">
        <span
          class="absolute left-0 top-0 h-[3px] rounded-[2px]"
          :style="{ width: `${chip.pct}%`, background: TONE_COLOR[quotaTone(chip.pct, store.policy)] }"
        />
      </span>
      <b class="mono font-medium text-es-dim dark:text-es-dark-text">{{ chip.pct !== null ? `${chip.pct}%` : chip.note }}</b>
    </div>

    <div v-if="rest.length" class="relative shrink-0" data-more>
      <button class="rounded-[6px] px-[6px] py-px" :class="more ? 'btn-ghost' : ''" @click="more = !more">
        +{{ rest.length }} ▾
      </button>
      <div v-if="more" class="glass absolute bottom-[24px] left-0 z-40 flex w-[250px] flex-col gap-[6px] rounded-[12px] p-[10px]">
        <div v-for="chip in rest" :key="chip.key" class="flex items-center gap-[6px]" :title="chip.note">
          <span class="truncate">{{ chip.label }}</span>
          <span v-if="chip.pct !== null" class="track relative ml-auto h-[3px] w-[44px] shrink-0 rounded-[2px]">
            <span
              class="absolute left-0 top-0 h-[3px] rounded-[2px]"
              :style="{ width: `${chip.pct}%`, background: TONE_COLOR[quotaTone(chip.pct, store.policy)] }"
            />
          </span>
          <b class="mono shrink-0 font-medium text-es-dim dark:text-es-dark-text">{{ chip.pct !== null ? `${chip.pct}%` : chip.note }}</b>
        </div>
      </div>
    </div>

    <div class="ml-auto flex shrink-0 items-center gap-[18px]">
      <button class="flex items-center gap-[6px]" :title="`主脑互通：${POLICY_LABEL[store.policyMode]}，点击切换`" @click="cycle">
        <span
          class="h-[7px] w-[7px] rounded-[4px]"
          :style="{ background: store.policyMode === 'open' ? '#2d6b4f' : store.policyMode === 'moderated' ? '#e5a835' : '#8a938e' }"
        />
        主脑互通 {{ POLICY_LABEL[store.policyMode] }}
      </button>

      <button
        class="rounded-[999px] px-[8px] py-px"
        :class="store.heldCount ? 'tone-red-solid' : 'tone-muted'"
        :title="store.heldCount ? '打开待批准的消息' : '没有待批准的消息'"
        @click="store.openHeld()"
      >
        待批准 {{ store.heldCount }}
      </button>

      <span class="mono">v{{ store.version || '0.0.0' }}</span>
    </div>
  </footer>
</template>
