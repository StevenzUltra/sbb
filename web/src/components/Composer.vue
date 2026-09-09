<script setup>
import { ref } from 'vue';
import { useSbb } from '../store/sbb.js';
import Icon from './Icon.vue';

const store = useSbb();
const draft = ref('');
const fileInput = ref(null);

const placeholder = () => {
  const tab = store.activeTab;
  if (tab?.kind === 'thread') return `直接对 ${tab.label.replace('私聊 ', '')} 说一句`;
  return `给 ${tab?.label ?? '#all'} 说一句，回车发送`;
};

async function submit() {
  const text = draft.value;
  draft.value = '';
  await store.send(text);
}

async function ask() {
  const text = draft.value;
  draft.value = '';
  await store.send(text, { ask: true });
}

// There is no upload: SBB brains read files by path, so the button inserts a path hint.
function attach() {
  fileInput.value?.click();
}

function onFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  draft.value = `${draft.value}${draft.value ? ' ' : ''}${file.name}`;
  store.toast('浏览器只给文件名；把完整路径写进消息，脑会自己读。', 'warn');
}
</script>

<template>
  <div class="flex items-center gap-[10px] border-t px-4 py-3" style="border-color: var(--es-divider)">
    <input
      v-model="draft"
      class="field min-w-0 flex-grow px-3 py-[9px] text-[13px] outline-none"
      :placeholder="placeholder()"
      @keydown.enter.exact.prevent="submit"
      @keydown.meta.enter.prevent="ask"
    />
    <input ref="fileInput" type="file" class="hidden" @change="onFile" />
    <button class="btn-ghost flex items-center gap-[6px] px-3 py-2 text-[12px] text-es-dim dark:text-es-dark-muted" @click="attach">
      <Icon name="file" :size="13" />
      附文件
    </button>
    <button class="btn-primary flex items-center gap-[6px] px-[14px] py-2 text-[13px]" @click="submit">
      <Icon name="send" :size="13" stroke="#ffffff" />
      发送
    </button>
  </div>
</template>
