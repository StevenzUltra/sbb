<script setup>
import { useSbb } from '../store/sbb.js';
import Icon from './Icon.vue';

const props = defineProps({ held: { type: Object, required: true } });
const store = useSbb();

const busy = () => Boolean(store.pending[props.held.msgId]);

async function allow() {
  await store.approve(props.held.msgId);
  store.threadId = props.held.thread ?? store.threadId;
}

async function deny() {
  await store.deny(props.held.msgId, 'denied');
}

async function alwaysAllow() {
  await store.approve(props.held.msgId);
  await store.setPolicy('open');
  store.toast(`以后 ${props.held.fromName} 与 ${props.held.toName} 之间不再问你`, 'ok');
}
</script>

<template>
  <div
    class="flex max-w-[640px] flex-col gap-[10px] rounded-[12px] px-[14px] py-3"
    style="border: 1px solid rgba(229, 168, 53, 0.6); background: rgba(229, 168, 53, 0.08)"
  >
    <div class="flex items-center gap-2">
      <span class="h-2 w-2 rounded-[4px] bg-es-yellow" />
      <span class="text-[12px] font-semibold text-[#7a5410] dark:text-es-yellow">被扣住，等你过目</span>
      <span class="mono text-[11px] text-es-muted">{{ held.msgId }} · 主脑互通策略：{{ held.policy ?? 'moderated' }}</span>
    </div>

    <div class="text-[14px] leading-[1.6]">{{ held.text }}</div>

    <div class="flex items-center gap-2">
      <button
        class="btn-primary flex items-center gap-[6px] px-[14px] py-[7px] text-[12px] disabled:opacity-60"
        :disabled="busy()"
        @click="allow"
      >
        <Icon name="check" :size="12" stroke="#ffffff" />
        放行
      </button>
      <button
        class="tone-red flex items-center gap-[6px] px-[14px] py-[7px] text-[12px] font-medium disabled:opacity-60"
        :disabled="busy()"
        @click="deny"
      >
        <Icon name="kill" :size="12" />
        拒绝
      </button>
      <button
        class="px-3 py-[7px] text-[12px] text-es-dim dark:text-es-dark-muted"
        :disabled="busy()"
        @click="alwaysAllow"
      >
        以后 {{ held.fromName }} 与 {{ held.toName }} 之间不再问我
      </button>
    </div>
  </div>
</template>
