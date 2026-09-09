<script setup>
import { computed, reactive } from 'vue';
import { useSbb } from '../store/sbb.js';

const store = useSbb();
const form = reactive({
  name: '',
  account: store.accounts[0]?.name ?? 'a',
  cli: '',
  model: '',
  role: 'sub',
  parent: store.brains.find((brain) => brain.role === 'main')?.id ?? null,
  cwd: '',
});

const account = computed(() => store.accounts.find((item) => item.name === form.account) ?? null);
const clis = computed(() => account.value?.clis ?? ['claude', 'codex']);
const models = computed(() => store.catalog.filter((item) => item.cli === (form.cli || clis.value[0])));
const parent = computed(() => store.brainById(form.parent));
const quota = computed(() => store.quota.find((item) => item.key === `${form.account}/${form.cli || clis.value[0]}`));

function pickAccount(name) {
  form.account = name;
  const first = store.accounts.find((item) => item.name === name)?.clis?.[0];
  form.cli = first ?? form.cli;
  form.model = store.catalog.find((item) => item.cli === form.cli)?.model ?? '';
}

const ready = computed(() => Boolean(form.name && form.account && (form.cli || clis.value[0])));

async function submit() {
  if (!ready.value) return;
  await store.spawn({
    name: form.name,
    account: form.account,
    cli: form.cli || clis.value[0],
    model: form.model || models.value[0]?.model,
    role: form.role,
    parent: form.role === 'main' ? null : form.parent,
    cwd: form.cwd || parent.value?.cwd || '/Users/steven/developer/sbb',
  });
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center" style="background: rgba(0, 0, 0, 0.24)" @click.self="store.dialog = null">
    <div class="glass w-[520px] rounded-[16px] p-4" style="box-shadow: 0 16px 48px rgba(0, 0, 0, 0.16)">
      <div class="flex flex-col gap-[12px]">
        <div class="flex items-center justify-between">
          <div class="text-[14px] font-semibold">开脑</div>
          <button class="text-es-muted" @click="store.dialog = null">关闭</button>
        </div>

        <label class="flex flex-col gap-[6px] text-[12px]">
          <span class="text-es-dim dark:text-es-dark-muted">名字</span>
          <input v-model="form.name" class="field px-3 py-2 outline-none" placeholder="例如 review" />
        </label>

        <div class="flex flex-col gap-[6px] text-[12px]">
          <span class="text-es-dim dark:text-es-dark-muted">账号（剩余额度）</span>
          <div class="flex flex-wrap gap-[6px]">
            <button
              v-for="item in store.accounts"
              :key="item.name"
              class="rounded-[8px] px-[10px] py-[6px] text-[12px]"
              :class="form.account === item.name ? 'tone-green font-medium' : 'btn-ghost'"
              @click="pickAccount(item.name)"
            >
              {{ item.label ?? item.name }}
              <span v-if="store.quota.find((q) => q.key.startsWith(`${item.name}/`))?.pct !== undefined" class="mono ml-1 text-[11px]">
                {{ store.quota.find((q) => q.key.startsWith(`${item.name}/`))?.pct ?? '按量' }}
              </span>
            </button>
          </div>
        </div>

        <div class="flex gap-3">
          <label class="flex flex-1 flex-col gap-[6px] text-[12px]">
            <span class="text-es-dim dark:text-es-dark-muted">CLI</span>
            <select v-model="form.cli" class="field px-3 py-2 outline-none">
              <option v-for="cli in clis" :key="cli" :value="cli">{{ cli }}</option>
            </select>
          </label>
          <label class="flex flex-1 flex-col gap-[6px] text-[12px]">
            <span class="text-es-dim dark:text-es-dark-muted">模型</span>
            <select v-model="form.model" class="field px-3 py-2 outline-none">
              <option v-for="item in models" :key="item.model" :value="item.model">{{ item.label }}</option>
            </select>
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

        <label class="flex flex-col gap-[6px] text-[12px]">
          <span class="text-es-dim dark:text-es-dark-muted">工作目录（默认跟上级）</span>
          <input v-model="form.cwd" class="field mono px-3 py-2 text-[12px] outline-none" :placeholder="parent?.cwd ?? '/Users/steven/developer/sbb'" />
        </label>

        <div class="flex items-center justify-between">
          <span class="text-[11px] text-es-muted">
            {{ quota ? `${quota.label} 剩余 ${quota.pct !== null ? `${quota.pct}%` : '按量'}` : '这个账号还没有额度数据' }}
          </span>
          <span class="flex gap-[6px]">
            <button class="px-3 py-[7px] text-[12px] text-es-dim dark:text-es-dark-muted" @click="store.dialog = null">取消</button>
            <button class="btn-primary px-[14px] py-[7px] text-[12px] disabled:opacity-60" :disabled="!ready" @click="submit">开脑</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
