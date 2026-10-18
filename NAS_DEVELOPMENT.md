# NAS 本机开发

位置：`/volume2/workflow/immich-nas-dev`。从现有 runner 的 `x5-viewer-v3.3.3` 干净工作区复制，基线 `14c0f2b1aabc`；原工作区不变。工具使用 NAS 已缓存的 Node 24.21.0，与 `.nvmrc` 一致；pnpm 11.27.1 由 Corepack 按 `package.json` 固定。

## 日常启动与停止

在仓库根目录运行：

```sh
docker-compose -f docker/compose.nas-dev.yml up -d
```

访问 <http://192.168.31.238:3000>。源码直接挂载，Web 使用 Vite HMR；无需重建镜像。绑定 NAS 的可信局域网地址，不配置公网入口或反向代理。数据库、Valkey 不发布宿主机端口；开发图库与数据库分别使用 `immich-nas-dev_library`、`immich-nas-dev_database` 卷，不挂载生产目录。

首次依赖安装和 SDK 构建（使用已建立的本地工具容器）：

```sh
docker start immich-nas-dev-tools
docker exec immich-nas-dev-tools pnpm --filter immich-web --filter @immich/sdk --filter immich --filter @immich/plugin-sdk install --frozen-lockfile
docker exec immich-nas-dev-tools pnpm --filter @immich/sdk build
```

工具容器若需重建：使用 `node:24.21.0`，挂载此仓库到 `/workspace`，工作目录 `/workspace`，执行 `sleep infinity`；容器内先 `corepack enable`。依赖位于挂载目录，容器重建后保留。

停止开发服务（保留测试数据）：

```sh
docker-compose -f docker/compose.nas-dev.yml stop
docker stop immich-nas-dev-tools
```

## 验证与镜像

```sh
docker exec immich-nas-dev-tools pnpm --dir web test --run src/lib/components/asset-viewer/x5/x5-jpg.spec.ts src/lib/components/asset-viewer/x5/x5-insp.spec.ts
docker exec immich-nas-dev-tools pnpm --dir web format
docker exec immich-nas-dev-tools pnpm --dir web exec eslint . --max-warnings 0 --concurrency 1
docker exec immich-nas-dev-tools pnpm --dir web check:svelte
docker exec immich-nas-dev-tools pnpm --dir web check:typescript
bash docker/build-nas-dev.sh
```

构建入口要求干净、已提交的本地源码。复用现有 `immich-nas-x5` builder（7 GiB 内存 / 8 GiB 内存加 Swap，单并发），不更改其设置。仅生成 `immich-server:nas-dev-<12位commit>`；版本环境变量记录完整 commit。不会更新开发或生产 Server。需要验证生产打包时，可显式设置 `NAS_DEV_SERVER_IMAGE` 后仅更新独立开发服务。

NAS 上全库 ESLint 使用单并发；默认 `check:code` 的 6 并发曾触发工具容器 OOM（137）。工具容器内存上限现为 6 GiB，内存加 Swap 为 7 GiB。

## JPG 识别边界

原有 `ProjectionType=EQUIRECTANGULAR` 继续优先触发球形查看器。真实样本缺失该字段，但已确认为拼接 JPG，EXIF 为 `Arashi Vision / Insta360 X5 / 11904×5952`。仅对这一组合增加 Web 查看器选择回退，不改 API、不写回 EXIF、不改服务端识别或移动端，不触发生产重新提取元数据。

其他尺寸、缺少型号的 JPG、PNG、INSP 和普通 2:1 图片不会因该规则进入球形查看器。EXIF 不是内容真实性证明；其他导出规格需要样本验证后另行扩展，不能据此宣称识别所有 X5 JPG。

私人样本、浏览器截图、开发账号凭据与验证记录存放于仓库外 `/volume2/workflow/immich-nas-dev-data`，不提交 Git。

手工复核：登录独立开发账号，在图库打开 X5 样本，拖拽改变视角、滚轮缩放（高倍率会切换原图）；退出后打开普通 2:1 测试图，确认保持平面查看。回退功能只需撤销本次 Web 改动并由 HMR 刷新；停止开发 Compose 不影响生产。
