<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useSbb } from '../store/sbb.js';
import { ScreenWidth } from '../lib/screen.js';
import Icon from './Icon.vue';

const store = useSbb();
const host = ref(null);
const scroller = ref(null);
let terminal = null;
let fitAddon = null;
let socket = null;
let observer = null;
let requestTimer = null;
let escapeAt = 0;
// The pane's own geometry (canned in fixture mode, reported by the server when it knows it).
let paneCols = 0;
let paneRows = 0;
// Monotone lower bound on the pane's columns, measured from the output itself.
const width = new ScreenWidth();
const decoder = new TextDecoder();

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
  socket = null;
  terminal.reset();
  width.reset();
  paneCols = 0;
  paneRows = 0;
  const id = paneId();
  if (!id) {
    terminal.writeln('这个脑没有窗格（可能已经结束）。');
    syncSize({ request: false });
    return;
  }
  socket = store.client.openPane(id, {
    onGeometry: ({ cols, rows }) => {
      paneCols = Number(cols) || 0;
      paneRows = Number(rows) || 0;
      syncSize({ request: false });
    },
    onData: (bytes) => {
      // Measure before writing: the terminal must already be wide enough for this chunk,
      // otherwise xterm would soft-wrap a line that fits the pane (see syncSize).
      if (width.feed(decoder.decode(bytes, { stream: true })) > terminal.cols) syncSize();
      terminal.write(bytes);
    },
    onClosed: (reason) => {
      if (reason) terminal.write(`\r\n[连接关闭：${reason}]\r\n`);
    },
    onRefused: (reason) => {
      // A resize is declined while someone has the pane open in a terminal (ui-server.md);
      // the console keeps streaming at the pane's own size, so nothing to report.
      if (reason === 'client_attached') return;
      if (reason === 'input_off') store.toast('先点「在此输入」再敲键盘', 'warn');
      else store.toast(`窗格拒绝了这次操作：${reason}`, 'warn');
    },
  });
  if (store.paneMode === 'input') socket.send({ type: 'mode', input: true });
  syncSize();
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

/** What the terminal could be if the pane were resized to this panel. */
function proposed() {
  if (!fitAddon) return null;
  try {
    return fitAddon.proposeDimensions() ?? null;
  } catch {
    return null;
  }
}

/**
 * Size the terminal to the pane's own columns and never below the widest line already
 * seen, so a line that fits the pane always fits xterm: a terminal wider than its pane
 * never wraps. A pane wider than the panel is shown at full width and the pane area
 * scrolls horizontally instead of folding lines. The resize frame asks the server to
 * resize the pane to the panel; the server declines while another client is attached
 * (ui-server.md, "Live pane stream").
 */
function syncSize({ request = true } = {}) {
  if (!terminal) return;
  const want = proposed();
  const cols = Math.max(paneCols, want?.cols ?? 0, width.cols, 2);
  const rows = Math.max(paneRows, want?.rows ?? 0, 1);
  if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
  if (!request) return;
  clearTimeout(requestTimer);
  requestTimer = setTimeout(() => {
    const fresh = proposed();
    if (fresh) socket?.send({ type: 'resize', cols: fresh.cols, rows: fresh.rows });
  }, 120);
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
  // Only proposeDimensions() is used; fit() would narrow the terminal to the panel and wrap.
  terminal.loadAddon(fitAddon);
  terminal.open(host.value);
  terminal.onData((data) => {
    if (store.paneMode === 'input') socket?.send({ type: 'input', data });
  });
  terminal.attachCustomKeyEventHandler(onKey);
  syncSize({ request: false });
  observer = new ResizeObserver(() => syncSize());
  observer.observe(scroller.value);
  openPane();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(requestTimer);
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

    <!-- Padding lives on this frame, not on the scroller: FitAddon measures the scroller's
         box, so padding there would over-estimate the panel's column count. -->
    <div class="relative m-3 min-h-0 flex-grow overflow-hidden rounded-[12px] p-3" :class="{ 'ring-2 ring-es-green': store.paneMode === 'input' }" :style="{ background: store.theme === 'dark' ? '#0c0f0d' : '#111513' }">
      <div ref="scroller" class="h-full w-full overflow-auto">
        <div ref="host" class="h-full w-full" />
      </div>
    </div>

    <div class="flex items-center gap-[10px] overflow-hidden whitespace-nowrap px-4 pb-[14px] pt-[10px] text-[11px] text-es-muted">
      <span class="min-w-0 truncate">画面来自 tmux 控制模式 · 点「在此输入」直接键入，或 ⌘` 跳到终端</span>
      <span class="mono ml-auto shrink-0">
        claims {{ store.claims.length }} · 回执 delivered {{ store.receiptStats.delivered }} / queued {{ store.receiptStats.queued }}
      </span>
    </div>
  </section>
</template>
