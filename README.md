# 无限画布开关（openchamber-infinite-canvas）

一个 OpenChamber 扩展：在会话状态区放一张小卡片，**一次点击**把 Infinite Canvas 的整套链路拉起来，再点一次全部收掉。

| 动作 | 发生什么 |
| --- | --- |
| **开启** | 起本机桥接（`127.0.0.1:17371`）→ 往 `opencode.json` 写入 `infinite-canvas` MCP 配置块 → 用 `mode=recent` 打开画布网页并自动连接 |
| **关闭** | 从 `opencode.json` 移除该配置块 → 按进程树停掉桥接（含它拉起的 Codex app-server）→ **浏览器不动**，那一页显示「未连接」 |
| **打开画布** | 只开网页，不动配置 |

状态永远现场读：端口通不通、`/health` 的 `clients`/`hasCanvas`、配置块在不在。用命令行脚本改过配置，卡片显示的也是同一份真相。

> 本项目只是一个「开关」。它调用 [@basketikun/canvas-agent](https://www.npmjs.com/package/@basketikun/canvas-agent) 与 [canvas.best](https://canvas.best) 的网页画布，**与两者没有隶属关系**，也不分发它们的代码。请遵守它们各自的许可与服务条款。

## 前置条件

- **Windows 10/11** —— 停桥接用的是 PowerShell 进程树操作，目前只验证过 Windows。
- **OpenChamber ≥ 2.7.0**（扩展 API v1）。
- **Node.js 22+**，且 `node` 在 `PATH` 里 —— OpenCode 启动 MCP 子进程要用它。
- 已安装桥接程序 `@basketikun/canvas-agent`（见下一节）。
- 浏览器能打开 `https://canvas.best/canvas`。

## 安装

### 1. 安装桥接程序（只需一次）

```powershell
npm install --prefix "$env:USERPROFILE\.infinite-canvas\agent" @basketikun/canvas-agent@0.6.0
```

扩展会按顺序找 `dist/index.js`：

1. 环境变量 `CANVAS_AGENT_JS` 指向的路径（装在别处时用这个）；
2. `%USERPROFILE%\.infinite-canvas\agent\node_modules\@basketikun\canvas-agent\dist\index.js`（上面命令的位置）；
3. 扩展私有数据目录下的 `agent/node_modules/@basketikun/canvas-agent/dist/index.js`。

一处都找不到时，卡片会直接给出安装命令，不会静默失败。

### 2. 安装扩展

**从仓库安装（推荐，能跟着更新）**

OpenChamber → 设置 → 扩展 → 添加扩展 → **URL**：

```
https://github.com/Mivimcrs/openchamber-infinite-canvas
```

安装后批准「本地服务」权限：`node`（起桥接）、`powershell`（按进程树停桥接）。

**离线安装**

下载 Release 里的 `openchamber-infinite-canvas-<版本>.zip`，用「添加扩展 → 文件夹 / zip」安装。

装好后在会话右栏「状态」区出现「无限画布」卡片；没有就折叠再展开一次，或重载标签页。

## 使用

- **开启**：起桥接 → 写 MCP 配置 → 打开画布页。OpenCode 通常几秒内热加载，`infinite-canvas` 的工具就出现在当前会话里。
- **关闭**：列表里的工具会消失，桥接进程树被收掉。浏览器那一页保留，只显示「未连接」。
- **打开画布**：桥接没起会先起桥接，再用已保存的 token 打开 `mode=recent`（回到上次那张画布）。

首次开启时，桥接会在 `%USERPROFILE%\.infinite-canvas\canvas-agent.json` 里生成本机 token；扩展只读取，不写这个文件。

## 它动了哪些本机文件

| 位置 | 动作 |
| --- | --- |
| `~/.config/opencode/opencode.json` | `mcp.infinite-canvas` 配置块：开启时写入，关闭时移除；写入前备份、写入后 `JSON.parse` 校验，不合法就放弃 |
| 扩展私有数据目录（宿主用 `OPENCHAMBER_SERVICE_DATA_DIR` 传入） | `logs/service.log` 操作日志；`logs/opencode.backup.*.json` 配置备份，只留最近 10 份 |
| `~/.infinite-canvas/canvas-agent.json` | 只读：桥接地址与 token |
| 浏览器 IndexedDB | 画布数据在**浏览器本地**；扩展不碰它，也不上传 |

卸载扩展会删掉它自己的数据目录（含备份与日志），但不会动 `opencode.json` 里的残留块 —— 先点一次「关闭」再卸载。

## 配置项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CANVAS_AGENT_JS` | 空 | 桥接程序 `dist/index.js` 的绝对路径；装在别处时设置它 |
| `CANVAS_SITE` | `https://canvas.best/canvas` | 画布站点（自建或镜像时改，必须带 `/canvas` 路径） |
| `OPENCHAMBER_SERVICE_DATA_DIR` | 宿主提供 | 扩展私有数据目录；单独调试时可自己指定 |

## 组成

| 路径 | 说明 |
| --- | --- |
| `package.json` | 扩展 manifest（仓库根就是可安装包） |
| `status/index.html` + `status/main.js` | 卡片 / 侧边栏面板页面（构建产物，IIFE） |
| `service/main.mjs` | 宿主拉起的本机服务（构建产物，ESM）：进程控制 + 配置编辑 + 状态汇总 |
| `源码/status/main.ts` | 卡片源码 |
| `源码/service/main.ts` | 服务源码 |
| `源码/scripts/build.mjs` | 打包，产物直接落到仓库根 |
| `源码/scripts/check-manifest.mjs` | 用宿主同一份 zod schema 离线校验 manifest |
| `源码/scripts/check-guest.mjs` | 跑官方 `openchamber-guest-check` |
| `源码/scripts/check-repo.mjs` | 公开仓库卫生检查：本机路径、私有目录、疑似密钥、版本一致性 |
| `.github/workflows/` | push/PR 自检；打 tag 时打包并发 Release |

## 构建与自检

```powershell
cd <仓库>\源码
npm install
npm run check
```

`check` = typecheck → build → manifest 校验 → 官方 guest 检查 → 仓库卫生检查。构建产物会直接覆盖仓库根的 `status/` 与 `service/`，**提交前记得把产物一起提交**（宿主不会在安装时编译）。

## 发布

```powershell
git tag v0.1.0
git push origin v0.1.0
```

tag 触发 CI：重新构建并自检、打 zip、发 Release。宿主按仓库根 `package.json` 的 `version` 做更新比较，**发版必须改版本号**。

## 排障

| 现象 | 处理 |
| --- | --- |
| 点「开启」提示找不到 Canvas Agent | 按提示装 `@basketikun/canvas-agent`，或设置 `CANVAS_AGENT_JS`；改完重启 OpenChamber |
| 桥接启动超时 | 端口 17371 可能被占；关掉旧的桥接进程再试 |
| 工具没出现 | 等几秒热加载；还没有就重启 OpenChamber |
| 工具报「当前没有已连接画布」 | 画布页没连上：再点一次「打开画布」，确认桥接在跑 |
| 页面一直连不上 | 桥接第一次连接会锁定 Origin；换域名访问时清掉 `canvas-agent.json` 的 `origins` 字段再重开 |
| 配置块删不干净 | 关闭操作会连同前后空白一起删；异常残留就点一次「关闭」，看 `logs/service.log` |

## 边界

- 关不掉浏览器标签（程序做不到），只能让那页变「未连接」。
- 画布数据在浏览器本地，换浏览器、清站点数据、换电脑都会丢；重要画布用画布内导出。
- 画布的 API Key 在画布网页里配置，本项目任何文件都不该出现它。
- 桥接只监听 `127.0.0.1`，面板请求经宿主代理并带 Bearer token；未授权的 `/health` 返回 401。

## 许可

[MIT](LICENSE) © 2026 Yiyu Luo (Mivimcrs)
