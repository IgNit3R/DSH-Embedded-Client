'use strict';

// 极简 HTTPS 下载器：支持重定向（GitHub Releases 需要）。
// 用法: node download.js <url> <destFile>
// 说明: Windows curl.exe 在受限环境下走 Schannel 可能报
//       SEC_E_NO_CREDENTIALS，Node 的 OpenSSL 栈没有这个问题。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

function request(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'shell-browser-setup/0.1' } }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          resolve(request(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status} ${url}`));
          return;
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function main() {
  const [url, destFile] = process.argv.slice(2);
  if (!url || !destFile) {
    console.error('usage: node download.js <url> <destFile>');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const stream = await request(url, 5);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destFile);
    out.on('finish', resolve);
    out.on('error', reject);
    stream.on('error', reject);
    stream.pipe(out);
  });
  const size = fs.statSync(destFile).size;
  console.log(`saved ${destFile} (${size} bytes)`);
}

main().catch((err) => {
  console.error(String((err && err.message) || err));
  process.exit(1);
});
