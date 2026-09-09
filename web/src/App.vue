<script setup>
import { onBeforeUnmount, onMounted } from 'vue';
import { useSbb } from './store/sbb.js';
import TopBar from './components/TopBar.vue';
import ConsoleView from './components/ConsoleView.vue';
import OrgChart from './components/OrgChart.vue';
import ReceiptLog from './components/ReceiptLog.vue';
import SettingsView from './components/SettingsView.vue';
import StatusBar from './components/StatusBar.vue';
import SpawnDialog from './components/SpawnDialog.vue';
import KillConfirm from './components/KillConfirm.vue';
import ToastStack from './components/ToastStack.vue';
import Icon from './components/Icon.vue';

const store = useSbb();
const onKey = (event) => store.handleKey(event);

onMounted(() => {
  store.init();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="relative flex h-full flex-col overflow-hidden">
    <TopBar />

    <main class="relative flex min-h-0 flex-1 flex-col">
      <div v-if="!store.ready" class="flex flex-1 items-center justify-center text-[13px] text-es-muted">
        <template v-if="store.error">
          <div class="glass flex max-w-[520px] flex-col items-center gap-3 rounded-[16px] px-6 py-5">
            <Icon name="warn" :size="20" class="text-es-red" />
            <div class="text-[13px] font-semibold">连不上 sbb ui</div>
            <div class="mono text-[12px] text-es-muted">{{ store.error }}</div>
            <div class="text-[12px] text-es-muted">
              先用 fixture 模式看看界面：<span class="mono">VITE_SBB_FIXTURE=1 npm run dev</span>
            </div>
          </div>
        </template>
        <template v-else>正在读取 sbb 状态…</template>
      </div>

      <template v-else>
        <div v-if="!store.brains.length" class="flex flex-1 items-center justify-center">
          <div class="glass flex w-[420px] flex-col items-center gap-3 rounded-[16px] px-6 py-6">
            <div class="text-[14px] font-semibold">还没有脑</div>
            <div class="text-center text-[12px] text-es-muted">新建一个主脑，让它带子脑干活。</div>
            <button class="btn-primary px-4 py-2 text-[13px]" @click="store.dialog = 'spawn'">新建</button>
          </div>
        </div>

        <ConsoleView v-else-if="store.view === 'console'" />
        <OrgChart v-else-if="store.view === 'org'" />
        <ReceiptLog v-else-if="store.view === 'log'" />
        <SettingsView v-else />
      </template>
    </main>

    <StatusBar />
    <SpawnDialog v-if="store.dialog === 'spawn'" />
    <KillConfirm />
    <ToastStack />
  </div>
</template>
