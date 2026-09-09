import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import './style.css';
import { applyAppearance, applyTheme, readAppearance, readTheme } from './lib/appearance.js';

// Inside the desktop app (docs/spec/desktop.md) the window is a translucent dark surface:
// the page paints no opaque ground and defaults to the dark theme.
const shell = new URL(window.location.href).searchParams.get('shell');
if (shell === 'desktop') document.documentElement.dataset.shell = 'desktop';

// Theme and window tint before first paint: the stored choice, else the OS (web-console.md).
const prefersDark = shell === 'desktop' || window.matchMedia('(prefers-color-scheme: dark)').matches;
applyTheme(document.documentElement, readTheme(localStorage), prefersDark);
applyAppearance(document.documentElement, readAppearance(localStorage));

createApp(App).use(createPinia()).mount('#app');
