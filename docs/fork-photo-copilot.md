# Immich Photo Copilot

Photo Copilot 在照片查看器内提供原生 Codex 聊天面板。Codex 在 NAS 的 Immich API 进程旁作为子进程运行；浏览器沿用 Immich 登录 Cookie，不需要扩展、本地 Bridge、配对令牌或额外登录。图片和元数据会送到配置的 Codex 模型服务；进程在 NAS 上运行不表示模型也在 NAS 上推理。

2026-11-10 已部署到 NAS 正式 Immich，运行镜像为 `immich-server:nas-dev-d3d32e845ef8`。刷新网页，打开照片后点击工具栏的机器人按钮 Photo Copilot 即可。正式专用 HOME 为 `/volume2/docker/immich/photo-copilot`，固定二进制目录为 `/volume2/docker/immich/photo-codex-0.166.0`；部署配置由 homelab-services 的 Immich override 管理，详细证据与回退边界见根目录 `change.log`。

## 当前实现

```text
照片查看器 → /api/fork/photo-copilot → PhotoCopilotService
                                          ↓ stdio JSON-RPC
                                   codex app-server
                                          ↓
                                    Codex 模型服务
```

- 基线为官方 `v3.3.6`，Fork 开发起点为 `70c4b0d84`，本次没有同步新上游。
- Web 使用 Svelte 5 / SvelteKit。入口位于 `AssetViewerNavBar.svelte`，侧栏由 `AssetViewer.svelte` 按 Asset ID 创建；占用最多 420px / 42vw，覆盖显示，不改变图片尺寸，下一张按钮向左避让。
- 现有 Immich 插件接口用于 workflow 方法与模板，没有照片查看器 UI 插槽，因此直接添加小范围原生组件，避免 DOM 注入及浏览器跨源 localhost 问题。
- 服务端复用 `AssetService.get`、`AlbumRepository.getByAssetId` 和现有 AssetRead/View/Download 权限。客户端只能提交 Asset ID、会话 ID、消息，不能指定文件路径、系统提示词、模型或执行命令。
- Codex 接口对照本机 `0.166.0` CLI 的 `generate-json-schema --experimental` 输出及[官方 App Server 文档](https://developers.openai.com/codex/app-server)。使用 `initialize`、`thread/start`、`turn/start`、`turn/interrupt`、`thread/unsubscribe` 和助手增量/终态通知。`additionalContext` 是该版本的实验字段，握手显式启用 `experimentalApi`，传递包含版本号的结构化 JSON 上下文；升级 CLI 后需重新验证。
- Fork API 使用 `ApiExcludeController`，不进入官方 OpenAPI/移动 SDK 生成链路，不修改官方接口或数据库。

## 图片和上下文

上下文包含 Asset ID、原始文件名、类型/MIME、大小、宽高、拍摄时间、相机和镜头、焦距、光圈、快门、ISO、GPS、描述、当前用户可见相册、标签和人物。缺失字段保持 null/空数组。当前 API 没有独立的“存储文件名”公开字段，不将服务器目录交给模型充当文件名。

每轮重新检查资产读取/下载权限并读取图像记录，图像通过官方 `localImage` 输入附加：

| 来源                               | 行为                                                                                | 面板标记               |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ---------------------- |
| JPEG/PNG/WebP/GIF                  | 原文件存在且不超过 20 MiB 时直接附加                                                | original photo         |
| NEF                                | 复用 Immich `MediaRepository.extract` 提取相机内嵌图，本地转换 JPEG；不完整显影 RAW | RAW embedded preview   |
| HEIC/HEIF                          | 用已有 sharp/libvips 在本地解码为 JPEG                                              | locally converted HEIC |
| 解码失败、其他格式、原片离线或超限 | 使用未编辑的 Immich 预览，存在且不超过 20 MiB                                       | Immich preview         |
| 原片和可用预览均不存在             | 仅元数据对话，模型明确获知没有图片                                                  | not attached           |

转换图最长边 4096px，输入上限 1 亿像素。临时图只写独立 Codex HOME 的 `workspace`，正常完成、停止和异常时清理，不写回图库、不更新 EXIF 或数据库。进程被 SIGKILL 时可能留下临时 JPEG，可在停止服务后清理该独立 workspace 中的 `.jpg` 文件。

## 配置与启动

必须使用包含本次 Server/Web 修改的开发构建。单独配置环境变量不能给旧运行镜像增加按钮/API。现有生产实例不随代码修改自动重建、重启或升级。

| 环境变量                          | 默认值         | 含义                                                              |
| --------------------------------- | -------------- | ----------------------------------------------------------------- |
| `IMMICH_PHOTO_COPILOT_ENABLED`    | 未启用         | `true` 才启动助手；没有数据库迁移                                 |
| `IMMICH_PHOTO_COPILOT_HOME`       | 无             | 必须为绝对路径、专用于此功能的可写目录，不能使用现有 `~/.codex`   |
| `IMMICH_PHOTO_COPILOT_EXECUTABLE` | `codex`        | NAS/容器内可执行的 Codex 路径；容器必须能访问该二进制及其配套资源 |
| `IMMICH_PHOTO_COPILOT_MODEL`      | Codex 默认模型 | 可选模型名，需当前登录账号支持                                    |

先准备独立目录及登录文件。可以在这份独立 HOME 下执行 Codex 的官方登录流程，也可以从已有登录复制 `auth.json`。不要把整个用户 HOME、`.codex`、SSH 目录或数据库环境变量交给助手。

```sh
# 示例路径需要替换为本机专用目录；复制的是登录文件，不在终端打印文件内容。
mkdir -p /absolute/photo-copilot
chmod 700 /absolute/photo-copilot
cp /absolute/existing-codex/auth.json /absolute/photo-copilot/auth.json
chmod 600 /absolute/photo-copilot/auth.json
```

启动时本功能会在专用 HOME 写入最小 `config.toml`，禁用 shell、view_image 工具、web search、Apps；不导入原有 MCP、插件、技能和项目配置。`localImage` 附件仍可读取服务端明确选定的图片。所有需要交互授权的 App Server 请求都拒绝，任务使用 read-only sandbox、禁止工具网络访问，启动子进程时不继承 Immich 数据库、模型 API key 或 SSH 环境变量。认证使用这份 HOME 内的登录文件；只支持系统 keyring 的登录需要先给独立 HOME 登录。

专用 HOME 如果已有不同内容的 `config.toml`，本功能会拒绝启动并保留原文件，不覆盖现有 Codex 配置。

本地源码调试沿用仓库开发入口，运行前准备独立数据库/Valkey，避免开发服务连接真实图库：

```sh
# 在 server/ 下启动开发 API；先按仓库开发文档配置隔离数据库和队列。
IMMICH_PHOTO_COPILOT_ENABLED=true \
IMMICH_PHOTO_COPILOT_HOME=/absolute/photo-copilot \
IMMICH_PHOTO_COPILOT_MODEL=gpt-6.1-sol \
pnpm start:dev
```

```sh
# 在 web/ 下启动 Web，API 地址必须是刚才的开发 API。
IMMICH_SERVER_URL=http://127.0.0.1:2283 pnpm dev
```

容器部署可参考 `docker/compose.photo-copilot.example.yml`，在隔离环境中与 `docker/compose.nas-dev.yml` 组合；示例本身不会执行部署。`PHOTO_COPILOT_CODEX_RELEASE` 指向包含 `codex` 与配套资源的 Linux release 目录，`PHOTO_COPILOT_HOME` 指向专用登录/缓存目录。只新增只读二进制挂载和专用状态卷，没有新端口或 Bridge 服务。不要把宿主机的 macOS/Windows 二进制挂到 Linux 容器中。

模型配置和登录属于服务器侧配置。Web 中进入一张照片，点击工具栏的机器人按钮 Photo Copilot 即可；首次打开会创建线程，首次发送会附加图片。面板顶部始终显示文件名、Asset ID、连接/任务状态及实际图片来源，展开 Photo context 可检查元数据。

## 停止、刷新与故障

- Stop 调用官方 `turn/interrupt`，显示 stopping，收到 interrupted 才确认结束。10 秒无终态会关闭本功能的 App Server，所有相关会话明确显示失败。
- 关闭侧栏、切图或刷新只断开观察，已提交任务在后台继续；重新打开按用户/Asset ID 从本标签页 `sessionStorage` 恢复。新照片使用新会话，旧照片输出不会串入。
- New session 开始新的照片会话；运行中的会话需先停止。HTTP/SSE 重连不重复提交用户消息。
- 服务端重启会丢失内存会话；前端发现 404 后创建新会话，不能恢复旧聊天历史。App Server 线程为 ephemeral；服务器本地仍可能保存 Codex 自身的运行状态，专用 HOME 应按私人数据保护。
- 每个 API 进程最多保留 32 个会话、同时运行 2 个任务、每会话最多 100 条消息，单轮 5 分钟后请求停止。只回收空闲会话。当前仅支持单 API 实例；多副本需要粘性路由或另行实现共享状态。
- 连接错误先检查功能开关、容器内 Codex 可执行路径、HOME 写权限、登录有效性、模型可用性和反向代理的 SSE buffering。Nginx 应允许长连接并关闭该路径的 proxy buffering。
- 前台开发用 Ctrl+C 停止；容器正常停止时随 Immich 清理自己的 Codex 子进程。禁用环境开关并重启服务即可停止整个功能，无数据库回退。不会停止 NAS 上其他 Codex 会话。
- 不记录用户消息、照片字节、EXIF 或 Codex stderr；既有请求日志仍可能记录 URL/Asset ID。全局 verbose body logging 对 Photo Copilot 路径跳过正文。

## 验证

下列命令在各自包目录运行，使用已安装依赖；本次没有新增依赖或 CI workflow。

```sh
# server/：服务、HTTP/SSE 合同测试及静态检查；数据库用替身，不访问生产。
pnpm exec vitest run --config test/vitest.config.mjs src/services/photo-copilot.service.spec.ts src/controllers/photo-copilot.controller.spec.ts
pnpm exec tsc --noEmit --incremental false
```

```sh
# server/：显式调用真实 Codex，复用本机登录，只发送测试生成的几何图。
PHOTO_COPILOT_LIVE_TEST=1 pnpm exec vitest run --config test/vitest.config.mjs src/utils/photo-copilot.live.spec.ts
```

```sh
# web/：面板交互、类型/可访问性检查及构建。
pnpm exec vitest run src/lib/components/asset-viewer/PhotoCopilotPanel.spec.ts
pnpm check:svelte
pnpm check:typescript
pnpm build
```

```sh
# e2e/：先运行隔离 Web，再用已有浏览器测试框架；API/照片使用合成网络替身。
PLAYWRIGHT_DISABLE_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
pnpm exec playwright test --project=ui --workers=1 src/ui/specs/asset-viewer/photo-copilot.e2e-spec.ts
```

实际结果在根目录 `change.log` 记录，明确区分网络替身的 UI 验收、真实 Codex 调用和实际编解码检查。

## 目前的边界

尚未实现描述/标签等数据富化写入、批量分析、相似搜索、持久化聊天、跨浏览器恢复、视频理解、完整 RAW 显影及移动端适配。没有授予 Codex 通用本机工具和 NAS 管理权限；后续富化应增加明确的结构化结果及写入确认，不能直接放开 shell 或让模型改数据库。iPhone 虚拟原片/恢复引用没有单独接入原片重建路径，原路径不可读时使用可用预览。

既有官方 API、数据库迁移、原片、官方移动端及 SDK 保持原有行为。没有以服务健康检查替代真机或实际照片验收。
