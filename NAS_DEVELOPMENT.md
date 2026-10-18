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

## 全景筛选

搜索筛选面板提供独立的“全景”开关，可与照片／视频、日期等条件组合。服务端在分页前应用条件：照片 INSP、视频 INSV（忽略后缀大小写）；有等距柱状投影元数据的照片／视频；以及上述已核实的 X5 JPG 导出规格。无投影元数据的 MP4 不仅凭 2:1 比例纳入，其他 MP4 导出规格需先核实样本。

现有搜索 API 增加可选 `isPanorama` 条件，兼容版参数为布尔值，结构化参数为 `filter.isPanorama.eq`。不传字段时查询行为不变；沿用既有鉴权、可见性、分页和计数，不新增端点、索引或迁移。OpenAPI 与 TypeScript SDK 通过原生成工具更新；不生成或修改移动端代码。

PostgreSQL 规则测试位于 `server/test/medium/specs/utils/panorama.spec.ts`，只在测试数据库事务的临时表中验证 14 种边界。它可随原有 medium 测试运行；NAS 的验证记录保存在仓库外私有目录。

私人样本、浏览器截图、开发账号凭据与验证记录存放于仓库外 `/volume2/workflow/immich-nas-dev-data`，不提交 Git。

手工复核：登录独立开发账号，在图库打开 X5 样本，拖拽改变视角、滚轮缩放（高倍率会切换原图）；退出后打开普通 2:1 测试图，确认保持平面查看。回退功能只需撤销本次 Web 改动并由 HMR 刷新；停止开发 Compose 不影响生产。

## Nikon NEF 与 RAW/JPEG 配对

NEF 优先使用相机内嵌 JPEG 生成预览及浏览器全尺寸副本，避免 Z5 II High Efficiency 压缩在 RAW 解码路径中生成异常图像。其他 RAW 格式继续遵守原 `extractEmbedded` 配置；没有内嵌图的 NEF 保留原有解码回退。这里提供相机 JPEG 渲染结果，不替代 RAW 显影。

完成元数据提取后，唯一的一对 Nikon NEF+JPG/JPEG 会进入原有堆叠，以 JPEG 为封面。要求用户、图库、可见性、文件名主体、相机厂商／型号及精确拍摄时间相同；外部图库还要求同目录。多个候选、缺失元数据、已堆叠、回收站、锁定或隐藏资源均不自动合并。使用事务、用户范围事务锁和资产行锁保证并发与重试安全；不修改、删除或移动原片。不新增 API、数据库列或迁移。

配对测试使用 PostgreSQL 临时表，位于 `server/test/medium/specs/utils/nikon-pair.spec.ts`。现有图库需要一次受限回填：仅调用同一配对方法，并对 NEF 重新生成衍生预览；结果和回退用堆叠 ID 记录在仓库外私有目录。
