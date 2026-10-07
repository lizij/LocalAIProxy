// Electron 主进程：在本进程内启动 LocalAIProxy 服务，并用内嵌 Chromium 窗口展示同一个 Web 控制台。
// 生命周期：打开窗口 = 启动服务；关闭窗口 = 服务与进程一并退出，不留后台残留。
const path = require('node:path');
const { app, BrowserWindow, dialog, shell } = require('electron');

let backend = null;
let mainWindow = null;
let cleanedUp = false;

app.setName('LocalAIProxy');

// 静态页面目录必须显式注入：后端被打包成 CJS 后 import.meta.url 不可用，无法自行推断路径。
// 打包后 public 位于 resources/public（extraResources，在 asar 之外）；开发模式位于仓库 public/。
process.env.LOCAL_AI_PROXY_PUBLIC_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'public')
  : path.join(__dirname, '..', 'public');

// 便携版：数据写在 exe 同级 data/ 目录（PORTABLE_EXECUTABLE_DIR 由 electron-builder 便携启动器注入）。
if (app.isPackaged) {
  const baseDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  process.env.LOCAL_AI_PROXY_HOME = path.join(baseDir, 'data');
}

// 打包后无 package.json 可读，由 Electron 注入版本号（单一来源仍是 package.json）。
process.env.LOCAL_AI_PROXY_VERSION = app.getVersion();

function startBackend() {
  // 后端已用 esbuild 打包为 CJS，避免 asar 内的 ESM 加载问题。
  const { createApp } = require(path.join(__dirname, '..', 'dist', 'backend.cjs'));
  backend = createApp();
  return backend.start();
}

function createWindow(adminPort) {
  const isTest = process.env.LOCAL_AI_PROXY_PROFILE === 'test';
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1115',
    title: `LocalAIProxy v${app.getVersion()}${isTest ? ' [测试档]' : ''}`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());

  // 固定窗口标题（Chromium 默认会用页面 <title> 覆盖它）。
  win.on('page-title-updated', (event) => event.preventDefault());

  // 外部链接交给系统浏览器，窗口内只保留本地控制台。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(`http://127.0.0.1:${adminPort}/`);
  return win;
}

async function bootstrap() {
  await app.whenReady();
  app.setAppUserModelId('com.localaiproxy.app');

  try {
    const cfg = await startBackend();
    mainWindow = createWindow(cfg.admin.port);
  } catch (err) {
    const hint =
      err && err.code === 'EADDRINUSE'
        ? `端口 ${err.address}:${err.port} 已被占用。请关闭占用该端口的程序，或修改 data/config.json 后重试。`
        : String((err && err.stack) || err);
    dialog.showErrorBox('LocalAIProxy 启动失败', hint);
    app.exit(1);
  }
}

// 单实例：重复启动只聚焦已有窗口，避免出现第二个服务进程。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // 关闭窗口即整体退出（含 macOS），不驻留后台。
  app.on('window-all-closed', () => app.quit());

  bootstrap();
}

app.on('will-quit', (event) => {
  if (cleanedUp) return;
  event.preventDefault();
  cleanedUp = true;
  (async () => {
    // 兜底：无论清理是否卡住，都要保证进程最终退出，绝不留后台残留。
    setTimeout(() => app.exit(0), 5000).unref?.();
    try {
      await backend?.stop();
    } catch {}
    app.quit();
    setTimeout(() => app.exit(0), 1500).unref?.();
  })();
});
