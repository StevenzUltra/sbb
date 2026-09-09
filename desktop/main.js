// SBB desktop: a window around `sbb ui`. The shell starts the same local server the CLI
// starts, loads its tokenized URL, and stops it on quit. No IPC, no node integration in
// the page: the console stays the web console (docs/spec/web-console.md).
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import updaterPkg from 'electron-updater';
const { autoUpdater } = updaterPkg;
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerCss, parseProbe, parseUiOutput, resolveCommand } from './lib/launch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const log = (...args) => process.stderr.write(`[sbb-desktop] ${args.join(' ')}\n`);

// ---------------------------------------------------------------- updates
// The feed is the project's GitHub Releases (electron-builder.config.cjs): everyone who took
// the app from the repo gets the same updates. Nothing is sent but the version check.
let updateState = 'idle';
function updateLog(line) {
  try {
    const dir = join(app.getPath('logs'));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'updater.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never break the app
  }
}
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { updateState = 'checking'; updateLog('checking'); });
  autoUpdater.on('update-available', (info) => { updateState = `downloading ${info.version}`; updateLog(`available ${info.version}`); });
  autoUpdater.on('update-not-available', () => { updateState = 'latest'; updateLog('up to date'); });
  autoUpdater.on('error', (err) => { updateState = 'error'; updateLog(`error ${err?.message ?? err}`); });
  autoUpdater.on('update-downloaded', async (info) => {
    updateState = `ready ${info.version}`;
    updateLog(`downloaded ${info.version}`);
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['现在重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      message: `SBB ${info.version} 已下载`,
      detail: '重启后就是新版本；选「稍后」则在下次退出时自动安装。',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch((err) => updateLog(`check failed ${err?.message ?? err}`));
  // A long-running window would otherwise only learn about releases at the next launch.
  const every = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => updateLog(`check failed ${err?.message ?? err}`));
  }, 30 * 60 * 1000);
  every.unref?.();
}
async function checkUpdatesFromMenu() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', message: '开发模式不检查更新', detail: '打包后的 SBB 会在启动时检查 GitHub Releases。' });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version;
    if (version && version !== app.getVersion()) return; // the download dialog follows
    dialog.showMessageBox({ type: 'info', message: `已是最新版本 ${app.getVersion()}` });
  } catch (err) {
    dialog.showMessageBox({ type: 'warning', message: '检查更新失败', detail: String(err?.message ?? err) });
  }
}
const SMOKE = process.env.SBB_DESKTOP_SMOKE || '';
/** @type {import('node:child_process').ChildProcess|null} */
let server = null;
/** @type {BrowserWindow|null} */
let win = null;

app.setName('SBB');

/** Where the CLI lives: the repo in development, resources/sbb in the packaged app. */
function bundledDir() {
  return app.isPackaged ? join(process.resourcesPath, 'sbb') : resolve(HERE, '..');
}

/** Ask the user's login shell for PATH and the tools; a GUI app starts with almost none. */
function probeShell() {
  const script = 'printf "%s\\n" "$PATH"; command -v node; command -v sbb; command -v tmux';
  return new Promise((done) => {
    execFile('/bin/zsh', ['-lc', script], { timeout: 8000 }, (err, stdout) => done(parseProbe(stdout || '')));
  });
}

/** @param {{ file: string, args: string[] }} cmd @param {string} path */
function startServer(cmd, path) {
  return new Promise((done, fail) => {
    const child = spawn(cmd.file, cmd.args, { env: { ...process.env, PATH: path || process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const info = parseUiOutput(out);
      if (info && !settled) {
        settled = true;
        done({ child, info });
      }
    });
    child.stderr.on('data', (chunk) => { errText += String(chunk); });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        fail(new Error(`sbb ui exited with code ${code}\n${errText || out}`.trim()));
      }
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        fail(err);
      }
    });
  });
}

function buildMenu() {
  const template = [
    { label: 'SBB', submenu: [{ role: 'about' }, { label: '检查更新…', click: () => checkUpdatesFromMenu() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openConsole() {
  const probe = await probeShell();
  log('probe', JSON.stringify(probe));
  if (!probe.tmux) {
    dialog.showErrorBox('SBB 需要 tmux', '登录 shell 的 PATH 里找不到 tmux。请先安装（brew install tmux）再打开 SBB。');
    app.quit();
    return;
  }
  let cmd;
  try {
    cmd = resolveCommand({ sbbPath: probe.sbb, nodePath: probe.node, bundledDir: bundledDir() });
  } catch (err) {
    dialog.showErrorBox('SBB 需要 Node.js', String(err?.message ?? err));
    app.quit();
    return;
  }
  let started;
  try {
    started = await startServer(cmd, probe.path);
  } catch (err) {
    dialog.showErrorBox('sbb ui 启动失败', String(err?.message ?? err));
    app.quit();
    return;
  }
  server = started.child;
  log('server', cmd.source, started.info.url.replace(/t=.*/, 't=..'));
  server.on('exit', () => {
    server = null;
    if (!app.isQuitting) app.quit();
  });

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: 'SBB',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    // A translucent dark window, like a terminal with background blur: macOS vibrancy under
    // a page that paints no opaque ground (web/src/style.css, data-shell="desktop").
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(HERE, 'preload.js') },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    win?.webContents.insertCSS(headerCss()).catch(() => {});
  });
  win.once('ready-to-show', () => {
    log('ready-to-show');
    win?.show();
    if (SMOKE) {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          writeFileSync(SMOKE, image.toPNG());
          console.log(`smoke: ${SMOKE} ${image.getSize().width}x${image.getSize().height} source=${cmd.source} url=${started.info.url.replace(/t=.*/, 't=..')}`);
        } catch (err) {
          console.log(`smoke failed: ${err?.message ?? err}`);
        }
        app.quit();
      }, 4000);
    }
  });
  win.on('closed', () => { win = null; });
  await win.loadURL(`${started.info.url}&shell=desktop`);
  setupUpdates();
  log('loaded');
}

// The one bridge the page has (desktop/preload.js): a native folder picker for 新建's
// working directory. Browsers cannot hand a page an absolute path; the app can.
ipcMain.handle('sbb:pick-folder', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: '选择工作目录',
    defaultPath: typeof options.defaultPath === 'string' && options.defaultPath ? options.defaultPath : app.getPath('home'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (server) {
    server.kill('SIGTERM');
    server = null;
  }
});
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  buildMenu();
  openConsole().catch((err) => {
    dialog.showErrorBox('SBB', String(err?.stack ?? err));
    app.quit();
  });
});
