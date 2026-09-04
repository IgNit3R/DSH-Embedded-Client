# DSH Client

Windows 桌面壳：用 Electron 自动启动并承载 DeepSeek Harness Web（`npx @deepseek-ai/dsh web`，默认 `http://127.0.0.1:3080`）。默认没有常驻地址栏/菜单栏/调试面板，只有 DSH 页面本身，由满铺客户区的 `WebContentsView` 承载；按 F10 可显示顶部工具栏。保留普通系统边框，可拖拽缩放；初始 1280×820，最小 720×480。

当前版本：`0.2.0`

## 运行

```powershell
npm install   # 首次会准备 Electron 二进制
npm start
```

## 启动链

1. **单实例锁**：`app.requestSingleInstanceLock()`，第二个实例直接退出，已有实例窗口聚焦前置。
2. **窗口**：`app ready` 后创建主窗口与满铺 `WebContentsView`，先显示本地 loading 页。
3. **附着检查**：先探测一次 `http://127.0.0.1:3080`；若已有 DSH 服务在跑则直接附着复用，不重复拉起，关闭窗口时也不会终止外部服务。
4. **启动服务**：端口空闲时 spawn：
   ```
   npx.cmd @deepseek-ai/dsh web --no-open
   ```
   `--no-open` 让 DSH 不自动打开默认浏览器。
5. **探活**：`node:http` 每 500ms 轮询一次，总上限 180 秒；服务就绪后导航到 DSH。
6. **Token 导航**：新版 DSH 会打印带 token 的 Web 地址，例如：
   ```
   dsh web: http://127.0.0.1:3080/?token=...
   ```
   主进程会从 DSH 的 stdout 中捕获该地址，并使用带 token 的 URL 进行首次导航。
7. **错误处理**：探活超时或服务提前退出时弹原生错误框，退出前清理服务进程树。

## F10 工具栏

默认无 UI。按 **F10** 显示/隐藏顶部一行工具栏：

```
[主页]  [刷新]  [关于]
```

- **主页**：回到 DSH 本地主页 `http://127.0.0.1:3080`。
- **刷新**：重新加载当前页面。
- **关于**：显示构建时间、打包工具版本和 `@deepseek-ai/dsh` 版本。

### 外部页面地址栏

当 DSH 页面跳转到外部地址（例如 GitHub）时，在 F10 工具栏同一行右侧会显示只读地址栏：

```
[协议标签] [URL 主体] [复制按钮]
```

- 地址栏只在「F10 工具栏显示中 + 当前是外部页面」时出现。
- 协议标签只展示，不可手动选择复制；颜色规则：
  - `https` / `ssh` / `ftps`：绿色
  - `http` / `ftp` / `telnet`：红色
  - `file`：蓝色
  - 其他协议：黄色
- URL 主体可选中复制；过长时省略号显示在末尾。
- 复制按钮复制完整 URL。

回到 `127.0.0.1:3080` 本地 DSH 后，地址栏自动消失。

## 窗口状态

三态模型，全部走原生标题栏按钮：

```
A 正常窗口 ──点最大化──▶ C 无边框满屏 ──按 Esc──▶ B 标准最大化 ──还原──▶ A
```

- 最小尺寸 1280×720，初始 1280×820。
- 最大化按钮语义为进入无边框满屏（覆盖整块显示器）。
- 满屏中按 Esc 退出到标准最大化；焦点在 DSH 页面内也能捕获。

## 关闭行为

- **自启服务**：关闭窗口时若 DSH 服务仍在运行，会弹确认框；确认后 `taskkill /pid <pid> /T /F` 终止整个进程树。
- **附着模式**：关闭窗口不弹确认框，也绝不终止外部启动的 DSH 服务。
- **兜底清理**：所有退出路径都会调用 `services.stopAll()`。

## 安全基线

- 主窗口与内容视图均开启 `contextIsolation` + `sandbox`，无 `nodeIntegration`。
- 默认拒绝所有权限申请（摄像头/麦克风/通知等）。
- 新开链接一律在当前视图内打开。
- 导航协议白名单：http / https / about。
- loading 页和菜单栏页面零内联脚本，DOM 操作由 sandbox preload 完成。

## 打包

```powershell
npm run pack:zip
npm run pack:portable
```

打包前会自动运行 `scripts/build-info.js`，把当前构建时间与 electron-builder 版本写入 `src/main/build-info.json`，供「关于」对话框显示。

默认输出目录：

```
dist\
```

## 项目结构

```
shell-browser/
├─ package.json
├─ scripts/
│  ├─ build-info.js             # 生成构建信息
│  ├─ download.js               # 受限环境手动下载 Electron 二进制
│  ├─ assemble-portable.ps1
│  ├─ electron-noop.js
│  └─ make-icon.js
├─ build/                       # 打包图标等资源
└─ src/
   ├─ main/
   │  ├─ main.js                # 主进程：窗口、服务生命周期、token 捕获、F10 工具栏
   │  ├─ service-manager.js     # 服务进程管理器
   │  └─ build-info.json        # 打包时生成的构建信息
   ├─ preload/
   │  ├─ loading-preload.js     # loading 页日志 preload
   │  └─ menu-preload.js        # F10 菜单栏/地址栏 preload
   └─ renderer/
      ├─ index.html             # loading 页
      ├─ menu.html              # F10 菜单栏 + 地址栏
      └─ icon.ico
```

## DSH 数据位置

DSH 的配置、凭据、附件和会话数据不在本项目目录内，默认位于：

```
%USERPROFILE%\.dsh\
```

例如会话目录：

```
%USERPROFILE%\.dsh\sessions\
```

升级或替换 `DSH Client` 不会清除这些数据；除非手动删除 `.dsh` 或修改 `DSH_HOME`。

## 环境备注

- 在受限沙箱内安装依赖时，可用项目内缓存：
  ```powershell
  npm install --cache .npm-cache
  ```
- Electron postinstall 受限时：
  ```powershell
  npm install --ignore-scripts
  node scripts/download.js <url> <dest>
  ```
  再解压到 `node_modules/electron/dist` 并写入 `path.txt`。
- 在受限进程树内启动 Electron 可能因 Chromium IPC 初始化失败而崩溃，属于运行环境限制；正常用户桌面运行 `npm start` 不受影响。
