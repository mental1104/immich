# Immich X5 Client Viewer

这是基于 Immich 3.3.3 维护的私有客户端增强。当前阶段只拦截 X5 `.insp` 图片；NAS 仍只提供原文件和认证，双鱼眼转换发生在访问浏览器的 WebGL2 中。

## 当前行为

- 图片类型且原文件名或路径以 `.insp` 结尾时，读取 Immich 原文件。
- 校验 JPEG 容器、X5 型号、`p2` 基础标定及约 2:1 的左右双鱼眼布局。
- 在客户端生成临时等距柱状 JPEG，并复用 Immich 的 Photo Sphere Viewer。
- 使用文件内的双镜头圆心和有效半径，并在重叠区域中央做窄幅接缝渐变。
- 文件校验、解码、WebGL 或运行时失败时，切回 Immich `PhotoViewer`。
- 降级只显示 3 秒中性提示；技术错误仅写入浏览器控制台。
- 不修改原文件，不产生 NAS 缓存，不新增 API、数据库表或后台任务。

当前 shader 已读取 X5 `p2` 基础标定，但仍使用通用的等距鱼眼模型，没有复现官方的完整畸变校正、视差补偿和光流拼接。因此当前目标是可用的浏览预览，不承诺达到 Insta360 Studio 的接缝质量。

## 分支和版本

- `main`：跟随 `immich-app/immich`，不放私有修改。
- `x5-viewer-v3.3.3`：基于官方 Immich v3.3.3 的试运行分支；NAS CI 仅在此分支构建本地开发镜像。
- `x5-viewer`：原 v3.2.0 实现保留作参考，不用于当前 NAS 部署。
- `feature/x5-insp`、`feature/x5-insv`：历史阶段性开发分支。
- 发布标签：`x5-v<upstream-version>-r<revision>`，例如 `x5-v3.3.3-r1`。

升级上游时，从目标 Immich release 建立新的 `x5-viewer` 基线，按提交顺序重放 X5 patch，完成检查后再打新的不可变标签。不要让 NAS 跟踪 `main`、`release` 或 `x5-dev`。

## 构建与部署

推送 `x5-v*` 标签会触发 `X5 Server Image` 工作流，在 GitHub-hosted runner 上构建并推送正式 `linux/amd64` 镜像。NAS CI 则在 `x5-viewer-v3.3.3` 分支构建本地 `immich-server:x5-nas-dev`，只构建、不推送、不自动部署。

```text
ghcr.io/mental1104/immich-server:<x5-v* tag>
```

NAS 的正式/试运行部署由 homelab-services 仓库管理；本仓库的 `docker/docker-compose.x5.yml` 仅作为镜像覆盖示例。只有在 NAS CI 绿灯且确认当前服务版本与 v3.3.3 一致后，才手动更新 Immich Server：

```bash
X5_IMMICH_VERSION=x5-v3.3.3-r1 docker compose \
  -f docker-compose.yml \
  -f docker-compose.x5.yml \
  pull immich-server

X5_IMMICH_VERSION=x5-v3.3.3-r1 docker compose \
  -f docker-compose.yml \
  -f docker-compose.x5.yml \
  up -d immich-server
```

回滚时把 `X5_IMMICH_VERSION` 改回上一个已经验证的不可变标签，再执行相同两条命令。数据库、Redis 和 machine-learning 不随此覆盖文件变化。

## NAS CI 与版本边界

- NAS runner 标签为 `immich-nas`，仅响应此分支的受信任 push，不响应外部 Pull Request。
- NAS CI 使用 BuildKit 并限制并行度为 2；主机可用内存低于 8 GiB 时会在构建前停止。
- CI 成功后镜像只存在于 NAS Docker daemon；它不会重启运行中的 Immich。
- 当前分支基于官方 v3.3.3。切换前必须核实 NAS 正在运行的 Server 版本不高于此版本；禁止用更旧版本回退数据库。

## 本地验证

首次检出仓库后先构建工作区 SDK，再运行 Web 检查：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @immich/sdk build
corepack pnpm --dir web check:code
corepack pnpm --dir web test --run src/lib/components/asset-viewer/x5/x5-insp.spec.ts
corepack pnpm --dir web build
```

已经使用真实 X5 INSP 验证 JPEG 结构、11904×5952 双鱼眼布局和 `p2` 标定字段。发布前仍需在实际 Immich 页面手工确认 WebGL 上下方向、交互和降级行为；原始私人素材不提交到仓库。

## 后续边界

INSV 不复用当前“先生成整张等距柱状图”的路径。视频阶段应新增 Range 请求、容器解析、WebCodecs 解码和逐帧 GPU 投影；任何不支持的编码或浏览器仍回到 Immich 原视频行为。
