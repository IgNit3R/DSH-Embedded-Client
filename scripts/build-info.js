'use strict';

/**
 * 生成 src/main/build-info.json。
 *
 * 在 electron-builder 打包前运行，把「构建时间」和「打包工具版本」固化进应用，
 * 供“关于”对话框显示。@deepseek-ai/dsh 版本由运行时从 npx 缓存读取。
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const builderPkgPath = path.join(root, 'node_modules', 'electron-builder', 'package.json');
const outPath = path.join(root, 'src', 'main', 'build-info.json');

let builderVersion = '未知';
try {
  builderVersion = JSON.parse(fs.readFileSync(builderPkgPath, 'utf8')).version || builderVersion;
} catch {
  // 保持“未知”
}

const info = {
  buildTime: new Date().toISOString(),
  builderName: 'electron-builder',
  builderVersion,
};

fs.writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(`[build-info] 已写入 ${path.relative(root, outPath)}`);
console.log(`[build-info] ${JSON.stringify(info)}`);
