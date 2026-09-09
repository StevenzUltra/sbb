<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useSbb } from '../store/sbb.js';
import Icon from './Icon.vue';

const store = useSbb();
const host = ref(null);
let terminal = null;
let fitAddon = null;
let socket = null;
let observer = null;
let escapeAt = 0;

const theme = () => ({
  background: store.theme === 'dark' ? '#0c0f0d' : '#111513',
  foreground: '#d5dbd7',
  cursor: '#7fbf9f',
  selectionBackground: 'rgba(127, 191, 159, 0.28)',
});

const paneId = () => store.selected?.paneId ?? null;

function openPane() {
  if (!terminal) return;
  socket?.close();
  terminal.reset();
  const id = paneId();
  if (!id) {
    terminal.writeln('这个脑没有窗格（可能已经结束）。');
    return;
  }
  socket = store.client.openPane(id, {
    onData: (bytes) => terminal.write(bytes),
    onClosed: (reason) => {
      if (reason && reason !== 'input_off') terminal.write(`\r\n[连接关闭：${reason}]\r\n`);
    },
  });
  if (store.paneMode === 'input') socket.send({ type: 'mode', input: true });
}

function setInputMode(on) {
  store.paneMode = on ? 'input' : 'view';
  if (terminal) terminal.options.disableStdin = !on;
  socket?.send({ type: 'mode', input: on });
  if (on) terminal?.focus();
}

function onKey(event) {
  if (event.type !== 'keydown') return true;
  if (event.key === 'Escape') {
    if (store.paneMode !== 'input') return true;
    // Esc-Esc leaves input mode (web-console.md, "在此输入").
    if (escapeAt && Date.now() - escapeAt < 700) {
      escapeAt = 0;
      setInputMode(false);
    } else {
      escapeAt = Date.now();
    }
    return false;
  }
  if (store.paneMode !== 'input') return true;
  if (event.key === 'Enter') {
    socket?.send({ type: 'key', name: 'Enter' });
    return false;
  }
  if (event.key === 'Backspace') {
    socket?.send({ type: 'key', name: 'BSpace' });
    return false;
  }
  if (event.key === 'Tab') {
    socket?.send({ type: 'key', name: 'Tab' });
    return false;
  }
  return true;
}

function resize() {
  if (!terminal || !fitAddon) return;
  try {
    fitAddon.fit();
  } catch {
    return;
  }
  socket?.send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
}

onMounted(() => {
  terminal = new Terminal({
    convertEol: true,
    fontSize: 12,
    lineHeight: 1.7,
    fontFamily: '"SF Mono", Menlo, Consolas, monospace',
    scrollback: 2000,
    disableStdin: true,
    theme: theme(),
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host.value);
  terminal.onData((data) => {
    if (store.paneMode === 'input') socket?.send({ type: 'input', data });
  });
  terminal.attachCustomKeyEventHandler(onKey);
  fitAddon.fit();
  observer = new ResizeObserver(() => resize());
  observer.observe(host.value);
  openPane();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  socket?.close();
  terminal?.dispose();
});

watch(() => store.selectedId, openPane);
watch(() => store.paneMode, (mode) => {
  if (terminal) terminal.options.disableStdin = mode !== 'input';
  socket?.send({ type: 'mode', input: mode === 'input' });
});
watch(() => store.theme, () => {
  if (terminal) terminal.options.theme = theme();
});
</script>

<template>
  <section class="glass flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[16px]">
    <div class="flex items-center gap-[10px] border-b px-4 py-3" style="border-color: var(--es-divider)">
      <div class="flex min-w-0 flex-grow flex-col gap-[2px]">
        <div class="flex items-baseline gap-[6px] whitespace-nowrap">
          <span class="text-[14px] font-semibold">{{ store.selected?.name ?? '没有选中的脑' }}</span>
          <span v-if="store.selected" class="mono text-[11px] text-es-muted">{{ store.selected.id }}</span>
          <span
            v-if="store.selected"
            class="h-[6px] w-[6px] rounded-[3px]"
            :class="store.selected.status === 'busy' ? 'dot-busy' : store.selected.status === 'blocked' ? 'dot-blocked' : 'dot-idle'"
          />
          <span class="text-[11px] text-es-muted">实时</span>
        </div>
        <div v-if="store.selected" class="mono truncate text-[11px] text-es-muted">
          {{ store.selected.account }} / {{ store.selected.cli }} · {{ store.selected.model }} · {{ store.selected.coord }}
        </div>
      </div>

      <div v-if="store.selected" class="flex gap-[6px]">
        <button
          class="rounded-[8px] px-[10px] py-[5px] text-[12px] whitespace-nowrap"
          :class="store.paneMode === 'input' ? 'btn-primary' : 'btn-ghost'"
          @click="setInputMode(store.paneMode !== 'input')"
        >
          在此输入
        </button>
        <button class="btn-ghost px-[10px] py-[5px] text-[12px] whitespace-nowrap" @click="store.goTerminal(store.selected.id)">
          去终端
        </button>
        <button class="btn-ghost px-[10px] py-[5px] text-[12px] whitespace-nowrap" @click="store.openMove(store.selected.id)">
          转移
        </button>
        <button class="tone-red px-[10px] py-[5px] text-[12px] whitespace-nowrap" @click="store.killTarget = store.selected.id">
          结束
        </button>
      </div>
    </div>

    <div class="relative m-3 min-h-0 flex-grow overflow-hidden rounded-[12px]" :class="{ 'ring-2 ring-es-green': store.paneMode === 'input' }" :style="{ background: store.theme === 'dark' ? '#0c0f0d' : '#111513' }">
      <div ref="host" class="h-full w-full pl-4 pt-3" />
    </div>

    <div class="flex items-center gap-[10px] px-4 pb-[14px] pt-[10px] text-[11px] text-es-muted">
      <span>画面来自 tmux 控制模式 · 点「在此输入」直接键入，或 ⌘` 跳到终端</span>
      <div class="flex-grow" />
      <span class="mono">
        claims {{ store.claims.length }} · 回执 delivered {{ store.receiptStats.delivered }} / queued {{ store.receiptStats.queued }}
      </span>
    </div>
  </section>
</template>
