'use strict';

// 对照实验用：不创建任何窗口/渲染进程，只验证 Electron 核心能否初始化。
const { app } = require('electron');

app.whenReady().then(() => {
  console.log('ELECTRON_READY');
  setTimeout(() => app.quit(), 500);
});

setTimeout(() => {
  console.log('TIMEOUT_NO_READY');
  app.exit(2);
}, 8000);
