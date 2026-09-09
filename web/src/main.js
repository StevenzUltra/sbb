import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@xterm/xterm/css/xterm.css';
import './style.css';

// Theme before first paint: the stored choice, else the OS (web-console.md, "Theme").
const stored = localStorage.getItem('sbb-theme');
const dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', dark);

createApp(App).use(createPinia()).mount('#app');
