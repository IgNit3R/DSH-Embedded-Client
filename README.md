# DSH Client

DSH 专用 Windows 桌面壳：自动启动 `@deepseek-ai/dsh` 的本地 Web 服务，并用 Electron 以全窗口方式承载其界面。

- 开发态：`npm start`
- 打包：`npm run pack:zip` / `npm run pack:portable`
- 产物：`dist/`

## 这是什么

`@deepseek-ai/dsh` 本身以 Web 服务方式运行，默认监听 `http://127.0.0.1:3080`。本项目的目标是把它包装成一个更像原生应用的桌面客户端：

- 启动应用时自动执行 `npx @deepseek-ai/dsh web --no-open`
- 轮询探测 `127.0.0.1:3080`，就绪后在一个满铺的 `WebContentsView` 中加载 DSH 页面
- 如果 3080 上已经有 DSH 服务在运行，则直接附着复用，不重复启动，也不接管其生命周期
- 关闭窗口时如果 DSH 服务还在运行，会先询问是否终止，避免误杀正在执行的任务

## 功能特性

- **单实例锁**：重复启动时只聚焦已有窗口并退出，避免端口冲突
- **自动服务管理**：拉起 `npx @deepseek-ai/dsh web --no-open`，退出时清理整个进程树
- **附着模式**：检测到外部已有 DSH 服务时直接复用，关闭应用不会终止外部服务
- **首装进度展示**：首次运行 npx 需要下载依赖时，loading 页会自动展示 npm 日志滚动区
- **无边框满屏体验**：点击最大化进入无边框满屏，`Esc` 退回标准最大化
- **F10 轻量菜单**：提供「刷新当前页面」和「关于」
- **更克制的 WebView 配置**：
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `sandbox: true`
  - 默认拒绝摄像头、麦克风、通知等权限申请
  - 新开链接在当前视图内打开，不放行 `file:` 协议

## 环境要求

- Windows x64
- Node.js（建议 18+，具体以 Electron 33 的官方要求为准）
- npm
- 首次运行需要网络，用于通过 npx 拉取 `@deepseek-ai/dsh`

## 开发运行

```bash
npm install
npm start
```

启动后应用会：

1. 探测 `http://127.0.0.1:3080`
2. 若已有 DSH 服务，直接加载页面
3. 否则自动运行 `npx @deepseek-ai/dsh web --no-open` 并等待就绪
4. 就绪后全窗口显示 DSH 页面

## 打包

### electron-builder 打包

```bash
# 生成 zip 安装包
npm run pack:zip

# 生成 portable 绿色版
npm run pack:portable
```

打包前会通过 `prepack` 脚本生成 `src/main/build-info.json`（构建时间、打包工具版本），该文件已加入 `.gitignore`。

### 手动组装绿色版

在受限环境或不想依赖 electron-builder 时：

```powershell
powershell -File scripts\assemble-portable.ps1
```

脚本会复制 `node_modules/electron/dist`，把主程序改名为 `DSH Client.exe`，放入应用代码，并生成 `dist/DSH-Shell-0.1.0-win-x64.zip`。

## 快捷键与操作

| 操作 | 效果 |
| --- | --- |
| `F10` | 显示 / 隐藏顶部菜单栏 |
| `Esc` | 在无边框满屏状态下退出到标准最大化 |
| 关闭窗口 | 若 DSH 服务由本应用启动，会询问是否「终止服务并退出」 |

## 项目结构

```text
DSH-Embedded-Client/
├── build/                      # 打包用图标资源
├── scripts/
│   ├── assemble-portable.ps1   # 手动组装绿色版
│   ├── build-info.js           # 生成构建信息
│   ├── download.js             # 极简 HTTPS 下载器
│   ├── electron-noop.js        # Electron 启动对照实验
│   └── make-icon.js            # 从图片生成 Windows 图标的工具
├── src/
│   ├── main/
│   │   ├── main.js             # Electron 主进程
│   │   └── service-manager.js  # 本地服务进程管理器
│   ├── preload/
│   │   ├── loading-preload.js  # loading 页日志推送
│   │   └── menu-preload.js     # F10 菜单栏交互
│   └── renderer/
│       ├── index.html          # 启动 loading 页
│       ├── menu.html           # F10 菜单栏
│       └── icon.ico            # 窗口/任务栏图标
├── package.json
└── README.md
```

## 技术栈

- Electron 33
- electron-builder 26
- 原生 Node.js 模块（`node:http`、`node:child_process` 等）
- 原生 HTML / CSS / JavaScript，无前端框架

## 说明

- DSH 服务默认端口写死在 `src/main/main.js` 的 `DSH_URL = http://127.0.0.1:3080`
- 首次启动超时放宽到 3 分钟（npx 首次下载依赖可能较慢）
- 项目当前主要面向 Windows，未做 macOS / Linux 适配
