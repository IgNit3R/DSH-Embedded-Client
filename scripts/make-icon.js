'use strict';

/**
 * 从表情包原图生成应用图标。
 *
 * 流程：白底去除（从四边泛洪填充，仅清除与边界连通的近白区域，
 * 不影响人物内部的白色高光）→ 裁剪内容包围盒 → 居中补成正方形
 * 透明画布 → 多尺寸 lanczos 缩放 → PNG → 封装为 Windows 多尺寸 .ico。
 *
 * 用法: node make-icon.js <inputImage> <outDir>
 * 依赖: 复用本机 DSH 运行时自带的 sharp（可用 SHARP_PATH 环境变量覆盖）
 */

const fs = require('node:fs');
const path = require('node:path');

const SHARP_PATH = process.env.SHARP_PATH
  || 'C:/Users/Yuuka/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/sharp';
const SIZES = [16, 32, 48, 64, 128, 256];
const WORK_SIZE = 512;       // 处理分辨率
const WHITE_THRESHOLD = 232; // 近白判定阈值（RGB 三通道均不低于此值）

function removeConnectedWhite(px, w, h) {
  const state = new Uint8Array(w * h); // 0 未访问 / 1 在队列 / 2 已处理
  const queue = [];
  const nearWhite = (i) => {
    const o = i * 4;
    return px[o] >= WHITE_THRESHOLD && px[o + 1] >= WHITE_THRESHOLD
      && px[o + 2] >= WHITE_THRESHOLD && px[o + 3] > 0;
  };
  const push = (i) => {
    if (state[i] === 0 && nearWhite(i)) {
      state[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  let removed = 0;
  while (queue.length) {
    const i = queue.pop();
    px[i * 4 + 3] = 0; // 置为透明
    state[i] = 2;
    removed++;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return removed;
}

function cropAndSquare(px, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { px, width: w, height: h }; // 全透明兜底：原样返回
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const side = Math.max(bw, bh);
  const out = new Uint8ClampedArray(side * side * 4);
  const ox = (side - bw) >> 1;
  const oy = (side - bh) >> 1;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const s = ((minY + y) * w + (minX + x)) * 4;
      const d = ((oy + y) * side + (ox + x)) * 4;
      out[d] = px[s];
      out[d + 1] = px[s + 1];
      out[d + 2] = px[s + 2];
      out[d + 3] = px[s + 3];
    }
  }
  return { px: out, width: side, height: side };
}

/** 组装 ICO：PNG 内嵌条目（Vista+ 支持），256 条目维度字段写 0。 */
function buildIco(entries) {
  const count = entries.length;
  const headerSize = 6 + 16 * count;
  const totalSize = entries.reduce((acc, e) => acc + e.buf.length, headerSize);
  const buf = Buffer.alloc(totalSize);
  buf.writeUInt16LE(0, 0); // reserved
  buf.writeUInt16LE(1, 2); // type: icon
  buf.writeUInt16LE(count, 4);
  let offset = headerSize;
  entries.forEach((entry, idx) => {
    const e = 6 + 16 * idx;
    const dim = entry.size >= 256 ? 0 : entry.size;
    buf.writeUInt8(dim, e);
    buf.writeUInt8(dim, e + 1);
    buf.writeUInt8(0, e + 2); // 调色板色数
    buf.writeUInt8(0, e + 3); // 保留
    buf.writeUInt16LE(1, e + 4); // 颜色平面
    buf.writeUInt16LE(32, e + 6); // 位深
    buf.writeUInt32LE(entry.buf.length, e + 8);
    buf.writeUInt32LE(offset, e + 12);
    entry.buf.copy(buf, offset);
    offset += entry.buf.length;
  });
  return buf;
}

async function main() {
  const [, , input, outDir] = process.argv;
  if (!input || !outDir) {
    console.error('usage: node make-icon.js <inputImage> <outDir>');
    process.exit(2);
  }
  let sharp;
  try {
    sharp = require(SHARP_PATH);
  } catch (err) {
    console.error(`无法加载 sharp（${SHARP_PATH}）: ${err.message}`);
    process.exit(1);
  }

  // 1) 统一到处理分辨率的 RGBA 原始像素
  const prep = await sharp(input)
    .resize(WORK_SIZE, WORK_SIZE, { fit: 'inside', withoutEnlargement: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let { width, height } = prep.info;
  let px = new Uint8ClampedArray(prep.data);

  // 2) 泛洪去白底
  const removed = removeConnectedWhite(px, width, height);
  const total = width * height;
  console.log(`白底去除: ${removed}/${total} 像素 (${((removed / total) * 100).toFixed(1)}%)`);

  // 3) 裁剪 + 补方
  ({ px, width, height } = cropAndSquare(px, width, height));

  // 4) 多尺寸 PNG
  const entries = [];
  for (const size of SIZES) {
    const buf = await sharp(px, { raw: { width, height, channels: 4 } })
      .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
      .png()
      .toBuffer();
    entries.push({ size, buf });
  }

  // 5) 写出 ico + 主尺寸 png
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(entries));
  fs.writeFileSync(path.join(outDir, 'icon.png'), entries[entries.length - 1].buf);
  console.log(`完成: ${path.join(outDir, 'icon.ico')}（${SIZES.join('/')}）`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
