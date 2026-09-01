# 组装 Windows x64 绿色版（不依赖 electron-builder，可在受限环境运行）
# 用法: powershell -File scripts\assemble-portable.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = "$root\dist\dsh-shell-win32-x64"

Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out, "$out\resources\app" | Out-Null

# 1) Electron 运行时（node_modules/electron/dist，安装时已校验 SHA256）
Copy-Item "$root\node_modules\electron\dist\*" $out -Recurse -Force

# 2) 主程序改名
Rename-Item "$out\electron.exe" 'DSH Client.exe'

# 3) 应用本体：精简运行时 package.json + src
@'
{
  "name": "shell-browser",
  "version": "0.1.0",
  "private": true,
  "author": "Yuuka",
  "description": "DSH 专用桌面壳",
  "main": "src/main/main.js"
}
'@ | Set-Content "$out\resources\app\package.json" -Encoding UTF8
Copy-Item "$root\src" "$out\resources\app\src" -Recurse -Force

# 4) 校验
$checks = @(
  "$out\DSH Client.exe",
  "$out\resources\app\src\main\main.js",
  "$out\resources\app\src\preload\loading-preload.js",
  "$out\resources\app\src\renderer\index.html",
  "$out\resources\app\src\renderer\icon.ico"
)
foreach ($c in $checks) {
  if (-not (Test-Path $c)) { Write-Output "MISSING: $c"; exit 1 }
}
$size = [math]::Round((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Output "OK: $out (${size} MB)"

# 5) 压缩分发包
$zip = "$root\dist\DSH-Shell-0.1.0-win-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$out\*" -DestinationPath $zip -CompressionLevel Optimal
Write-Output ("zip: {0} ({1:N0} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
