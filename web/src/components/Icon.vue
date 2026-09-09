<script setup>
// One inline SVG set: no icon font, no extra dependency (web-console.md "Nothing else").
const PATHS = {
  brand: ['M7 7h4a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8', 'M17 7h-2'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm20 20-3.5-3.5'],
  plus: ['M12 5v14M5 12h14'],
  check: ['m5 12 5 5L20 7'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  terminal: ['m5 8 4 4-4 4', 'M12 16h7'],
  move: ['M5 12h13', 'm13 7 5 5-5 5'],
  kill: ['M6 6l12 12', 'M18 6 6 18'],
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M12 2v2M12 20v2M4 12H2M22 12h-2M5 5 4 4M20 20l-1-1M19 5l1-1M4 20l1-1'],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  warn: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 8v5', 'M12 16h.01'],
  users: ['M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M2 21v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2', 'M16 3.5a4 4 0 0 1 0 7', 'M22 21v-2a5 5 0 0 0-4-4.9'],
  send: ['M4 12 20 4l-8 16-2-6-6-2Z'],
  chevron: ['m9 6 6 6-6 6'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v5h-5'],
};

defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 14 },
  width: { type: Number, default: 2 },
  stroke: { type: String, default: 'currentColor' },
});
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke="stroke"
    :stroke-width="width"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
  >
    <path v-for="(d, index) in PATHS[name] ?? []" :key="index" :d="d" />
  </svg>
</template>
