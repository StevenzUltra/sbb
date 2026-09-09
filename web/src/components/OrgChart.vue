<script setup>
import { computed, ref } from 'vue';
import { Handle, Position, VueFlow, useVueFlow } from '@vue-flow/core';
import { useSbb } from '../store/sbb.js';
import MoveConfirm from './MoveConfirm.vue';

const store = useSbb();
// Pan and zoom mean screen pixels are not layout pixels: convert before hit-testing.
const { screenToFlowCoordinate } = useVueFlow();
const dragSource = ref(null);

const NODE_W = 200;
const NODE_H = 92;
const GAP_X = 60;
const GAP_Y = 120;

/** Tidy-tree width of a subtree, so siblings never overlap. */
function subtreeWidth(node) {
  const children = node.children ?? [];
  if (!children.length) return NODE_W;
  return children.reduce((sum, child, index) => sum + subtreeWidth(child) + (index ? GAP_X : 0), 0);
}

const graph = computed(() => {
  const nodes = [];
  const edges = [];
  const tree = store.tree;
  if (!tree) return { nodes, edges };

  const place = (node, left, depth) => {
    nodes.push({
      id: node.id,
      type: 'brain',
      position: { x: left, y: depth * GAP_Y },
      data: {
        node,
        brainId: node.id,
        ghost: Boolean(store.moveDraft?.to) && store.moveDraft?.brain === node.id,
      },
      draggable: node.kind === 'brain' && node.id !== store.moveDraft?.brain,
    });
    let cursor = left;
    for (const child of node.children ?? []) {
      place(child, cursor, depth + 1);
      edges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        type: 'smoothstep',
        style: { stroke: 'rgba(26,26,26,0.18)', strokeWidth: 1.5 },
      });
      cursor += subtreeWidth(child) + GAP_X;
    }
  };
  place(tree, 0, 0);

  // A pending move keeps the source in place as a ghost and shows its new slot under the
  // target (docs/design/console/Transfer.html).
  const draft = store.moveDraft;
  const source = draft?.brain ? nodes.find((item) => item.id === draft.brain) : null;
  const target = draft?.to ? nodes.find((item) => item.id === draft.to) : null;
  if (source && target) {
    const pendingId = `${draft.brain}~pending`;
    nodes.push({
      id: pendingId,
      type: 'brain',
      position: { x: target.position.x, y: target.position.y + GAP_Y },
      data: { node: source.data.node, brainId: draft.brain, pending: true },
      draggable: false,
    });
    edges.push({
      id: `${pendingId}-edge`,
      source: source.id,
      target: pendingId,
      type: 'smoothstep',
      style: { stroke: '#2d6b4f', strokeWidth: 2, strokeDasharray: '6 6' },
    });
  }
  return { nodes, edges };
});

function descendants(id) {
  const out = new Set();
  const walk = (parentId) => {
    for (const brain of store.brains) {
      if (brain.parent === parentId && !out.has(brain.id)) {
        out.add(brain.id);
        walk(brain.id);
      }
    }
  };
  walk(id);
  return out;
}

const validTargets = computed(() => {
  const source = dragSource.value ?? store.moveDraft?.brain;
  if (!source) return null;
  const blocked = descendants(source);
  return new Set(store.brains.filter((brain) => !blocked.has(brain.id) && brain.id !== source).map((brain) => brain.id));
});

const nodeClass = (id) => {
  const source = dragSource.value;
  if (!source) return '';
  if (id === source) return 'opacity-50';
  return validTargets.value?.has(id) ? 'ring-2 ring-es-green' : 'opacity-35 grayscale';
};

function onDragStop({ node, event }) {
  const source = store.brainById(node.id);
  // Snapshot the allowed set first: clearing dragSource empties the computed.
  const allowed = validTargets.value;
  const point = event?.clientX ? screenToFlowCoordinate({ x: event.clientX, y: event.clientY }) : null;
  dragSource.value = null;
  if (!source || !point || !allowed) return;
  const target = graph.value.nodes.find((item) => {
    if (item.id === node.id || !allowed.has(item.id)) return false;
    const { x, y } = item.position;
    return point.x >= x && point.x <= x + NODE_W && point.y >= y && point.y <= y + NODE_H;
  });
  if (target) store.openMove(source.id, target.id);
  else store.toast('拖到另一个脑（或「你」）上松手，才能转移', 'warn');
}

const nameOf = (brainId) => (brainId === 'user' ? '你' : store.brainById(brainId)?.name ?? brainId);

/** Ghost keeps the old slot, pending marks the new one; everything else is a plain card. */
function cardStyle(data) {
  if (data.node.kind === 'user') {
    return { background: '#1e3a32', color: '#ffffff', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' };
  }
  if (data.pending) {
    return { background: 'rgba(255,255,255,0.92)', border: '2px solid #2d6b4f', boxShadow: '0 16px 48px rgba(0,0,0,0.16)' };
  }
  if (data.ghost) {
    return { background: 'rgba(255,255,255,0.45)', border: '1px dashed rgba(26,26,26,0.18)', opacity: 0.6 };
  }
  return { background: 'rgba(255,255,255,0.8)', border: '1px solid rgba(26,26,26,0.06)', boxShadow: '0 8px 32px rgba(0,0,0,0.06)' };
}

const command = computed(() => {
  const draft = store.moveDraft;
  if (!draft) return null;
  const parts = ['sbb move', store.brainById(draft.brain)?.name ?? '<脑>', '--to', store.brainById(draft.to)?.name ?? '<上级>'];
  if (draft.mode === 'afterIdle') parts.push('--after-idle');
  if (draft.handoff) parts.push('--handoff');
  return parts.join(' ');
});
</script>

<template>
  <div class="relative h-full min-h-0 p-6">
    <div class="pointer-events-none absolute left-10 top-7 z-10 flex items-center gap-[10px] text-[12px] text-es-dim dark:text-es-dark-muted">
      <span class="h-2 w-2 rounded-[4px] dot-idle" />空闲
      <span class="ml-2 h-2 w-2 rounded-[4px] dot-busy" />忙
      <span class="ml-2 h-2 w-2 rounded-[4px] dot-blocked" />阻塞或待批准
      <span class="ml-4 text-es-muted">拖动节点到新的上级上松手，确认后转移，整棵子树一起走</span>
    </div>

    <VueFlow
      :nodes="graph.nodes"
      :edges="graph.edges"
      :min-zoom="0.6"
      :max-zoom="1"
      :fit-view-on-init="true"
      :nodes-draggable="true"
      :nodes-connectable="false"
      :elements-selectable="false"
      :pan-on-drag="true"
      class="h-full w-full"
      @node-drag-start="dragSource = $event.node.id"
      @node-drag-stop="onDragStop"
    >
      <template #node-brain="{ id, data }">
        <div class="relative">
          <Handle type="target" :position="Position.Top" class="!h-[1px] !w-[1px] !border-0 !bg-transparent" />

          <div
            class="flex w-[200px] flex-col gap-[6px] rounded-[16px] px-[14px] py-3"
            :class="nodeClass(data.brainId ?? id)"
            :style="cardStyle(data)"
          >
            <template v-if="data.node.kind === 'user'">
              <div class="text-[12px] opacity-70">根</div>
              <div class="text-[15px] font-semibold">你</div>
              <div class="text-[11px] opacity-70">用户 · 全部可达</div>
            </template>

            <template v-else>
              <div class="flex items-center gap-2">
                <span
                  class="h-2 w-2 rounded-[4px]"
                  :class="{
                    'dot-idle': store.brainById(data.brainId ?? id)?.status === 'idle',
                    'dot-busy': store.brainById(data.brainId ?? id)?.status === 'busy',
                    'dot-blocked': store.brainById(data.brainId ?? id)?.status === 'blocked',
                    'dot-unknown': !['idle', 'busy', 'blocked'].includes(store.brainById(data.brainId ?? id)?.status),
                  }"
                />
                <span class="text-[14px] font-semibold">{{ data.node.name }}</span>
                <span class="mono text-[11px] text-es-muted">{{ data.brainId ?? id }}</span>
              </div>
              <div class="truncate text-[11px] text-es-dim dark:text-es-dark-muted">
                {{ store.brainById(data.brainId ?? id)?.role === 'main' ? '主脑' : '子脑' }} · {{ store.brainById(data.brainId ?? id)?.account }} /
                {{ store.brainById(data.brainId ?? id)?.cli }} · {{ store.brainById(data.brainId ?? id)?.modelLabel ?? store.brainById(data.brainId ?? id)?.model }}
              </div>

              <div v-if="store.brainById(data.brainId ?? id)?.role === 'main'" class="flex items-center gap-[6px] text-[11px] text-es-muted">
                <span class="track relative h-1 w-[60px] rounded-[2px]">
                  <span
                    class="absolute left-0 top-0 h-1 rounded-[2px] bg-es-green dark:bg-es-dark-green"
                    :style="{ width: `${store.quota.find((q) => q.key.startsWith(`${store.brainById(data.brainId ?? id)?.account}/`))?.pct ?? 0}%` }"
                  />
                </span>
                {{ store.brainById(data.brainId ?? id)?.account }} 周额度 {{ store.quota.find((q) => q.key.startsWith(`${store.brainById(data.brainId ?? id)?.account}/`))?.pct ?? '按量' }}%
              </div>
              <div v-else class="truncate text-[11px] text-es-muted">
                {{
                  data.pending
                    ? `已收到 ${nameOf(store.moveDraft?.to)} 名下，等待确认`
                    : data.ghost
                      ? '原位置'
                      : `最近：${store.brainById(data.brainId ?? id)?.lastMessage ?? ''}`
                }}
              </div>
            </template>
          </div>

          <Handle type="source" :position="Position.Bottom" class="!h-[1px] !w-[1px] !border-0 !bg-transparent" />
        </div>
      </template>
    </VueFlow>

    <div v-if="command" class="absolute bottom-7 left-10 z-10">
      <span class="mono rounded-[999px] px-2 py-1 text-[11px] text-es-dim dark:text-es-dark-muted" style="background: var(--es-sunken)">{{ command }}</span>
    </div>

    <MoveConfirm />
  </div>
</template>
