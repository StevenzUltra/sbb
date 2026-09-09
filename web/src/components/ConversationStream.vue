<script setup>
import { computed } from 'vue';
import { useSbb } from '../store/sbb.js';
import Icon from './Icon.vue';
import Composer from './Composer.vue';
import HeldCard from './HeldCard.vue';

const store = useSbb();

// Header tabs follow docs/design/console/Main.html: one 组频道 tab plus one per private
// thread. Which team 组频道 means is picked by the switcher under the tree.
const headerTabs = computed(() => [
  { id: 'group', kind: 'team', label: '组频道' },
  ...store.threads.map((thread) => ({ id: `thread:${thread.id}`, kind: 'thread', threadId: thread.id, label: thread.title })),
]);
const headerActive = (tab) =>
  tab.kind === 'team' ? store.activeTab?.kind === 'team' : store.activeTab?.id === tab.id;
const openHeaderTab = (tab) => {
  if (tab.kind === 'team') store.openTab({ kind: 'team', teamId: store.teamId });
  else store.openTab(tab);
};

const initial = (message) => (message.from === 'user' ? '你' : (message.fromName ?? '?').slice(0, 1).toUpperCase());

function avatarStyle(message) {
  if (message.from === 'user' || store.brainById(message.from)?.role === 'main') {
    return { background: 'var(--es-avatar-lead)', color: '#ffffff' };
  }
  return { background: 'var(--es-avatar-sub)', color: 'var(--es-avatar-sub-text)' };
}

const TONE = {
  delivered: 'text-es-green dark:text-es-dark-green',
  queued: 'text-[#7a5410] dark:text-es-yellow',
  held: 'text-[#7a5410] dark:text-es-yellow',
  blocked: 'text-es-red',
  unverified: 'text-es-muted',
};
const ICON = { delivered: 'check', queued: 'clock', held: 'clock', blocked: 'kill', unverified: 'warn' };

function receiptText(receipt) {
  const parts = [receipt.status];
  if (receipt.via) parts.push(receipt.via);
  if (receipt.elapsedMs) parts.push(`${(receipt.elapsedMs / 1000).toFixed(1)}s`);
  if (receipt.reason) parts.push(`reason=${receipt.reason}`);
  if (receipt.count > 1) parts.push(`${receipt.count} 位成员`);
  if (receipt.msgId) parts.push(String(receipt.msgId).slice(0, 8));
  return parts.join(' · ');
}

const heldFor = (message) => store.held.find((item) => item.msgId === message.msgId);
</script>

<template>
  <section class="glass flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[16px]">
    <div class="flex items-center gap-3 border-b px-4 py-3" style="border-color: var(--es-divider)">
      <div class="flex items-baseline gap-2 whitespace-nowrap">
        <span class="mono text-[14px] font-semibold">{{ store.activeTab?.label ?? '#all' }}</span>
        <span class="text-[12px] text-es-muted">{{ store.activeTab?.sub ?? '' }}</span>
      </div>
      <div class="flex-grow" />
      <div class="seg">
        <button
          v-for="tab in headerTabs"
          :key="tab.id"
          class="seg-item"
          :class="{ 'seg-item-active': headerActive(tab) }"
          @click="openHeaderTab(tab)"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-5 py-[18px]">
      <article v-for="message in store.messages" :key="message.msgId" class="flex gap-3" :class="{ 'opacity-55': message.pending }">
        <div class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[15px] text-[13px] font-semibold" :style="avatarStyle(message)">
          {{ initial(message) }}
        </div>

        <div class="flex min-w-0 flex-grow flex-col gap-[6px]">
          <div class="flex items-baseline gap-2 whitespace-nowrap">
            <span class="text-[13px] font-semibold">{{ message.fromName }}</span>
            <span v-if="message.from !== 'user'" class="mono text-[11px] text-es-muted">{{ message.from }}</span>
            <span v-if="store.brainById(message.from)?.role === 'main'" class="tone-green rounded-[999px] px-[6px] py-px text-[11px]">主脑</span>
            <span class="text-[11px] text-es-muted">{{ message.at }}{{ message.note ? ` · ${message.note}` : '' }}</span>
          </div>

          <HeldCard v-if="heldFor(message)" :held="heldFor(message)" />

          <template v-else>
            <div v-if="message.pending" class="flex flex-col gap-2">
              <div class="h-3 w-80 rounded-[6px]" style="background: var(--es-sunken)" />
              <div class="h-3 w-56 rounded-[6px]" style="background: var(--es-sunken)" />
            </div>
            <div
              v-else
              class="max-w-[640px] text-[14px] leading-[1.6]"
              :class="message.highlight ? 'rounded-[12px] px-3 py-[10px]' : ''"
              :style="message.highlight ? { background: 'var(--es-highlight-fill)', color: 'var(--es-highlight-text)' } : {}"
            >
              {{ message.text }}
            </div>
          </template>

          <div v-if="message.receipt" class="mono flex items-center gap-[6px] whitespace-nowrap text-[11px]" :class="TONE[message.receipt.status] ?? TONE.delivered">
            <Icon :name="ICON[message.receipt.status] ?? 'check'" :size="12" :width="2.5" />
            {{ receiptText(message.receipt) }}
          </div>

          <div v-if="store.waiting[message.msgId]" class="mono flex items-center gap-[6px] text-[11px] text-[#7a5410] dark:text-es-yellow">
            <span class="h-[6px] w-[6px] animate-pulse rounded-[3px] bg-es-yellow" />
            等待回复…（{{ store.waiting[message.msgId] }} 发出）
          </div>
        </div>
      </article>

      <div v-if="!store.messages.length" class="py-6 text-center text-[13px] text-es-muted">
        这里还没有消息。
      </div>
    </div>

    <Composer />
  </section>
</template>
