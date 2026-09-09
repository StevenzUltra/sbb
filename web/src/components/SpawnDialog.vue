<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useSbb } from '../store/sbb.js';
import {
  clampOffset, cliOptions, cwdPicks, effortOptions, footerText, modelOptions,
  modelSuggestions, quotaChipFor, quotaLabel, readCustomModels, readDialogPosition,
  sanitizeName, writeCustomModel, writeDialogPosition,
} from '../lib/spawn.js';

const store = useSbb();

const form = reactive({
  name: '',
  account: store.accounts[0]?.name ?? 'a',
  cli: '',
  model: '',
  effort: '',
  role: 'sub',
  parent: store.brains.find((brain) => brain.role === 'main')?.id ?? null,
  cwd: '',
});

const storage = typeof localStorage === 'undefined' ? null : localStorage;

const panel = ref(null);
const nameInput = ref(null);
const cwdOpen = ref(false);
const modelOpen = ref(false);
const customModels = ref(readCustomModels(storage));
const pos = reactive({ x: 0, y: 0 });

const account = computed(() => store.accounts.find((item) => item.name === form.account) ?? null);
const clis = computed(() => {
  const list = cliOptions(account.value);
  return list.length ? list : ['claude'];
});
const cli = computed(() => form.cli || clis.value[0] || '');
const models = computed(() => modelOptions(store.catalog, { account: form.account, cli: cli.value }));
const efforts = computed(() => effortOptions(cli.value));
const parent = computed(() => store.brainById(form.parent));
const picks = computed(() => cwdPicks({ recent: store.recentCwds, parent: parent.value?.cwd ?? null }));
const selectedQuota = computed(() => quotaChipFor(store.quota, form.account, cli.value));
// The model is a combo: catalog suggestions plus anything typed, remembered per CLI.
const modelPicks = computed(() =>
  modelSuggestions(store.catalog, { account: form.account, cli: cli.value, custom: customModels.value[cli.value] ?? null }));
const footer = computed(() =>
  footerText({
    chip: selectedQuota.value, account: form.account, cli: cli.value,
    model: form.model, effort: form.effort,
  }));
const hasBridge = computed(() => typeof window !== 'undefined' && Boolean(window.sbbDesktop?.pickFolder));

// The account changed: fall back to its first CLI. The model is free text now, so switching
// CLI clears it back to the CLI's own default instead of forcing a catalog entry.
watch(clis, (list) => {
  if (!list.includes(form.cli)) form.cli = list[0] ?? '';
}, { immediate: true });
watch(cli, () => {
  form.model = '';
  form.effort = '';
  modelOpen.value = false;
});

// A name is an address: spaces can never survive the server, so turn them into '-' while typing.
function onNameInput(event) {
  const next = sanitizeName(event.target.value);
  if (next !== event.target.value) event.target.value = next;
  form.name = next;
}

function accountQuota(item) {
  const pair = item.name === form.account ? cli.value : (cliOptions(item)[0] ?? '');
  return quotaLabel(store.quota, item.name, pair);
}

function chooseCwd(path) {
  form.cwd = path;
  cwdOpen.value = false;
}

function chooseModel(id) {
  form.model = id;
  modelOpen.value = false;
}

async function pickFolder() {
  const chosen = await window.sbbDesktop?.pickFolder({ defaultPath: form.cwd || parent.value?.cwd || undefined });
  if (chosen) form.cwd = chosen;
  cwdOpen.value = false;
}

const ready = computed(() => Boolean(form.name && form.account && cli.value));

async function submit() {
  if (!ready.value) return;
  const model = form.model.trim();
  const catalogIds = models.value.map((row) => row.model);
  if (model && !catalogIds.includes(model)) customModels.value = writeCustomModel(storage, cli.value, model);
  await store.spawn({
    name: form.name,
    account: form.account,
    cli: cli.value,
    model: model || undefined,
    effort: form.effort || undefined,
    role: form.role,
    parent: form.role === 'main' ? null : form.parent,
    cwd: form.cwd.trim() || parent.value?.cwd || picks.value[0] || undefined,
  });
}

// ---- drag by the title bar -------------------------------------------------
const drag = { active: false, startX: 0, startY: 0, baseX: 0, baseY: 0, width: 0, height: 0 };

function onDragStart(event) {
  if (event.button !== 0) return;
  if (event.target.closest('button, input, select, textarea')) return;
  const box = panel.value?.getBoundingClientRect();
  if (!box) return;
  drag.active = true;
  drag.startX = event.clientX;
  drag.startY = event.clientY;
  drag.baseX = pos.x;
  drag.baseY = pos.y;
  drag.width = box.width;
  drag.height = box.height;
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd, { once: true });
  event.preventDefault();
}

function onDragMove(event) {
  if (!drag.active) return;
  const next = clampOffset({
    x: drag.baseX + (event.clientX - drag.startX),
    y: drag.baseY + (event.clientY - drag.startY),
    width: drag.width,
    height: drag.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  pos.x = next.x;
  pos.y = next.y;
}

function onDragEnd() {
  drag.active = false;
  writeDialogPosition({ x: pos.x, y: pos.y });
  window.removeEventListener('pointermove', onDragMove);
}

function reclamp() {
  const box = panel.value?.getBoundingClientRect();
  if (!box) return;
  const next = clampOffset({
    x: pos.x, y: pos.y, width: box.width, height: box.height,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  });
  pos.x = next.x;
  pos.y = next.y;
}

function onKeydown(event) {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  if (cwdOpen.value) cwdOpen.value = false;
  else if (modelOpen.value) modelOpen.value = false;
  else store.dialog = null;
}

onMounted(async () => {
  const saved = readDialogPosition();
  if (saved) {
    pos.x = saved.x;
    pos.y = saved.y;
  }
  await nextTick();
  reclamp();
  nameInput.value?.focus();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', reclamp);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', reclamp);
  window.removeEventListener('pointermove', onDragMove);
});
</script>

<template>
  <div class="scrim fixed inset-0 z-40 flex items-center justify-center" @click.self="store.dialog = null">
    <div
      ref="panel"
      class="dialog-solid w-[520px] rounded-[16px] p-4"
      :style="{ transform: `translate(${pos.x}px, ${pos.y}px)` }"
    >
      <div class="flex flex-col gap-[12px]">
        <div class="dialog-bar flex items-center justify-between" @pointerdown="onDragStart">
          <div class="text-[14px] font-semibold">新建</div>
          <button class="text-es-muted" @click="store.dialog = null">关闭</button>
        </div>

        <label class="flex flex-col gap-[6px] text-[12px]">
          <span class="text-es-dim dark:text-es-dark-muted">名字</span>
          <input
            ref="nameInput"
            v-model="form.name"
            class="field px-3 py-2 outline-none"
            placeholder="例如 review"
            @input="onNameInput"
          />
        </label>

        <div class="flex flex-col gap-[6px] text-[12px]">
          <span class="text-es-dim dark:text-es-dark-muted">账号（剩余额度）</span>
          <div class="flex flex-wrap gap-[6px]">
            <button
              v-for="item in store.accounts"
              :key="item.name"
              class="rounded-[8px] px-[10px] py-[6px] text-[12px]"
              :class="form.account === item.name ? 'tone-green font-medium' : 'btn-ghost'"
              @click="form.account = item.name"
            >
              {{ item.label ?? item.name }}
              <span class="mono ml-1 text-[11px]">{{ accountQuota(item) }}</span>
            </button>
          </div>
        </div>

        <div class="flex gap-3">
          <label class="flex flex-1 flex-col gap-[6px] text-[12px]">
            <span class="text-es-dim dark:text-es-dark-muted">CLI</span>
            <select v-model="form.cli" class="field px-3 py-2 outline-none">
              <option v-for="item in clis" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label v-if="efforts.length" class="flex w-[110px] shrink-0 flex-col gap-[6px] text-[12px]">
            <span class="text-es-dim dark:text-es-dark-muted">思考强度</span>
            <select v-model="form.effort" class="field px-2 py-2 outline-none">
              <option value="">无</option>
              <option v-for="level in efforts" :key="level" :value="level">{{ level }}</option>
            </select>
          </label>
          <label class="flex flex-1 flex-col gap-[6px] text-[12px]">
            <span class="text-es-dim dark:text-es-dark-muted">模型（可手输）</span>
            <div class="relative">
              <input
                v-model="form.model"
                class="field mono w-full px-3 py-2 text-[12px] outline-none"
                :placeholder="modelPicks.length ? 'CLI 默认' : '该 CLI 默认'"
                @focus="modelOpen = true"
                @click="modelOpen = true"
                @blur="modelOpen = false"
              />
              <div
                v-if="modelOpen && modelPicks.length"
                class="glass absolute top-[calc(100%+4px)] left-0 z-50 flex w-full flex-col rounded-[10px] p-[4px]"
              >
                <button
                  v-for="pick in modelPicks"
                  :key="pick.id"
                  class="rounded-[7px] px-[8px] py-[5px] text-left text-[11px] hover:bg-black/5 dark:hover:bg-white/10"
                  @mousedown.prevent="chooseModel(pick.id)"
                >
                  {{ pick.label }}
                </button>
              </div>
            </div>
          </label>
        </div>

        <div class="flex gap-3">
          <label class="flex flex-1 flex-col gap-[6px] text-[12px]">
            <span class="text-es-dim dark:text-es-dark-muted">角色</span>
            <select v-model="form.role" class="field px-3 py-2 outline-none">
              <option value="sub">子脑</option>
              <option value="main">主脑</option>
            </select>
          </label>
          <label v-if="form.role === 'sub'" class="flex flex-1 flex-col gap-[6px] text-[12px]">
            <span class="text-es-dim dark:text-es-dark-muted">上级</span>
            <select v-model="form.parent" class="field px-3 py-2 outline-none">
              <option v-for="brain in store.brains.filter((item) => item.role === 'main')" :key="brain.id" :value="brain.id">
                {{ brain.name }}#{{ brain.id }}
              </option>
            </select>
          </label>
        </div>

        <div class="flex flex-col gap-[6px] text-[12px]">
          <span class="text-es-dim dark:text-es-dark-muted">工作目录（默认跟上级）</span>
          <div class="flex gap-[6px]">
            <div class="relative flex-1">
              <input
                v-model="form.cwd"
                class="field mono w-full px-3 py-2 text-[12px] outline-none"
                :placeholder="parent?.cwd ?? picks[0] ?? '/Users/steven/developer/sbb'"
                @focus="cwdOpen = true"
                @blur="cwdOpen = false"
              />
              <div
                v-if="cwdOpen && picks.length"
                class="glass absolute top-[calc(100%+4px)] left-0 z-50 flex w-full flex-col rounded-[10px] p-[4px]"
              >
                <button
                  v-for="path in picks"
                  :key="path"
                  class="mono rounded-[7px] px-[8px] py-[5px] text-left text-[11px] hover:bg-black/5 dark:hover:bg-white/10"
                  @mousedown.prevent="chooseCwd(path)"
                >
                  {{ path }}
                </button>
              </div>
            </div>
            <button v-if="hasBridge" class="btn-ghost shrink-0 px-[10px] text-[12px]" @click="pickFolder">选择文件夹…</button>
          </div>
        </div>

        <div class="flex items-center justify-between">
          <span class="mono text-[11px] text-es-muted">{{ footer }}</span>
          <span class="flex gap-[6px]">
            <button class="px-3 py-[7px] text-[12px] text-es-dim dark:text-es-dark-muted" @click="store.dialog = null">取消</button>
            <button class="btn-primary px-[14px] py-[7px] text-[12px] disabled:opacity-60" :disabled="!ready" @click="submit">新建</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
