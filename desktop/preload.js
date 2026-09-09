// Bridge between the console page and the desktop shell. Kept tiny and explicit: the page
// gets a `window.sbbDesktop` with named functions, never raw ipc or node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbbDesktop', {
  /** Native folder picker; resolves to an absolute path or null when cancelled. */
  pickFolder: (options) => ipcRenderer.invoke('sbb:pick-folder', options ?? {}),
  platform: process.platform,
});
