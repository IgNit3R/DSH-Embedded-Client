'use strict';

/**
 * Loading 页专用 preload。
 *
 * 方案说明（t3/B1）：把「订阅 boot:log + 操作日志区 DOM」全部放在本 preload
 * 内完成，loading.html 本身零内联脚本 —— 因此 CSP 无需放开 script-src。
 * 沙箱 preload 与页面共享 DOM 但处于隔离 JS 世界，且这里不用 contextBridge，
 * 页面上下文看不到本模块的任何接口；导航到 DSH 后 preload 重跑时找不到
 * 日志区元素，只会安静地忽略后续推送。
 */

const { ipcRenderer } = require('electron');

const MAX_LINES = 400;       // 与主进程内存上限一致，防 DOM 膨胀
const LINE_MAX_CHARS = 2000; // 单行截断，防止超长 URL 撑爆布局

let shown = false;
let domReady = document.readyState !== 'loading';
/** DOM 未就绪时暂存的推送 */
const pendingPayloads = [];

function handleBootLog(payload) {
  const lines = payload && payload.lines;
  if (!Array.isArray(lines) || lines.length === 0) return;
  const wrap = document.getElementById('boot-log-wrap');
  const log = document.getElementById('boot-log');
  if (!wrap || !log) return; // 非 loading 页面 → 忽略
  if (!shown) {
    shown = true;
    wrap.hidden = false; // 首个批次到达即展开滚动日志区
  }
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    const text = typeof line === 'string' ? line : String(line);
    div.textContent = text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text;
    frag.appendChild(div);
  }
  log.appendChild(frag);
  while (log.childElementCount > MAX_LINES) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight; // 自动滚底
}

document.addEventListener('DOMContentLoaded', () => {
  domReady = true;
  for (const payload of pendingPayloads.splice(0)) handleBootLog(payload);
}, { once: true });

ipcRenderer.on('boot:log', (_event, payload) => {
  if (domReady) handleBootLog(payload);
  else pendingPayloads.push(payload);
});
