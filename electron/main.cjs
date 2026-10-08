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

/**
 * 打包后的数据目录（LOCAL_AI_PROXY_HOME）：
 * - Windows 便携版：exe 同级 data/（PORTABLE_EXECUTABLE_DIR 由 electron-builder 便携启动器注入）。
 * - macOS：PORTABLE_EXECUTABLE_DIR 不存在，若回退到 path.dirname(app.getPath('exe')) 会把数据写进
 *   `LocalAIProxy.app/Contents/MacOS/data`——从 dmg 直接运行时该处为只读挂载（App Translocation），
 *   配置与日志写不进去；拖入 /Applications 后覆盖安装/升级又会连数据一起丢。
 *   因此 macOS 统一改用系统用户数据目录：~/Library/Application Support/LocalAIProxy/data。
 * 必须在 ready 之后调用 app.getPath('userData')，故延迟到 bootstrap 内执行。
 */
function applyDataDir() {
  if (!app.isPackaged) return; // 开发模式：后端默认使用 <cwd>/data
  // 注意（Linux 未验证）：Windows 便携版靠 PORTABLE_EXECUTABLE_DIR 得到 exe 同级目录，行为正确；
  // 但 Linux（AppImage/deb）没有该变量，会回退到 path.dirname(app.getPath('exe'))——
  // AppImage 的 exe 位于只读临时挂载（/tmp/.mount_*/）、deb 安装到系统目录，data 可能写不进去或重启即丢。
  // Linux 桌面端数据目录落点尚未实测，结论出来前不要照搬此处行为（见 docs/design.md §9.3 与 §12 待确认）。
  const baseDir =
    process.platform === 'darwin'
      ? app.getPath('userData')
      : process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
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
  applyDataDir(); // 需在 ready 之后才能取 app.getPath('userData')

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

// 单实例：同一时间只运行一个服务进程。
// 重复启动时，**提示必须由已运行的实例发出**——拿不到锁的新实例按 Electron 语义必须立即退出，
// 自己弹不出任何界面。用 additionalData 把新实例的版本号带过去，才能明确告诉用户
// 「已有 v旧 在运行，你刚启动的是 v新」，避免"双击新版本却看到旧界面"的困惑。
const gotLock = app.requestSingleInstanceLock({ version: app.getVersion() });
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv, workingDirectory, additionalData) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const newVersion =
      additionalData && typeof additionalData.version === 'string' ? additionalData.version : '';
    const curVersion = app.getVersion();
    // 开发模式（有终端）下可据此确认重复启动走到了哪个分支；打包后无终端，不影响用户。
    console.log(
      `[desktop] 收到重复启动请求：当前 v${curVersion}，新实例 v${newVersion || '未知'}` +
        (newVersion && newVersion !== curVersion ? '（弹窗提示）' : '（同版本，仅聚焦窗口）'),
    );
    // 版本相同（或取不到）时只聚焦窗口，不打扰用户；只有版本不同才提示。
    if (!mainWindow || !newVersion || newVersion === curVersion) return;
    // 必须用异步弹窗：backend 服务与主进程是同一个 Node 进程，若用 showMessageBoxSync 会
    // 阻塞事件循环，弹窗期间 8787/8788 会整体无响应（用户正在用的请求也会卡住）。
    dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['退出当前实例', '保留当前实例'],
        defaultId: 0,
        cancelId: 1,
        message: `LocalAIProxy 已在运行（v${curVersion}）`,
        detail: `你刚启动的是 v${newVersion}，但同一时间只能运行一个实例。\n\n若要使用 v${newVersion}，请先退出当前实例，然后重新启动新版本。`,
      })
      .then(({ response }) => {
        if (response === 0) app.quit();
      })
      .catch(() => {});
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
