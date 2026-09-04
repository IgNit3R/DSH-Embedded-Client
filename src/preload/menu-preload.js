'use strict';

/**
 * F10 菜单栏专用 preload。
 *
 * 页面零内联脚本，DOM 监听与地址栏更新都放在 sandbox preload 的隔离世界里。
 * 页面上下文看不到本模块的任何接口。
 */

const { ipcRenderer } = require('electron');

const PROTOCOL_COLORS = {
  green: '#3fb950',
  red: '#f85149',
  blue: '#58a6ff',
  yellow: '#d29922',
};

function getProtocolStyle(url) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/)?/.exec(url);
  if (!match) {
    return { label: '', body: url, color: PROTOCOL_COLORS.yellow };
  }
  const scheme = match[1].slice(0, -1).toLowerCase();
  const label = match[1] + (match[2] || '');
  let color = PROTOCOL_COLORS.yellow;
  if (scheme === 'https' || scheme === 'ssh' || scheme === 'ftps') {
    color = PROTOCOL_COLORS.green;
  } else if (scheme === 'http' || scheme === 'ftp' || scheme === 'telnet') {
    color = PROTOCOL_COLORS.red;
  } else if (scheme === 'file') {
    color = PROTOCOL_COLORS.blue;
  }
  return { label, body: url.slice(label.length), color };
}

function updateAddress(payload) {
  const wrap = document.getElementById('address-wrap');
  if (!wrap) return;
  if (!payload || !payload.show || !payload.url) {
    wrap.hidden = true;
    return;
  }

  const style = getProtocolStyle(payload.url);
  const protocol = document.getElementById('address-protocol');
  const urlEl = document.getElementById('address-url');

  protocol.textContent = style.label;
  protocol.style.color = style.color;
  urlEl.textContent = style.body;
  urlEl.title = payload.url;
  wrap.hidden = false;
}

function onDomReady(fn) {
  if (document.readyState !== 'loading') fn();
  else document.addEventListener('DOMContentLoaded', fn, { once: true });
}

onDomReady(() => {
  const home = document.getElementById('home');
  const refresh = document.getElementById('refresh');
  const about = document.getElementById('about');
  const copyUrl = document.getElementById('copy-url');

  home?.addEventListener('click', () => ipcRenderer.send('menu:home'));
  refresh?.addEventListener('click', () => ipcRenderer.send('menu:refresh'));
  about?.addEventListener('click', () => ipcRenderer.send('menu:about'));
  copyUrl?.addEventListener('click', () => ipcRenderer.send('menu:copy-url'));
});

ipcRenderer.on('menu:address', (_event, payload) => {
  updateAddress(payload);
});
