# Immich X5 Client Viewer

这是基于 Immich 3.2.0 维护的私有客户端增强。当前阶段只拦截 X5 `.insp` 图片；NAS 仍只提供原文件和认证，双鱼眼转换发生在访问浏览器的 WebGL2 中。

## 当前行为

- 图片类型且原文件名或路径以 `.insp` 结尾时，读取 Immich 原文件。
- 校验 JPEG 容器及约 2:1 的左右双鱼眼布局。
- 在客户端生成临时等距柱状 JPEG，并复用 Immich 的 Photo Sphere Viewer。
- 文件校验、解码、WebGL 或运行时失败时，切回 Immich `PhotoViewer`。
- 降级只显示 3 秒中性提示；技术错误仅写入浏览器控制台。
- 不修改原文件，不产生 NAS 缓存，不新增 API、数据库表或后台任务。

当前 shader 使用通用的等距鱼眼模型和左右镜头几何关系，还没有读取 X5 文件中的镜头标定参数。因此第一版目标是验证端到端链路和交互，不承诺达到 Insta360 Studio 的接缝与防抖质量。

## 分支和版本

- `main`：跟随 `immich-app/immich`，不放私有修改。
- `x5-viewer`：长期维护的 X5 patch stack。
- `feature/x5-insp`、`feature/x5-insv`：阶段性开发分支，完成后合入 `x5-viewer`。
- 发布标签：`x5-v<upstream-version>-r<revision>`，例如 `x5-v3.2.0-r1`。

升级上游时，从目标 Immich release 建立新的 `x5-viewer` 基线，按提交顺序重放 X5 patch，完成检查后再打新的不可变标签。不要让 NAS 跟踪 `main`、`release` 或 `x5-dev`。

## 构建与部署

推送 `x5-v*` 标签会触发 `X5 Server Image` 工作流，生成仅面向 DS224+ 的 `linux/amd64` 镜像：

```text
ghcr.io/mental1104/immich-server:<x5-v* tag>
```

NAS 保留对应 Immich release 的官方 Compose，只叠加仓库中的覆盖文件：

```bash
X5_IMMICH_VERSION=x5-v3.2.0-r1 docker compose \
  -f docker-compose.yml \
  -f docker-compose.x5.yml \
  pull immich-server

X5_IMMICH_VERSION=x5-v3.2.0-r1 docker compose \
  -f docker-compose.yml \
  -f docker-compose.x5.yml \
  up -d immich-server
```

回滚时把 `X5_IMMICH_VERSION` 改回上一个已经验证的不可变标签，再执行相同两条命令。数据库、Redis 和 machine-learning 不随此覆盖文件变化。

## 本地验证

首次检出仓库后先构建工作区 SDK，再运行 Web 检查：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @immich/sdk build
corepack pnpm --dir web check:code
corepack pnpm --dir web test --run src/lib/components/asset-viewer/x5/x5-insp.spec.ts
corepack pnpm --dir web build
```

发布前还需要用一张真实 X5 INSP 手工确认镜头顺序、上下方向、接缝和缩放。原始私人素材不提交到仓库。

## 后续边界

INSV 不复用当前“先生成整张等距柱状图”的路径。视频阶段应新增 Range 请求、容器解析、WebCodecs 解码和逐帧 GPU 投影；任何不支持的编码或浏览器仍回到 Immich 原视频行为。
