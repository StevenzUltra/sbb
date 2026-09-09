import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@xterm/xterm/css/xterm.css';
import './style.css';

// Inside the desktop app (docs/spec/desktop.md) the window is a translucent dark surface:
// the page paints no opaque ground and defaults to the dark theme.
const shell = new URL(window.location.href).searchParams.get('shell');
if (shell === 'desktop') document.documentElement.dataset.shell = 'desktop';

// Theme before first paint: the stored choice, else the OS (web-console.md, "Theme").
const stored = localStorage.getItem('sbb-theme');
const dark = stored ? stored === 'dark' : shell === 'desktop' || window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', dark);

createApp(App).use(createPinia()).mount('#app');
