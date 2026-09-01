'use strict';

/**
 * F10 菜单栏专用 preload。
 *
 * 与 loading-preload 相同思路：页面零内联脚本，DOM 监听放在 sandbox preload
 * 的隔离世界里，不通过 contextBridge 向页面暴露任何接口。
 */

const { ipcRenderer } = require('electron');

function onDomReady(fn) {
  if (document.readyState !== 'loading') fn();
  else document.addEventListener('DOMContentLoaded', fn, { once: true });
}

onDomReady(() => {
  const refresh = document.getElementById('refresh');
  const about = document.getElementById('about');
  refresh?.addEventListener('click', () => ipcRenderer.send('menu:refresh'));
  about?.addEventListener('click', () => ipcRenderer.send('menu:about'));
});
