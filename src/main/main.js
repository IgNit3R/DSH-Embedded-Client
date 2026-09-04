'use strict';

/**
 * DSH Client — 主进程（DSH 专用套壳）
 *
 * 职责：
 *  1. 单实例锁：二次启动时聚焦已有窗口后退出，避免 3080 端口双开冲突
 *  2. app ready 后先探测 127.0.0.1:3080：已有 DSH 服务则直接附着复用（退出时不终止它）；
 *     否则通过 ServiceManager 启动 DSH 服务（npx @deepseek-ai/dsh web）
 *  3. 用 node:http 轮询探活 http://127.0.0.1:3080（任意 HTTP 响应即视为就绪），
 *     就绪后把满铺的 WebContentsView 导航到 DSH；等待期间显示本地 loading 页，
 *     超时 / 服务提前退出则弹原生错误框并退出
 *  4. 关闭窗口时若 DSH 服务仍在运行，先弹确认框「终止服务并退出」，覆盖所有退出路径
 *  5. UI 极简：无地址栏/工具栏/服务面板，contentView 满铺整个客户区
 *  6. 首装进度日志：spawn 前快照 npm _logs 目录，300ms 轮询 tail 新出现的
 *     -debug-*.log；超过 5 秒仍未就绪且已有新日志才在 loading 页展开滚动日志区，
 *     5 秒内就绪则全程保持纯净
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { StringDecoder } = require('node:string_decoder');
const { app, BrowserWindow, WebContentsView, dialog, clipboard } = require('electron');
const ServiceManager = require('./service-manager');

const APP_ROOT = path.join(__dirname, '..', '..');
const LOADING_PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
const MENU_PAGE = path.join(__dirname, '..', 'renderer', 'menu.html');
const WINDOW_ICON = path.join(__dirname, '..', 'renderer', 'icon.ico');
const MENU_HEIGHT = 36; // F10 菜单栏高度（px）
// 打包后 __dirname 位于 asar 虚拟路径内，子进程无法以其为 CWD；
// 开发态用项目根，打包态退回用户主目录（真实文件系统路径）
const SERVICE_CWD = app.isPackaged
  ? (process.env.USERPROFILE || os.homedir())
  : APP_ROOT;
const DSH_SERVICE_ID = 'dsh-web';
const DSH_SERVICE_SPEC = {
  id: DSH_SERVICE_ID,
  // Windows 上 npx 实际是 npx.cmd；ServiceManager 对 .cmd 自动走 shell:true
  command: 'npx.cmd',
  args: ['@deepseek-ai/dsh', 'web', '--no-open'],
  cwd: SERVICE_CWD,
};
const DSH_URL = 'http://127.0.0.1:3080';
// 新版 DSH 会在启动日志里输出带 ?token= 的 Web 地址，例如：
// dsh web: http://127.0.0.1:3080/?token=... (LAN: ...)
const DSH_URL_ANNOUNCE_RE = /dsh web: (https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/;
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 180 * 1000; // 首次 npx 需要下载包，放宽到 3 分钟
const PROBE_REQUEST_TIMEOUT_MS = 3000;

// --- 首装进度日志（npm _logs 增量 tail） ---
const BOOT_LOG_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_logs')
  : '';
const BOOT_LOG_POLL_MS = 300;          // 轮询扫描间隔（不用 fs.watch：网络盘/杀软场景不可靠）
const BOOT_LOG_GRACE_MS = 5 * 1000;    // 5 秒内就绪 → 全程不显示任何日志内容
const BOOT_LOG_MAX_LINES = 400;        // 内存/页面只保留最后 N 行防膨胀
const BOOT_LOG_MAX_READ_PER_TICK = 512 * 1024; // 单轮最多读取的增量字节
const DEBUG_LOG_NAME_RE = /-debug-\d*\.log$/;  // 形如 <ISO时间戳>-debug-0.log

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:']); // S3: 收紧，不放行 file:

// --- 窗口尺寸与状态 ---
const MIN_WIDTH = 1280;  // 最小 720p 宽
const MIN_HEIGHT = 720;  // 最小 720p 高
/** ESC 退出满屏后调用 maximize() 会再次触发 'maximize' 事件，用它防止回环 */
let suppressMaximizeOnceAt = 0;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {WebContentsView | null} */
let contentView = null;
/** @type {WebContentsView | null} */
let menuView = null;
let menuVisible = false;
/** @type {object | null} */
let buildInfoCache = null;
let forceQuit = false; // 确认退出后置位，close 拦截直接放行，防死循环
let confirmDialogOpen = false; // 防止连点 X 堆叠多个确认框
let fatalDialogShown = false;
/** dsh-web 进程退出信息；null 表示尚未退出 */
let dshExitInfo = null;
let dshErrorMessage = '';
/** true = 服务由本应用拉起（关闭时负责终止）；false = 附着到外部已运行的服务（退出时不碰它） */
let ownsService = false;
/** 从 DSH 启动日志捕获的带 token 的 Web 地址；空 = 尚未捕获或附着外部服务 */
let dshWebUrl = '';
/** 当前主内容区实际加载的 URL（用于判断是否显示外部地址栏） */
let currentPageUrl = '';

// --- 首装进度日志 tail 状态 ---
/** spawn 前 _logs 目录文件名快照；null = 特性禁用（无 LOCALAPPDATA 或目录不存在） */
let knownBootLogs = null;
/** 当前 tail 目标 { filePath, offset, pending, decoder }；null = 尚未发现新日志 */
let tailTarget = null;
let bootLogTimer = null;
let bootLogStopped = false;
/** 门槛（5 秒）跨越后的一次性全量补发是否已完成 */
let backlogFlushed = false;
let bootStartedAt = 0;
/** @type {string[]} 内存中最近 N 行日志 */
let bootLines = [];

// ---------------------------------------------------------------------------
// DSH 服务管理
// ---------------------------------------------------------------------------

// 从 DSH 进程输出的 dsh web: http://...?token=... 行里捕获带 token 的地址
function captureDshWebUrl(line) {
  if (typeof line !== 'string' || dshWebUrl) return;
  const match = DSH_URL_ANNOUNCE_RE.exec(line);
  if (match && match[1]) {
    dshWebUrl = match[1];
    console.log('captured');
  }
}

const services = new ServiceManager({
  baseDir: APP_ROOT,
  onEvent(event) {
    if (event.id !== DSH_SERVICE_ID) return;
    switch (event.type) {
      case 'stdout':
      case 'stderr':
        captureDshWebUrl(event.data);
        console.log(`[dsh-web:${event.type}] ${event.data}`);
        break;
      case 'started':
        console.log(`[dsh-web] 已启动 pid=${event.pid} command=${event.command}`);
        break;
      case 'exit':
        dshExitInfo = { code: event.code, signal: event.signal };
        console.log(`[dsh-web] 进程退出 code=${event.code ?? ''} signal=${event.signal ?? ''}`);
        stopBootLogTail(); // 服务进程退出 → 停止 tail
        break;
      case 'error':
        dshErrorMessage = event.message || '';
        console.error(`[dsh-web] 错误: ${event.message}`);
        break;
    }
  },
});

/** @returns {boolean} 是否成功拉起进程（失败时已弹错误框并安排退出） */
function startDshService() {
  try {
    services.start({ ...DSH_SERVICE_SPEC });
    return true;
  } catch (err) {
    void showFatalError(`无法启动 DSH 服务：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 探活
// ---------------------------------------------------------------------------

/**
 * 发一次 HTTP GET；收到任意 HTTP 响应即视为就绪（body 直接丢弃），
 * ECONNREFUSED / 超时等一律视为未就绪。
 */
function probeOnce() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const req = http.get(DSH_URL, (res) => {
      res.resume();
      finish(true);
    });
    req.setTimeout(PROBE_REQUEST_TIMEOUT_MS, () => req.destroy());
    req.on('error', () => finish(false));
    req.on('close', () => finish(false));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询探活，直到就绪 / 服务进程退出 / 超时。
 * @returns {Promise<{ ok: true } | { ok: false, detail: string }>}
 */
async function waitForDshReady() {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 先探活：若 3080 上已有可用服务（含用户手动启动的），直接复用
    if (await probeOnce()) return { ok: true };
    if (dshExitInfo) {
      // 竞态兜底：本应用拉起的进程因端口被占等原因秒退，但端口上探测到了活服务
      // （外部实例恰好在此期间启动）→ 转为附着模式而非报错
      if (await probeOnce()) {
        ownsService = false;
        console.log('[dsh-web] 服务进程提前退出，但 3080 已有可用服务，转为附着模式');
        return { ok: true };
      }
      const code = dshExitInfo.code ?? 'null';
      const extra = dshErrorMessage ? `，${dshErrorMessage}` : '';
      return {
        ok: false,
        detail: `DSH 服务进程提前退出（code=${code}${extra}）。\n\n常见原因：127.0.0.1:3080 已被其他程序占用。请手动运行 "npx @deepseek-ai/dsh web" 查看具体错误。`,
      };
    }
    await delay(PROBE_INTERVAL_MS);
  }
  return {
    ok: false,
    detail: `等待 DSH 服务就绪超时（${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒，${DSH_URL} 无响应）。\n\n首次运行 npx 需要下载依赖包，请检查网络后重试；也可手动运行 "npx @deepseek-ai/dsh web" 确认服务可用。`,
  };
}

/** 弹原生错误框，用户确认后退出应用。 */
async function showFatalError(detail) {
  if (fatalDialogShown || forceQuit) return;
  fatalDialogShown = true;
  const options = {
    type: 'error',
    title: 'DSH Client',
    message: 'DSH 服务启动失败',
    detail,
    buttons: ['退出'],
    noLink: true,
  };
  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (parent) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  } catch {
    // 弹框过程中窗口销毁等异常：忽略，直接退出
  }
  // B2: app.exit() 不触发 before-quit，必须在此显式清掉服务进程树，
  // 否则探活超时/页面加载失败路径会孤儿化存活的 dsh-web（继续占用 3080）
  services.stopAll();
  app.exit(1);
}

// ---------------------------------------------------------------------------
// 首装进度日志：tail npm _logs 新增的 -debug-*.log（轮询，不用 fs.watch）
// ---------------------------------------------------------------------------

/** spawn 前调用：快照现有日志文件集合；目录不存在则整个特性禁用。 */
function snapshotBootLogs() {
  if (!BOOT_LOG_DIR) {
    knownBootLogs = null;
    return;
  }
  try {
    knownBootLogs = new Set(fs.readdirSync(BOOT_LOG_DIR));
  } catch {
    knownBootLogs = null; // 目录不存在 → 容错跳过整个特性
  }
}

function startBootLogTail() {
  bootLogStopped = false;
  bootLogTimer = setInterval(pollBootLogTick, BOOT_LOG_POLL_MS);
}

function stopBootLogTail() {
  bootLogStopped = true;
  if (bootLogTimer) {
    clearInterval(bootLogTimer);
    bootLogTimer = null;
  }
}

/** 在 _logs 里找 spawn 之后新出现的 -debug-*.log，返回绝对路径或 null。 */
function discoverNewDebugLog() {
  let names;
  try {
    names = fs.readdirSync(BOOT_LOG_DIR);
  } catch {
    return null;
  }
  for (const name of names) {
    if (knownBootLogs.has(name)) continue; // 只认新出现的
    if (!DEBUG_LOG_NAME_RE.test(name)) continue;
    return path.join(BOOT_LOG_DIR, name);
  }
  return null;
}

function pollBootLogTick() {
  if (bootLogStopped) return;
  if (!isContentAlive()) {
    stopBootLogTail(); // loading 页没了（窗口关闭）→ 没有推送对象
    return;
  }
  flushBootLogBacklog();
  if (knownBootLogs === null) return; // 特性被禁用
  try {
    if (!tailTarget) {
      const filePath = discoverNewDebugLog();
      if (!filePath) return;
      let size = 0;
      try {
        size = fs.statSync(filePath).size; // 记录发现时的初始大小，只 tail 之后的新增
      } catch {
        return; // 下轮再试
      }
      tailTarget = {
        filePath,
        offset: size,
        pending: '',
        decoder: new StringDecoder('utf8'), // 处理 UTF-8 多字节跨块
      };
      return;
    }
    tailNewBytes(tailTarget);
  } catch {
    // 单轮扫描异常忽略，下轮继续
  }
}

/** 读取目标文件 [offset, size) 的新增字节，按行切分后推送。 */
function tailNewBytes(target) {
  let stats;
  try {
    stats = fs.statSync(target.filePath);
  } catch {
    return; // 本轮不可读，下轮重试
  }
  if (stats.size <= target.offset) {
    if (stats.size < target.offset) target.offset = stats.size; // 日志被截断时对齐偏移
    return;
  }
  const length = Math.min(stats.size - target.offset, BOOT_LOG_MAX_READ_PER_TICK);
  const buf = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  let fd;
  try {
    fd = fs.openSync(target.filePath, 'r');
    bytesRead = fs.readSync(fd, buf, 0, length, target.offset);
  } catch {
    return; // 读失败丢弃本轮，offset 未推进，下轮重读
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  target.offset += bytesRead;
  ingestBootLogText(target, target.decoder.write(buf.subarray(0, bytesRead)));
}

/** UTF-8 文本按行切分（\r?\n），残行留在 pending 缓冲。 */
function ingestBootLogText(target, text) {
  target.pending += text;
  if (!target.pending.includes('\n')) return;
  const parts = target.pending.split(/\r?\n/);
  target.pending = parts.pop() ?? '';
  const lines = parts.filter((line) => line.length > 0);
  if (lines.length) appendBootLines(lines);
}

function appendBootLines(lines) {
  bootLines.push(...lines);
  if (bootLines.length > BOOT_LOG_MAX_LINES) {
    bootLines.splice(0, bootLines.length - BOOT_LOG_MAX_LINES);
  }
  // 门槛内保持纯净不推送；跨过门槛后增量推送（首波全量由 flushBootLogBacklog 负责）
  if (backlogFlushed && Date.now() - bootStartedAt > BOOT_LOG_GRACE_MS) {
    sendToContentView('boot:log', { lines });
  }
}

/** 跨过 5 秒门槛且已有新日志时，把积累的行一次性补发给 loading 页并展开日志区。 */
function flushBootLogBacklog() {
  if (backlogFlushed) return;
  if (Date.now() - bootStartedAt <= BOOT_LOG_GRACE_MS) return;
  if (!bootLines.length) return; // 还没有新日志产生 → 继续保持纯净
  backlogFlushed = true;
  sendToContentView('boot:log', { lines: [...bootLines] });
}

function sendToContentView(channel, payload) {
  try {
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.send(channel, payload);
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// 窗口与内容视图
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^about:blank$/i.test(trimmed)) return 'about:blank';
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function wireContentView(wc) {
  wc.on('page-title-updated', (_e, title) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(title || 'DSH Client');
    }
  });
  wc.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED：跳转被打断（重定向/手动停止），不算错误
    if (!isMainFrame || errorCode === -3) return;
    console.error(`[content] 页面加载失败 (${errorCode}) ${errorDesc} ${validatedURL}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    console.error(`[content] 渲染进程退出: ${details.reason}`);
  });
  wc.on('did-navigate', (_e, url) => onContentUrlChanged(url));
  wc.on('did-navigate-in-page', (_e, url) => onContentUrlChanged(url));

  // 新开链接一律在当前视图内打开，不弹新窗口
  wc.setWindowOpenHandler(({ url }) => {
    const normalized = normalizeUrl(url);
    if (normalized) void wc.loadURL(normalized);
    return { action: 'deny' };
  });

  // 默认拒绝所有权限申请（摄像头/麦克风/通知等），后续按需求放开
  // 注意：权限处理器挂在 session 上，而不是 webContents 上
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function isDshLocalUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    return u.protocol === 'http:'
      && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1')
      && (u.port === '' || u.port === '3080');
  } catch {
    return false;
  }
}

function shouldShowAddressBar(url) {
  if (!url || isDshLocalUrl(url)) return false;
  // 内置 loading 页是本地 file://，不当作“外部页面”
  if (url.startsWith('file://')) return false;
  try {
    const u = new URL(url);
    return u.protocol !== 'about:';
  } catch {
    return false;
  }
}

function onContentUrlChanged(url) {
  currentPageUrl = url || '';
  updateMenuAddressBar();
}

function updateMenuAddressBar() {
  if (!menuView || menuView.webContents.isDestroyed()) return;
  const show = Boolean(menuVisible && shouldShowAddressBar(currentPageUrl));
  menuView.webContents.send('menu:address', { show, url: show ? currentPageUrl : '' });
}

/** 主内容区 / 菜单栏共用的键盘处理：F10 开关菜单栏，Esc 退出无边框满屏。 */
function handleKeyInput(event, input) {
  if (input.type !== 'keyDown') return;
  if (input.key === 'F10') {
    event.preventDefault();
    toggleMenuBar();
    return;
  }
  if (input.key === 'Escape'
      && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
    event.preventDefault();
    exitFullScreenToMaximized();
  }
}

function wireMenuView(wc) {
  wc.on('ipc-message', (_event, channel) => {
    if (channel === 'menu:home') navigateHome();
    else if (channel === 'menu:refresh') refreshCurrentPage();
    else if (channel === 'menu:about') void showAbout();
    else if (channel === 'menu:copy-url') copyCurrentUrl();
  });
  wc.on('before-input-event', handleKeyInput);
  wc.on('did-finish-load', () => updateMenuAddressBar());
}

function toggleMenuBar() {
  if (!menuView) return;
  menuVisible = !menuVisible;
  menuView.setVisible(menuVisible);
  layoutContentView();
  updateMenuAddressBar();
}

function refreshCurrentPage() {
  try {
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.reload();
    }
  } catch {
    // 忽略刷新过程中的瞬时异常
  }
}

function navigateHome() {
  try {
    if (contentView && !contentView.webContents.isDestroyed()) {
      void contentView.webContents.loadURL(DSH_URL);
    }
  } catch {
    // 忽略导航过程中的瞬时异常
  }
}

function copyCurrentUrl() {
  const url = currentPageUrl || dshWebUrl || DSH_URL;
  if (url) clipboard.writeText(url);
}

function getBuildInfo() {
  if (buildInfoCache) return buildInfoCache;
  try {
    buildInfoCache = require('./build-info.json');
  } catch {
    buildInfoCache = {};
  }
  return buildInfoCache;
}

/** 从 npx 缓存里读取当前实际使用的 @deepseek-ai/dsh 版本。 */
function getDshVersion() {
  const cacheRoot = process.env.npm_config_cache
    || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache') : '');
  if (!cacheRoot) return '未知';
  try {
    const npxRoot = path.join(cacheRoot, '_npx');
    let best = null;
    for (const entry of fs.readdirSync(npxRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(npxRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      try {
        if (!fs.existsSync(pkgPath)) continue;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (!pkg.version) continue;
        const stat = fs.statSync(pkgPath);
        if (!best || stat.mtimeMs > best.mtimeMs) best = { version: pkg.version, mtimeMs: stat.mtimeMs };
      } catch {
        // 单个缓存项损坏不影响其他项
      }
    }
    return best ? best.version : '未知';
  } catch {
    return '未知';
  }
}

async function showAbout() {
  const info = getBuildInfo();
  const detail = [
    `构建时间：${info.buildTime || '未知'}`,
    `打包工具：${info.builderName || 'electron-builder'} ${info.builderVersion || '未知'}`,
    `@deepseek-ai/dsh：${getDshVersion()}`,
  ].join('\n');
  const options = {
    type: 'info',
    title: '关于',
    message: 'DSH Client',
    detail,
    buttons: ['确定'],
    noLink: true,
  };
  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (parent) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  } catch {
    // 对话框异常忽略
  }
}

/** contentView 满铺客户区；菜单栏可见时顶部让出 MENU_HEIGHT 高度。 */
function layoutContentView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const menuHeight = (menuVisible && menuView) ? MENU_HEIGHT : 0;
  if (contentView) {
    contentView.setBounds({
      x: 0,
      y: menuHeight,
      width: Math.max(width, 0),
      height: Math.max(height - menuHeight, 0),
    });
  }
  if (menuView) {
    menuView.setBounds({
      x: 0,
      y: 0,
      width: Math.max(width, 0),
      height: menuHeight,
    });
  }
}

// ---------------------------------------------------------------------------
// 窗口三态：A 正常窗口 ⇄（最大化按钮）C 无边框满屏；（Esc）C → B 标准最大化
// ---------------------------------------------------------------------------

function enterBorderlessFullScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
}

function exitFullScreenToMaximized() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isFullScreen()) return;
  // 先离场再补一记标准最大化；期间产生的 'maximize' 事件要抑制，防止又进满屏
  mainWindow.once('leave-full-screen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    suppressMaximizeOnceAt = Date.now();
    mainWindow.maximize();
  });
  mainWindow.setFullScreen(false);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#14161a',
    title: 'DSH Client',
    icon: WINDOW_ICON, // 标题栏 + 任务栏图标（exe 内嵌图标由 electron-builder 打包时注入）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.setMenu(null);

  contentView = new WebContentsView({
    webPreferences: {
      // B1: loading 页日志区由 sandbox preload 驱动（隔离世界，不向页面暴露 API）
      preload: path.join(__dirname, '..', 'preload', 'loading-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.contentView.addChildView(contentView);
  wireContentView(contentView.webContents);

  // F10 菜单栏：独立 WebContentsView，默认隐藏，显示时占顶部一行
  menuView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  menuView.setBackgroundColor('#1b1f27');
  menuView.setVisible(false);
  mainWindow.contentView.addChildView(menuView);
  wireMenuView(menuView.webContents);
  void menuView.webContents.loadFile(MENU_PAGE);

  // 最大化按钮 → 无边框满屏（覆盖整块显示器，含任务栏区域）
  mainWindow.on('maximize', () => {
    // ESC 退出满屏时的补记 maximize() 会触发本事件，1 秒内只放行一次抑制
    if (Date.now() - suppressMaximizeOnceAt < 1000) return;
    if (!mainWindow.isFullScreen()) enterBorderlessFullScreen();
  });

  // 主内容区键盘处理：F10 开关菜单栏；无边框满屏中 Esc → 标准最大化
  contentView.webContents.on('before-input-event', handleKeyInput);
  mainWindow.webContents.on('before-input-event', handleKeyInput);

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(ev, layoutContentView);
  }
  mainWindow.on('close', onCloseRequested);
  mainWindow.on('closed', () => {
    mainWindow = null;
    contentView = null;
    menuView = null;
  });

  // 服务就绪前：两层都停在本地 loading 页；就绪后 contentView 导航到 DSH
  layoutContentView();
  void mainWindow.loadFile(LOADING_PAGE);
  void contentView.webContents.loadFile(LOADING_PAGE);
}

function isContentAlive() {
  try {
    return Boolean(contentView) && !contentView.webContents.isDestroyed();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 关闭行为：服务运行中先确认
// ---------------------------------------------------------------------------

function onCloseRequested(event) {
  if (forceQuit) return; // 已确认退出：放行，防死循环
  // 附着模式（ownsService=false）下服务不在管理表里 → isRunning 为 false 直接放行，
  // 绝不终止外部启动的 DSH 实例
  // S2: 服务未运行或已在停止中（将死进程）都直接关，避免竞态窗口误弹确认框
  if (!services.isRunning(DSH_SERVICE_ID) || services.isStopping(DSH_SERVICE_ID)) return;
  event.preventDefault();
  void confirmStopAndQuit();
}

async function confirmStopAndQuit() {
  if (confirmDialogOpen) return;
  confirmDialogOpen = true;
  const options = {
    type: 'warning',
    title: 'DSH Client',
    message: 'DSH 服务仍在运行，可能有正在执行的任务。确定终止服务并退出吗？',
    buttons: ['终止并退出', '取消'],
    cancelId: 1,
    defaultId: 1, // 回车默认「取消」，避免误杀正在执行的任务
    noLink: true,
  };
  let response = 1;
  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    ({ response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options));
  } catch {
    confirmDialogOpen = false;
    return;
  }
  confirmDialogOpen = false;
  if (response !== 0) return; // 取消：保持窗口打开

  forceQuit = true;
  services.stopAll();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  app.quit();
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 导航到 DSH 页面；失败（且非用户主动退出）弹错误框。 */
async function navigateToDsh() {
  try {
    await contentView.webContents.loadURL(dshWebUrl || DSH_URL);
  } catch (err) {
    if (!forceQuit) {
      await showFatalError(`DSH 页面加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function bootstrap() {
  createMainWindow();

  // 附着模式：3080 上已有服务在跑（用户手动启动 / 外部实例）→ 直接复用，
  // 不重复拉起、不接管其生命周期（关闭窗口时也不会终止它）
  if (await probeOnce()) {
    ownsService = false;
    console.log('[dsh-web] 检测到 127.0.0.1:3080 已有 DSH 服务，直接附着（退出时不终止该服务）');
    if (!isContentAlive()) return;
    await navigateToDsh();
    return;
  }

  bootStartedAt = Date.now();
  snapshotBootLogs(); // spawn 前快照 npm _logs 现有文件集合
  startBootLogTail();
  if (!startDshService()) {
    stopBootLogTail(); // 启动失败已弹错误框并安排退出
    return;
  }
  ownsService = true;
  const outcome = await waitForDshReady();
  stopBootLogTail(); // 探活成功（导航走人）或超时报错，都停止 tail
  if (!outcome.ok) {
    await showFatalError(outcome.detail);
    return;
  }
  // 新版 DSH 会在 stdout 里打印带 token 的 Web 地址；自己拉起服务时等一小段日志
  if (ownsService && !dshWebUrl) {
    const tokenWaitDeadline = Date.now() + 5000;
    while (Date.now() < tokenWaitDeadline && !dshWebUrl && isContentAlive()) {
      await delay(100);
    }
  }
  if (!isContentAlive()) return; // 等待期间窗口已被关闭
  await navigateToDsh();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 已有实例在运行（3080 端口已被占用），由已有实例负责聚焦，本实例直接退出
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('应用启动失败:', err);
  });

  app.on('before-quit', () => {
    // 兜底：任何退出路径都清掉本地服务进程，避免孤儿进程
    services.stopAll();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
